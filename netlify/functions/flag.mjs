// POST /.netlify/functions/flag
// Body: { messageId, note }
// A tester flags a coach reply. Saves a review copy (the reply, the few messages before
// it, what was saved, and the tester's note) to flags/{id}, which only admins can read
// in the Firebase console.

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const toIso = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v || null);

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  const { db } = admin();
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const id = String(body.messageId || '');
  const note = String(body.note || '').trim().slice(0, 2000);
  if (!id) return json(400, { error: 'Missing message' });

  const msgs = db.collection('users').doc(who.uid).collection('messages');
  const target = await msgs.doc(id).get();
  if (!target.exists) return json(404, { error: 'Message not found' });
  const t = target.data();

  // The reply plus the 8 messages before it, oldest first. No photos (thumbnails stay private).
  const before = await msgs.where('createdAt', '<=', t.createdAt).orderBy('createdAt', 'desc').limit(9).get();
  const transcript = before.docs.reverse().map((d) => {
    const m = d.data();
    return {
      id: d.id, role: m.role, text: m.text || '', at: toIso(m.createdAt), photo: !!m.photo,
      entries: (m.entries || []).map((e) => ({ kind: e.kind, description: e.description, calories: e.calories, deleted: !!e.deleted })),
      model: m.model || null, error: m.error || null,
    };
  });

  const ref = await db.collection('flags').add({
    uid: who.uid, email: who.email, name: who.name || '', note, messageId: id,
    reply: t.text || '', model: t.model || null, transcript,
    status: 'open', createdAt: FieldValue.serverTimestamp(),
  });
  await msgs.doc(id).set({ flagged: true, flagNote: note }, { merge: true });
  return json(200, { ok: true, flagId: ref.id });
};
