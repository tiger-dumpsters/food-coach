// POST /.netlify/functions/access
// Body: { action: 'status' | 'redeem' | 'invite', code? }
// Invite links: anyone with access can make a personal link (?invite=CODE). A friend who
// signs in through it gets access. A household invite code also grants access (household.mjs).

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USES_PER_LINK = Number(process.env.INVITES_PER_USER || 25);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function newCode() {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}

export async function grantAccess(db, uid, invitedBy) {
  await db.collection('users').doc(uid).set({ access: true, ...(invitedBy ? { invitedBy } : {}), accessAt: FieldValue.serverTimestamp() }, { merge: true });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req, { allowNoAccess: true });
  if (who.error) return json(who.status, { error: who.error });
  const { db } = admin();
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const userRef = db.collection('users').doc(who.uid);

  if (body.action === 'status') {
    // Original testers on the email list get access recorded, so the list can be retired later.
    if (who.hasAccess) {
      const snap = await userRef.get();
      if (!snap.exists || snap.data().access !== true) await grantAccess(db, who.uid, null);
    }
    return json(200, { access: who.hasAccess });
  }

  if (body.action === 'redeem') {
    if (who.hasAccess) return json(200, { access: true });
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const master = (process.env.BETA_CODE || '').toUpperCase();
    if (master && code === master) {
      await grantAccess(db, who.uid, 'beta-code');
      return json(200, { access: true });
    }
    const ref = db.collection('accessInvites').doc(code || '-');
    try {
      const by = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!code || !snap.exists) throw new Error("That invite link didn't work. Ask your friend for a new one.");
        const inv = snap.data();
        if ((inv.uses || 0) >= (inv.max || USES_PER_LINK)) throw new Error('That invite link has been used up. Ask for a new one.');
        tx.update(ref, { uses: (inv.uses || 0) + 1 });
        return inv.by;
      });
      await grantAccess(db, who.uid, by);
      return json(200, { access: true });
    } catch (err) {
      return json(400, { error: err.message, access: false });
    }
  }

  if (body.action === 'invite') {
    if (!who.hasAccess) return json(403, { error: 'This beta is invite-only.' });
    const profile = (await userRef.get()).data() || {};
    let code = profile.inviteCode;
    if (code) {
      const snap = await db.collection('accessInvites').doc(code).get();
      if (snap.exists) {
        const inv = snap.data();
        return json(200, { code, left: Math.max(0, (inv.max || USES_PER_LINK) - (inv.uses || 0)) });
      }
    }
    code = newCode();
    await db.collection('accessInvites').doc(code).set({ by: who.uid, byName: String(profile.name || who.name || '').split(/\s+/)[0], uses: 0, max: USES_PER_LINK, createdAt: FieldValue.serverTimestamp() });
    await userRef.set({ inviteCode: code }, { merge: true });
    return json(200, { code, left: USES_PER_LINK });
  }

  return json(400, { error: 'Unknown action' });
};
