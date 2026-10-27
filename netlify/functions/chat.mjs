// POST /.netlify/functions/chat
// Body: { text: string, tz: "America/New_York" }
// Header: Authorization: Bearer <Firebase ID token>
//
// Verifies the user, loads their context from Firestore, lets Claude log entries via
// tools, saves both chat messages, and returns the reply plus the entries it logged.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { TOOLS, runTool, foodKey } from './lib/tools.mjs';
import { buildSystem, totals } from './lib/prompt.mjs';

const MODEL_FAST = process.env.MODEL_FAST || 'claude-haiku-5-5';
const MODEL_SMART = process.env.MODEL_SMART || 'claude-sonnet-5-5';
const MAX_ROUNDS = 8;
const MAX_TOKENS = 8000;
const TIME_BUDGET_MS = 50_000; // stay under Netlify's function limit
const LONG_PASTE = 1500;       // chars; treated as a bulk import

function admin() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(sa) });
  }
  return { auth: getAuth(), db: getFirestore() };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Local calendar info for the user's timezone.
export function makeClock(tz, now = new Date()) {
  let zone = tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'America/New_York'; }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
    }).formatToParts(now).map(p => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const h = Number(parts.hour), m = Number(parts.minute);
  return { now, tz: zone, day, weekday: parts.weekday, hhmm: `${parts.hour}:${parts.minute}`, localMinutes: h * 60 + m };
}

