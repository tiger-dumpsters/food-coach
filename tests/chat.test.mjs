import { test, mock } from 'node:test';
import assert from 'node:assert';

// ---- in-memory Firestore fake ----
const store = new Map(); // path -> data
let idc = 0;
const sentinel = (k, v) => ({ __s: k, v });
const FieldValue = { serverTimestamp: () => new Date(), increment: (n) => sentinel('inc', n) };
function docRef(path) {
  return {
    id: path.split('/').at(-1), path,
    async get() { const d = store.get(path); return { exists: !!d, id: this.id, data: () => d }; },
    async set(data, opts) { store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : data); },
    async update(p) { const cur = { ...(store.get(path) || {}) }; for (const [k, v] of Object.entries(p)) { if (k.includes('.')) { const [a, b] = k.split('.'); cur[a] = { ...(cur[a] || {}), [b]: v }; } else cur[k] = v; } store.set(path, cur); },
    async delete() { store.delete(path); },
    collection(name) { return colRef(`${path}/${name}`); },
  };
}
function colRef(path, filters = [], order = null, lim = null) {
  return {
    doc: (id) => docRef(`${path}/${id}`),
    async add(data) { const id = 'id' + (++idc); store.set(`${path}/${id}`, data); return docRef(`${path}/${id}`); },
    where: (f, op, v) => colRef(path, [...filters, [f, op, v]], order, lim),
    orderBy: (f, dir) => colRef(path, filters, [f, dir], lim),
    limit: (n) => colRef(path, filters, order, n),
    async get() {
      let docs = [...store.entries()].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
        .map(([k, v]) => ({ id: k.split('/').at(-1), data: () => v }));
      for (const [f, op, v] of filters) docs = docs.filter(d => op === '==' ? d.data()[f] === v : d.data()[f] >= v);
      if (order) { docs.sort((a, b) => (a.data()[order[0]] > b.data()[order[0]] ? 1 : -1)); if (order[1] === 'desc') docs.reverse(); }
      if (lim) docs = docs.slice(0, lim);
      return { docs };
    },
  };
}
mock.module('firebase-admin/app', { namedExports: { initializeApp() {}, cert: () => ({}), getApps: () => [1] } });
mock.module('firebase-admin/auth', { namedExports: { getAuth: () => ({ verifyIdToken: async (t) => { if (t !== 'good') throw new Error('bad'); return { uid: 'u1', email: 'will@tigerdumpsters.com' }; } }) } });
mock.module('firebase-admin/firestore', { namedExports: { getFirestore: () => ({ collection: (n) => colRef(n) }), FieldValue } });

// ---- fake Claude: first call logs a meal + hunger, second returns text ----
const calls = [];
const queue = []; // scripted responses; when empty, fall back to the default pair
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push(body);
  if (queue.length) { const q = queue.shift(); return { ok: true, json: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, ...q }) }; }
  const n = calls.length;
  const content = n % 2 === 1
    ? [{ type: 'tool_use', id: 't1', name: 'log_meal', input: { description: 'banana smoothie', meal: 'breakfast', time: '08:00', calories: 300, protein_g: 5, fiber_g: 4, processing: 'processed' } },
       { type: 'tool_use', id: 't2', name: 'log_hunger', input: { level: 4, note: 'starving', time: '10:00' } }]
    : [{ type: 'text', text: 'Logged. Add Greek yogurt next time.' }];
  return { ok: true, json: async () => ({ content, stop_reason: n % 2 === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }) };
};
process.env.ALLOWED_EMAILS = 'will@tigerdumpsters.com';

const { default: handler, linkHunger, pickModel, makeClock } = await import('../netlify/functions/chat.mjs');
const { resolveWhen } = await import('../netlify/functions/lib/tools.mjs');
const req = (token, body) => new Request('http://x/chat', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });

test('rejects bad token', async () => {
  const r = await handler(req('nope', { text: 'hi' })); assert.equal(r.status, 401);
});

