// A whole-app daily ceiling on Claude spending, so a bug, a bad actor, or a busy day
// can't run up the bill. Every Claude call records its estimated cost in
// spend/{UTC day}; once the day's total passes DAILY_SPEND_LIMIT_USD (default $15),
// the coach pauses until tomorrow and the admins get a phone alert.
//
// Prices are per million tokens and only used for this estimate. Override with
// PRICE_FAST / PRICE_SMART as "input,output" (e.g. "1,5") if Anthropic's prices change.

import { FieldValue } from 'firebase-admin/firestore';

function prices(model) {
  const smart = /sonnet|opus/i.test(model);
  const env = smart ? process.env.PRICE_SMART : process.env.PRICE_FAST;
  const [inp, out] = (env || (smart ? '3,15' : '1,5')).split(',').map(Number);
  return { inp, out, cacheRead: inp * 0.1, cacheWrite: inp * 1.25 };
}

export function costOf(model, usage = {}) {
  const p = prices(model);
  return ((usage.input_tokens || 0) * p.inp + (usage.output_tokens || 0) * p.out
    + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}

const dayKey = () => new Date().toISOString().slice(0, 10);
export const dailyLimit = () => Number(process.env.DAILY_SPEND_LIMIT_USD || 15);

export async function spendAllowed(db) {
  const snap = await db.collection('spend').doc(dayKey()).get();
  return (snap.exists ? snap.data().usd || 0 : 0) < dailyLimit();
}

export async function addSpend(db, model, usage, source = 'chat') {
  const usd = costOf(model, usage);
  if (!usd) return 0;
  await db.collection('spend').doc(dayKey()).set({
    usd: FieldValue.increment(usd),
    by: { [source]: FieldValue.increment(usd) },
    calls: FieldValue.increment(1),
  }, { merge: true });
  return usd;
}

export const BUDGET_MESSAGE = "The coach is taking a short break, so I couldn't log that. Your message is still here; please send it again in a little while. Sorry about that!";
