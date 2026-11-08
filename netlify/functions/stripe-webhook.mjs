// POST /.netlify/functions/stripe-webhook  (called by Stripe, not the app)
// Keeps users/{uid}.plan in step with their Stripe subscription.
// In Stripe: Developers -> Webhooks -> add this URL, with events
// checkout.session.completed, customer.subscription.created/updated/deleted.

import { FieldValue } from 'firebase-admin/firestore';
import { admin } from './lib/admin.mjs';
import { stripe, verifyWebhook } from './lib/stripe.mjs';

const text = (status, body) => new Response(body, { status });

async function uidFor(db, { uid, customer }) {
  if (uid) return uid;
  if (!customer) return null;
  const snap = await db.collection('stripeCustomers').doc(customer).get();
  return snap.exists ? snap.data().uid : null;
}

export async function applySubscription(db, sub, eventTime, uidHint = null) {
  const uid = await uidFor(db, { uid: uidHint || sub.metadata?.uid, customer: sub.customer });
  if (!uid) return false;
  const ref = db.collection('users').doc(uid);
  const cur = (await ref.get()).data() || {};
  if (cur.planEventAt && eventTime < cur.planEventAt) return true; // older event arrived late
  const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
  await ref.set({
    plan: 'plus',
    planStatus: sub.status === 'canceled' || sub.deleted ? 'canceled' : sub.status,
    planRenewsAt: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    planCancelAtPeriodEnd: !!sub.cancel_at_period_end,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    planEventAt: eventTime,
    planUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await db.collection('stripeCustomers').doc(sub.customer).set({ uid }, { merge: true });
  return true;
}

export default async (req) => {
  if (req.method !== 'POST') return text(405, 'POST only');
  const raw = await req.text();
  const event = verifyWebhook(raw, req.headers.get('stripe-signature'));
  if (!event) return text(400, 'Bad signature');
  const { db } = admin();
  const obj = event.data?.object || {};

  try {
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
      const uid = obj.client_reference_id || obj.metadata?.uid;
      if (uid && obj.customer) await db.collection('stripeCustomers').doc(obj.customer).set({ uid }, { merge: true });
      if (obj.subscription) {
        const sub = typeof obj.subscription === 'string' ? await stripe(`subscriptions/${obj.subscription}`) : obj.subscription;
        await applySubscription(db, sub, event.created, uid);
      }
    } else if (event.type.startsWith('customer.subscription.')) {
      await applySubscription(db, { ...obj, deleted: event.type === 'customer.subscription.deleted' }, event.created);
    }
  } catch (err) {
    console.error('stripe webhook', event.type, err.message);
    return text(500, 'Error'); // Stripe retries
  }
  return text(200, 'ok');
};
