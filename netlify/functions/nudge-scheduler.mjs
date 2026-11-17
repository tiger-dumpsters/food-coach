// Scheduled every 15 minutes: pre-meal ideas and hunger checks (see lib/nudges.mjs).

import { admin } from './lib/admin.mjs';
import { runNudges } from './lib/nudges.mjs';
import { reportError, alertAdmins } from './lib/monitor.mjs';

export default async () => {
  const { db, auth } = admin();
  try {
    const sent = await runNudges(db);
    if (sent.length) console.log(`nudges sent: ${sent.length}`);
  } catch (err) {
    await reportError(err, { where: 'nudge-scheduler' });
    await alertAdmins(db, auth, 'HungerHush: coaching nudges failed', err.message).catch(() => {});
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: '*/15 * * * *' };
