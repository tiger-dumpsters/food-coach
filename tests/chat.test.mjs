process.env.REQUIRE_AI_CONSENT = 'false'; // most tests skip the first-run consent screen; one test turns it on
import { test, mock } from 'node:test';
import assert from 'node:assert';

// ---- in-memory Firestore fake ----
const store = new Map(); // path -> data
let idc = 0;
const sentinel = (k, v) => ({ __s: k, v });
const FieldValue = { serverTimestamp: () => new Date(), increment: (n) => sentinel('inc', n), arrayUnion: (...v) => sentinel('union', v), delete: () => sentinel('del') };
function applyVal(cur, v) {
  if (v && v.__s === 'union') return [...new Set([...(cur || []), ...v.v])];
  if (v && v.__s === 'inc') return (typeof cur === 'number' ? cur : 0) + v.v;
  return v;
}
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !v.__s;
function mergeInto(cur, data) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(data)) {
    if (v && v.__s === 'del') delete out[k];
    else if (isPlain(v) && isPlain(out[k])) out[k] = mergeInto(out[k], v);
    else if (isPlain(v)) out[k] = mergeInto({}, v);
    else out[k] = applyVal(out[k], v);
  }
  return out;
}
function docRef(path) {
  return {
    id: path.split('/').at(-1), path,
    async get() { const d = store.get(path); return { exists: !!d, id: this.id, data: () => d }; },
    async set(data, opts) { store.set(path, opts?.merge ? mergeInto(store.get(path), data) : data); },
    async update(p) { const cur = { ...(store.get(path) || {}) }; for (const [k, v] of Object.entries(p)) { if (k.includes('.')) { const [a, b] = k.split('.'); cur[a] = { ...(cur[a] || {}) }; if (v && v.__s === 'del') delete cur[a][b]; else cur[a][b] = v; } else if (v && v.__s === 'del') delete cur[k]; else cur[k] = applyVal(cur[k], v); } store.set(path, cur); },
    async delete() { store.delete(path); },
    collection(name) { return colRef(`${path}/${name}`); },
  };
}
function colRef(path, filters = [], order = null, lim = null) {
  return {
    doc: (id) => docRef(`${path}/${id ?? 'id' + (++idc)}`),
    async add(data) { const id = 'id' + (++idc); store.set(`${path}/${id}`, data); return docRef(`${path}/${id}`); },
    where: (f, op, v) => colRef(path, [...filters, [f, op, v]], order, lim),
    orderBy: (f, dir) => colRef(path, filters, [f, dir], lim),
    limit: (n) => colRef(path, filters, order, n),
    async get() {
      let docs = [...store.entries()].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
        .map(([k, v]) => ({ id: k.split('/').at(-1), data: () => v, ref: docRef(k) }));
      for (const [f, op, v] of filters) docs = docs.filter(d => op === '==' ? d.data()[f] === v : op === '<=' ? d.data()[f] <= v : d.data()[f] >= v);
      if (order) { docs.sort((a, b) => (a.data()[order[0]] > b.data()[order[0]] ? 1 : -1)); if (order[1] === 'desc') docs.reverse(); }
      if (lim) docs = docs.slice(0, lim);
      return { docs };
    },
  };
}
mock.module('firebase-admin/app', { namedExports: { initializeApp() {}, cert: () => ({}), getApps: () => [1] } });
const USERS = { good: { uid: 'u1', email: 'will@tigerdumpsters.com', name: 'Will Stewart' }, alexa: { uid: 'u2', email: 'alexa@example.com', name: 'Alexa Stewart' },
  sam: { uid: 'u3', email: 'sam@example.com', name: 'Sam Lee' }, jo: { uid: 'u4', email: 'jo@example.com', name: 'Jo Park' }, kim: { uid: 'u5', email: 'kim@example.com', name: 'Kim Ross' } };
