// POST /.netlify/functions/chat
// Body: { text: string, tz: "America/New_York", image?: { media_type, data }, thumb?: dataURL }
// Header: Authorization: Bearer <Firebase ID token>
//
// Verifies the user, loads their context from Firestore, lets Claude log entries via
// tools, saves both chat messages, and returns the reply plus the entries it logged.

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';
import { TOOLS, runTool, foodKey } from './lib/tools.mjs';
import { buildSystem, totals } from './lib/prompt.mjs';
import { weakSpots, keepsYouFull } from '../../public/js/insights.js';

const MODEL_FAST = process.env.MODEL_FAST || 'claude-haiku-5-5';
const MODEL_SMART = process.env.MODEL_SMART || 'claude-sonnet-5-5';
const MAX_ROUNDS = 8;
const MAX_TOKENS = 8000;
const TIME_BUDGET_MS = 50_000; // stay under Netlify's function limit
const LONG_PASTE = 1500;       // chars; treated as a bulk import
const MAX_IMAGE_B64 = 2_500_000; // ~1.8 MB image after the phone shrinks it
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];


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
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// Turn saved chat history into alternating user/assistant turns.
// What a past reply actually saved, so the model sees the link between "logged" and a save.
export function savedNote(entries = []) {
  const all = (entries || []).filter(Boolean);
  if (!all.length) return '[app: nothing was saved this turn]';
  const desc = all.slice(0, 6).map(e => e.deleted ? `removed ${e.kind}`
    : e.kind === 'meal' ? `meal "${e.description}"` : e.kind === 'workout' ? `workout ${e.type}`
    : e.kind === 'hunger' ? `hunger ${e.level}/5` : e.kind === 'profile' ? 'profile settings'
    : e.kind === 'pantry' ? 'pantry' : e.kind).join('; ');
  return `[app: saved — ${desc}${all.length > 6 ? '; …' : ''}]`;
}

