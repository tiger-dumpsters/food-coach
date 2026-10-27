import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getFirestore, doc, collection, query, where, orderBy, limit, onSnapshot, getDocs,
  setDoc, updateDoc,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  profile: null,
  messages: [],
  pending: null,          // text of a message waiting for a reply
  view: 'chat',
  today: { meals: [], workouts: [], checkins: [], weighins: [] },
  unsub: [],
};

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function localDay(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function dayMinus(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  return new Date(v);
}
function hhmm(d) {
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
function r(n) { return n == null ? '–' : Math.round(n); }
function hideCal() { return !!state.profile?.hide_calories; }
function rows(snap) { return snap.docs.map((d) => ({ id: d.id, ...d.data() })); }

// Minimal formatting for coach replies: **bold** and line breaks only.
function fmtText(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// ---------- auth ----------
$('#signin-btn').addEventListener('click', async () => {
  const provider = new GoogleAuthProvider();
  $('#signin-error').hidden = true;
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else if (err.code !== 'auth/popup-closed-by-user') {
      $('#signin-error').textContent = 'Sign-in failed: ' + (err.message || err.code);
      $('#signin-error').hidden = false;
    }
  }
});
getRedirectResult(auth).catch(() => {});

onAuthStateChanged(auth, (user) => {
  state.unsub.forEach((u) => u());
  state.unsub = [];
  state.user = user;
  $('#signin').hidden = !!user;
  $('#app').hidden = !user;
  if (user) startSession(user);
});

function startSession(user) {
  const uref = doc(db, 'users', user.uid);

  state.unsub.push(onSnapshot(uref, (snap) => {
    state.profile = snap.exists() ? snap.data() : null;
    document.querySelectorAll('.weight-only').forEach((el) => { el.hidden = !state.profile?.track_weight; });
    renderThread();
    if (state.view === 'today') renderToday();
    if (state.view === 'settings') renderSettings();
  }));

  const mq = query(collection(uref, 'messages'), orderBy('createdAt', 'desc'), limit(80));
  state.unsub.push(onSnapshot(mq, (snap) => {
    state.messages = rows(snap).reverse();
    renderThread();
  }));

  const day = localDay();
  for (const col of ['meals', 'workouts', 'checkins', 'weighins']) {
    const q = query(collection(uref, col), where('day', '==', day));
    state.unsub.push(onSnapshot(q, (snap) => {
      state.today[col] = rows(snap).sort((a, b) => (toDate(a.at) || 0) - (toDate(b.at) || 0));
      if (state.view === 'today') renderToday();
    }));
  }
}

// ---------- navigation ----------
const TITLES = { chat: 'Coach', today: 'Today', trends: 'Trends', settings: 'You' };
document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => show(btn.dataset.view));
});
function show(view) {
  state.view = view;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  for (const v of ['chat', 'today', 'trends', 'settings']) $(`#view-${v}`).hidden = v !== view;
  $('#view-title').textContent = TITLES[view];
  if (view === 'chat') scrollThread();
  if (view === 'today') renderToday();
  if (view === 'trends') renderTrends();
  if (view === 'settings') renderSettings();
}

// ---------- chat ----------
const input = $('#input');
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.pending) return;
  input.value = '';
  autosize();
  send(text);
});

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.send) { send(b.dataset.send); return; }
  input.value = b.dataset.fill || '';
  input.focus();
  autosize();
});

async function send(text) {
  state.pending = text;
  $('#send').disabled = true;
  renderThread();
  try {
    const token = await state.user.getIdToken();
    const res = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, tz: TZ }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }
    await res.json(); // messages arrive through the Firestore listener
  } catch (err) {
    state.messages.push({ id: 'err' + Date.now(), role: 'assistant', text: `Couldn't send that (${err.message}). Try again?`, local: true });
    input.value = input.value || text;
  } finally {
    state.pending = null;
    $('#send').disabled = false;
    renderThread();
  }
}