const deletedAuth = [];
const lookedUp = [];
mock.module('firebase-admin/auth', { namedExports: { getAuth: () => ({ verifyIdToken: async (t) => { if (!USERS[t]) throw new Error('bad'); return USERS[t]; }, deleteUser: async (uid) => { deletedAuth.push(uid); }, getUserByEmail: async (e) => { lookedUp.push(e); const u = Object.values(USERS).find((x) => x.email === e); if (!u) throw new Error('no user'); return u; } }) } });
const fakeDb = {
  collection: (n) => colRef(n),
  // Transactions run one at a time, like Firestore's (which retries on conflict).
  _tx: Promise.resolve(),
  async runTransaction(fn) {
    const run = this._tx.then(() => fn({ get: (ref) => ref.get(), update: (ref, p) => ref.update(p), set: (ref, d, o) => ref.set(d, o), delete: (ref) => ref.delete() }));
    this._tx = run.catch(() => {});
    return run;
  },
};
mock.module('firebase-admin/firestore', { namedExports: { getFirestore: () => fakeDb, FieldValue } });
const pushed = [];
let vapidMade = 0;
const fcmSent = [];
mock.module('firebase-admin/messaging', { namedExports: { getMessaging: () => ({ send: async (m) => {
  if (m.token.includes('dead')) { const e = new Error('gone'); e.code = 'messaging/registration-token-not-registered'; throw e; }
  fcmSent.push(m); return 'msg-id';
} }) } });
mock.module('web-push', { defaultExport: {
  generateVAPIDKeys: () => { vapidMade++; return { publicKey: 'PUB' + vapidMade, privateKey: 'PRIV' + vapidMade }; },
  sendNotification: async (sub, payload) => {
    if (sub.endpoint.includes('dead')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  },
} });

// ---- fake Claude: first call logs a meal + hunger, second returns text ----
const calls = [];
const queue = []; // scripted responses; when empty, fall back to the default pair
const stripeCalls = [];
const sentryCalls = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.revenuecat.com/')) {
    const uid = decodeURIComponent(String(url).split('/subscribers/')[1]);
    const exp = new Date(Date.now() + 6 * 864e5).toISOString();
    const subscriber = uid === 'u3'
      ? { entitlements: { plus: { expires_date: exp, product_identifier: 'hungerhush_plus_monthly' } }, subscriptions: { hungerhush_plus_monthly: { period_type: 'trial', is_sandbox: true } } }
      : { entitlements: {}, subscriptions: {} };
    return { ok: true, json: async () => ({ subscriber }) };
  }
  if (String(url).includes('/envelope/')) { sentryCalls.push({ url: String(url), headers: init.headers, body: init.body }); return { ok: true }; }
  if (String(url).startsWith('https://api.stripe.com/')) {
    stripeCalls.push({ url: String(url), body: init.body ? new URLSearchParams(init.body) : null });
    const path = String(url).slice('https://api.stripe.com/v1/'.length);
    const data = path.startsWith('checkout/') ? { url: 'https://checkout.stripe.com/c/test' }
      : path.startsWith('billing_portal/') ? { url: 'https://billing.stripe.com/p/test' }
      : path.startsWith('subscriptions/') ? { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_end: 1800000000 }] }, metadata: {} }
      : {};
    return { ok: true, json: async () => data };
  }
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
  assert.match(j.reply, /short break/);
  assert.doesNotMatch(j.reply, /API|Admin|console/);
  assert.ok(lookedUp.includes('will@tigerdumpsters.com'), 'admins alerted');
  assert.ok(store.get('config/alerts')['HungerHush is out of API credit']);
  // a second failure within the hour doesn't alert again
  const before = lookedUp.length;
  await handler(req('good', { text: 'and now?', tz: 'America/New_York' }));
  globalThis.fetch = realFetch;
  assert.equal(lookedUp.length, before);
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
  assert.ok(hist.includes('[app: saved — meal') && hist.includes('3 pieces grilled chicken'), hist.slice(-600));
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

test('flag: saves the reply with recent context for review and marks the message', async () => {
  const { default: flag } = await import('../netlify/functions/flag.mjs');
  for (const k of [...store.keys()]) if (k.startsWith('users/u1/messages/')) store.delete(k);
  const t0 = Date.now();
  store.set('users/u1/messages/f1', { role: 'user', text: 'no restrictions', createdAt: new Date(t0 - 2000), day: 'x' });
  store.set('users/u1/messages/f2', { role: 'assistant', text: 'My last reply said "saved," not "logged"…', createdAt: new Date(t0 - 1000), entries: [{ kind: 'profile' }], model: 'claude-haiku-5-5' });
  store.set('users/u1/messages/f3', { role: 'user', text: 'later message', createdAt: new Date(t0), day: 'x' });
  const freq = (body, token = 'good') => new Request('http://x/flag', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const r = await (await flag(freq({ messageId: 'f2', note: 'weird defensive reply' }))).json();
  assert.ok(r.ok);
  const saved = store.get(`flags/${r.flagId}`);
  assert.equal(saved.note, 'weird defensive reply');
  assert.equal(saved.email, 'will@tigerdumpsters.com');
  assert.deepEqual(saved.transcript.map((m) => m.id), ['f1', 'f2']); // nothing after the flagged reply
  assert.equal(store.get('users/u1/messages/f2').flagged, true);
  const other = await flag(freq({ messageId: 'f2' }, 'alexa')); // can't flag someone else's message
  assert.equal(other.status, 404);
});

test('coach instructions: positive tone, no unprompted totals or next-meal advice', async () => {
  const { buildSystem } = await import('../netlify/functions/lib/prompt.mjs');
  const sys = buildSystem({ profile: { onboarded: true }, clock: makeClock('America/New_York'), today: { meals: [], workouts: [], checkins: [] }, week: [], recentWeights: [] });
  assert.match(sys, /positive and reinforcing/);
  assert.match(sys, /Never criticize or police what they ate/);
  assert.match(sys, /Don't follow up with day totals, gaps, targets, or what the next meal should be/);
  assert.doesNotMatch(sys, /Point out gaps when they matter/);
});

test('occasions: holidays and Mondays', async () => {
  const { occasionFor } = await import('../netlify/functions/lib/occasions.mjs');
  assert.equal(occasionFor('2026-10-31').name, 'Halloween');
  assert.equal(occasionFor('2026-11-26').name, 'Thanksgiving');
  assert.equal(occasionFor('2026-09-07').name, 'Labor Day');
  assert.equal(occasionFor('2026-05-25').name, 'Memorial Day');
  assert.equal(occasionFor('2026-04-05').name, 'Easter');
  assert.equal(occasionFor('2027-03-28').name, 'Easter');
  assert.equal(occasionFor('2026-07-04').name, 'the Fourth of July');
  assert.equal(occasionFor('2026-11-02').kind, 'monday');
  assert.equal(occasionFor('2026-11-01'), null);
});

test('morning notes: one supportive note on Halloween, none twice, none when off', async () => {
  const { runMorning, factsFor } = await import('../netlify/functions/morning.mjs');
  for (const k of [...store.keys()]) if (k.startsWith('users/')) store.delete(k);
  const recent = new Date('2026-10-30T15:00:00Z');
  store.set('users/u1', { onboarded: true, name: 'Will', tz: 'America/New_York', lastActiveAt: recent, targets: { protein_g: 160 } });
  store.set('users/u2', { onboarded: true, name: 'Alexa', tz: 'America/New_York', lastActiveAt: recent, morning_notes: false });
  store.set('users/u3', { onboarded: true, name: 'Old', tz: 'America/New_York', lastActiveAt: new Date('2026-09-01T00:00:00Z') });
  store.set('users/u1/meals/a', { day: '2026-10-30', calories: 2000, protein_g: 150, fiber_g: 30, processing_mix: { whole: 1500, processed: 300, ultraprocessed: 200 } });
  store.set('users/u1/meals/b', { day: '2026-10-29', calories: 1900, protein_g: 120, fiber_g: 25 });
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: "Happy Halloween, Will! You've logged every day lately. Enjoy the treats." }] });
  const sent = await runMorning(new Date('2026-10-31T17:00:00Z')); // 1 pm in Andover
  assert.deepEqual(sent, ['u1']);
  const notes = [...store.entries()].filter(([k, v]) => k.startsWith('users/u1/messages/') && v.kind === 'morning');
  assert.equal(notes.length, 1);
  assert.match(notes[0][1].text, /Halloween/);
  const prompt = calls.at(-1).messages[0].content;
  assert.match(prompt, /Halloween \(holiday\)/);
  assert.match(prompt, /Days logged in the last 3: 2/);
  assert.deepEqual(await runMorning(new Date('2026-10-31T18:00:00Z')), []); // already sent today
  assert.deepEqual(await runMorning(new Date('2026-11-01T14:00:00Z')), []); // ordinary Sunday
  assert.deepEqual(await runMorning(new Date('2026-11-02T10:00:00Z')), []); // Monday 5 am: too early
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Morning, Will. New week!' }] });
  assert.deepEqual(await runMorning(new Date('2026-11-02T13:00:00Z')), ['u1']); // Monday 8 am
  assert.ok(factsFor('Will', { kind: 'monday' }, [], {}, '2026-11-02').includes('Monday'));
});

