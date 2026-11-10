// POST /.netlify/functions/health-sync
// Body: { workouts: [{ id, type, start, end, durationSec, kcal, meters, source }], tz }
// Workouts read from Apple Health on the phone. Each is saved once (keyed by its
// HealthKit ID) into the person's workout log, where the coach and Trends see it.

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';
import { monitored } from './lib/monitor.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Apple Health workout types -> the categories the app already uses.
const MAP = {
  walking: 'Walking', running: 'Running', runningTreadmill: 'Running', trackAndField: 'Running',
  cycling: 'Cycling', bikingStationary: 'Cycling', handCycling: 'Cycling',
  traditionalStrengthTraining: 'Traditional Strength Training', strengthTraining: 'Traditional Strength Training', weightlifting: 'Traditional Strength Training',
  functionalStrengthTraining: 'Functional Strength Training', crossTraining: 'Functional Strength Training', coreTraining: 'Functional Strength Training',
  bootCamp: 'Functional Strength Training', calisthenics: 'Functional Strength Training',
  highIntensityIntervalTraining: 'HIIT', yoga: 'Yoga',
  swimming: 'Swimming', swimmingPool: 'Swimming', swimmingOpenWater: 'Swimming',
  elliptical: 'Elliptical', rowing: 'Rowing', rowingMachine: 'Rowing', hiking: 'Hiking',
};
const readable = (t) => String(t || 'workout').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

export function toEntry(w, tz) {
  const start = new Date(w.start);
  if (!w.id || Number.isNaN(start.getTime())) return null;
  const type = MAP[w.type] || 'Other';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(start);
  const entry = {
    type, day, at: start, source: 'apple_health',
    duration_min: Math.max(1, Math.round((Number(w.durationSec) || 0) / 60)),
    healthId: String(w.id).slice(0, 80),
    device: w.source ? String(w.source).slice(0, 60) : undefined,
    notes: type === 'Other' ? readable(w.type) : undefined,
  };
  if (Number(w.kcal) > 0) entry.calories = Math.round(Number(w.kcal));
  if (Number(w.meters) > 0) { entry.distance = Math.round((Number(w.meters) / 1609.344) * 100) / 100; entry.distance_unit = 'mi'; }
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  return entry;
}

const handler = async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const list = Array.isArray(body.workouts) ? body.workouts.slice(0, 200) : [];
  const { db } = admin();
  const userRef = db.collection('users').doc(who.uid);
  const tz = typeof body.tz === 'string' ? body.tz : (await userRef.get()).data()?.tz;

  const entries = list.map((w) => toEntry(w, tz)).filter(Boolean);
  const refs = entries.map((e) => userRef.collection('workouts').doc(`hk_${e.healthId.replace(/[^A-Za-z0-9-]/g, '')}`));
  const existing = await Promise.all(refs.map((r) => r.get()));
  let added = 0;
  await Promise.all(entries.map((e, i) => {
    if (existing[i].exists) return null;
    added++;
    return refs[i].set({ ...e, createdAt: FieldValue.serverTimestamp() });
  }));
  await userRef.set({ health_connected: true, healthSyncedAt: FieldValue.serverTimestamp() }, { merge: true });
  return json(200, { added, seen: entries.length });
};

export default monitored('health-sync', handler);