test('logs entries and saves messages', async () => {
  const r = await handler(req('good', { text: 'had a smoothie at 8, now starving', tz: 'America/New_York' }));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.reply, 'Logged. Add Greek yogurt next time.');
  assert.deepEqual(j.entries.map(e => e.kind), ['meal', 'hunger']);
  const keys = [...store.keys()];
  assert.ok(keys.some(k => k.startsWith('users/u1/meals/')));
  assert.equal(keys.filter(k => k.startsWith('users/u1/messages/')).length, 2);
  assert.ok(calls[0].system[0].cache_control);
  assert.ok(calls[0].system[1].text.includes('CONTEXT'));
  // the tool_result round trip
  assert.equal(calls[1].messages.at(-1).content[0].type, 'tool_result');
});

test('second message sees hunger link in context', async () => {
  await handler(req('good', { text: 'what should I eat?', tz: 'America/New_York' }));
  const sys = calls.at(-2).system[1].text;
  assert.ok(sys.includes('after "banana smoothie"'), sys);
  assert.ok(calls.at(-2).messages.length >= 3);
});

test('model routing', () => {
  assert.equal(pickModel('2 eggs and toast', true), 'claude-haiku-5-5');
  assert.equal(pickModel('why am I hungry?', true), 'claude-sonnet-5-5');
  assert.equal(pickModel('2 eggs', false), 'claude-sonnet-5-5');
});

test('clock', () => {
  const c = makeClock('America/New_York', new Date('2026-10-27T01:30:00Z'));
  assert.equal(c.day, '2026-10-26'); assert.equal(c.hhmm, '21:30');
});

test('resolveWhen puts past dates on the right local day', () => {
  const clock = makeClock('America/New_York', new Date('2026-10-27T02:30:00Z')); // Oct 26 22:30 ET
  const w = resolveWhen(clock, '2026-10-21', '08:15');
  assert.equal(w.day, '2026-10-21');
  assert.equal(w.at.toISOString(), '2026-10-21T12:15:00.000Z');
  assert.equal(resolveWhen(clock, '2026-10-22').at.toISOString(), '2026-10-22T16:00:00.000Z'); // noon
  assert.equal(resolveWhen(clock, '2027-01-01', '09:00').day, '2026-10-26'); // future date ignored
});

test('long paste: cut-off reply is resumed, entries land on their dates, no "…"', async () => {
  const paste = 'FOOD LOG Oct 21-22\n' + 'Wed Oct 21 8:00am smoothie | 440 / 27 / 1.5\n'.repeat(60);
  const meal = (id, date, time) => ({ type: 'tool_use', id, name: 'log_meal', input: { description: 'smoothie', date, time, calories: 440, protein_g: 27, fiber_g: 1.5, processing: 'processed' } });
  queue.push(
    { stop_reason: 'max_tokens', content: [meal('a', '2026-10-21', '08:00'), { type: 'tool_use', id: 'b', name: 'log_meal', input: { description: 'smoo' } }] },
    { stop_reason: 'tool_use', content: [meal('c', '2026-10-22', '08:00'), { type: 'tool_use', id: 'h', name: 'log_hunger', input: { level: 3, date: '2026-10-22', time: '11:20' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged 2 days.' }] },
  );
  store.set('users/u1', { ...store.get('users/u1'), onboarded: true });
  const before = calls.length;
  const r = await handler(req('good', { text: paste, tz: 'America/New_York' }));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.reply, 'Logged 2 days.');
  assert.equal(j.model, 'claude-haiku-5-5');
  assert.deepEqual(j.entries.map(e => e.day), ['2026-10-21', '2026-10-22', '2026-10-22']);
  // the truncated tool call was dropped and the model was told to continue
  const second = calls[before + 1];
  const lastUser = second.messages.at(-1).content;
  assert.ok(lastUser.some(c => c.type === 'text' && /cut off/.test(c.text)));
  assert.ok(!second.messages.at(-2).content.some(c => c.id === 'b'));
  assert.equal(calls[before].max_tokens, 8000);
});

test('history hides failed replies and earlier long pastes', async () => {
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] });
  await handler(req('good', { text: 'hello', tz: 'America/New_York' }));
  const msgs = calls.at(-1).messages;
  const flat = JSON.stringify(msgs);
  assert.ok(flat.includes('already handled'));
  assert.ok(!flat.includes('"…"'));
  assert.equal(msgs[0].role, 'user');
});