// Does a reply claim something was logged?
export function claimsLogged(text) {
  return /\b(logged|i(?:'ve| have) added|added (?:it|that|them|your)|saved|recorded)\b/i.test(text || '');
}

// "[Today 1:03 PM]" / "[Yesterday 5:19 PM]" / "[Mon Oct 26 8:02 AM]" so the coach knows
// which day an earlier message (and any running total in it) belongs to.
export function stamp(h, clock) {
  const at = h.createdAt?.toDate ? h.createdAt.toDate() : h.createdAt ? new Date(h.createdAt) : null;
  const day = h.day || clock.day;
  const label = day === clock.day ? 'Today' : day === dayMinus(clock.day, 1) ? 'Yesterday'
    : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = at ? new Intl.DateTimeFormat('en-US', { timeZone: clock.tz, hour: 'numeric', minute: '2-digit' }).format(at) : '';
  return `${label}${time ? ` ${time}` : ''}`;
}

function historyToMessages(history, clock) {
  const out = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    let text = (h.text || '').trim();
    if (h.photo) text = `[photo]${text ? ` ${text}` : ''}`;
    if (!text || h.failed || text === '…') continue;
    // Earlier long pastes were already handled (or failed); don't let the model redo them.
    if (role === 'user' && text.length > LONG_PASTE) {
      text = `${text.slice(0, 200)}… [long pasted log from earlier, ${text.length} chars — already handled; do not log it again unless the user pastes it again]`;
    }
    if (clock) {
      if (role === 'user') text = `[${stamp(h, clock)}] ${text}`;
      else text += `\n[app: sent ${stamp(h, clock)}]`;
    }
    if (role === 'assistant') text += `\n${savedNote(h.entries)}`;
    const last = out.at(-1);
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const { db } = admin();
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  const { uid, email } = who;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  const text = String(body.text || '').trim().slice(0, 4000);
  let image = null;
  if (body.image) {
    const { media_type: mt, data } = body.image;
    if (!IMAGE_TYPES.includes(mt) || typeof data !== 'string' || data.length > MAX_IMAGE_B64) {
      return json(400, { error: 'Photo too large or unsupported' });
    }
    image = { type: 'image', source: { type: 'base64', media_type: mt, data } };
  }
  const thumb = typeof body.thumb === 'string' && body.thumb.startsWith('data:image/') && body.thumb.length < 60_000 ? body.thumb : null;
  if (!text && !image) return json(400, { error: 'Empty message' });

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
  const household = await loadHousehold(db, profile?.householdId, uid);
  const me = { uid, name: firstName(profile?.name, email) };

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
  const knownFoods = mergeFoods(household?.foods || [], foodLibrary(meals));
  const insights = {
    weakSpots: weakSpots(meals, clock.tz),
    keepsFull: keepsYouFull(meals, checkins),
  };

  // Save the user's message first so entries can point back to it.
  const userMsgRef = await userRef.collection('messages').add({
    role: 'user', text, createdAt: FieldValue.serverTimestamp(), day: clock.day,
    ...(image ? { photo: true } : {}), ...(thumb ? { thumb } : {}),
  });

  const history = rows(histSnap, clock.tz).reverse();
  const messages = [...historyToMessages(history, clock)];
  const nowStamp = `[Today ${new Intl.DateTimeFormat('en-US', { timeZone: clock.tz, hour: 'numeric', minute: '2-digit' }).format(clock.now)}]`;
  const turnText = `${nowStamp} ${image ? `[photo]${text ? ` ${text}` : ' (no caption)'}` : text}`;
  const userContent = image ? [image, { type: 'text', text: turnText }] : turnText;
  if (messages.length && messages.at(-1).role === 'user') {
    const prev = messages.pop().content;
    messages.push({ role: 'user', content: image ? [{ type: 'text', text: prev }, ...userContent] : `${prev}\n\n${turnText}` });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  const systemText = buildSystem({
    profile, clock, today, week, recentWeights, hungerLinks, knownFoods, insights,
    household: household ? { members: household.members.map((m) => m.name), me: me.name, pantry: household.pantry } : null,
  });
  const [core, context] = splitSystem(systemText);
  const system = [
    { type: 'text', text: core, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: context },
  ];

  const model = image ? MODEL_SMART : pickModel(text, profile?.onboarded);
  const entries = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let replyText = '';
  let stopReason = null, partial = false, failed = false, errorDetail = null;
  let activeModel = model;
  let nudged = false;

  try {
    const started = Date.now();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let resp;
      try {
        resp = await callClaude({ model: activeModel, system, messages });
      } catch (err) {
        // One fallback: if the stronger model rejects the request, try the fast one.
        if (activeModel === MODEL_FAST || /credit balance/i.test(err.message)) throw err;
        console.error('Smart model failed, falling back', err.message);
        errorDetail = err.message;
        activeModel = MODEL_FAST;
        resp = await callClaude({ model: activeModel, system, messages });
      }
      for (const k of Object.keys(usage)) usage[k] += resp.usage?.[k] || 0;
      stopReason = resp.stop_reason;

      const textParts = resp.content.filter(c => c.type === 'text').map(c => c.text.trim()).filter(Boolean);
      if (textParts.length) replyText = textParts.join('\n');

      let toolUses = resp.content.filter(c => c.type === 'tool_use');
      if (!toolUses.length) {
        // Only when nothing at all was saved this turn (a profile or pantry save counts).
        if (!entries.length && !nudged && claimsLogged(replyText)) {
          nudged = true;
          console.warn('Reply claimed a log with no tool call; nudging', { model: activeModel });
          messages.push({ role: 'assistant', content: resp.content });
          messages.push({ role: 'user', content: 'App check (not from the user — never mention it): your reply says something was logged, but nothing was saved this turn. If the user\'s last message mentioned food, exercise, a weigh-in, hunger or a settings change, save it now with the right tool, then give your reply again. If there was nothing to save, just give your reply again without claiming you saved anything. Either way, reply to the user normally.' });
          replyText = '';
          continue;
        }
        break;
      }
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
      const outcomes = await Promise.all(toolUses.map(async (tu) => {
        try {
          const { result, entry } = await runTool(tu.name, tu.input || {}, {
            userRef, clock, FieldValue, sourceMessageId: userMsgRef.id, db, household, me,
          });
          return { entry, block: { type: 'tool_result', tool_use_id: tu.id, content: result } };
        } catch (err) {
          return { entry: null, block: { type: 'tool_result', tool_use_id: tu.id, content: `error: ${err.message}`, is_error: true } };
        }
      }));
      // Keep cards in the order the user mentioned things.
      for (const o of outcomes) if (o.entry) entries.push(o.entry);
      const results = outcomes.map((o) => o.block);
      // After any food change, give the coach today's real totals from the database so it
      // never adds up the day itself (or carries over yesterday's running total).
      if (outcomes.some((o) => o.entry && (o.entry.kind === 'meal'))) {
        try {
          const todaySnap = await userRef.collection('meals').where('day', '==', clock.day).get();
          const t = totals(todaySnap.docs.map((d) => d.data()));
          results.push({ type: 'text', text: `[app: today's totals (${clock.weekday} ${clock.day}) after this change: ${Math.round(t.calories)} cal, ${Math.round(t.protein_g)} g protein, ${Math.round(t.fiber_g)} g fiber, ${Math.round(t.fat_g)} g fat across ${t.meals} meals/snacks. Quote these if you mention today's totals.]` });
        } catch (err) {
          console.error('totals refresh failed', err.message);
        }
      }
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
    errorDetail = err.message;
    failed = !entries.length;
    const outOfCredit = /credit balance/i.test(err.message);
    replyText = replyText || (entries.length
      ? ''
      : outOfCredit
        ? "I'm out of API credit, so I couldn't log that. (Admin: top up at console.anthropic.com → Billing.)"
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
      role: 'assistant', text: replyText, entries, model: activeModel, failed, ...(errorDetail ? { error: errorDetail.slice(0, 500) } : {}),
      createdAt: FieldValue.serverTimestamp(), day: clock.day,
    }),
    userRef.set({
      usage: {
        [activeModel.replace(/\./g, '_')]: {
          input_tokens: FieldValue.increment(usage.input_tokens),
          output_tokens: FieldValue.increment(usage.output_tokens),
          cache_read_input_tokens: FieldValue.increment(usage.cache_read_input_tokens),
          requests: FieldValue.increment(1),
        },
      },
    }, { merge: true }),
  ]);

  return json(200, { reply: replyText, entries, model: activeModel });
};

// The user's own foods with the numbers already used for them (most recent wins),
// so repeat foods get the same estimate every time.
export function foodLibrary(meals, max = 60) {
  const seen = new Map();
  const sorted = [...meals].sort((a, b) => (b.at || 0) - (a.at || 0));
  for (const m of sorted) {
    for (const it of m.items || []) {
      if (typeof it.calories !== 'number' || it.derived) continue; // re-rated items have no reliable macros
      const key = `${foodKey(it.name)}|${String(it.qty || '').toLowerCase().trim()}`;
      if (!seen.has(key)) seen.set(key, { ...it, uses: 0 });
      seen.get(key).uses += 1;
    }
  }
  return [...seen.values()].sort((a, b) => b.uses - a.uses).slice(0, max);
}

function firstName(name, email) {
  const n = String(name || '').trim().split(/\s+/)[0];
  if (n) return n;
  const local = String(email || '').split('@')[0].split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : 'Someone';
}

// Household: members (names only), shared pantry, shared food numbers.
async function loadHousehold(db, hid, uid) {
  if (!hid) return null;
  const ref = db.collection('households').doc(hid);
  const [snap, foodsSnap] = await Promise.all([ref.get(), ref.collection('foods').limit(200).get()]);
  if (!snap.exists) return null;
  const h = snap.data();
  if (!(h.members || []).includes(uid)) return null;
  const members = (h.members || []).map((m) => ({ uid: m, name: (h.names || {})[m] || 'Member' }));
  return { id: hid, ref, members, pantry: h.pantry || [], foods: foodsSnap.docs.map((d) => d.data()) };
}

// Household numbers win over personal ones for the same food + amount.
export function mergeFoods(shared, personal, max = 80) {
  const out = new Map();
  for (const f of [...shared, ...personal]) {
    const k = `${foodKey(f.name)}|${String(f.qty || '').toLowerCase().trim()}`;
    if (!out.has(k)) out.set(k, f);
  }
  return [...out.values()].slice(0, max);
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
