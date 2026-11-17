// Proactive coaching: a short idea before the person's usual meal times, and a
// "how's your hunger?" check a few hours after a real meal (answered with one tap in
// the chat). Runs every 15 minutes from nudge-scheduler.mjs.
//
// How much each person gets (profile nudge_level):
//   off   - nothing
//   light - (default) one meal idea a day, for their weakest meal, and one hunger check
//   more  - ideas before breakfast, lunch and dinner, and up to two hunger checks
// "Just log" people (coach_style quiet) default to off.

import { FieldValue } from 'firebase-admin/firestore';
import { makeClock, dayMinus } from '../chat.mjs';
import { spendAllowed, addSpend } from './spend.mjs';
import { sendToUser } from './push.mjs';

const MODEL = process.env.MODEL_FAST || 'claude-haiku-5-5';
const SLOTS = ['breakfast', 'lunch', 'dinner'];
const DEFAULT_TIMES = { breakfast: 7 * 60 + 45, lunch: 12 * 60 + 15, dinner: 18 * 60 + 30 };
const LEAD = { from: 40, to: 15 }; // send between 40 and 15 minutes before the usual time
const HUNGER_AFTER = { from: 150, to: 200 }; // minutes after a meal
const ACTIVE_DAYS = 14;

const toDate = (v) => (v?.toDate ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null);

export function nudgeLevel(p) {
  if (['off', 'light', 'more'].includes(p?.nudge_level)) return p.nudge_level;
  return p?.coach_style === 'quiet' ? 'off' : 'light';
}