export function dayMinus(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function localHHMM(date, tz) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function rows(snap, tz) {
  return snap.docs.map(d => {
    const v = d.data();
    const at = v.at?.toDate ? v.at.toDate() : v.at ? new Date(v.at) : null;
    return { id: d.id, ...v, at, localTime: localHHMM(at, tz) };
  });
}

// Questions and planning go to the stronger model; plain logging to the fast one.
export function pickModel(text, onboarded) {
  if (!onboarded) return MODEL_SMART;
  // A long pasted log is mostly transcription; the fast model handles it quicker.
  if (text.length > LONG_PASTE) return MODEL_FAST;
  const t = text.toLowerCase();
  if (t.includes('?')) return MODEL_SMART;
  if (/\b(what|why|how|should|could|would|can i|recommend|suggest|plan|idea|ideas|help|hungry|starving|snacky|craving|week|month|trend|progress|stuck)\b/.test(t)) return MODEL_SMART;
  return MODEL_FAST;
}

async function callClaude({ model, system, messages }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, temperature: 0, system, tools: TOOLS, messages }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// Turn saved chat history into alternating user/assistant turns.
function historyToMessages(history) {
  const out = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    let text = (h.text || '').trim();
    if (!text || h.failed || text === '…') continue;
    // Earlier long pastes were already handled (or failed); don't let the model redo them.
    if (role === 'user' && text.length > LONG_PASTE) {
      text = `${text.slice(0, 200)}… [long pasted log from earlier, ${text.length} chars — already handled; do not log it again unless the user pastes it again]`;
    }
    const last = out.at(-1);
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let uid, email;
  const { auth, db } = admin();
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const decoded = await auth.verifyIdToken(token);
    uid = decoded.uid;
    email = (decoded.email || '').toLowerCase();
  } catch {
    return json(401, { error: 'Not signed in' });
  }

  const allowed = (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    return json(403, { error: 'This beta is invite-only.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!text) return json(400, { error: 'Empty message' });

  const clock = makeClock(body.tz);
  const userRef = db.collection('users').doc(uid);
  const weekStart = dayMinus(clock.day, 13); // 2 weeks: hunger patterns need repeats

  const [profileSnap, histSnap, mealsSnap, workoutsSnap, checkinsSnap, weightsSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('messages').orderBy('createdAt', 'desc').limit(20).get(),
    userRef.collection('meals').where('day', '>=', weekStart).get(),
    userRef.collection('workouts').where('day', '>=', weekStart).get(),
    userRef.collection('checkins').where('day', '>=', weekStart).get(),
    userRef.collection('weighins').orderBy('at', 'desc').limit(7).get(),
  ]);

  const profile = profileSnap.exists ? profileSnap.data() : null;
  if (!profileSnap.exists) {
    await userRef.set({ email, createdAt: FieldValue.serverTimestamp(), onboarded: false });
  }

  const meals = rows(mealsSnap, clock.tz).sort((a, b) => (a.at || 0) - (b.at || 0));
  const workouts = rows(workoutsSnap, clock.tz);
  const checkins = rows(checkinsSnap, clock.tz);
  const today = {
    meals: meals.filter(m => m.day === clock.day),
    workouts: workouts.filter(w => w.day === clock.day),
    checkins: checkins.filter(c => c.day === clock.day),
  };
  const week = [];
  for (let i = 6; i >= 1; i--) {
    const d = dayMinus(clock.day, i);
    const dm = meals.filter(m => m.day === d);
    const dc = checkins.filter(c => c.day === d);
    if (!dm.length && !dc.length && !workouts.some(w => w.day === d)) continue;
    week.push({
      day: d,
      ...totals(dm),
      workouts: workouts.filter(w => w.day === d).length,
      hunger: dc.length ? (dc.reduce((s, c) => s + (c.level || 0), 0) / dc.length).toFixed(1) : null,
    });
  }
  const recentWeights = rows(weightsSnap, clock.tz).reverse();
  const hungerLinks = linkHunger(checkins, meals);
  const knownFoods = foodLibrary(meals);

  // Save the user's message first so entries can point back to it.
  const userMsgRef = await userRef.collection('messages').add({
    role: 'user', text, createdAt: FieldValue.serverTimestamp(), day: clock.day,
  });

  const history = rows(histSnap, clock.tz).reverse();
  const messages = [...historyToMessages(history)];
  if (messages.length && messages.at(-1).role === 'user') messages.at(-1).content += `\n\n${text}`;
  else messages.push({ role: 'user', content: text });

  const systemText = buildSystem({ profile, clock, today, week, recentWeights, hungerLinks, knownFoods });
  const [core, context] = splitSystem(systemText);
  const system = [
    { type: 'text', text: core, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: context },
  ];

  const model = pickModel(text, profile?.onboarded);
  const entries = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let replyText = '';
  let stopReason = null, partial = false, failed = false;

  try {
    const started = Date.now();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await callClaude({ model, system, messages });
      for (const k of Object.keys(usage)) usage[k] += resp.usage?.[k] || 0;
      stopReason = resp.stop_reason;

      const textParts = resp.content.filter(c => c.type === 'text').map(c => c.text.trim()).filter(Boolean);
      if (textParts.length) replyText = textParts.join('\n');

      let toolUses = resp.content.filter(c => c.type === 'tool_use');
      if (!toolUses.length) break;
      if (resp.stop_reason !== 'tool_use' && resp.stop_reason !== 'max_tokens') break;

      // If the reply was cut off, the last tool call may be incomplete: skip it and ask
      // the model to carry on from there.
      const cutOff = resp.stop_reason === 'max_tokens';
      const skipped = cutOff ? toolUses.at(-1) : null;
      const content = resp.content.filter(c => !(skipped && c === skipped));
      toolUses = toolUses.filter(t => t !== skipped);
      if (!toolUses.length) break;

      messages.push({ role: 'assistant', content });
      // Write all of this round's entries in parallel (a pasted log can be dozens).
      const results = await Promise.all(toolUses.map(async (tu) => {
        try {
          const { result, entry } = await runTool(tu.name, tu.input || {}, {
            userRef, clock, FieldValue, sourceMessageId: userMsgRef.id,
          });
          if (entry) entries.push(entry);
          return { type: 'tool_result', tool_use_id: tu.id, content: result };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: tu.id, content: `error: ${err.message}`, is_error: true };
        }
      }));
      if (cutOff) {
        results.push({ type: 'text', text: 'Your last reply was cut off. Continue logging from where you stopped (skip anything already logged above), then reply briefly.' });
      }
      messages.push({ role: 'user', content: results });

      if (Date.now() - started > TIME_BUDGET_MS) {
        partial = true;
        break;
      }
    }
  } catch (err) {
    console.error(err);
    failed = !entries.length;
    replyText = replyText || (entries.length
      ? ''
      : "Sorry — something went wrong on my end and nothing was logged. Try again in a minute.");
  }

  if (partial) {
    replyText = `${replyText ? replyText + '\n\n' : ''}That was a lot — I logged ${entries.length} entries so far. Paste the rest (from where it stops) and I'll keep going.`;
  }
  if (!replyText) {
    replyText = entries.length ? summarize(entries) : "Hmm, I didn't catch anything to log there. Can you try again?";
    if (!entries.length) {
      failed = true;
      console.error('Empty reply', { model, stopReason });
    }
  }

  await Promise.all([
    userRef.collection('messages').add({
      role: 'assistant', text: replyText, entries, model, failed,
      createdAt: FieldValue.serverTimestamp(), day: clock.day,
    }),
    userRef.set({
      usage: {
        [model.replace(/\./g, '_')]: {
          input_tokens: FieldValue.increment(usage.input_tokens),
          output_tokens: FieldValue.increment(usage.output_tokens),
          cache_read_input_tokens: FieldValue.increment(usage.cache_read_input_tokens),
          requests: FieldValue.increment(1),
        },
      },
    }, { merge: true }),
  ]);

  return json(200, { reply: replyText, entries, model });
};

