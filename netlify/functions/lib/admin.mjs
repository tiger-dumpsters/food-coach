// Shared Firebase Admin setup and request auth for the Netlify functions.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export function admin() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(sa) });
  }
  return { auth: getAuth(), db: getFirestore() };
}

// Verify the Firebase ID token and beta access.
// Access: email on ALLOWED_EMAILS (original testers), or users/{uid}.access === true
// (granted by an invite link or a household invite), or OPEN_SIGNUP=true for everyone.
// { allowNoAccess: true } lets a signed-in user through without access (to redeem an invite).
// Returns { uid, email, name, hasAccess } or { status, error }.
export async function verify(req, { allowNoAccess = false } = {}) {
  const { auth, db } = admin();
  let decoded;
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    decoded = await auth.verifyIdToken(token);
  } catch {
    return { status: 401, error: 'Not signed in' };
  }
  const email = (decoded.email || '').toLowerCase();
  const who = { uid: decoded.uid, email, name: decoded.name || '' };
  who.hasAccess = await hasAccess(db, who);
  if (!who.hasAccess && !allowNoAccess) return { status: 403, error: 'This beta is invite-only.', code: 'no_access' };
  return who;
}

async function hasAccess(db, { uid, email }) {
  if (process.env.OPEN_SIGNUP === 'true') return true;
  const allowed = (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(email)) return true;
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists && snap.data().access === true;
}

// Per-person daily message cap (a safety net on API spend). Stored server-only in usage/{uid}.
export async function underDailyCap(db, uid, day) {
  const cap = Number(process.env.DAILY_MESSAGE_CAP || 150);
  const ref = db.collection('usage').doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const count = d.day === day ? (d.count || 0) : 0;
    if (count >= cap) return false;
    tx.set(ref, { day, count: count + 1 }, { merge: true });
    return true;
  });
}