function renderThread() {
  const el = $('#thread');
  if (!state.user) return;
  const msgs = state.messages;

  if (!msgs.length && !state.pending) {
    const name = state.user.displayName?.split(' ')[0] || 'there';
    el.innerHTML = `
      <div class="welcome">
        <h2>Hi ${esc(name)}</h2>
        <p>I'm your food coach. Tell me what you eat, when you're hungry, and how you move — I'll keep track, point out gaps, and suggest what to eat next.</p>
        <p class="muted">Takes about three minutes to set up.</p>
        <button class="btn primary" id="start-onboarding">Let's get set up</button>
      </div>`;
    $('#start-onboarding').onclick = () => send("Hi! Let's get set up.");
    return;
  }

  let html = '';
  let lastDay = null;
  for (const m of msgs) {
    const at = toDate(m.createdAt) || new Date();
    const d = localDay(at);
    if (d !== lastDay) {
      html += `<div class="day-sep">${esc(dayLabel(d))}</div>`;
      lastDay = d;
    }
    html += msgHtml(m, at);
  }
  // Show the pending message until the server's copy arrives.
  if (state.pending) {
    const echoed = msgs.length && msgs.at(-1).role === 'user' && msgs.at(-1).text === state.pending;
    if (!echoed) html += msgHtml({ role: 'user', text: state.pending }, new Date());
    html += `<div class="msg assistant"><div class="bubble typing" aria-label="Coach is typing"><i></i><i></i><i></i></div></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.blur').forEach((b) => b.addEventListener('click', () => b.classList.toggle('revealed')));
  scrollThread();
}

function dayLabel(d) {
  const today = localDay();
  if (d === today) return 'Today';
  if (d === dayMinus(today, 1)) return 'Yesterday';
  return new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function msgHtml(m, at) {
  const cards = (m.entries || []).map(cardHtml).filter(Boolean).join('');
  return `
    <div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">
      <div class="bubble">${fmtText(m.text)}</div>
      ${cards ? `<div class="cards">${cards}</div>` : ''}
      <span class="time">${esc(hhmm(at))}</span>
    </div>`;
}

function cardHtml(e) {
  if (e.kind === 'profile') return `<div class="card"><span class="k">Profile updated</span></div>`;
  const del = e.deleted ? ' deleted' : '';
  if (e.deleted) return `<div class="card ${e.kind}${del}"><span class="k">Removed ${esc(e.kind)}</span></div>`;
  if (e.kind === 'meal') {
    const nums = [
      hideCal() ? '' : `~${r(e.calories)} cal`,
      `${r(e.protein_g)} g protein`,
      `${r(e.fiber_g)} g fiber`,
      e.fat_g != null ? `${r(e.fat_g)} g fat` : '',
    ].filter(Boolean).map((n) => `<span>${n}</span>`).join('');
    return `<div class="card meal">
      <span class="k">${e.updated ? 'Updated ' : ''}${esc(e.meal || 'Food')}${e.at ? ' · ' + esc(hhmm(new Date(e.at))) : ''}</span>
      <span class="title">${esc(e.description)}</span>
      <span class="nums">${nums}${e.processing ? `<span class="tag ${esc(e.processing)}">${esc(e.processing)}</span>` : ''}</span>
    </div>`;
  }
  if (e.kind === 'workout') {
    const bits = [e.duration_min ? `${r(e.duration_min)} min` : '', e.distance ? `${e.distance} ${e.distance_unit || ''}` : '', e.effort || ''].filter(Boolean);
    return `<div class="card workout"><span class="k">Workout</span><span class="title">${esc(e.type)}</span><span class="nums">${bits.map((b) => `<span>${esc(b)}</span>`).join('')}</span></div>`;
  }
  if (e.kind === 'hunger') {
    const labels = ['', 'Not hungry', 'A little hungry', 'Hungry', 'Very hungry', 'Starving'];
    return `<div class="card hunger"><span class="k">Hunger check-in</span><span class="title">${esc(labels[e.level] || e.level)}</span>${e.note ? `<span class="nums">${esc(e.note)}</span>` : ''}</div>`;
  }
  if (e.kind === 'weight') {
    return `<div class="card weight"><span class="k">Weigh-in · tap to show</span><span class="title blur">${esc(e.weight)} ${esc(e.unit)}</span></div>`;
  }
  return '';
}

function scrollThread() {
  const el = $('#thread');
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// ---------- Today ----------
function renderToday() {
  const el = $('#today');
  const { meals, workouts, checkins } = state.today;
  const t = sum(meals);
  const tg = state.profile?.targets || {};
  const nowH = new Date().getHours();

  const meter = (cls, label, val, target, unit) => {
    const pct = target ? Math.min(100, (val / target) * 100) : 0;
    return `<div class="meter ${cls}">
      <div class="row"><span>${label}</span><span><b>${r(val)}</b>${target ? ` / ${r(target)}` : ''} ${unit}</span></div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
    </div>`;
  };

  const calTarget = tg.calories_max || tg.calories_min;
  const meters = [
    meter('protein', 'Protein', t.protein_g, tg.protein_g, 'g'),
    meter('fiber', 'Fiber', t.fiber_g, tg.fiber_g, 'g'),
    meter('fat', 'Healthy fats', t.fat_g, tg.fat_g, 'g'),
    hideCal() ? '' : meter('cal', 'Calories', t.calories, calTarget, ''),
  ].join('');

  // Simple, honest gap hints (the coach does the nuanced version in chat).
  const gaps = [];
  if (meals.length) {
    if (tg.protein_g && t.protein_g < tg.protein_g * (nowH < 14 ? 0.3 : 0.6)) gaps.push(`Protein's running low — about ${r(tg.protein_g - t.protein_g)} g to go.`);
    if (tg.fiber_g && t.fiber_g < tg.fiber_g * (nowH < 14 ? 0.25 : 0.5)) gaps.push(`Fiber's light so far — beans, berries, veggies or whole grains would help.`);
    if (t.upf >= 2) gaps.push(`${t.upf} ultraprocessed items today — maybe make the next one whole food.`);
  }
  const gapHtml = meals.length
    ? `<ul class="gap-list">${gaps.length ? gaps.map((g) => `<li>${esc(g)}</li>`).join('') : '<li class="ok">Nothing flagged — nicely balanced so far.</li>'}</ul>`
    : '<p class="muted">Nothing logged yet today. Tell the coach what you had.</p>';

  const mix = mixHtml(meals);

  const log = [
    ...meals.map((m) => ({ at: toDate(m.at), label: m.description, n: [hideCal() ? '' : `${r(m.calories)} cal`, `${r(m.protein_g)}p`, `${r(m.fiber_g)}f`].filter(Boolean).join(' · ') })),
    ...workouts.map((w) => ({ at: toDate(w.at), label: `Workout: ${w.type}`, n: w.duration_min ? `${r(w.duration_min)} min` : '' })),
    ...checkins.map((c) => ({ at: toDate(c.at), label: `Hunger ${c.level}/5${c.note ? ' — ' + c.note : ''}`, n: '' })),
  ].sort((a, b) => (a.at || 0) - (b.at || 0));

  el.innerHTML = `
    <section class="panel">
      <h2>${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      ${tg.protein_g ? '' : '<p class="sub">Finish setup with the coach to get personal targets.</p>'}
      ${meters}
    </section>
    <section class="panel"><h2>Gaps to fill</h2>${gapHtml}</section>
    <section class="panel"><h2>Whole vs processed</h2>${mix}</section>
    <section class="panel"><h2>Log</h2>
      ${log.length ? `<ul class="log-list">${log.map((x) => `<li><span class="t">${esc(hhmm(x.at))}</span><span>${esc(x.label)}</span><span class="n">${esc(x.n)}</span></li>`).join('')}</ul>` : '<p class="muted">Empty so far.</p>'}
    </section>`;
}