// The user's own foods with the numbers already used for them (most recent wins),
// so repeat foods get the same estimate every time.
export function foodLibrary(meals, max = 60) {
  const seen = new Map();
  const sorted = [...meals].sort((a, b) => (b.at || 0) - (a.at || 0));
  for (const m of sorted) {
    for (const it of m.items || []) {
      if (typeof it.calories !== 'number') continue;
      const key = `${foodKey(it.name)}|${String(it.qty || '').toLowerCase().trim()}`;
      if (!seen.has(key)) seen.set(key, { ...it, uses: 0 });
      seen.get(key).uses += 1;
    }
  }
  return [...seen.values()].sort((a, b) => b.uses - a.uses).slice(0, max);
}

// Fallback reply when the model logged things but said nothing.
function summarize(entries) {
  const live = entries.filter(e => !e.deleted && e.kind !== 'profile');
  if (!live.length) return 'Done.';
  const days = [...new Set(live.map(e => e.day).filter(Boolean))].sort();
  return `Logged ${live.length} ${live.length === 1 ? 'entry' : 'entries'}${days.length > 1 ? ` across ${days.length} days (${days[0]} to ${days.at(-1)})` : ''}.`;
}

// For each hunger check-in, find the most recent meal in the 6 hours before it.
// This lets the coach spot repeats like "hungry ~2 h after a smoothie, three days running".
export function linkHunger(checkins, meals) {
  return checkins
    .filter(c => c.at)
    .sort((a, b) => a.at - b.at)
    .map(c => {
      const before = meals.filter(m => m.at && m.at <= c.at && c.at - m.at <= 6 * 3600e3);
      const prev = before.at(-1);
      return {
        day: c.day, time: c.localTime, level: c.level, note: c.note || '',
        after: prev ? prev.description : null,
        afterProtein: prev?.protein_g, afterFiber: prev?.fiber_g, afterProcessing: prev?.processing,
        hoursAfter: prev ? Math.round(((c.at - prev.at) / 3600e3) * 10) / 10 : null,
      };
    });
}

// The static instructions (cacheable) come before "--- CONTEXT ---".
function splitSystem(s) {
  const i = s.indexOf('--- CONTEXT ---');
  return i === -1 ? [s, ' '] : [s.slice(0, i).trim(), s.slice(i)];
}
