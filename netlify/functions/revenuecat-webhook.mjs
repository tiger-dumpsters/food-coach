// POST /.netlify/functions/revenuecat-webhook  (called by RevenueCat, not the app)
// Keeps users/{uid}.plan in step with Apple in-app subscriptions.
// In RevenueCat: Project settings -> Integrations -> Webhooks -> this URL, with an
// Authorization header value equal to the REVENUECAT_WEBHOOK_AUTH env var.

import { timingSafeEqual } from 'node:crypto';
import { admin } from './lib/admin.mjs';
import { applyApplePlan, stateFromEvent } from './lib/apple-plan.mjs';
import { monitored, reportError, alertAdmins } from './lib/monitor.mjs';

const text = (status, body) => new Response(body, { status });

function authorized(req) {
  const want = process.env.REVENUECAT_WEBHOOK_AUTH || '';
  const got = req.headers.get('authorization') || '';
  if (!want) return false;
  const a = Buffer.from(got), b = Buffer.from(want), c = Buffer.from(`Bearer ${want}`);
  return (a.length === b.length && timingSafeEqual(a, b)) || (a.length === c.length && timingSafeEqual(a, c));
}

const handler = async (req) => {
  if (req.method !== 'POST') return text(405, 'POST only');
  if (!authorized(req)) return text(401, 'Unauthorized');
  let body;
  try { body = await req.json(); } catch { return text(400, 'Bad JSON'); }
  const e = body.event || {};
  const state = stateFromEvent(e);
  if (!state) return text(200, 'ignored');
  if (e.entitlement_ids && !e.entitlement_ids.includes('plus')) return text(200, 'not plus');
  const { db, auth } = admin();
  const uid = e.app_user_id && !String(e.app_user_id).startsWith('$RCAnonymousID') ? e.app_user_id : e.original_app_user_id;
  try {
    await applyApplePlan(db, uid, {
      ...state, productId: e.product_id, environment: e.environment,
      eventSec: Math.floor((e.event_timestamp_ms || Date.now()) / 1000),
    });
  } catch (err) {
    await reportError(err, { where: 'revenuecat-webhook', tags: { event: e.type } });
    await alertAdmins(db, auth, 'HungerHush: an App Store subscription update failed', `${e.type}: ${err.message}`.slice(0, 160)).catch(() => {});
    return text(500, 'Error'); // RevenueCat retries
  }
  return text(200, 'ok');
};

export default monitored('revenuecat-webhook', handler);
