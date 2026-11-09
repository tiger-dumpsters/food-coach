// Web Push (works on iPhone for home-screen apps, iOS 16.4+, and on Android/desktop).
// The app makes its own VAPID keys on first use and keeps them in config/vapid, which
// only the server can read. Subscriptions live in users/{uid}/push/{id}.

import webpush from 'web-push';
import { createHash } from 'node:crypto';

const SUBJECT = process.env.VAPID_SUBJECT || 'https://gethungerhush.com';
let cached = null;

export async function getVapid(db) {
  if (cached) return cached;
  const ref = db.collection('config').doc('vapid');
  cached = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().publicKey) return snap.data();
    const keys = webpush.generateVAPIDKeys();
    tx.set(ref, { ...keys, createdAt: new Date() });
    return keys;
  });
  return cached;
}

export function subId(endpoint) {
  return createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 32);
}

// Send to every device the user turned notifications on for. Dead subscriptions are removed.
// Phone-app devices (iPhone) get notifications through Firebase Cloud Messaging.
async function sendNative(token, { title, body, url, tag }) {
  const { getMessaging } = await import('firebase-admin/messaging');
  return getMessaging().send({
    token,
    notification: { title, body: String(body || '').slice(0, 240) },
    data: { url: String(url || '/app'), tag: String(tag || '') },
    apns: { payload: { aps: { sound: 'default', 'thread-id': String(tag || 'hungerhush') } } },
  });
}

export async function sendToUser(db, uid, { title, body, url = '/', tag }) {
  const subs = await db.collection('users').doc(uid).collection('push').get();
  if (!subs.docs.length) return 0;
  const { publicKey, privateKey } = await getVapid(db);
  const payload = JSON.stringify({ title, body: String(body || '').slice(0, 240), url, tag });
  let sent = 0;
  await Promise.all(subs.docs.map(async (d) => {
    const sub = d.data();
    if (sub.fcmToken) {
      try { await sendNative(sub.fcmToken, { title, body, url, tag }); sent++; }
      catch (err) {
        if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(err.code || '')) await d.ref.delete();
        else console.error('native push failed', err.code || err.message);
      }
      return;
    }
    try {
      await webpush.sendNotification(sub.subscription, payload, {
        vapidDetails: { subject: SUBJECT, publicKey, privateKey }, TTL: 6 * 3600,
      });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await d.ref.delete();
      else console.error('push failed', err.statusCode, err.body || err.message);
    }
  }));
  return sent;
}
