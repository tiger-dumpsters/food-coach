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

// Verify the Firebase ID token and the beta allowlist.
// Returns { uid, email, name } or { status, error }.
export async function verify(req) {
  const { auth } = admin();
  let decoded;
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    decoded = await auth.verifyIdToken(token);
  } catch {
    return { status: 401, error: 'Not signed in' };
  }
  const email = (decoded.email || '').toLowerCase();
  const allowed = (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) return { status: 403, error: 'This beta is invite-only.' };
  return { uid: decoded.uid, email, name: decoded.name || '' };
}