function sum(meals) {
  const t = { calories: 0, protein_g: 0, fiber_g: 0, fat_g: 0, upf: 0 };
  for (const m of meals) {
    t.calories += m.calories || 0;
    t.protein_g += m.protein_g || 0;
    t.fiber_g += m.fiber_g || 0;
    t.fat_g += m.fat_g || 0;
    if (m.processing === 'ultraprocessed') t.upf++;
  }
  return t;
}

const MIX_COLORS = { whole: 'var(--accent)', processed: 'var(--amber)', mixed: 'var(--ink-3)', ultraprocessed: 'var(--warm)' };
function mixHtml(meals) {
  if (!meals.length) return '<p class="muted">Shows up once you log food.</p>';
  const c = { whole: 0, processed: 0, mixed: 0, ultraprocessed: 0 };
  meals.forEach((m) => { c[m.processing || 'mixed'] = (c[m.processing || 'mixed'] || 0) + 1; });
  const n = meals.length;
  const bar = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `<span style="width:${(v / n) * 100}%;background:${MIX_COLORS[k]}"></span>`).join('');
  const leg = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `<span><i style="background:${MIX_COLORS[k]}"></i>${k} ${v}</span>`).join('');
  return `<div class="mix">${bar}</div><div class="legend">${leg}</div>`;
}

