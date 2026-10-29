import { test, mock } from 'node:test';
import assert from 'node:assert';

// ---- in-memory Firestore fake ----
const store = new Map(); // path -> data
let idc = 0;
const sentinel = (k, v) => ({ __s: k, v });
const FieldValue = { serverTimestamp: () => new Date(), increment: (n) => sentinel('inc', n), arrayUnion: (...v) => sentinel('union', v), delete: () => sentinel('del') };
function applyVal(cur, v) { if (v && v.__s === 'union') return [...new Set([...(cur || []), ...v.v])]; return v; }
function docRef(path) {
  return {
    id: path.split('/').at(-1), path,
    async get() { const d = store.get(path); return { exists: !!d, id: this.id, data: () => d }; },
    async set(data, opts) { store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : data); },
    async update(p) { const cur = { ...(store.get(path) || {}) }; for (const [k, v] of Object.entries(p)) { if (k.includes('.')) { const [a, b] = k.split('.'); cur[a] = { ...(cur[a] || {}) }; if (v && v.__s === 'del') delete cur[a][b]; else cur[a][b] = v; } else if (v && v.__s === 'del') delete cur[k]; else cur[k] = applyVal(cur[k], v); } store.set(path, cur); },
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
const USERS = { good: { uid: 'u1', email: 'will@tigerdumpsters.com', name: 'Will Stewart' }, alexa: { uid: 'u2', email: 'alexa@example.com', name: 'Alexa Stewart' } };
mock.module('firebase-admin/auth', { namedExports: { getAuth: () => ({ verifyIdToken: async (t) => { if (!USERS[t]) throw new Error('bad'); return USERS[t]; } }) } });
const fakeDb = {
  collection: (n) => colRef(n),
  async runTransaction(fn) {
    return fn({ get: (ref) => ref.get(), update: (ref, p) => ref.update(p), set: (ref, d, o) => ref.set(d, o), delete: (ref) => ref.delete() });
  },
};
mock.module('firebase-admin/firestore', { namedExports: { getFirestore: () => fakeDb, FieldValue } });

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
process.env.ALLOWED_EMAILS = 'will@tigerdumpsters.com,alexa@example.com';

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
  assert.ok(hist.includes('[app: saved — meal "3 pieces grilled chicken"'), hist.slice(-600));
});

