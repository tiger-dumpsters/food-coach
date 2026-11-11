// Plus bought in the iPhone app (Apple in-app purchase, through RevenueCat).
// RevenueCat tells us about purchases, renewals, cancellations, and expirations by
// webhook; the app also asks for an immediate sync right after a purchase.
//
// App user IDs in RevenueCat are Firebase user IDs (the app logs in with the uid).

import { FieldValue } from 'firebase-admin/firestore';

// RevenueCat entitlement IDs that mean Plus (RevenueCat auto-created hungerhush_pro).
export const ENTITLEMENTS = ['plus', 'hungerhush_pro'];

// Write an Apple subscription state onto the profile. eventSec orders updates so an
// old event that arrives late can't undo a newer one (same field Stripe uses).
export async function applyApplePlan(db, uid, { status, expiresAtMs, cancelAtPeriodEnd = false, productId, eventSec, environment }) {
  if (!uid || uid.startsWith('$RCAnonymousID')) return false;
  const ref = db.collection('users').doc(uid);
  const cur = (await ref.get()).data() || {};
  if (cur.planEventAt && eventSec < cur.planEventAt) return true;
  // Don't let an Apple expiry switch off a Plus that someone pays for on the web.
  if (status === 'expired' && cur.planSource === 'stripe' && ['active', 'trialing', 'past_due'].includes(cur.planStatus)) return true;
  await ref.set({
    plan: 'plus',
    planStatus: status,
    planSource: 'apple',
    planRenewsAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    planCancelAtPeriodEnd: !!cancelAtPeriodEnd,
    appleProductId: productId || null,
    appleEnvironment: environment || null,
    planEventAt: eventSec,
    planUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
}

// RevenueCat webhook event -> plan state.
export function stateFromEvent(e) {
  const expires = e.expiration_at_ms || null;
  const trial = e.period_type === 'TRIAL';
  const live = (expires || 0) > Date.now();
  switch (e.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'SUBSCRIPTION_EXTENDED':
    case 'TEMPORARY_ENTITLEMENT_GRANT':
      return { status: trial ? 'trialing' : 'active', expiresAtMs: expires, cancelAtPeriodEnd: false };
    case 'CANCELLATION': // turned off auto-renew (or refunded): keeps Plus until it runs out
      return { status: live ? (trial ? 'trialing' : 'active') : 'expired', expiresAtMs: expires, cancelAtPeriodEnd: true };
    case 'BILLING_ISSUE':
      return { status: 'past_due', expiresAtMs: expires, cancelAtPeriodEnd: false };
    case 'EXPIRATION':
      return { status: 'expired', expiresAtMs: expires, cancelAtPeriodEnd: false };
    default:
      return null; // TEST, TRANSFER, NON_RENEWING_PURCHASE, etc.: nothing to change
  }
}

// Ask RevenueCat for someone's current state (used right after a purchase or restore).
export async function syncFromRevenueCat(db, uid) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) return { synced: false, reason: 'not configured' };
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`RevenueCat ${res.status}`);
  const { subscriber = {} } = await res.json();
  const ent = ENTITLEMENTS.map((k) => subscriber.entitlements?.[k]).find(Boolean);
  if (!ent) return { synced: true, plus: false };
  const expiresAtMs = ent.expires_date ? Date.parse(ent.expires_date) : null;
  const sub = subscriber.subscriptions?.[ent.product_identifier] || {};
  const live = !expiresAtMs || expiresAtMs > Date.now();
  const status = !live ? 'expired'
    : sub.billing_issues_detected_at ? 'past_due'
    : sub.period_type === 'trial' ? 'trialing' : 'active';
  await applyApplePlan(db, uid, {
    status, expiresAtMs, cancelAtPeriodEnd: !!sub.unsubscribe_detected_at,
    productId: ent.product_identifier, eventSec: Math.floor(Date.now() / 1000), environment: sub.is_sandbox ? 'SANDBOX' : 'PRODUCTION',
  });
  return { synced: true, plus: live };
}