// ---------- Trends ----------
async function renderTrends() {
  const el = $('#trends');
  el.innerHTML = '<p class="muted">Loading…</p>';
  const uref = doc(db, 'users', state.user.uid);
  const today = localDay();
  const start = dayMinus(today, 13);
  const [mS, wS, cS, kS] = await Promise.all([
    getDocs(query(collection(uref, 'meals'), where('day', '>=', start))),
    getDocs(query(collection(uref, 'workouts'), where('day', '>=', start))),
    getDocs(query(collection(uref, 'checkins'), where('day', '>=', start))),
    getDocs(query(collection(uref, 'weighins'), orderBy('at', 'desc'), limit(60))),
  ]);
  const meals = rows(mS), workouts = rows(wS), checkins = rows(cS), weights = rows(kS).reverse();

  const days = Array.from({ length: 14 }, (_, i) => dayMinus(today, 13 - i));
  const perDay = days.map((d) => {
    const dm = meals.filter((m) => m.day === d);
    const s = sum(dm);
    const dc = checkins.filter((c) => c.day === d);
    return { day: d, logged: dm.length > 0, ...s, meals: dm.length, workouts: workouts.filter((w) => w.day === d).length, hunger: dc.length ? dc.reduce((a, c) => a + c.level, 0) / dc.length : null };
  });
  const logged = perDay.filter((d) => d.logged);
  const tg = state.profile?.targets || {};
  const avg = (k) => logged.length ? logged.reduce((a, d) => a + d[k], 0) / logged.length : 0;
  const totalMeals = logged.reduce((a, d) => a + d.meals, 0);
  const upfShare = totalMeals ? Math.round((logged.reduce((a, d) => a + d.upf, 0) / totalMeals) * 100) : 0;
  const hungerDays = perDay.filter((d) => d.hunger != null);
  const hungerAvg = hungerDays.length ? (hungerDays.reduce((a, d) => a + d.hunger, 0) / hungerDays.length).toFixed(1) : '–';

  let weightHtml = '';
  if (state.profile?.track_weight) {
    const avg7 = movingAvg(weights);
    weightHtml = `<section class="panel"><h2>Weight</h2><p class="sub">7-day average — hidden until you tap.</p>
      <div class="blur" id="wchart">${avg7.length >= 2 ? lineChart(avg7) : '<p class="muted">A few more weigh-ins and a trend will show here.</p>'}</div></section>`;
  }

  el.innerHTML = `
    <section class="panel">
      <h2>Last 14 days</h2>
      <p class="sub">${logged.length} of 14 days logged</p>
      <div class="stat-row">
        <div class="stat"><div class="v">${r(avg('protein_g'))}<small> g</small></div><div class="l">avg protein</div></div>
        <div class="stat"><div class="v">${r(avg('fiber_g'))}<small> g</small></div><div class="l">avg fiber</div></div>
        <div class="stat"><div class="v">${upfShare}%</div><div class="l">ultraprocessed</div></div>
      </div>
    </section>
    <section class="panel chart"><h2>Protein by day</h2>${barChart(perDay, 'protein_g', tg.protein_g, 'var(--accent)')}</section>
    <section class="panel chart"><h2>Fiber by day</h2>${barChart(perDay, 'fiber_g', tg.fiber_g, 'var(--amber)')}</section>
    <section class="panel">
      <h2>Hunger & movement</h2>
      <div class="stat-row">
        <div class="stat"><div class="v">${hungerAvg}</div><div class="l">avg hunger (1–5)</div></div>
        <div class="stat"><div class="v">${hungerDays.length}</div><div class="l">days with check-ins</div></div>
        <div class="stat"><div class="v">${workouts.length}</div><div class="l">workouts</div></div>
      </div>
      <p class="sub" style="margin-top:12px">Ask the coach "what makes me hungriest?" for the patterns behind these.</p>
    </section>
    ${weightHtml}`;
  const w = $('#wchart');
  if (w) w.addEventListener('click', () => w.classList.toggle('revealed'));
}

