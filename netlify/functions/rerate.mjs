// POST /.netlify/functions/rerate
// One-time pass: give meals logged before per-item processing a whole / processed /
// ultraprocessed split. Calorie and protein totals are left exactly as they were.

import { FieldValue } from 'firebase-admin/firestore';
import { admin, verify } from './lib/admin.mjs';
import { processingMix, dominant, LEVELS } from './lib/tools.mjs';

const MODEL = process.env.MODEL_FAST || 'claude-haiku-5-5';
const VERSION = 'v1';
const CHUNK = 20;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const TOOL = {
  name: 'rate_meals',
  description: 'Return each meal split into items, with each item\'s processing level and its rough share of the meal\'s calories.',
  input_schema: {
    type: 'object',
    properties: {
      meals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  qty: { type: 'string' },
                  share: { type: 'number', description: 'Fraction of the meal\'s calories, 0–1; shares in a meal add up to 1.' },
                  processing: { type: 'string', enum: LEVELS },
                },
                required: ['name', 'share', 'processing'],
              },
            },
          },
          required: ['id', 'items'],
        },
      },
    },
    required: ['meals'],
  },
};

const SYSTEM = `You rate foods by processing level. For each meal, list its foods as items (if the meal already lists items, return exactly those items in the same order). Rate every item on its own:
- whole: fruit, vegetables, eggs, plain meat/fish/poultry, plain milk and plain yogurt, beans, nuts, seeds, oats, rice, potatoes, coffee, tea, homemade food made from these.
- processed: cheese, butter, oils, homemade or bakery bread, simple soups and broths, plain canned fish, salted nuts, natural peanut butter.
- ultraprocessed: packaged snacks, chips, cookies, most granola and bars, frozen waffles, sweetened or flavored yogurt, American cheese, deli meats, soda, protein bars and shakes, most packaged sliced bread, flavored syrups.
Give each item its rough share of the meal's calories. Call rate_meals once with every meal.`;

async function rateChunk(meals) {
  const list = meals.map((m) => ({
    id: m.id, description: m.description, calories: m.calories,
    ...(m.items?.length ? { items: m.items.map((i) => `${i.qty ? i.qty + ' ' : ''}${i.name}`) } : {}),
  }));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 6000, system: SYSTEM, tools: [TOOL],
      messages: [{ role: 'user', content: JSON.stringify(list) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const call = data.content.find((c) => c.type === 'tool_use' && c.name === 'rate_meals');
  return call?.input?.meals || [];
}

// Split a calorie total by shares into whole numbers that add up exactly.
function split(shares, total = 0) {
  const t = shares.reduce((a, x) => a + (x || 0), 0) || 1;
  const raw = shares.map((x) => ((x || 0) / t) * total);
  const out = raw.map(Math.floor);
  let left = Math.round(total) - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

// Merge a rating into a stored meal without changing its totals.
export function applyRating(meal, rated) {
  const r = (rated.items || []).filter((i) => LEVELS.includes(i.processing));
  if (!r.length) return null;
  let items;
  if (meal.items?.length && meal.items.length === r.length) {
    items = meal.items.map((it, i) => ({ ...it, processing: r[i].processing }));
    if (!items.some((i) => typeof i.calories === 'number')) {
      const cals = split(r.map((i) => i.share), meal.calories);
      items = items.map((it, i) => ({ ...it, calories: cals[i], derived: true }));
    }
  } else {
    const cals = split(r.map((i) => i.share), meal.calories);
    items = r.map((i, n) => ({ name: i.name, qty: i.qty || '', processing: i.processing, calories: cals[n], derived: true }));
  }
  const mix = processingMix(items);
  return mix ? { items, processing_mix: mix, processing: dominant(mix) } : null;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const who = await verify(req);
  if (who.error) return json(who.status, { error: who.error });
  const { db } = admin();
  const userRef = db.collection('users').doc(who.uid);
  const profile = (await userRef.get()).data() || {};
  if (profile.rerated === VERSION) return json(200, { updated: 0, already: true });

  const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
  const snap = await userRef.collection('meals').where('day', '>=', since).get();
  const todo = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => !m.processing_mix).slice(0, 120);

  let updated = 0;
  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  try {
    const results = await Promise.all(chunks.map(rateChunk));
    const byId = new Map(todo.map((m) => [m.id, m]));
    const writes = [];
    for (const rated of results.flat()) {
      const meal = byId.get(rated.id);
      const patch = meal && applyRating(meal, rated);
      if (patch) {
        writes.push(userRef.collection('meals').doc(meal.id).update({ ...patch, reratedAt: FieldValue.serverTimestamp() }));
        updated++;
      }
    }
    await Promise.all(writes);
  } catch (err) {
    console.error('rerate failed', err.message);
    return json(502, { error: 'Could not re-rate right now', updated });
  }
  await userRef.set({ rerated: VERSION }, { merge: true });
  return json(200, { updated, of: todo.length });
};
