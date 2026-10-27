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
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push(body);
  const n = calls.length;
  const content = n % 2 === 1
    ? [{ type: 'tool_use', id: 't1', name: 'log_meal', input: { description: 'banana smoothie', meal: 'breakfast', time: '08:00', calories: 300, protein_g: 5, fiber_g: 4, processing: 'processed' } },
       { type: 'tool_use', id: 't2', name: 'log_hunger', input: { level: 4, note: 'starving', time: '10:00' } }]
    : [{ type: 'text', text: 'Logged. Add Greek yogurt next time.' }];
  return { ok: true, json: async () => ({ content, stop_reason: n % 2 === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }) };
};
process.env.ALLOWED_EMAILS = 'will@tigerdumpsters.com';

const { default: handler, linkHunger, pickModel, makeClock } = await import('../netlify/functions/chat.mjs');
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
