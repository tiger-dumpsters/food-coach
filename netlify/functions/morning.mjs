// Scheduled hourly. On Mondays and holidays, drops one short, supportive note into each
// active user's chat, in their morning (first run between 7 am and 2 pm their time).

import { FieldValue } from 'firebase-admin/firestore';
import { admin } from './lib/admin.mjs';
import { occasionFor } from './lib/occasions.mjs';
import { makeClock, dayMinus } from './chat.mjs';
import { totals } from './lib/prompt.mjs';
import { sendToUser } from './lib/push.mjs';

const MODEL = process.env.MODEL_FAST || 'claude-haiku-5-5';
const ACTIVE_DAYS = 14;

const SYSTEM = `You write a short morning note from a supportive food coach, shown in the user's chat. 1–3 sentences, warm and genuine, like a friend — never preachy or over-the-top, no emoji.
- Mention the occasion naturally.
- If the facts show they've been consistent or eating well, say so specifically (e.g. "you've logged every day this week", "lots of whole foods lately"). Never mention weight, calories or targets.
- Holidays: tell them to enjoy it and the food that comes with it. Logging is optional ("log if you get the chance"). No talk of restraint, portions, "being good" or making up for it later.
- Mondays: fresh-week energy, light and encouraging. No advice or to-dos.
Reply with the note only.`;

export function factsFor(name, occasion, meals, profile, today) {
  const days = [1, 2, 3].map((i) => dayMinus(today, i));
  const byDay = days.map((d) => meals.filter((m) => m.day === d));
  const logged = byDay.filter((x) => x.length).length;
  const tg = profile.targets || {};
  const proteinHits = tg.protein_g ? byDay.filter((x) => x.length && totals(x).protein_g >= tg.protein_g * 0.9).length : 0;
  const mix = { whole: 0, total: 0 };
  for (const m of byDay.flat()) {
    const pm = m.processing_mix;
    if (pm) { mix.whole += pm.whole || 0; mix.total += Object.values(pm).reduce((a, b) => a + b, 0); }
  }
  const wholePct = mix.total ? Math.round((mix.whole / mix.total) * 100) : null;
  return [
    `Name: ${name}`,
    `Occasion: ${occasion.kind === 'holiday' ? `${occasion.name} (holiday)` : 'Monday, start of the week'}`,
    `Days logged in the last 3: ${logged}`,
    proteinHits ? `Days they hit their protein goal in the last 3: ${proteinHits}` : '',
    wholePct != null && wholePct >= 60 ? `Share of recent calories from whole foods: ${wholePct}%` : '',
  ].filter(Boolean).join('\n');
}

function fallback(name, occasion) {
  return occasion.kind === 'holiday'
    ? `Happy ${occasion.name}, ${name}! Enjoy the day and the food that comes with it. Log if you get the chance.`
    : `Morning, ${name}. New week, fresh start. I'm here whenever you want to log or need an idea.`;
}

async function writeNote(facts, name, occasion) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content: facts }] }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    const text = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return text || fallback(name, occasion);
  } catch (err) {
    console.error('morning note fallback', err.message);
    return fallback(name, occasion);
  }
}

export async function runMorning(now = new Date()) {
  const { db } = admin();
  const users = await db.collection('users').where('onboarded', '==', true).get();
  const sent = [];
  await Promise.all(users.docs.map(async (u) => {
    const p = u.data();
    if (p.morning_notes === false) return;
    const clock = makeClock(p.tz || 'America/New_York', now);
    const hour = Math.floor(clock.localMinutes / 60);
    if (hour < 7 || hour >= 14) return;
    if (p.lastMorningNote === clock.day) return;
    const occasion = occasionFor(clock.day);
    if (!occasion) return;
    const ref = db.collection('users').doc(u.id);
    const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
    let last = toDate(p.lastActiveAt);
    if (!last) { // older accounts: use their latest message
      const m = await ref.collection('messages').orderBy('createdAt', 'desc').limit(1).get();
      last = m.docs.length ? toDate(m.docs[0].data().createdAt) : null;
    }
    if (!last || now - last > ACTIVE_DAYS * 864e5) return;

    await ref.set({ lastMorningNote: clock.day }, { merge: true }); // claim first: no double notes
    const name = String(p.name || 'there').split(/\s+/)[0];
    const meals = (await ref.collection('meals').where('day', '>=', dayMinus(clock.day, 3)).get()).docs.map((d) => d.data());
    const text = await writeNote(factsFor(name, occasion, meals, p, clock.day), name, occasion);
    await ref.collection('messages').add({
      role: 'assistant', text, kind: 'morning', entries: [], day: clock.day, createdAt: FieldValue.serverTimestamp(),
    });
    if (p.push_enabled) {
      await sendToUser(db, u.id, { title: occasion.kind === 'holiday' ? `Happy ${occasion.name.replace(/^the /, '')}` : 'Good morning', body: text, tag: `morning-${clock.day}` })
        .catch((err) => console.error('morning push', err.message));
    }
    sent.push(u.id);
  }));
  return sent;
}

export default async () => {
  const sent = await runMorning();
  console.log(`morning notes sent: ${sent.length}`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: '@hourly' };
