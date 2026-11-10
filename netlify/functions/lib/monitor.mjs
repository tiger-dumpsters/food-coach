// Monitoring: phone alerts to the people running HungerHush, and error reports to Sentry.
//
// Alerts go to ADMIN_EMAILS (else ALLOWED_EMAILS) as push notifications, at most once an
// hour per kind. Error reports go to Sentry when SENTRY_DSN is set (Netlify env var); no
// SDK, just Sentry's public HTTP API. Nobody's chat text or food log is ever sent: only
// the error message, where it happened, and a stack trace.

import { sendToUser } from './push.mjs';

export async function alertAdmins(db, auth, title, body) {
  const ref = db.collection('config').doc('alerts');
  const last = (await ref.get()).data()?.[title] || 0;
  if (Date.now() - last < 60 * 60 * 1000) return 0;
  await ref.set({ [title]: Date.now() }, { merge: true });
  const emails = (process.env.ADMIN_EMAILS || process.env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  let sent = 0;
  for (const email of emails) {
    try { const u = await auth.getUserByEmail(email); sent += await sendToUser(db, u.uid, { title, body, url: '/app', tag: 'admin-alert' }); }
    catch (e) { console.error('alert', email, e.message); }
  }
  return sent;
}

// Count an error and alert once it happens `threshold` times within the hour, so one
// hiccup doesn't buzz your phone but a real outage does.
export async function countError(db, auth, kind, detail, threshold = 3) {
  const hour = new Date().toISOString().slice(0, 13);
  const ref = db.collection('errors').doc(`${hour}`);
  const n = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() || {};
    const next = (d[kind] || 0) + 1;
    tx.set(ref, { [kind]: next }, { merge: true });
    return next;
  });
  if (n >= threshold) await alertAdmins(db, auth, `HungerHush: ${kind}`, `${n} times in the last hour. Latest: ${String(detail || '').slice(0, 140)}`);
  return n;
}

function parseDsn(dsn) {
  const m = /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(String(dsn || '').trim());
  return m && { key: m[1], host: m[2], project: m[3] };
}

// Send one error to Sentry. Never throws, never waits more than 2 seconds.
export async function reportError(err, { where = 'server', tags = {} } = {}) {
  console.error(where, err?.message || err);
  const d = parseDsn(process.env.SENTRY_DSN);
  if (!d) return false;
  const id = crypto.randomUUID().replace(/-/g, '');
  const event = {
    event_id: id, timestamp: Date.now() / 1000, platform: 'node', level: 'error',
    environment: process.env.CONTEXT || 'production', release: process.env.COMMIT_REF?.slice(0, 7),
    tags: { function: where, ...tags },
    exception: { values: [{ type: err?.name || 'Error', value: String(err?.message || err).slice(0, 500) }] },
    extra: { stack: String(err?.stack || '').slice(0, 4000) },
  };
  const body = `${JSON.stringify({ event_id: id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
  try {
    const res = await fetch(`https://${d.host}/api/${d.project}/envelope/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${d.key}, sentry_client=hungerhush/1.0` },
      body, signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch { return false; }
}

// Wrap a function so an unexpected crash is reported to Sentry and the person gets a
// clean error instead of a blank failure.
export function monitored(name, handler) {
  return async (req, context) => {
    try { return await handler(req, context); }
    catch (err) {
      await reportError(err, { where: name });
      return new Response(JSON.stringify({ error: 'Something went wrong on our end. Please try again.' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
  };
}