function barChart(perDay, key, target, color) {
  const W = 340, H = 140, pad = 22, bw = (W - pad) / perDay.length;
  const max = Math.max(target || 0, ...perDay.map((d) => d[key])) * 1.15 || 10;
  const y = (v) => H - 18 - (v / max) * (H - 30);
  const bars = perDay.map((d, i) => {
    if (!d.logged) return '';
    const x = pad + i * bw + 2;
    return `<rect x="${x}" y="${y(d[key])}" width="${bw - 4}" height="${H - 18 - y(d[key])}" rx="3" fill="${color}"/>`;
  }).join('');
  const labels = perDay.map((d, i) => (i % 2 === 1 ? `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${Number(d.day.slice(8))}</text>` : '')).join('');
  const tline = target ? `<line x1="${pad}" x2="${W}" y1="${y(target)}" y2="${y(target)}" stroke="var(--ink-3)" stroke-dasharray="4 4"/><text x="0" y="${y(target) + 3}">${r(target)}</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${key} per day">${tline}${bars}${labels}</svg>`;
}

function movingAvg(weights) {
  const byDay = {};
  weights.forEach((w) => { byDay[w.day] = w.weight; });
  const daysSorted = Object.keys(byDay).sort();
  return daysSorted.map((d) => {
    const window = daysSorted.filter((x) => x <= d && x > dayMinus(d, 7));
    return { day: d, v: window.reduce((a, x) => a + byDay[x], 0) / window.length };
  });
}