test('household: invite, join, shared meal lands in both logs with same numbers', async () => {
  const { default: hh } = await import('../netlify/functions/household.mjs');
  const hreq = (token, body) => new Request('http://x/household', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  store.set('users/u2', { onboarded: true, staples: ['Greek yogurt'] });
  const inv = await (await hh(hreq('good', { action: 'invite' }))).json();
  assert.match(inv.code, /^[A-Z2-9]{6}$/);
  const bad = await hh(hreq('alexa', { action: 'join', code: 'ZZZZZZ' }));
  assert.equal(bad.status, 400);
  const joined = await (await hh(hreq('alexa', { action: 'join', code: inv.code.toLowerCase() }))).json();
  assert.equal(joined.householdId, inv.householdId);
  const h = store.get(`households/${inv.householdId}`);
  assert.deepEqual(h.members, ['u1', 'u2']);
  assert.equal(h.names.u2, 'Alexa');
  assert.ok(h.pantry.includes('Greek yogurt'));
  assert.ok(!store.has(`invites/${inv.code}`)); // single use

  queue.push(
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 's1', name: 'log_meal', input: { description: 'chicken rice bowl', meal: 'lunch', processing: 'whole', shared_with: ['Alexa'], their_portion: 0.5,
        items: [{ name: 'chicken rice bowl', qty: '1 bowl', calories: 600, protein_g: 40, fiber_g: 6 }] } },
      { type: 'tool_use', id: 's2', name: 'update_pantry', input: { add: ['salmon'], remove: ['greek yogurt'] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged for both of you.' }] },
  );
  const r = await handler(req('good', { text: 'Alexa and I both had chicken rice bowls, she had half', tz: 'America/New_York' }));
  const j = await r.json();
  assert.deepEqual(j.entries[0].sharedWith, ['Alexa']);
  const alexaMeals = [...store.entries()].filter(([k]) => k.startsWith('users/u2/meals/')).map(([, v]) => v);
  assert.equal(alexaMeals.length, 1);
  assert.equal(alexaMeals[0].calories, 300);
  assert.equal(alexaMeals[0].sharedFrom.name, 'Will');
  const alexaMsgs = [...store.entries()].filter(([k]) => k.startsWith('users/u2/messages/')).map(([, v]) => v);
  assert.match(alexaMsgs[0].text, /Will logged a shared lunch/);
  const h2 = store.get(`households/${inv.householdId}`);
  assert.ok(h2.pantry.includes('salmon') && !h2.pantry.some((p) => /yogurt/i.test(p)));
  assert.ok([...store.keys()].some((k) => k.startsWith(`households/${inv.householdId}/foods/`)));

  // Alexa's coach sees the shared food numbers and household in context
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  await handler(req('alexa', { text: 'what is in the pantry?', tz: 'America/New_York' }));
  const sys = calls.at(-1).system[1].text;
  assert.ok(sys.includes('Household: Will, Alexa'), sys.slice(0, 400));
  assert.ok(sys.includes('chicken rice bowl | 1 bowl | 600 cal'));
  // privacy: nothing about Will's hunger or his unshared meals in Alexa's context
  assert.ok(!sys.includes('starving'));
  assert.ok(!sys.includes('banana smoothie'));
  assert.ok(!sys.includes('Homemade GF bread'));

  const left = await hh(hreq('alexa', { action: 'leave' }));
  assert.equal(left.status, 200);
  assert.deepEqual(store.get(`households/${inv.householdId}`).members, ['u1']);
});

test('photo: image goes to the smart model, thumb saved, history marks it', async () => {
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Looks like eggs and toast.' }] });
  const r = await handler(req('good', { text: 'breakfast', tz: 'America/New_York', image: { media_type: 'image/jpeg', data: 'AAAA' }, thumb: 'data:image/jpeg;base64,BBBB' }));
  assert.equal(r.status, 200);
  const call = calls.at(-1);
  assert.equal(call.model, 'claude-sonnet-5-5');
  const last = call.messages.at(-1).content;
  assert.ok(Array.isArray(last) && last.some((c) => c.type === 'image'));
  assert.ok(last.some((c) => c.type === 'text' && c.text.includes('[photo] breakfast')));
  const saved = [...store.entries()].find(([k, v]) => k.startsWith('users/u1/messages/') && v.photo);
  assert.equal(saved[1].thumb, 'data:image/jpeg;base64,BBBB');
  const big = await handler(req('good', { text: 'x', image: { media_type: 'image/gif', data: 'AA' } }));
  assert.equal(big.status, 400);
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  await handler(req('good', { text: 'thanks', tz: 'America/New_York' }));
  assert.ok(JSON.stringify(calls.at(-1).messages).includes('[photo] breakfast'));
});

test('rerate: older meals get a split without changing totals, once', async () => {
  const { default: rerate, applyRating } = await import('../netlify/functions/rerate.mjs');
  const p = applyRating({ calories: 290, description: 'yogurt, strawberries, granola' }, { items: [
    { name: 'Greek yogurt', share: 0.65, processing: 'whole' }, { name: 'strawberries', share: 0.05, processing: 'whole' }, { name: 'granola', share: 0.3, processing: 'ultraprocessed' }] });
  assert.equal(p.items.reduce((a, i) => a + i.calories, 0), 290);
  assert.equal(p.processing, 'whole');
  assert.ok(p.items.every((i) => i.derived));

  store.set('users/u1/meals/old1', { day: new Date().toISOString().slice(0, 10), description: 'yogurt bowl', calories: 290, protein_g: 27, processing: 'mixed' });
  queue.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'rate_meals', input: { meals: [{ id: 'old1', items: [
    { name: 'Greek yogurt', share: 0.7, processing: 'whole' }, { name: 'granola', share: 0.3, processing: 'ultraprocessed' }] }] } }] });
  const before = calls.length;
  const r = await (await rerate(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer good' }, body: '{}' }))).json();
  assert.ok(r.updated >= 1);
  const m = store.get('users/u1/meals/old1');
  assert.equal(m.calories, 290);
  assert.equal(m.protein_g, 27);
  assert.deepEqual(m.processing_mix, { whole: 203, processed: 0, ultraprocessed: 87 });
  const again = await (await rerate(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer good' }, body: '{}' }))).json();
  assert.equal(again.already, true);
  assert.equal(calls.length, before + 1);
});

test('yesterday\'s running total is stamped; after logging the coach gets today\'s real totals', async () => {
  for (const k of [...store.keys()]) if (k.startsWith('users/u1/messages/') || k.startsWith('users/u1/meals/')) store.delete(k);
  const clock = makeClock('America/New_York');
  const y = new Date(Date.now() - 864e5);
  const yDay = makeClock('America/New_York', y).day;
  store.set('users/u1/messages/y1', { role: 'user', text: '3 pieces of grilled chicken', day: yDay, createdAt: y });
  store.set('users/u1/messages/y2', { role: 'assistant', text: 'You\'re at 2,070 cal for the day.', day: yDay, createdAt: new Date(y.getTime() + 1000), entries: [] });
  store.set('users/u1/meals/ym', { day: yDay, at: y, description: 'dinner', calories: 2070, protein_g: 122, fiber_g: 26 });
  store.set('users/u1/meals/tm', { day: clock.day, at: new Date(), description: 'breakfast', calories: 400, protein_g: 30, fiber_g: 5 });
  queue.push(
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'l', name: 'log_meal', input: { description: 'rice bowl', items: [{ name: 'brown rice', qty: '2 cups', calories: 430, protein_g: 10, fiber_g: 7, processing: 'whole' }] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged. You\'re at about 830 cal.' }] },
  );
  await handler(req('good', { text: 'rice bowl for lunch', tz: 'America/New_York' }));
  const first = calls.at(-2);
  const hist = JSON.stringify(first.messages);
  assert.ok(hist.includes('[Yesterday'), hist.slice(0, 300));
  assert.ok(hist.includes('[Today'));
  const toolTurn = calls.at(-1).messages.at(-1).content;
  const totalsNote = toolTurn.find((c) => c.type === 'text' && c.text.includes("today's totals"));
  assert.ok(totalsNote, JSON.stringify(toolTurn));
  assert.match(totalsNote.text, /830 cal/);
  assert.match(totalsNote.text, /2 meals/);
});

