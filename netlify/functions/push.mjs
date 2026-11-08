// POST /.netlify/functions/push
// Body: { action: 'key' | 'subscribe' | 'unsubscribe' | 'test', subscription? }

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';
import { getVapid, subId, sendToUser } from './lib/push.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  const { db } = admin();
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const subs = db.collection('users').doc(who.uid).collection('push');

  if (body.action === 'key') return json(200, { publicKey: (await getVapid(db)).publicKey });

  if (body.action === 'subscribe') {
    const s = body.subscription;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json(400, { error: 'Bad subscription' });
    await subs.doc(subId(s.endpoint)).set({
      subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      userAgent: String(req.headers.get('user-agent') || '').slice(0, 200), createdAt: FieldValue.serverTimestamp(),
    });
    await db.collection('users').doc(who.uid).set({ push_enabled: true }, { merge: true });
    return json(200, { ok: true });
  }

  if (body.action === 'unsubscribe') {
    if (body.subscription?.endpoint) await subs.doc(subId(body.subscription.endpoint)).delete();
    const left = await subs.get();
    if (!left.docs.length) await db.collection('users').doc(who.uid).set({ push_enabled: false }, { merge: true });
    return json(200, { ok: true });
  }

  if (body.action === 'test') {
    const sent = await sendToUser(db, who.uid, { title: 'HungerHush', body: "Notifications are on. I'll only ping you for the good stuff.", tag: 'test' });
    return json(200, { sent });
  }

  return json(400, { error: 'Unknown action' });
};