test('morning notes reach older accounts with no activity timestamp', async () => {
  const { runMorning } = await import('../netlify/functions/morning.mjs');
  for (const k of [...store.keys()]) if (k.startsWith('users/')) store.delete(k);
  store.set('users/u9', { onboarded: true, name: 'Sofia' });
  store.set('users/u9/messages/m', { role: 'user', text: 'eggs', createdAt: new Date('2026-10-30T12:00:00Z') });
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Happy Halloween, Sofia!' }] });
  assert.deepEqual(await runMorning(new Date('2026-10-31T17:00:00Z')), ['u9']);
});

test('push: keys made once, subscribe, test send, dead devices removed, morning note pushes', async () => {
  const { default: push } = await import('../netlify/functions/push.mjs');
  const preq = (body, token = 'good') => new Request('http://x/push', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  for (const k of [...store.keys()]) if (k.startsWith('users/') || k.startsWith('config/')) store.delete(k);
  const k1 = await (await push(preq({ action: 'key' }))).json();
  const k2 = await (await push(preq({ action: 'key' }))).json();
  assert.equal(k1.publicKey, k2.publicKey);
  assert.equal(vapidMade, 1);
  assert.ok(store.get('config/vapid').privateKey);
  const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
  assert.equal((await push(preq({ action: 'subscribe', subscription: sub('https://push.example/phone') }))).status, 200);
  await push(preq({ action: 'subscribe', subscription: sub('https://push.example/dead') }));
  assert.equal(store.get('users/u1').push_enabled, true);
  const t = await (await push(preq({ action: 'test' }))).json();
  assert.equal(t.sent, 1);
  assert.equal([...store.keys()].filter((k) => k.startsWith('users/u1/push/')).length, 1); // dead one removed
  assert.equal((await push(preq({ action: 'subscribe', subscription: { endpoint: 'x' } }))).status, 400);

  const { runMorning } = await import('../netlify/functions/morning.mjs');
  store.set('users/u1', { ...store.get('users/u1'), onboarded: true, name: 'Will', tz: 'America/New_York', lastActiveAt: new Date('2026-12-24T12:00:00Z') });
  pushed.length = 0;
  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Merry Christmas, Will! Enjoy every bite today.' }] });
  assert.deepEqual(await runMorning(new Date('2026-12-25T14:00:00Z')), ['u1']);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.title, 'Happy Christmas');
  assert.match(pushed[0].payload.body, /Merry Christmas/);
});