function localMinutes(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

// Usual time for each meal (median of the last few weeks, needs 3+ examples), and the
// meal that's usually lightest on protein and fiber: that's where an idea helps most.
export function mealPlan(meals, tz) {
  const times = { ...DEFAULT_TIMES };
  const score = {};
  for (const slot of SLOTS) {
    const ms = meals.filter((m) => m.meal === slot && toDate(m.at));
    const mins = ms.map((m) => localMinutes(toDate(m.at), tz)).sort((a, b) => a - b);
    if (mins.length >= 3) times[slot] = mins[Math.floor(mins.length / 2)];
    if (ms.length >= 2) score[slot] = ms.reduce((a, m) => a + (m.protein_g || 0) / 25 + (m.fiber_g || 0) / 8, 0) / ms.length;
  }
  const scored = Object.entries(score).sort((a, b) => a[1] - b[1]);
  return { times, weakSlot: scored.length ? scored[0][0] : 'lunch' };
}

// Which nudges are due right now for this person. Pure: easy to test.
export function dueNudges(p, clock, now = clock.now) {
  const level = nudgeLevel(p);
  if (level === 'off') return [];
  const out = [];
  const mins = clock.localMinutes;
  const plan = p.nudgePlan?.day === clock.day ? p.nudgePlan : null;
  const sent = p.nudgeLog?.day === clock.day ? p.nudgeLog.sent || [] : [];
  if (plan) {
    const slots = level === 'more' ? SLOTS : [plan.weakSlot || 'lunch'];
    for (const slot of slots) {
      const t = plan.times?.[slot];
      if (t == null || sent.includes(slot)) continue;
      if (mins >= t - LEAD.from && mins <= t - LEAD.to) out.push({ kind: 'idea', slot });
    }
  }
  const m = p.lastMeal;
  const at = toDate(m?.at);
  if (m && at && mins >= 9 * 60 && mins <= 21 * 60) {
    const ago = (now - at) / 60000;
    const asked = sent.filter((s) => s.startsWith('hunger:'));
    const allowed = level === 'more' ? 2 : 1;
    const answeredSince = toDate(p.lastCheckinAt) > at;
    const realMeal = SLOTS.includes(m.slot) || (m.calories || 0) >= 300;
    if (ago >= HUNGER_AFTER.from && ago <= HUNGER_AFTER.to && realMeal && !answeredSince
      && asked.length < allowed && !asked.includes(`hunger:${m.id}`)) {
      out.push({ kind: 'hunger', mealId: m.id, desc: m.desc || 'your last meal' });
    }
  }
  return out;
}

const IDEA_SYSTEM = `You write short pre-meal ideas for HungerHush, a supportive food coach about staying full on real food.
For each of breakfast, lunch and dinner, write ONE idea under 120 characters, like a text from a friend that starts "Breakfast idea:", "Lunch idea:" or "Dinner idea:".
- Build on foods they actually eat and have on hand. Make it specific and easy.
- Aim it at staying full: pair protein with fiber. Frame it as an add or an easy swap, never a cut or a rule.
- Restrictions and allergies are absolute. Skip disliked foods.
- If they worked out today, the next meal can mention refueling. No calories, weight, numbers of grams or emoji.
Reply with JSON only: {"breakfast":"...","lunch":"...","dinner":"..."}`;

const FALLBACK = {
  breakfast: 'Breakfast idea: pair something with protein (eggs, Greek yogurt) with fruit or oats so it holds you till lunch.',
  lunch: 'Lunch idea: build it around a protein and add beans, veggies or a whole grain so it carries you through the afternoon.',
  dinner: 'Dinner idea: half the plate veggies, a palm of protein, and a scoop of beans, potatoes or rice. Filling and easy.',
};

export function ideaFacts(p, meals, workouts, day, pantry = []) {
  const counts = {};
  for (const m of meals) if (m.description) counts[m.description] = (counts[m.description] || 0) + 1;
  const often = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d]) => d);
  const bySlot = SLOTS.map((s) => {
    const ms = meals.filter((m) => m.meal === s);
    if (!ms.length) return null;
    const avg = (k) => Math.round(ms.reduce((a, m) => a + (m[k] || 0), 0) / ms.length);
    return `${s}: usually ~${avg('protein_g')} g protein, ~${avg('fiber_g')} g fiber`;
  }).filter(Boolean);
  const trained = workouts.filter((w) => w.day === day || w.day === dayMinus(day, 1)).map((w) => `${w.day === day ? 'today' : 'yesterday'} ${w.type}${w.duration_min ? ` ${w.duration_min} min` : ''}`);
  return [
    `Goals: ${(p.goals || []).join(', ') || 'eat better, feel full'}`,
    p.restrictions?.length ? `Restrictions: ${p.restrictions.join(', ')}` : '',
    p.allergies?.length ? `Allergies: ${p.allergies.join(', ')}` : '',
    p.dislikes?.length ? `Dislikes: ${p.dislikes.join(', ')}` : '',
    (pantry.length || p.staples?.length) ? `On hand: ${(pantry.length ? pantry : p.staples).slice(0, 30).join(', ')}` : '',
    often.length ? `Meals they often eat: ${often.join('; ')}` : '',
    bySlot.length ? `Recent meals: ${bySlot.join('; ')}` : '',
    trained.length ? `Workouts: ${trained.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

async function writeIdeas(db, facts) {
  if (!(await spendAllowed(db))) return { ...FALLBACK };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: IDEA_SYSTEM, messages: [{ role: 'user', content: facts }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    await addSpend(db, MODEL, data.usage, 'nudge').catch(() => {});
    const text = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const out = {};
    for (const s of SLOTS) out[s] = typeof parsed[s] === 'string' && parsed[s].trim() ? parsed[s].trim().slice(0, 200) : FALLBACK[s];
    return out;
  } catch (err) {
    console.error('nudge ideas fallback', err.message);
    return { ...FALLBACK };
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export async function runNudges(db, now = new Date()) {
  const users = await db.collection('users').where('onboarded', '==', true).get();
  const sent = [];
  await Promise.all(users.docs.map(async (u) => {
    try {
      const p = u.data();
      if (!p.push_enabled || nudgeLevel(p) === 'off') return;
      if (process.env.REQUIRE_AI_CONSENT !== 'false' && !p.aiConsentAt) return;
      const last = toDate(p.lastActiveAt);
      if (!last || now - last > ACTIVE_DAYS * 864e5) return;
      const clock = makeClock(p.tz || 'America/New_York', now);
      const ref = db.collection('users').doc(u.id);

      // Once a day, work out their usual meal times.
      let profile = p;
      if (p.nudgePlan?.day !== clock.day) {
        const meals = (await ref.collection('meals').where('day', '>=', dayMinus(clock.day, 21)).get()).docs.map((d) => d.data());
        const nudgePlan = { day: clock.day, ...mealPlan(meals, clock.tz), ideas: null };
        await ref.set({ nudgePlan }, { merge: true });
        profile = { ...p, nudgePlan };
      }

      for (const n of dueNudges(profile, clock, now)) {
        const key = n.kind === 'idea' ? n.slot : `hunger:${n.mealId}`;
        // Claim it first so an overlapping run can't send it twice.
        const claimed = await db.runTransaction(async (tx) => {
          const cur = (await tx.get(ref)).data() || {};
          const log = cur.nudgeLog?.day === clock.day ? cur.nudgeLog : { day: clock.day, sent: [] };
          if (log.sent.includes(key)) return false;
          tx.set(ref, { nudgeLog: { day: clock.day, sent: [...log.sent, key] } }, { merge: true });
          return true;
        });
        if (!claimed) continue;

        if (n.kind === 'idea') {
          // Nothing to suggest if they've already eaten that meal.
          const today = (await ref.collection('meals').where('day', '==', clock.day).get()).docs.map((d) => d.data());
          if (today.some((m) => m.meal === n.slot)) continue;
          let ideas = profile.nudgePlan.ideas;
          if (!ideas) {
            const [meals, workouts, hh] = await Promise.all([
              ref.collection('meals').where('day', '>=', dayMinus(clock.day, 14)).get(),
              ref.collection('workouts').where('day', '>=', dayMinus(clock.day, 1)).get(),
              p.householdId ? db.collection('households').doc(p.householdId).get() : null,
            ]);
            const pantry = hh?.exists ? (hh.data().pantry || []) : [];
            ideas = await writeIdeas(db, ideaFacts(p, meals.docs.map((d) => d.data()), workouts.docs.map((d) => d.data()), clock.day, pantry));
            await ref.set({ nudgePlan: { ideas } }, { merge: true });
            profile = { ...profile, nudgePlan: { ...profile.nudgePlan, ideas } };
          }
          const text = ideas[n.slot] || FALLBACK[n.slot];
          await ref.collection('messages').add({ role: 'assistant', text, kind: 'nudge', slot: n.slot, entries: [], day: clock.day, createdAt: FieldValue.serverTimestamp() });
          await sendToUser(db, u.id, { title: `${cap(n.slot)} idea`, body: text.replace(/^\w+ idea:\s*/i, ''), url: '/app', tag: `nudge-${clock.day}-${n.slot}` });
        } else {
          const text = `How's your hunger since ${n.desc}? Tap a number, or just tell me.`;
          await ref.collection('messages').add({ role: 'assistant', text, kind: 'hungercheck', hungerFor: n.mealId, entries: [], day: clock.day, createdAt: FieldValue.serverTimestamp() });
          await sendToUser(db, u.id, { title: "How's your hunger?", body: `About 3 hours since ${n.desc}. Tap to tell me.`, url: '/app', tag: `hunger-${n.mealId}` });
        }
        sent.push(`${u.id}:${key}`);
      }
    } catch (err) {
      console.error('nudge user failed', u.id, err.message);
    }
  }));
  return sent;
}