test('meal totals come from items, and known foods are reused in context', async () => {
  const { withItemTotals } = await import('../netlify/functions/lib/tools.mjs');
  const t = withItemTotals({ calories: 999, items: [
    { name: 'GF bread', qty: '2 slices', calories: 220, protein_g: 4, fiber_g: 3, fat_g: 8 },
    { name: 'apple', qty: '1', calories: 95, protein_g: 0.5, fiber_g: 4.4, fat_g: 0.3 },
  ] });
  assert.equal(t.calories, 315); assert.equal(t.fiber_g, 7.4); assert.equal(t.fat_g, 8.3);

  queue.push(
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'm', name: 'log_meal', input: { description: 'toast + apple', processing: 'mixed', items: [
      { name: 'Homemade GF bread', qty: '2 slices', calories: 220, protein_g: 4, fiber_g: 3 },
      { name: 'Apple', qty: '1', calories: 95, protein_g: 0.5, fiber_g: 4.4 }] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged.' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  );
  const r = await handler(req('good', { text: 'toast and an apple', tz: 'America/New_York' }));
  const j = await r.json();
  assert.equal(j.entries[0].calories, 315);
  await handler(req('good', { text: 'same again', tz: 'America/New_York' }));
  const sys = calls.at(-1).system[1].text;
  assert.ok(sys.includes('Known foods'));
  assert.ok(sys.includes('- Homemade GF bread | 2 slices | 220 cal'), sys);
  assert.equal(calls.at(-1).temperature, undefined); // newer models reject sampling params
});

test('smart model rejection falls back to fast model; error saved', async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body); n++;
    if (body.model === 'claude-sonnet-5-5') return { ok: false, status: 400, text: async () => '{"error":{"message":"temperature is not supported"}}' };
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nice, that lunch held you.' }], usage: {} }) };
  };
  const r = await handler(req('good', { text: 'still not hungry which is remarkable', tz: 'America/New_York' }));
  const j = await r.json();
  globalThis.fetch = realFetch;
  assert.equal(j.reply, 'Nice, that lunch held you.');
  assert.equal(j.model, 'claude-haiku-5-5');
  const saved = [...store.entries()].filter(([k, v]) => k.includes('/messages/') && v.error);
  assert.ok(saved.length >= 1);
});

test('out of credit gets a clear message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'Your credit balance is too low to access the Anthropic API.' });
  const r = await handler(req('good', { text: 'why am I hungry?', tz: 'America/New_York' }));
  const j = await r.json();
  globalThis.fetch = realFetch;
  assert.match(j.reply, /out of API credit/);
});

test('reply that claims "logged" without a tool call gets corrected', async () => {
  queue.push(
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged 3 pieces of grilled chicken.' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'k', name: 'log_meal', input: { description: '3 pieces grilled chicken', processing: 'whole', items: [{ name: 'grilled chicken', qty: '3 pieces', calories: 140, protein_g: 26, fiber_g: 0 }] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged 3 pieces of grilled chicken, ~140 cal.' }] },
  );
  const r = await handler(req('good', { text: '3 pieces of grilled chicken', tz: 'America/New_York' }));
  const j = await r.json();
  assert.equal(j.entries.length, 1);
  assert.equal(j.entries[0].calories, 140);
  assert.match(calls.at(-2).messages.at(-1).content, /App check/);
  // history now carries saved notes
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  await handler(req('good', { text: 'thanks', tz: 'America/New_York' }));
  const hist = JSON.stringify(calls.at(-1).messages);
  assert.ok(hist.includes('[app: saved 1'), hist.slice(-600));
});