test('invite links: a friend not on the list gets in through a link; limits hold', async () => {
  const { default: acc } = await import('../netlify/functions/access.mjs');
  const areq = (token, body) => new Request('http://x/access', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  // Sam isn't on the list: chat is closed, status says no access
  assert.equal((await handler(req('sam', { text: 'hi', tz: 'America/New_York' }))).status, 403);
  assert.equal((await (await acc(areq('sam', { action: 'status' }))).json()).access, false);
  assert.equal((await acc(areq('sam', { action: 'invite' }))).status, 403);
  // Will makes a link (same code on repeat)
  const inv = await (await acc(areq('good', { action: 'invite' }))).json();
  assert.match(inv.code, /^[A-Z2-9]{8}$/);
  assert.equal((await (await acc(areq('good', { action: 'invite' }))).json()).code, inv.code);
  // bad code fails, real code works
  assert.equal((await acc(areq('sam', { action: 'redeem', code: 'NOPE1234' }))).status, 400);
  const ok = await (await acc(areq('sam', { action: 'redeem', code: inv.code.toLowerCase() }))).json();
  assert.equal(ok.access, true);
  assert.equal(store.get('users/u3').invitedBy, 'u1');
  assert.equal(store.get(`accessInvites/${inv.code}`).uses, 1);
  assert.equal((await handler(req('sam', { text: 'hi', tz: 'America/New_York' }))).status, 200);
  // used-up link
  store.set(`accessInvites/${inv.code}`, { ...store.get(`accessInvites/${inv.code}`), max: 1 });
  const used = await acc(areq('jo', { action: 'redeem', code: inv.code }));
  assert.equal(used.status, 400);
  assert.match((await used.json()).error, /used up/);
  // master beta code
  process.env.BETA_CODE = 'FRIENDS';
  assert.equal((await (await acc(areq('jo', { action: 'redeem', code: 'friends' }))).json()).access, true);
  delete process.env.BETA_CODE;
});

test('household code also lets a new person in; other household actions still need access', async () => {
  const { default: hh } = await import('../netlify/functions/household.mjs');
  const hreq = (token, body) => new Request('http://x/household', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  assert.equal((await hh(hreq('kim', { action: 'invite' }))).status, 403);
  const inv = await (await hh(hreq('sam', { action: 'invite' }))).json();
  const r = await hh(hreq('kim', { action: 'join', code: inv.code }));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(store.get('users/u5').access, true);
  assert.equal(store.get('users/u5').invitedBy, 'u3');
});

test('daily message cap', async () => {
  process.env.DAILY_MESSAGE_CAP = '1';
  const day = makeClock('America/New_York').day;
  store.set('usage/u4', { day, count: 0 });
  assert.equal((await handler(req('jo', { text: 'eggs', tz: 'America/New_York' }))).status, 200);
  const r = await handler(req('jo', { text: 'more eggs', tz: 'America/New_York' }));
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /limit/);
  store.set('usage/u4', { day: '2000-01-01', count: 99 }); // a new day resets
  assert.equal((await handler(req('jo', { text: 'eggs', tz: 'America/New_York' }))).status, 200);
  delete process.env.DAILY_MESSAGE_CAP;
});

test('a retried message (same id) is answered once', async () => {
  const before = [...store.keys()].filter((k) => k.startsWith('users/u1/messages/')).length;
  const r1 = await handler(req('good', { text: 'an apple', tz: 'America/New_York', cid: 'abc-123' }));
  assert.equal(r1.status, 200);
  const r2 = await (await handler(req('good', { text: 'an apple', tz: 'America/New_York', cid: 'abc-123' }))).json();
  assert.equal(r2.duplicate, true);
  assert.equal([...store.keys()].filter((k) => k.startsWith('users/u1/messages/')).length, before + 2);
});

test('tiers: off by default, everyone has Plus features', async () => {
  const { planFor } = await import('../netlify/functions/lib/plans.mjs');
  assert.equal(planFor({}), 'plus');
});

test('tiers on: free plan locks photos, household invites and the smart model; comp and paid unlock', async () => {
  process.env.TIERS_ENABLED = 'true';
  const { default: hh } = await import('../netlify/functions/household.mjs');
  const { default: billing } = await import('../netlify/functions/billing.mjs');
  const breq = (fn, token, body) => new Request('http://x/' + fn, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  store.set('users/u4', { ...store.get('users/u4'), onboarded: true, householdId: null });
  store.delete('usage/u4');
  // photo refused with an upgrade note
  const ph = await handler(req('jo', { text: '', tz: 'America/New_York', image: { media_type: 'image/jpeg', data: 'abc' } }));
  assert.equal(ph.status, 402);
  assert.equal((await ph.json()).code, 'upgrade');
  // questions run on the fast model
  const n = calls.length;
  await handler(req('jo', { text: 'why am I always hungry at 3pm?', tz: 'America/New_York' }));
  assert.equal(calls[n].model, 'claude-haiku-5-5');
  // household invite is Plus
  assert.equal((await hh(breq('household', 'jo', { action: 'invite' }))).status, 402);
  // status
  const st = await (await billing(breq('billing', 'jo', { action: 'status' }))).json();
  assert.equal(st.plan, 'free'); assert.equal(st.limits.photos, false); assert.equal(st.limits.messagesPerDay, 25); assert.equal(st.billingReady, false);
  // free cap
  process.env.FREE_MESSAGES_PER_DAY = '1';
  const capped = await handler(req('jo', { text: 'eggs', tz: 'America/New_York' }));
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /free plan/);
  delete process.env.FREE_MESSAGES_PER_DAY;
  // comped friend gets Plus
  store.set('users/u4', { ...store.get('users/u4'), comp: true });
  assert.equal((await (await billing(breq('billing', 'jo', { action: 'status' }))).json()).plan, 'plus');
  store.set('users/u4', { ...store.get('users/u4'), comp: false });
  delete process.env.TIERS_ENABLED;
});

test('stripe: checkout link, signed webhook turns on Plus, cancel turns it off, bad signature refused', async () => {
  process.env.TIERS_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_1'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const { default: billing } = await import('../netlify/functions/billing.mjs');
  const { default: hook } = await import('../netlify/functions/stripe-webhook.mjs');
  const { signForTest } = await import('../netlify/functions/lib/stripe.mjs');
  const { planFor } = await import('../netlify/functions/lib/plans.mjs');
  const breq = (token, body) => new Request('http://x/billing', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const co = await (await billing(breq('jo', { action: 'checkout' }))).json();
  assert.equal(co.url, 'https://checkout.stripe.com/c/test');
  const sent = stripeCalls.at(-1).body;
  assert.equal(sent.get('client_reference_id'), 'u4'); assert.equal(sent.get('line_items[0][price]'), 'price_1'); assert.equal(sent.get('mode'), 'subscription');
  const send = (evt, sig) => { const raw = JSON.stringify(evt); return hook(new Request('http://x/hook', { method: 'POST', headers: { 'stripe-signature': sig ?? signForTest(raw, 'whsec_test') }, body: raw })); };
  // forged
  assert.equal((await send({ type: 'checkout.session.completed', data: { object: {} } }, 't=1,v1=bad')).status, 400);
  // paid
  const r = await send({ type: 'checkout.session.completed', created: 100, data: { object: { mode: 'subscription', client_reference_id: 'u4', customer: 'cus_1', subscription: 'sub_1' } } });
  assert.equal(r.status, 200);
  assert.equal(planFor(store.get('users/u4')), 'plus');
  assert.equal(store.get('users/u4').stripeCustomerId, 'cus_1');
  assert.equal(store.get('stripeCustomers/cus_1').uid, 'u4');
  // portal
  assert.equal((await (await billing(breq('jo', { action: 'portal' }))).json()).url, 'https://billing.stripe.com/p/test');
  // a stale event doesn't undo a newer one; cancel does
  await send({ type: 'customer.subscription.updated', created: 50, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {} } } });
  assert.equal(planFor(store.get('users/u4')), 'plus');
  await send({ type: 'customer.subscription.deleted', created: 200, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {} } } });
  assert.equal(planFor(store.get('users/u4')), 'free');
  for (const k of ['TIERS_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET']) delete process.env[k];
});

