// POST /.netlify/functions/household
// Body: { action: 'invite' | 'join' | 'leave', code? }
// Links accounts into a household. Each member keeps their own private log; the household
// shares a pantry, a food library (consistent numbers) and meals logged "for both of us".

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';

const MAX_MEMBERS = 6;
const INVITE_HOURS = 72;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function newCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}

function firstName(profile, who) {
  const n = String(profile?.name || who.name || '').trim().split(/\s+/)[0];
  if (n) return n;
  const local = who.email.split('@')[0].split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : 'Member';
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  const { db } = admin();
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }

  const userRef = db.collection('users').doc(who.uid);
  const profile = (await userRef.get()).data() || {};
  const name = firstName(profile, who);

  if (body.action === 'invite') {
    let hid = profile.householdId;
    if (!hid) {
      const ref = await db.collection('households').add({
        members: [who.uid], names: { [who.uid]: name }, pantry: profile.staples || [],
        createdBy: who.uid, createdAt: FieldValue.serverTimestamp(),
      });
      hid = ref.id;
      await userRef.set({ householdId: hid }, { merge: true });
    }
    const code = newCode();
    await db.collection('invites').doc(code).set({
      householdId: hid, createdBy: who.uid, createdByName: name,
      expiresAt: new Date(Date.now() + INVITE_HOURS * 3600e3),
    });
    return json(200, { code, householdId: hid, expiresInHours: INVITE_HOURS });
  }

  if (body.action === 'join') {
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) return json(400, { error: 'Codes are 6 characters.' });
    if (profile.householdId) return json(409, { error: 'Leave your current household first.' });
    const invRef = db.collection('invites').doc(code);
    try {
      const result = await db.runTransaction(async (tx) => {
        const inv = await tx.get(invRef);
        if (!inv.exists) throw new Error('That code didn\'t work. Ask for a new one.');
        const { householdId, expiresAt } = inv.data();
        const exp = expiresAt?.toDate ? expiresAt.toDate() : new Date(expiresAt);
        if (exp < new Date()) throw new Error('That code has expired. Ask for a new one.');
        const hRef = db.collection('households').doc(householdId);
        const h = await tx.get(hRef);
        if (!h.exists) throw new Error('That household no longer exists.');
        const data = h.data();
        if ((data.members || []).length >= MAX_MEMBERS) throw new Error('That household is full.');
        const pantry = [...(data.pantry || [])];
        for (const item of profile.staples || []) {
          if (!pantry.some((p) => p.toLowerCase() === String(item).toLowerCase())) pantry.push(item);
        }
        tx.update(hRef, {
          members: FieldValue.arrayUnion(who.uid),
          [`names.${who.uid}`]: name,
          pantry,
        });
        tx.set(userRef, { householdId }, { merge: true });
        tx.delete(invRef);
        return { householdId, invitedBy: inv.data().createdByName };
      });
      return json(200, result);
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  if (body.action === 'leave') {
    const hid = profile.householdId;
    if (!hid) return json(200, { ok: true });
    const hRef = db.collection('households').doc(hid);
    await db.runTransaction(async (tx) => {
      const h = await tx.get(hRef);
      if (h.exists) {
        const members = (h.data().members || []).filter((m) => m !== who.uid);
        if (members.length) tx.update(hRef, { members, [`names.${who.uid}`]: FieldValue.delete() });
        else tx.delete(hRef);
      }
      tx.update(userRef, { householdId: FieldValue.delete() });
    });
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action' });
};
