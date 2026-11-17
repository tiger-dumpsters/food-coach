// POST /.netlify/functions/nudge
// { action: 'hunger', level: 1-5, messageId? }  one-tap answer to a hunger check
// { action: 'settings', nudge_level: 'off' | 'light' | 'more' }

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';
import { makeClock } from './chat.mjs';
import { monitored } from './lib/monitor.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const handler = async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const { db } = admin();
  const userRef = db.collection('users').doc(who.uid);

  if (body.action === 'settings') {
    if (!['off', 'light', 'more'].includes(body.nudge_level)) return json(400, { error: 'Unknown setting' });
    await userRef.set({ nudge_level: body.nudge_level }, { merge: true });
    return json(200, { ok: true, nudge_level: body.nudge_level });
  }

  if (body.action === 'hunger') {
    const level = Number(body.level);
    if (!(level >= 1 && level <= 5 && Number.isInteger(level))) return json(400, { error: 'Pick 1 to 5.' });
    const profile = (await userRef.get()).data() || {};
    const clock = makeClock(typeof body.tz === 'string' ? body.tz : profile.tz);
    let msgRef = null, after = null;
    if (typeof body.messageId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.messageId)) {
      msgRef = userRef.collection('messages').doc(body.messageId);
      const m = await msgRef.get();
      if (!m.exists || m.data().kind !== 'hungercheck') return json(404, { error: 'Not found' });
      if (m.data().answered) return json(200, { ok: true, already: true });
      after = m.data().hungerFor || null;
    }
    const ref = await userRef.collection('checkins').add({
      level, note: 'hunger check', source: 'nudge', ...(after ? { after_meal: after } : {}),
      day: clock.day, at: clock.now, createdAt: FieldValue.serverTimestamp(),
    });
    await Promise.all([
      msgRef ? msgRef.set({ answered: level, checkinId: ref.id }, { merge: true }) : null,
      userRef.set({ lastCheckinAt: clock.now }, { merge: true }),
    ]);
    return json(200, { ok: true, id: ref.id });
  }

  return json(400, { error: 'Unknown action' });
};

export default monitored('nudge', handler);