test('placeholder "Test" meal is refused; profile saves don\'t trip the safety net', async () => {
  const { rejectEntry } = await import('../netlify/functions/lib/tools.mjs');
  assert.ok(rejectEntry('log_meal', { description: 'Test' }));
  assert.ok(rejectEntry('log_meal', { description: 'lunch', items: [] }));
  assert.equal(rejectEntry('log_meal', { description: '2 eggs', items: [{ name: 'eggs', qty: '2', calories: 140, protein_g: 12, fiber_g: 0, processing: 'whole' }] }), null);

  queue.push(
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'g', name: 'log_meal', input: { description: '2 eggs', items: [{ name: 'eggs', qty: '2', calories: 140, protein_g: 12, fiber_g: 0, processing: 'whole' }] } },
      { type: 'tool_use', id: 't', name: 'log_meal', input: { description: 'Test' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged your eggs.' }] },
  );
  const r = await (await handler(req('good', { text: '2 eggs', tz: 'America/New_York' }))).json();
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].description, '2 eggs');
  assert.match(JSON.stringify(calls.at(-1).messages.at(-1).content), /not saved/);

  const before = calls.length;
  queue.push(
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'p', name: 'save_profile', input: { restrictions: [], allergies: [] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Saved — no restrictions or allergies.' }] },
  );
  const p = await (await handler(req('good', { text: 'no restrictions, no allergies', tz: 'America/New_York' }))).json();
  assert.equal(p.reply, 'Saved — no restrictions or allergies.');
  assert.equal(calls.length, before + 2); // no corrective round
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  await handler(req('good', { text: 'thanks', tz: 'America/New_York' }));
  assert.ok(JSON.stringify(calls.at(-1).messages).includes('profile settings'));
});