test('delete account: log, chat, household seat, invites, flags, usage, subscription, and sign-in all go', async () => {
  const { default: account } = await import('../netlify/functions/account.mjs');
  const areq = (token, body) => new Request('http://x/account', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  // Kim (u5) is in Sam's household; give her some data, a Plus subscription, an invite, and a flag
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  store.set('users/u5', { ...store.get('users/u5'), stripeSubscriptionId: 'sub_9', stripeCustomerId: 'cus_9', planStatus: 'active', plan: 'plus' });
  store.set('stripeCustomers/cus_9', { uid: 'u5' });
  store.set('users/u5/meals/m1', { description: 'toast' });
  store.set('users/u5/messages/x1', { role: 'user', text: 'toast' });
  store.set('accessInvites/KIMCODE1', { by: 'u5', uses: 0, max: 25 });
  store.set('flags/f9', { uid: 'u5', note: 'odd' });
  store.set('usage/u5', { day: 'x', count: 3 });
  const hid = store.get('users/u5').householdId;
  assert.ok(hid && store.get(`households/${hid}`).members.includes('u5'));
  // needs the typed confirmation
  assert.equal((await account(areq('kim', { action: 'delete' }))).status, 400);
  const r = await account(areq('kim', { action: 'delete', confirm: 'DELETE' }));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal([...store.keys()].filter((k) => k.startsWith('users/u5')).length, 0);
  assert.ok(!store.get(`households/${hid}`).members.includes('u5'));
  assert.ok(store.get(`households/${hid}`).members.includes('u3'));
  for (const k of ['accessInvites/KIMCODE1', 'flags/f9', 'usage/u5', 'stripeCustomers/cus_9']) assert.equal(store.get(k), undefined, k);
  assert.ok(stripeCalls.some((c) => c.url.endsWith('subscriptions/sub_9')));
  assert.deepEqual(deletedAuth, ['u5']);
  // Sam's data untouched
  assert.ok(store.get('users/u3'));
  delete process.env.STRIPE_SECRET_KEY;
});

test('iPhone app notifications: register a token, send through FCM, drop dead tokens', async () => {
  const { default: push } = await import('../netlify/functions/push.mjs');
  const preq = (token, body) => new Request('http://x/push', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  assert.equal((await push(preq('alexa', { action: 'subscribe-native' }))).status, 400);
  assert.equal((await push(preq('alexa', { action: 'subscribe-native', token: 'tok-live', platform: 'ios' }))).status, 200);
  assert.equal((await push(preq('alexa', { action: 'subscribe-native', token: 'tok-dead' }))).status, 200);
  assert.equal(store.get('users/u2').push_enabled, true);
  const n = fcmSent.length;
  const r = await (await push(preq('alexa', { action: 'test' }))).json();
  assert.ok(r.sent >= 1);
  assert.equal(fcmSent.length, n + 1);
  assert.equal(fcmSent.at(-1).token, 'tok-live');
  assert.equal(fcmSent.at(-1).notification.title, 'HungerHush');
  const left = [...store.keys()].filter((k) => k.startsWith('users/u2/push/')).map((k) => store.get(k).fcmToken).filter(Boolean);
  assert.deepEqual(left, ['tok-live']);
  // token rotation replaces the old one; turning off removes it
  await push(preq('alexa', { action: 'subscribe-native', token: 'tok-new', replaces: 'tok-live' }));
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith('users/u2/push/')).map((k) => store.get(k).fcmToken).filter(Boolean), ['tok-new']);
  await push(preq('alexa', { action: 'unsubscribe-native', token: 'tok-new' }));
  assert.equal([...store.keys()].filter((k) => k.startsWith('users/u2/push/') && store.get(k).fcmToken).length, 0);
});

