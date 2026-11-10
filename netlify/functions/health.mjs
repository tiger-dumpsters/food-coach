// GET /.netlify/functions/health  (also /health)
// For an uptime monitor: 200 when the server can reach the database and has its keys,
// 503 otherwise. Reveals nothing private.

import { admin } from './lib/admin.mjs';

export default async () => {
  const checks = {
    keys: !!(process.env.ANTHROPIC_API_KEY && process.env.FIREBASE_SERVICE_ACCOUNT),
    database: false,
  };
  try {
    const { db } = admin();
    await Promise.race([
      db.collection('config').doc('health').get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    checks.database = true;
  } catch { /* stays false */ }
  const ok = Object.values(checks).every(Boolean);
  return new Response(JSON.stringify({ ok, checks }), {
    status: ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