function lineChart(pts) {
  const W = 340, H = 140, pad = 30;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs) - 1, hi = Math.max(...vs) + 1;
  const x = (i) => pad + (i / (pts.length - 1)) * (W - pad - 8);
  const y = (v) => H - 18 - ((v - lo) / (hi - lo)) * (H - 30);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.v)}`).join('');
  return `<svg viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    <text x="0" y="${y(hi) + 10}">${hi.toFixed(0)}</text><text x="0" y="${y(lo)}">${lo.toFixed(0)}</text>
    <text x="${pad}" y="${H - 2}">${pts[0].day.slice(5)}</text><text x="${W - 8}" y="${H - 2}" text-anchor="end">${pts.at(-1).day.slice(5)}</text></svg>`;
}

// ---------- Settings ----------
const RESTRICTIONS = ['gluten-free', 'dairy-free', 'vegetarian', 'vegan', 'nut-free', 'low-sodium', 'pescatarian', 'kosher', 'halal'];

function renderSettings() {
  const el = $('#settings');
  const p = state.profile || {};
  const tg = p.targets || {};
  const list = (a) => (a || []).join(', ');
  const restr = new Set(p.restrictions || []);

  el.innerHTML = `
    <section class="panel">
      <h2>${esc(p.name || state.user.displayName || 'You')}</h2>
      <p class="sub">${esc(state.user.email)}</p>
      <div class="field"><label>Dietary restrictions</label>
        <div class="pick" id="restr">${RESTRICTIONS.map((x) => `<button type="button" data-v="${x}" class="${restr.has(x) ? 'on' : ''}">${x}</button>`).join('')}</div>
        <input type="text" id="restr-other" placeholder="Other (comma-separated)" value="${esc([...restr].filter((x) => !RESTRICTIONS.includes(x)).join(', '))}">
      </div>
      <div class="field"><label>Allergies</label><input type="text" id="allergies" value="${esc(list(p.allergies))}" placeholder="e.g. shellfish, peanuts"></div>
      <div class="field"><label>Foods you dislike</label><input type="text" id="dislikes" value="${esc(list(p.dislikes))}"></div>
      <div class="field"><label>Usually in the house</label><input type="text" id="staples" value="${esc(list(p.staples))}" placeholder="e.g. eggs, Greek yogurt, apples"><span class="hint">The coach builds suggestions from these.</span></div>
    </section>

    <section class="panel">
      <h2>Daily targets</h2>
      <p class="sub">Ranges are fine — the coach treats these as guides.</p>
      <div class="grid2">
        <div class="field"><label>Protein (g)</label><input type="number" id="t-protein" value="${tg.protein_g ?? ''}"></div>
        <div class="field"><label>Fiber (g)</label><input type="number" id="t-fiber" value="${tg.fiber_g ?? ''}"></div>
        <div class="field"><label>Healthy fats (g)</label><input type="number" id="t-fat" value="${tg.fat_g ?? ''}"></div>
        <div class="field"><label>Calories (max)</label><input type="number" id="t-cal" value="${tg.calories_max ?? ''}"></div>
      </div>
      <label class="toggle"><span>Hide calories everywhere</span><input type="checkbox" id="hide-cal" ${p.hide_calories ? 'checked' : ''}></label>
      <label class="toggle"><span>Track weight</span><input type="checkbox" id="track-weight" ${p.track_weight ? 'checked' : ''}></label>
    </section>

    <div class="btn-row">
      <button class="btn primary" id="save-settings" style="width:auto">Save changes</button>
      <span id="saved-note" class="saved-note" hidden>Saved</span>
    </div>

    <section class="panel">
      <h2>Your data</h2>
      <div class="btn-row">
        <button class="btn small" id="export">Export log (CSV)</button>
        <button class="btn small" id="redo">Redo setup with coach</button>
        <button class="btn small danger" id="signout">Sign out</button>
      </div>
      <p class="sub" style="margin-top:12px">Install: in Safari tap Share → Add to Home Screen.</p>
    </section>`;

  $('#restr').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.classList.toggle('on');
  });
  $('#save-settings').addEventListener('click', saveSettings);
  $('#export').addEventListener('click', exportCsv);
  $('#signout').addEventListener('click', () => signOut(auth));
  $('#redo').addEventListener('click', async () => {
    await updateDoc(doc(db, 'users', state.user.uid), { onboarded: false });
    show('chat');
    send("Let's redo my setup.");
  });
}

async function saveSettings() {
  const split = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
  const num = (id) => { const v = $(id).value; return v === '' ? null : Number(v); };
  const restrictions = [...document.querySelectorAll('#restr button.on')].map((b) => b.dataset.v).concat(split('#restr-other'));
  const patch = {
    restrictions,
    allergies: split('#allergies'),
    dislikes: split('#dislikes'),
    staples: split('#staples'),
    hide_calories: $('#hide-cal').checked,
    track_weight: $('#track-weight').checked,
    targets: {
      ...(state.profile?.targets || {}),
      protein_g: num('#t-protein'),
      fiber_g: num('#t-fiber'),
      fat_g: num('#t-fat'),
      calories_max: num('#t-cal'),
    },
  };
  await setDoc(doc(db, 'users', state.user.uid), patch, { merge: true });
  $('#saved-note').hidden = false;
  setTimeout(() => { const n = $('#saved-note'); if (n) n.hidden = true; }, 2000);
}

async function exportCsv() {
  const uref = doc(db, 'users', state.user.uid);
  const snap = await getDocs(query(collection(uref, 'meals'), orderBy('day')));
  const head = ['day', 'time', 'meal', 'description', 'calories', 'protein_g', 'fiber_g', 'fat_g', 'carbs_g', 'processing'];
  const lines = [head.join(',')];
  rows(snap).forEach((m) => {
    const vals = [m.day, hhmm(toDate(m.at)), m.meal, m.description, m.calories, m.protein_g, m.fiber_g, m.fat_g, m.carbs_g, m.processing];
    lines.push(vals.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `food-log-${localDay()}.csv`;
  a.click();
}

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
