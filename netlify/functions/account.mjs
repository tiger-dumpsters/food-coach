// POST /.netlify/functions/account
// Body: { action: 'delete', confirm: 'DELETE' }
// Permanently deletes the person's account: their log, chat, photos, settings,
// household membership, invite links, flags, usage, any Plus subscription, and the
// sign-in itself. Required by Apple for App Store apps, and the right thing to offer.

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';
import { stripe } from './lib/stripe.mjs';
import { monitored, reportError } from './lib/monitor.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SUBCOLLECTIONS = ['messages', 'meals', 'workouts', 'checkins', 'weighins', 'foods', 'push'];

async function deleteQuery(q) {
  const snap = await q.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  return snap.docs.length;
}

async function deleteDocDeep(db, ref, subs = SUBCOLLECTIONS) {
  if (typeof db.recursiveDelete === 'function') return db.recursiveDelete(ref);
  for (const c of subs) {
    // Page through in chunks so big logs don't time out.
    while (await deleteQuery(ref.collection(c).limit(400)) === 400) { /* keep going */ }
  }
  await ref.delete();
}

export async function deleteAccount(db, auth, uid) {
  const userRef = db.collection('users').doc(uid);
  const profile = (await userRef.get()).data() || {};

  // 1. Stop billing first, so nobody is charged for a deleted account.
  if (profile.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY && profile.planStatus !== 'canceled') {
    try { await stripe(`subscriptions/${profile.stripeSubscriptionId}`, {}, 'DELETE'); }
    catch (err) { if (!/No such subscription/i.test(err.message)) throw err; }
  }
  if (profile.stripeCustomerId) await db.collection('stripeCustomers').doc(profile.stripeCustomerId).delete();

  // 2. Leave the household (delete it if they were the last member).
  if (profile.householdId) {
    const hRef = db.collection('households').doc(profile.householdId);
    const h = await hRef.get();
    if (h.exists) {
      const members = (h.data().members || []).filter((m) => m !== uid);
      if (members.length) await hRef.update({ members, [`names.${uid}`]: FieldValue.delete() });
      else await deleteDocDeep(db, hRef, ['foods']);
    }
  }

  // 3. Invite links and codes they made, flags they sent, their usage counter.
  await deleteQuery(db.collection('accessInvites').where('by', '==', uid));
  await deleteQuery(db.collection('invites').where('createdBy', '==', uid));
  await deleteQuery(db.collection('flags').where('uid', '==', uid));
  await db.collection('usage').doc(uid).delete();

  // 4. Their whole log and profile.
  await deleteDocDeep(db, userRef);

  // 5. The sign-in itself.
  try { await auth.deleteUser(uid); } catch (err) { if (err.code !== 'auth/user-not-found') throw err; }
}

const handler = async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req, { allowNoAccess: true });
  if (who.error) return json(who.status, { error: who.error });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  if (body.action !== 'delete') return json(400, { error: 'Unknown action' });
  if (body.confirm !== 'DELETE') return json(400, { error: 'Type DELETE to confirm.' });
  const { db, auth } = admin();
  try {
    await deleteAccount(db, auth, who.uid);
  } catch (err) {
    await reportError(err, { where: 'account-delete' });
    return json(500, { error: "Something went wrong deleting your account. Nothing was charged. Please try again, or email hello@gethungerhush.com." });
  }
  return json(200, { deleted: true });
};

export default monitored('account', handler);