test('save_profile only writes its own fields, with sane sizes', async () => {
  const { profilePatch } = await import('../netlify/functions/lib/tools.mjs');
  const p = profilePatch({
    name: 'Sam', comp: true, plan: 'plus', access: true, stripeCustomerId: 'x', push_enabled: true,
    allergies: Array(100).fill('peanuts'), sex: 'robot', goals: ['feel_full', 'hack'], age: 1e12,
    targets: { protein_g: 120, admin: 1 }, notes: 'x'.repeat(9999),
  });
  assert.deepEqual(Object.keys(p).sort(), ['age', 'allergies', 'goals', 'name', 'targets']);
  assert.equal(p.allergies.length, 40);
  assert.deepEqual(p.goals, ['feel_full']);
  assert.equal(p.age, 100000);
  assert.deepEqual(p.targets, { protein_g: 120 });
});

test('limits: changing the phone time zone does not reset the daily message count', async () => {
  process.env.DAILY_MESSAGE_CAP = '2';
  store.delete('usage/u2');
  assert.equal((await handler(req('alexa', { text: 'eggs', tz: 'America/New_York' }))).status, 200);
  assert.equal((await handler(req('alexa', { text: 'toast', tz: 'Pacific/Kiritimati' }))).status, 200);
  assert.equal((await handler(req('alexa', { text: 'more', tz: 'Pacific/Pago_Pago' }))).status, 429);
  delete process.env.DAILY_MESSAGE_CAP;
  store.delete('usage/u2');
});

test('limits: "redo setup" only gets the stronger model for the first messages of the day', async () => {
  process.env.TIERS_ENABLED = 'true'; process.env.ONBOARDING_SMART_MSGS = '1';
  store.set('users/u4', { ...store.get('users/u4'), onboarded: false, comp: false, plan: null });
  store.delete('usage/u4');
  let n = calls.length;
  await handler(req('jo', { text: 'hi, set me up', tz: 'America/New_York' }));
  assert.equal(calls[n].model, 'claude-sonnet-5-5');
  n = calls.length;
  await handler(req('jo', { text: 'eggs and toast', tz: 'America/New_York' }));
  assert.equal(calls[n].model, 'claude-haiku-5-5');
  delete process.env.TIERS_ENABLED; delete process.env.ONBOARDING_SMART_MSGS;
  store.set('users/u4', { ...store.get('users/u4'), onboarded: true });
});

