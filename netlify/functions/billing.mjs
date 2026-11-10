// POST /.netlify/functions/billing
// Body: { action: 'status' | 'checkout' | 'portal' }
// status: the person's plan and limits. checkout: a Stripe Checkout link to start Plus.
// portal: a Stripe link to change card, see receipts or cancel.

import { admin, verify } from './lib/admin.mjs';
import { planSummary } from './lib/plans.mjs';
import { stripe } from './lib/stripe.mjs';
import { monitored } from './lib/monitor.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const handler = async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  const { db } = admin();
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const userRef = db.collection('users').doc(who.uid);
  const profile = (await userRef.get()).data() || {};
  const origin = process.env.URL || new URL(req.url).origin;

  if (body.action === 'status') return json(200, planSummary(profile));

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    return json(503, { error: "Upgrades aren't open yet." });
  }

  if (body.action === 'checkout') {
    if (planSummary(profile).paid) return json(400, { error: "You're already on Plus." });
    const session = await stripe('checkout/sessions', {
      mode: 'subscription',
      line_items: { 0: { price: process.env.STRIPE_PRICE_ID, quantity: 1 } },
      client_reference_id: who.uid,
      ...(profile.stripeCustomerId ? { customer: profile.stripeCustomerId } : { customer_email: who.email }),
      subscription_data: { metadata: { uid: who.uid } },
      metadata: { uid: who.uid },
      allow_promotion_codes: 'true',
      success_url: `${origin}/app?upgraded=1`,
      cancel_url: `${origin}/app?upgrade=cancelled`,
    });
    return json(200, { url: session.url });
  }

  if (body.action === 'portal') {
    if (!profile.stripeCustomerId) return json(400, { error: 'No subscription on this account.' });
    const session = await stripe('billing_portal/sessions', { customer: profile.stripeCustomerId, return_url: `${origin}/app` });
    return json(200, { url: session.url });
  }

  return json(400, { error: 'Unknown action' });
};

export default monitored('billing', handler);