test('daily spending ceiling: spend is recorded, and over the limit the coach pauses and admins hear once', async () => {
  const { costOf } = await import('../netlify/functions/lib/spend.mjs');
  assert.ok(Math.abs(costOf('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 12) < 1e-9);
  assert.ok(Math.abs(costOf('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 0.6) < 1e-9);
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(store.get(`spend/${day}`).usd > 0, 'spend recorded');
  assert.ok(store.get(`spend/${day}`).by.chat > 0);
  store.delete('config/alerts');
  process.env.DAILY_SPEND_LIMIT_USD = '0.000001';
  const n = calls.length, looked = lookedUp.length;
  const j = await (await handler(req('good', { text: 'eggs', tz: 'America/New_York' }))).json();
  assert.equal(calls.length, n, 'no Claude call over the ceiling');
  assert.match(j.reply, /short break/);
  assert.ok(lookedUp.length > looked, 'admins alerted');
  assert.ok(store.get('config/alerts')['HungerHush hit its daily spending limit']);
  delete process.env.DAILY_SPEND_LIMIT_USD;
});

test('rerate: runs once even if called twice at the same time, and gives up after 3 tries', async () => {
  const { default: rerate } = await import('../netlify/functions/rerate.mjs');
  const rreq = () => new Request('http://x/rerate', { method: 'POST', headers: { authorization: 'Bearer alexa' }, body: '{}' });
  store.set('users/u2', { ...store.get('users/u2'), rerated: null, rerateAttempts: 0, rerateStartedAt: 0 });
  const [a, b] = await Promise.all([rerate(rreq()), rerate(rreq())]);
  const statuses = [await a.json(), await b.json()].map((r) => r.status || 'ran');
  assert.ok(statuses.includes('running') || statuses.includes('done'), JSON.stringify(statuses));
  store.set('users/u2', { ...store.get('users/u2'), rerated: null, rerateAttempts: 3, rerateStartedAt: 0 });
  assert.equal((await (await rerate(rreq())).json()).status, 'gave-up');
});

test('the coach only sees the profile fields it needs, trimmed', async () => {
  const { profileForPrompt } = await import('../netlify/functions/lib/prompt.mjs');
  const p = profileForPrompt({ name: 'Sam', email: 'sam@example.com', stripeCustomerId: 'cus_1', plan: 'plus', comp: true, access: true,
    allergies: ['x'.repeat(5000), ...Array(100).fill('nuts')], onboarded: true, targets: { protein_g: 100 } });
  assert.deepEqual(Object.keys(p).sort(), ['allergies', 'name', 'onboarded', 'targets']);
  assert.equal(p.allergies.length, 40);
  assert.equal(p.allergies[0].length, 80);
});

test('monitoring: errors reach Sentry without anyone\'s chat text; repeated failures alert; health check works', async () => {
  const { reportError, countError, monitored } = await import('../netlify/functions/lib/monitor.mjs');
  // no DSN: nothing sent
  assert.equal(await reportError(new Error('x')), false);
  process.env.SENTRY_DSN = 'https://abc123@o1.ingest.us.sentry.io/4507';
  assert.equal(await reportError(new Error('Claude API 529: overloaded'), { where: 'chat' }), true);
  const sc = sentryCalls.at(-1);
  assert.equal(sc.url, 'https://o1.ingest.us.sentry.io/api/4507/envelope/');
  assert.match(sc.headers['x-sentry-auth'], /sentry_key=abc123/);
  const event = JSON.parse(sc.body.trim().split('\n')[2]);
  assert.equal(event.exception.values[0].value, 'Claude API 529: overloaded');
  assert.equal(event.tags.function, 'chat');
  // a crash inside a function becomes a clean 500 and a report
  const n = sentryCalls.length;
  const r = await monitored('billing', async () => { throw new Error('boom'); })(new Request('http://x'));
  assert.equal(r.status, 500);
  assert.equal(sentryCalls.length, n + 1);
  // one hiccup doesn't alert; three in an hour do
  store.delete('config/alerts');
  const before = lookedUp.length;
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  const db = getFirestore(), auth = getAuth();
  await countError(db, auth, 'chat replies failing', 'e1');
  await countError(db, auth, 'chat replies failing', 'e2');
  assert.equal(lookedUp.length, before);
  await countError(db, auth, 'chat replies failing', 'e3');
  assert.ok(lookedUp.length > before);
  delete process.env.SENTRY_DSN;
  // health
  const { default: health } = await import('../netlify/functions/health.mjs');
  process.env.ANTHROPIC_API_KEY ||= 'k'; process.env.FIREBASE_SERVICE_ACCOUNT ||= '{}';
  const h = await health();
  assert.equal(h.status, 200);
  assert.deepEqual((await h.json()).checks, { keys: true, database: true });
});

test('speed: a simple log that comes back with its reply takes one coach call, a question still gets two', async () => {
  const logResp = () => ({ stop_reason: 'tool_use', content: [
    { type: 'text', text: 'Nice, oatmeal is a great start.' },
    { type: 'tool_use', id: 't' + Math.random(), name: 'log_meal', input: { meal: 'breakfast', description: 'oatmeal', items: [{ name: 'oatmeal', calories: 150, protein_g: 5, fiber_g: 4, fat_g: 3, carbs_g: 27, processing: 'whole' }] } },
  ] });
  queue.length = 0;
  queue.push(logResp());
  let n = calls.length;
  const j = await (await handler(req('alexa', { text: 'oatmeal for breakfast', tz: 'America/New_York' }))).json();
  assert.equal(calls.length - n, 1, 'one call');
  assert.equal(j.reply, 'Nice, oatmeal is a great start.');
  assert.equal(j.entries.length, 1);
  // a question needs the coach to see the saved result first
  queue.push(logResp(), { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged. Want ideas for lunch?' }] });
  n = calls.length;
  await handler(req('alexa', { text: 'had oatmeal, what should I eat for lunch?', tz: 'America/New_York' }));
  assert.equal(calls.length - n, 2, 'two calls');
  queue.length = 0;
});

test('reliability: Claude busy (529) gets one quick retry; a stuck call times out', async () => {
  const { callClaude } = await import('../netlify/functions/chat.mjs');
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => (++n === 1
    ? { ok: false, status: 529, text: async () => 'overloaded' }
    : { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) });
  const r = await callClaude({ model: 'claude-haiku-5-5', system: [], messages: [] });
  assert.equal(n, 2);
  assert.equal(r.content[0].text, 'ok');
  // a second busy signal is not retried forever
  n = 0;
  globalThis.fetch = async () => { n++; return { ok: false, status: 529, text: async () => 'overloaded' }; };
  await assert.rejects(callClaude({ model: 'claude-haiku-5-5', system: [], messages: [] }), /529/);
  assert.equal(n, 2);
  // out of credit is not retried
  n = 0;
  globalThis.fetch = async () => { n++; return { ok: false, status: 400, text: async () => 'Your credit balance is too low' }; };
  await assert.rejects(callClaude({ model: 'claude-haiku-5-5', system: [], messages: [] }), /credit/);
  assert.equal(n, 1);
  // a call that hangs is cut off
  globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
  const keepAlive = setTimeout(() => {}, 7_000); // AbortSignal.timeout's timer doesn't hold the test open
  await assert.rejects(callClaude({ model: 'claude-haiku-5-5', system: [], messages: [], timeoutMs: 5_000 }), /timeout/);
  clearTimeout(keepAlive);
  globalThis.fetch = realFetch;
});

test('App Store purchases: RevenueCat webhook sets Plus, cancel keeps it until expiry, expiry ends it, stale and forged events ignored', async () => {
  process.env.TIERS_ENABLED = 'true'; process.env.REVENUECAT_WEBHOOK_AUTH = 'rc-secret';
  const { default: hook } = await import('../netlify/functions/revenuecat-webhook.mjs');
  const { planFor } = await import('../netlify/functions/lib/plans.mjs');
  const send = (event, auth = 'rc-secret') => hook(new Request('http://x/rc', { method: 'POST', headers: { authorization: auth }, body: JSON.stringify({ event }) }));
  store.set('users/u4', { ...store.get('users/u4'), comp: false, plan: null, planStatus: null, planEventAt: 0, planSource: null });
  const base = { app_user_id: 'u4', product_id: 'hungerhush_plus_monthly', entitlement_ids: ['plus'], environment: 'SANDBOX' };
  const future = Date.now() + 30 * 864e5;
  assert.equal((await send({ ...base, type: 'INITIAL_PURCHASE' }, 'wrong')).status, 401);
  assert.equal((await send({ ...base, type: 'INITIAL_PURCHASE', period_type: 'TRIAL', expiration_at_ms: future, event_timestamp_ms: 1000_000 })).status, 200);
  let u = store.get('users/u4');
  assert.equal(u.planStatus, 'trialing'); assert.equal(u.planSource, 'apple'); assert.equal(planFor(u), 'plus');
  await send({ ...base, type: 'CANCELLATION', period_type: 'NORMAL', expiration_at_ms: future, event_timestamp_ms: 2000_000 });
  u = store.get('users/u4');
  assert.equal(planFor(u), 'plus'); assert.equal(u.planCancelAtPeriodEnd, true);
  await send({ ...base, type: 'RENEWAL', expiration_at_ms: future, event_timestamp_ms: 1500_000 }); // late, older event
  assert.equal(store.get('users/u4').planCancelAtPeriodEnd, true);
  await send({ ...base, type: 'EXPIRATION', expiration_at_ms: Date.now() - 1000, event_timestamp_ms: 3000_000 });
  assert.equal(planFor(store.get('users/u4')), 'free');
  assert.equal((await (await send({ ...base, type: 'TEST' })).text()), 'ignored');
  delete process.env.TIERS_ENABLED; delete process.env.REVENUECAT_WEBHOOK_AUTH;
});

test('App Store purchases: right after buying, the app syncs from RevenueCat and gets Plus', async () => {
  process.env.TIERS_ENABLED = 'true'; process.env.REVENUECAT_SECRET_KEY = 'sk_test';
  const { default: billing } = await import('../netlify/functions/billing.mjs');
  store.set('users/u3', { ...store.get('users/u3'), comp: false, plan: null, planStatus: null, planEventAt: 0, planSource: null });
  const r = await (await billing(new Request('http://x/billing', { method: 'POST', headers: { authorization: 'Bearer sam' }, body: JSON.stringify({ action: 'sync-apple' }) }))).json();
  assert.equal(r.plan, 'plus'); assert.equal(r.source, 'apple');
  assert.equal(store.get('users/u3').planStatus, 'trialing');
  delete process.env.TIERS_ENABLED; delete process.env.REVENUECAT_SECRET_KEY;
});

test('Apple Health: workouts are mapped, saved once, and put on the right day', async () => {
  const { default: hs, toEntry } = await import('../netlify/functions/health-sync.mjs');
  const e = toEntry({ id: 'A1-B2', type: 'runningTreadmill', start: '2026-11-10T03:30:00Z', durationSec: 1830, kcal: 301.4, meters: 4828, source: 'Apple Watch' }, 'America/New_York');
  assert.deepEqual([e.type, e.day, e.duration_min, e.calories, e.distance, e.source], ['Running', '2026-11-09', 31, 301, 3, 'apple_health']);
  assert.equal(toEntry({ id: 'x', type: 'pilates', start: '2026-11-10T15:00:00Z', durationSec: 600 }, 'UTC').notes, 'pilates');
  const hreq = (workouts) => new Request('http://x/hs', { method: 'POST', headers: { authorization: 'Bearer alexa' }, body: JSON.stringify({ workouts, tz: 'America/New_York' }) });
  const w = [{ id: 'HK-1', type: 'walking', start: '2026-11-10T14:00:00Z', durationSec: 1800 }, { id: 'HK-2', type: 'yoga', start: '2026-11-10T22:00:00Z', durationSec: 2400 }];
  assert.equal((await (await hs(hreq(w))).json()).added, 2);
  assert.equal((await (await hs(hreq(w))).json()).added, 0, 'no duplicates on re-sync');
  assert.equal(store.get('users/u2/workouts/hk_HK-1').type, 'Walking');
  assert.equal(store.get('users/u2').health_connected, true);
});

test('AI consent: no coach call until the person agrees (and confirms 18+)', async () => {
  process.env.REQUIRE_AI_CONSENT = 'true';
  const { default: acc } = await import('../netlify/functions/access.mjs');
  store.set('users/u2', { ...store.get('users/u2'), aiConsentAt: null });
  const n = calls.length;
  const r = await handler(req('alexa', { text: 'eggs', tz: 'America/New_York' }));
  assert.equal(r.status, 428); assert.equal((await r.json()).code, 'consent');
  assert.equal(calls.length, n);
  const areq = (body) => new Request('http://x/access', { method: 'POST', headers: { authorization: 'Bearer alexa' }, body: JSON.stringify(body) });
  assert.equal((await acc(areq({ action: 'consent', ai: true }))).status, 400);
  assert.equal((await acc(areq({ action: 'consent', ai: true, adult: true }))).status, 200);
  assert.ok(store.get('users/u2').aiConsentAt && store.get('users/u2').ageConfirmedAt);
  store.delete('usage/u2');
  assert.equal((await handler(req('alexa', { text: 'eggs', tz: 'America/New_York' }))).status, 200);
  process.env.REQUIRE_AI_CONSENT = 'false';
});
