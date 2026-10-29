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
import { hungerHeatmap, weakSpots, keepsYouFull, BUCKETS, WEEKDAYS, bucketRange } from './insights.js';

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
  household: null,        // { id, members, names, pantry }
  householdUnsub: null,
  householdId: null,
  mixFilter: null,        // Today: highlight foods of one processing level
  photo: null,            // { data, media_type, thumb } waiting to send
  invite: null,           // last invite code created
  flagging: null,         // id of the coach reply being flagged
  viewDay: null,          // Today tab: a past day being viewed (null = today)
  days: {},               // cache of past days' entries
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
// Calories rounded to the nearest 10: estimates shouldn't look more precise than they are.
function rc(n) { return n == null ? '–' : (Math.round(n / 10) * 10).toLocaleString(); }
function hideCal() { return !!state.profile?.hide_calories; }
const LEVELS = ['whole', 'processed', 'ultraprocessed'];
const LEVEL_LABEL = { whole: 'whole', processed: 'processed', ultraprocessed: 'ultraprocessed', unrated: 'older entries' };
// Calories by processing level for one meal. Older meals rated as a whole fall back to that rating.
function mealMix(m) {
  if (m.processing_mix) return m.processing_mix;
  const k = LEVELS.includes(m.processing) ? m.processing : 'unrated';
  return { [k]: Math.max(1, m.calories || 0) };
}
function pct(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, Math.round((v / total) * 100)]));
}
function splitBar(mix, cls = 'split') {
  const p = pct(mix);
  return `<span class="${cls}">${[...LEVELS, 'unrated'].filter((k) => p[k]).map((k) => `<i style="width:${p[k]}%;background:${MIX_COLORS[k]}"></i>`).join('')}</span>`;
}
function splitText(mix) {
  const p = pct(mix);
  return [...LEVELS, 'unrated'].filter((k) => p[k]).map((k) => `${p[k]}% ${k === 'ultraprocessed' ? 'ultra' : LEVEL_LABEL[k]}`).join(' · ');
}

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
  watchHousehold(null);
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
    watchHousehold(state.profile?.householdId || null);
    // One-time: give older meals a per-item whole/processed split (runs in the background).
    if (state.profile?.onboarded && state.profile.rerated !== 'v1' && !state.rerateStarted) {
      state.rerateStarted = true;
      api('rerate', {}).catch(() => { state.rerateStarted = false; });
    }
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

function watchHousehold(hid) {
  if (hid === state.householdId) return;
  if (state.householdUnsub) state.householdUnsub();
  state.householdUnsub = null;
  state.householdId = hid;
  state.household = null;
  if (!hid) { if (state.view === 'settings') renderSettings(); return; }
  state.householdUnsub = onSnapshot(doc(db, 'households', hid), (snap) => {
    state.household = snap.exists() ? { id: hid, ...snap.data() } : null;
    if (state.view === 'settings') renderSettings();
  }, () => { state.household = null; });
}

async function api(path, body) {
  const token = await state.user.getIdToken();
  const res = await fetch(`/.netlify/functions/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

// ---------- navigation ----------
const TITLES = { chat: 'Coach', today: 'Today', trends: 'Trends', settings: 'You' };
document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'today' && state.view === 'today') state.viewDay = null; // tap again: back to today
    show(btn.dataset.view);
  });
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
  if ((!text && !state.photo) || state.pending) return;
  input.value = '';
  autosize();
  const photo = state.photo;
  clearPhoto();
  send(text, photo);
});

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.send) { send(b.dataset.send); return; }
  input.value = b.dataset.fill || '';
  input.focus();
  autosize();
});

// ---------- photos ----------
$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    state.photo = await preparePhoto(file);
    $('#photo-img').src = state.photo.thumb;
    $('#photo-preview').hidden = false;
    input.focus();
  } catch {
    alert("Couldn't read that photo. Try another?");
  }
});
$('#photo-remove').addEventListener('click', clearPhoto);
function clearPhoto() {
  state.photo = null;
  $('#photo-preview').hidden = true;
  $('#photo-img').removeAttribute('src');
}

// Shrink on the phone before upload: ~1280px for the coach, ~320px thumbnail for the chat.
async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const draw = (max, q) => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    };
    const full = draw(1280, 0.82);
    return { media_type: 'image/jpeg', data: full.split(',')[1], thumb: draw(320, 0.7) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function send(text, photo = null) {
  state.pending = { text, thumb: photo?.thumb || null };
  $('#send').disabled = true;
  renderThread();
  try {
    await api('chat', {
      text, tz: TZ,
      ...(photo ? { image: { media_type: photo.media_type, data: photo.data }, thumb: photo.thumb } : {}),
    }); // messages arrive through the Firestore listener
  } catch (err) {
    state.messages.push({ id: 'err' + Date.now(), role: 'assistant', text: `Couldn't send that (${err.message}). Try again?`, local: true });
    input.value = input.value || text;
    if (photo && !state.photo) { state.photo = photo; $('#photo-img').src = photo.thumb; $('#photo-preview').hidden = false; }
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
    const echoed = msgs.length && msgs.at(-1).role === 'user' && msgs.at(-1).text === state.pending.text;
    if (!echoed) html += msgHtml({ role: 'user', text: state.pending.text, thumb: state.pending.thumb }, new Date());
    html += `<div class="msg assistant"><div class="bubble typing" aria-label="Coach is typing"><i></i><i></i><i></i></div></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.blur').forEach((b) => b.addEventListener('click', () => b.classList.toggle('revealed')));
  bindFlags(el);
  if (!state.flagging) scrollThread();
}

// "Flag" on a coach reply: optional note, saved for review.
function bindFlags(el) {
  el.querySelectorAll('[data-flag]').forEach((b) => b.addEventListener('click', () => {
    state.flagging = b.dataset.flag;
    renderThread();
    const form = el.querySelector('.flag-form');
    form?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    form?.querySelector('textarea')?.focus({ preventScroll: true });
  }));
  el.querySelector('[data-flag-cancel]')?.addEventListener('click', () => { state.flagging = null; renderThread(); });
  el.querySelector('[data-flag-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await api('flag', { messageId: f.dataset.flagForm, note: f.querySelector('textarea').value });
      state.flagging = null; // the message updates itself through the listener
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Try again';
    }
  });
}

function dayLabel(d) {
  const today = localDay();
  if (d === today) return 'Today';
  if (d === dayMinus(today, 1)) return 'Yesterday';
  return new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function msgHtml(m, at) {
  // An entry removed later in the same reply shows crossed out, not as a second "removed" card.
  const list = m.entries || [];
  const removed = new Set(list.filter((e) => e.deleted).map((e) => e.id));
  const shown = list.filter((e) => !(e.deleted && list.some((o) => !o.deleted && o.id === e.id)))
    .map((e) => (removed.has(e.id) && !e.deleted ? { ...e, struck: true } : e));
  // A pasted log can produce dozens of cards; show a few and summarize the rest.
  const all = shown.map(cardHtml).filter(Boolean);
  const cards = all.length > 5
    ? all.slice(0, 3).join('') + `<div class="card"><span class="k">+ ${all.length - 3} more entries · see Today and Trends</span></div>`
    : all.join('');
  const body = blurWeights(fmtText(m.text));
  const thumb = m.thumb ? `<img class="thumb" src="${esc(m.thumb)}" alt="Meal photo">` : (m.photo ? '<span class="muted">[photo]</span><br>' : '');
  const canFlag = m.role === 'assistant' && m.id && !m.local;
  const flag = canFlag ? (m.flagged
    ? '<span class="flagged">Flagged, thanks</span>'
    : `<button type="button" class="flag-btn" data-flag="${esc(m.id)}">Flag</button>`) : '';
  const form = state.flagging === m.id ? `
    <form class="flag-form" data-flag-form="${esc(m.id)}">
      <textarea rows="2" placeholder="What was off? (optional)"></textarea>
      <div class="btn-row"><button class="btn small primary" type="submit" style="width:auto">Send flag</button><button class="btn small" type="button" data-flag-cancel>Cancel</button></div>
    </form>` : '';
  return `
    <div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">
      <div class="bubble">${thumb}${body}</div>
      ${cards ? `<div class="cards">${cards}</div>` : ''}
      <span class="time">${esc(hhmm(at))}${flag ? ` · ${flag}` : ''}</span>
      ${form}
    </div>`;
}

// Per-item breakdown (with processing dots and assumptions), shared by chat cards and Today.
function breakdownHtml(e, open = false) {
  const items = (e.items || []).filter((it) => it && it.name);
  if (!(items.length > 1 || e.assumptions || items.some((it) => it.processing))) return '';
  const nums = (it) => it.derived
    ? (hideCal() ? '' : `~${rc(it.calories)} cal`)
    : `${hideCal() ? '' : `${rc(it.calories)} cal · `}${r(it.protein_g)}p · ${r(it.fiber_g)}f`;
  return `
      <details${open ? ' open' : ''}><summary>Breakdown${e.assumptions ? ' & assumptions' : ''}</summary>
        ${items.length ? `<ul class="items">${items.map((it) => `<li><span>${it.processing ? `<i class="dot" style="background:${MIX_COLORS[it.processing]}" title="${esc(it.processing)}"></i>` : ''}${esc(it.qty ? `${it.qty} ` : '')}${esc(it.name)}</span><span>${nums(it)}</span></li>`).join('')}</ul>` : ''}
        ${e.assumptions ? `<div class="assume">Assumed: ${esc(e.assumptions)}</div>` : ''}
      </details>`;
}

// Blur weights everywhere in the chat — what you typed and what the coach says back.
// A number is blurred if it matches any logged weigh-in, or if the message talks about
// weight and the number looks like a body weight.
function knownWeights() {
  const set = new Set();
  for (const m of state.messages) for (const e of m.entries || []) if (e.kind === 'weight' && e.weight != null) set.add(Number(e.weight));
  return set;
}
function blurWeights(html, known = knownWeights()) {
  const talksWeight = /\b(weigh|weighs|weighed|weight|weighing|weigh-in|scale|lbs?|kg|pounds?)\b/i.test(html);
  if (!talksWeight && !known.size) return html;
  return html.replace(/(?<!&#)\b(\d{2,3}(?:\.\d{1,2})?)(\s?(?:lbs?|pounds?|kg))?\b/gi, (m0, num, unit) => {
    const n = Number(num);
    const isKnown = known.has(n);
    const plausible = talksWeight && (unit ? true : n >= 70 && n <= 450);
    return isKnown || plausible ? `<span class="blur" title="Tap to show">${m0}</span>` : m0;
  });
}

function cardHtml(e) {
  if (e.kind === 'profile') return `<div class="card"><span class="k">Profile updated</span></div>`;
  const del = e.deleted ? ' deleted' : '';
  if (e.deleted) return `<div class="card ${e.kind}${del}"><span class="k">Removed ${esc(e.kind)}</span></div>`;
  if (e.kind === 'pantry') {
    const bits = [e.add?.length ? `+ ${e.add.join(', ')}` : '', e.remove?.length ? `− ${e.remove.join(', ')}` : ''].filter(Boolean).join(' · ');
    return `<div class="card pantry"><span class="k">${e.shared ? 'Household pantry' : 'Pantry'} updated</span><span class="nums">${esc(bits)}</span></div>`;
  }
  if (e.kind === 'meal') {
    const nums = [
      hideCal() ? '' : `~${rc(e.calories)} cal`,
      `${r(e.protein_g)} g protein`,
      `${r(e.fiber_g)} g fiber`,
      e.fat_g != null ? `${r(e.fat_g)} g fat` : '',
    ].filter(Boolean).map((n) => `<span>${n}</span>`).join('');
    const details = breakdownHtml(e);
    const share = e.sharedWith?.length ? `<span class="share">Also logged for ${esc(e.sharedWith.join(', '))}</span>`
      : e.sharedFrom ? `<span class="share">Shared by ${esc(e.sharedFrom.name)}</span>` : '';
    return `<div class="card meal${e.struck ? ' deleted' : ''}">${e.struck ? '<span class="k">Removed</span>' : ''}
      <span class="k">${e.updated ? 'Updated ' : ''}${esc(e.meal || 'Food')}${e.day && e.day !== localDay() ? ' · ' + esc(dayLabel(e.day)) : ''}${e.at ? ' · ' + esc(hhmm(new Date(e.at))) : ''}</span>
      <span class="title">${esc(e.description)}</span>
      <span class="nums">${nums}</span>
      ${e.processing_mix ? `<span class="split-row">${splitBar(e.processing_mix)}<span>${esc(splitText(e.processing_mix))}</span></span>`
        : e.processing ? `<span class="nums"><span class="tag ${esc(e.processing)}">${esc(e.processing)}</span></span>` : ''}
      ${share}${details}
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
// Past days: loaded on demand and cached for the session.
async function loadDay(day) {
  if (state.days[day]) return state.days[day];
  const uref = doc(db, 'users', state.user.uid);
  const [m, w, c] = await Promise.all(['meals', 'workouts', 'checkins'].map((col) => getDocs(query(collection(uref, col), where('day', '==', day)))));
  const byTime = (a, b) => (toDate(a.at) || 0) - (toDate(b.at) || 0);
  state.days[day] = { meals: rows(m).sort(byTime), workouts: rows(w).sort(byTime), checkins: rows(c).sort(byTime) };
  return state.days[day];
}

function openDay(day) {
  state.viewDay = !day || day === localDay() ? null : day;
  state.mixFilter = null;
  if (state.view !== 'today') show('today'); else renderToday();
}

function renderToday() {
  const el = $('#today');
  const today = localDay();
  const day = state.viewDay || today;
  const isToday = day === today;
  $('#view-title').textContent = isToday ? 'Today' : dayLabel(day);
  if (!isToday && !state.days[day]) {
    el.innerHTML = `${dayNavHtml(day, isToday)}<p class="muted">Loading…</p>`;
    bindDayNav(el, day);
    loadDay(day).then(() => { if (state.view === 'today' && state.viewDay === day) renderToday(); });
    return;
  }
  const { meals, workouts, checkins } = isToday ? state.today : state.days[day];
  const t = sum(meals);
  const tg = state.profile?.targets || {};
  const now = new Date();
  // Past days are judged as finished days.
  const nowH = isToday ? now.getHours() + now.getMinutes() / 60 : 24;
  // Share of the day's eating you'd typically have done by now (7 am – 8 pm window).
  const pace = Math.min(1, Math.max(0, (nowH - 7) / 13));
  const mealsLeft = nowH < 11 ? 3 : nowH < 15 ? 2 : nowH < 20 ? 1 : 0;

  const meter = (cls, label, val, target, unit) => {
    const pct = target ? Math.min(100, (val / target) * 100) : 0;
    const tick = target && pace > 0 && pace < 1 ? `<i class="pace" style="left:${pace * 100}%" title="Typical by this time of day"></i>` : '';
    return `<div class="meter ${cls}">
      <div class="row"><span>${label}</span><span><b>${unit ? r(val) : rc(val)}</b>${target ? ` / ${unit ? r(target) : rc(target)}` : ''} ${unit}</span></div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div>${tick}</div>
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
    // Judge against where you'd normally be by this time of day, and say what to do at the
    // next meal — not "running low" right after breakfast.
    const behind = (val, target) => target && nowH >= 11 && mealsLeft > 0 && val < target * pace * 0.7;
    // A realistic amount for one meal, not the whole remaining gap.
    const nextMeal = (val, target, cap) => Math.min(cap, Math.max(5, Math.round((target - val) / mealsLeft / 5) * 5));
    const meal = nowH < 15 ? 'lunch' : 'dinner';
    if (behind(t.protein_g, tg.protein_g)) {
      const g = nextMeal(t.protein_g, tg.protein_g, 45);
      gaps.push(`Protein's a bit behind pace for this time of day. Aim for about ${g} g at ${meal}${g === 45 ? ' — you may not close the whole gap today, and that\'s fine' : ''}.`);
    }
    if (behind(t.fiber_g, tg.fiber_g)) gaps.push(`Fiber's behind pace. Beans, berries, veggies or whole grains at ${meal} would help (about ${nextMeal(t.fiber_g, tg.fiber_g, 15)} g).`);
    const dayMix = {};
    for (const m of meals) for (const [k, v] of Object.entries(mealMix(m))) dayMix[k] = (dayMix[k] || 0) + v;
    const upfPct = pct(dayMix).ultraprocessed || 0;
    const upfItems = [...new Set(meals.flatMap((m) => (m.items || []).filter((it) => it.processing === 'ultraprocessed').map((it) => it.name)))];
    if (isToday && upfPct >= 25 && (meals.length >= 2 || nowH >= 11)) gaps.push(`About ${upfPct}% of today's calories are ultraprocessed${upfItems.length ? ` (${upfItems.slice(0, 3).join(', ')})` : ''}. Maybe make the next one whole food.`);
    if (!isToday) {
      // A finished day: a plain recap, not advice about a next meal.
      if (tg.protein_g) gaps.push(t.protein_g >= tg.protein_g * 0.9 ? `Protein: ${r(t.protein_g)} g, hit the target.` : `Protein: ${r(t.protein_g)} of ${r(tg.protein_g)} g.`);
      if (tg.fiber_g) gaps.push(t.fiber_g >= tg.fiber_g * 0.9 ? `Fiber: ${r(t.fiber_g)} g, hit the target.` : `Fiber: ${r(t.fiber_g)} of ${r(tg.fiber_g)} g.`);
      if (upfPct) gaps.push(`${upfPct}% of calories ultraprocessed${upfItems.length ? ` (${upfItems.slice(0, 3).join(', ')})` : ''}.`);
    }
  }
  const okLine = (g) => /hit the target/.test(g);
  const gapHtml = meals.length
    ? `<ul class="gap-list">${gaps.length ? gaps.map((g) => `<li class="${okLine(g) ? 'ok' : isToday ? '' : 'neutral'}">${esc(g)}</li>`).join('') : `<li class="ok">${nowH < 11 ? 'Good start. Keep protein and fiber in your next meal too.' : 'On pace for this time of day.'}</li>`}</ul>`
    : `<p class="muted">${isToday ? 'Nothing logged yet today. Tell the coach what you had.' : 'Nothing was logged this day.'}</p>`;

  const mix = mixHtml(meals, isToday);

  const f = state.mixFilter;
  const log = [
    ...meals.map((m) => ({ at: toDate(m.at), label: m.description, meal: m, mix: mealMix(m), items: m.items || [], n: [hideCal() ? '' : `${rc(m.calories)} cal`, `${r(m.protein_g)}p`, `${r(m.fiber_g)}f`].filter(Boolean).join(' · ') })),
    ...workouts.map((w) => ({ at: toDate(w.at), label: `Workout: ${w.type}`, n: w.duration_min ? `${r(w.duration_min)} min` : '' })),
    ...checkins.map((c) => ({ at: toDate(c.at), label: `Hunger ${c.level}/5${c.note ? ' — ' + c.note : ''}`, n: '' })),
  ].sort((a, b) => (a.at || 0) - (b.at || 0));
  const logRow = (x) => {
    const has = x.mix && x.mix[f] > 0;
    const cls = f ? (has ? `hl ${f}` : 'dim') : '';
    const matching = f && has ? x.items.filter((it) => it.processing === f).map((it) => it.name) : [];
    const split = x.mix && Object.keys(x.mix).length ? splitBar(x.mix, 'split mini') : '';
    const which = matching.length ? `<span class="which">${esc(LEVEL_LABEL[f])}: ${esc(matching.join(', '))}</span>` : '';
    const details = x.meal ? breakdownHtml(x.meal) : '';
    return `<li class="${cls}"><span class="t">${esc(hhmm(x.at))}</span><span>${esc(x.label)}${split}${which}</span><span class="n">${esc(x.n)}</span>${details}</li>`;
  };

  el.innerHTML = `
    ${dayNavHtml(day, isToday)}
    <section class="panel">
      <h2>${new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      ${tg.protein_g ? (isToday && pace > 0 && pace < 1 ? '<p class="sub">The small mark shows where you\'d typically be by this time of day.</p>' : '') : '<p class="sub">Finish setup with the coach to get personal targets.</p>'}
      ${meters}
    </section>
    <section class="panel"><h2>${isToday ? 'Gaps to fill' : 'How the day went'}</h2>${gapHtml}</section>
    <section class="panel"><h2>Whole vs processed</h2>${mix}</section>
    <section class="panel"><h2>Log</h2>
      ${log.length ? `<ul class="log-list">${log.map(logRow).join('')}</ul>` : '<p class="muted">Empty so far.</p>'}
    </section>`;
  el.querySelectorAll('[data-mix]').forEach((b) => b.addEventListener('click', () => {
    state.mixFilter = state.mixFilter === b.dataset.mix ? null : b.dataset.mix;
    renderToday();
  }));
  bindDayNav(el, day);
}

function dayNavHtml(day, isToday) {
  return `<nav class="day-nav" aria-label="Choose day">
    <button type="button" data-day-step="-1" aria-label="Previous day">‹</button>
    <span>${esc(isToday ? 'Today' : dayLabel(day))}</span>
    <button type="button" data-day-step="1" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    ${isToday ? '' : '<button type="button" class="link" data-day-today>Back to today</button>'}
  </nav>`;
}

function bindDayNav(el, day) {
  el.querySelectorAll('[data-day-step]').forEach((b) => b.addEventListener('click', () => {
    const next = dayMinus(day, -Number(b.dataset.dayStep));
    if (next <= localDay()) openDay(next);
  }));
  el.querySelector('[data-day-today]')?.addEventListener('click', () => openDay(null));
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

const MIX_COLORS = { whole: 'var(--accent)', processed: 'var(--amber)', ultraprocessed: 'var(--warm)', unrated: 'var(--ink-3)', mixed: 'var(--ink-3)' };
function mixHtml(meals, isToday = true) {
  if (!meals.length) return '<p class="muted">Shows up once you log food.</p>';
  const c = {};
  for (const m of meals) for (const [k, v] of Object.entries(mealMix(m))) c[k] = (c[k] || 0) + v;
  const p = pct(c);
  const f = state.mixFilter;
  const parts = [...LEVELS, 'unrated'].filter((k) => p[k]);
  const bar = parts.map((k) => `<span data-mix="${k}" class="${f && f !== k ? 'dim' : ''}" style="width:${p[k]}%;background:${MIX_COLORS[k]}" title="${LEVEL_LABEL[k]}"></span>`).join('');
  const leg = parts.map((k) => `<button type="button" data-mix="${k}" class="${f === k ? 'on' : ''}"><i style="background:${MIX_COLORS[k]}"></i>${LEVEL_LABEL[k]} ${p[k]}%</button>`).join('');
  return `<div class="mix">${bar}</div><div class="legend">${leg}</div><div class="mix-hint">${f ? `Showing ${LEVEL_LABEL[f]} foods in the log below · tap again to clear` : `Share of ${isToday ? 'today\'s' : 'the day\'s'} calories · tap a color to see which foods`}</div>`;
}

// ---------- Trends ----------
async function renderTrends() {
  const el = $('#trends');
  el.innerHTML = '<p class="muted">Loading…</p>';
  const uref = doc(db, 'users', state.user.uid);
  const today = localDay();
  const start = dayMinus(today, 27); // 4 weeks for hunger patterns; charts show 14 days
  const [mS, wS, cS, kS] = await Promise.all([
    getDocs(query(collection(uref, 'meals'), where('day', '>=', start))),
    getDocs(query(collection(uref, 'workouts'), where('day', '>=', start))),
    getDocs(query(collection(uref, 'checkins'), where('day', '>=', start))),
    getDocs(query(collection(uref, 'weighins'), orderBy('at', 'desc'), limit(60))),
  ]);
  const withAt = (x) => ({ ...x, at: toDate(x.at) });
  const meals = rows(mS).map(withAt), workouts = rows(wS), checkins = rows(cS).map(withAt), weights = rows(kS).reverse();

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
  const recentMeals = meals.filter((m) => m.day >= days[0]);
  const calMix = {};
  for (const m of recentMeals) for (const [k, v] of Object.entries(mealMix(m))) calMix[k] = (calMix[k] || 0) + v;
  const upfShare = pct(calMix).ultraprocessed || 0;
  const recentWorkouts = workouts.filter((w) => w.day >= days[0]).length;

  let weightHtml = '';
  if (state.profile?.track_weight) {
    const avg7 = movingAvg(weights);
    weightHtml = `<section class="panel"><h2>Weight</h2><p class="sub">7-day average — hidden until you tap.</p>
      <div class="blur" id="wchart">${avg7.length >= 2 ? lineChart(avg7) : '<p class="muted">A few more weigh-ins and a trend will show here.</p>'}</div></section>`;
  }

  const chart = (title, key, target, color, unit) => `
    <section class="panel chart"><h2>${title}</h2><div class="readout">Tap a bar for the exact number</div>
      ${barChart(perDay, key, target, color, unit)}</section>`;

  el.innerHTML = `
    <section class="panel">
      <h2>Last 14 days</h2>
      <p class="sub">${logged.length} of 14 days logged</p>
      <div class="stat-row">
        <div class="stat"><div class="v">${r(avg('protein_g'))}<small> g</small></div><div class="l">avg protein</div></div>
        <div class="stat"><div class="v">${r(avg('fiber_g'))}<small> g</small></div><div class="l">avg fiber</div></div>
        <div class="stat"><div class="v">${upfShare}%</div><div class="l">calories ultra-processed</div></div>
      </div>
    </section>
    ${chart('Protein by day', 'protein_g', tg.protein_g, 'var(--accent)', 'g protein')}
    ${chart('Fiber by day', 'fiber_g', tg.fiber_g, 'var(--amber)', 'g fiber')}
    ${hideCal() ? '' : chart('Calories by day', 'calories', tg.calories_max || tg.calories_min, 'var(--ink-3)', 'cal')}
    ${hungerHtml(meals, checkins)}
    <section class="panel">
      <h2>Movement</h2>
      <div class="stat-row">
        <div class="stat"><div class="v">${recentWorkouts}</div><div class="l">workouts, 14 days</div></div>
        <div class="stat"><div class="v">${r(recentWorkouts / 2)}</div><div class="l">per week</div></div>
        <div class="stat"><div class="v">${perDay.filter((d) => d.workouts).length}</div><div class="l">active days</div></div>
      </div>
    </section>
    ${weightHtml}`;

  const w = $('#wchart');
  if (w) w.addEventListener('click', () => w.classList.toggle('revealed'));
  // Tap a bar (or heat-map cell) to read its exact value.
  el.querySelectorAll('[data-tip]').forEach((t) => t.addEventListener('click', () => {
    const panel = t.closest('.panel');
    panel.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    (t.dataset.bar ? panel.querySelector(`#${t.dataset.bar}`) : t)?.classList.add('sel');
    panel.querySelector('.readout').innerHTML = t.dataset.tip;
    panel.querySelector('[data-open-day]')?.addEventListener('click', (ev) => openDay(ev.target.dataset.openDay));
  }));
}

function shortDate(d) {
  return new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

let chartSeq = 0;
function barChart(perDay, key, target, color, unit) {
  const W = 340, H = 140, pad = 26, bw = (W - pad) / perDay.length;
  const max = Math.max(target || 0, ...perDay.map((d) => d[key])) * 1.15 || 10;
  const y = (v) => H - 18 - (v / max) * (H - 30);
  const fmtV = (v) => (key === 'calories' ? `~${rc(v)}` : r(v));
  const bars = perDay.map((d, i) => {
    const x = pad + i * bw;
    const id = `b${++chartSeq}`;
    const open = d.logged ? ` <button type="button" class="link" data-open-day="${d.day}">See day</button>` : '';
    const tip = d.logged ? `<b>${shortDate(d.day)}:</b> ${fmtV(d[key])} ${unit}${target ? ` · target ${fmtV(target)}` : ''}${open}` : `<b>${shortDate(d.day)}:</b> nothing logged`;
    const bar = d.logged ? `<rect id="${id}" class="bar" x="${x + 2}" y="${y(d[key])}" width="${bw - 4}" height="${H - 18 - y(d[key])}" rx="3" fill="${color}"/>` : '';
    return `${bar}<rect class="hit" data-tip="${esc(tip)}" data-bar="${d.logged ? id : ''}" x="${x}" y="0" width="${bw}" height="${H - 14}"/>`;
  }).join('');
  const labels = perDay.map((d, i) => (i % 2 === 1 ? `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${Number(d.day.slice(8))}</text>` : '')).join('');
  const tline = target ? `<line x1="${pad}" x2="${W}" y1="${y(target)}" y2="${y(target)}" stroke="var(--ink-3)" stroke-dasharray="4 4"/><text x="0" y="${y(target) + 3}">${key === 'calories' ? rc(target) : r(target)}</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${key} per day">${tline}${bars}${labels}</svg>`;
}

// ---------- Hunger insights ----------
function hungerHtml(meals, checkins) {
  const grid = hungerHeatmap(checkins, TZ);
  const cells = grid.flat();
  const max = Math.max(1, ...cells.map((c) => c.score));
  const total = cells.reduce((a, c) => a + c.count, 0);
  let heat;
  if (total < 3) {
    heat = `<p class="muted">Tell the coach when you're hungry — even if you don't eat. After a week or two, your hungriest times show up here.</p>`;
  } else {
    const head = `<span></span>${BUCKETS.map((b, i) => `<span class="h">${i % 2 === 0 ? b.label : ''}</span>`).join('')}`;
    const body = WEEKDAYS.map((wd, di) => `<span class="d">${wd}</span>${grid[di].map((c, bi) => {
      const a = c.score ? 0.18 + 0.82 * (c.score / max) : 0;
      const tip = `<b>${wd} ${bucketRange(bi)}:</b> ${c.count ? `hungry ${c.count}×` : 'no hunger logged'}`;
      return `<button type="button" class="c" data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/<[^>]+>/g, ''))}" style="${a ? `background:color-mix(in srgb, var(--warm) ${Math.round(a * 100)}%, var(--surface-2))` : ''}"></button>`;
    }).join('')}`).join('');
    heat = `<div class="readout">Tap a square for details</div><div class="heat">${head}${body}</div>
      <div class="heat-key">Less <i style="background:var(--surface-2)"></i><i style="background:color-mix(in srgb, var(--warm) 45%, var(--surface-2))"></i><i style="background:var(--warm)"></i> More hunger · last 4 weeks</div>`;
  }

  const spots = weakSpots(meals, TZ);
  const spotsHtml = spots.length
    ? `<ul class="insight-list">${spots.map((w) => `<li><b>${esc(w.days)} ${esc(w.label)}</b><span class="sub2">${w.count} ultraprocessed snacks · ${esc(w.examples.join(', '))}</span></li>`).join('')}</ul>`
    : '<p class="muted">No pattern yet. When ultraprocessed snacks cluster at a certain time, it shows up here.</p>';

  const full = keepsYouFull(meals, checkins);
  let fullHtml;
  if (full.length < 2) {
    fullHtml = '<p class="muted">Needs a few repeats: log meals and when hunger hits, and this ranks foods by how long they hold you.</p>';
  } else {
    // Split the ranking in half: top half "holds you", bottom half "hungry again soonest".
    const half = Math.ceil(full.length / 2);
    const top = full.slice(0, Math.min(4, half));
    const bottom = full.slice(half).slice(-3).reverse();
    const row = (x, short) => `<div class="full-row ${short ? 'short' : ''}"><span>${esc(x.food)}</span><div class="bar"><div class="fill" style="width:${(x.avgHours / 6) * 100}%"></div></div><span class="hrs">${x.avgHours.toFixed(1)} h</span></div>`;
    fullHtml = `<div class="full-head">Holds you longest</div>${top.map((x) => row(x, false)).join('')}
      ${bottom.length ? `<div class="full-head">Hungry again soonest</div>${bottom.map((x) => row(x, true)).join('')}` : ''}
      <p class="sub" style="margin-top:8px">Average hours until the next hunger or snack, same day. Foods seen 2+ times.</p>`;
  }

  return `
    <section class="panel"><h2>When hunger hits</h2>${heat}</section>
    <section class="panel"><h2>Weak spots</h2><p class="sub">When ultraprocessed snacks tend to happen</p>${spotsHtml}</section>
    <section class="panel"><h2>What keeps you full</h2>${fullHtml}</section>`;
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
      <div class="field"><label>Usually in the house</label><textarea id="staples" rows="3" placeholder="e.g. eggs, Greek yogurt, apples">${esc(list(state.household ? state.household.pantry : p.staples))}</textarea><span class="hint">${state.household ? `Shared pantry with ${esc(otherNames().join(', ') || 'your household')}. ` : ''}The coach builds suggestions from these.</span></div>
    </section>

    ${householdHtml()}

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
      <h2>About the numbers</h2>
      <p class="disclaimer">Food Coach gives estimates, not measurements. Numbers come from your description, a photo or a label, and even packaged-food labels can legally be off by 20%. Estimates are built to be consistent, so the patterns hold up: what keeps you full, where the gaps are, how your week is trending. The more specific you are (amounts, brands, how it was cooked), the closer they get. Tap "Breakdown" on any meal to see what the coach assumed. This isn't medical advice; talk to a doctor or dietitian about medical conditions.</p>
    </section>

    <section class="panel">
      <h2>Your data</h2>
      <div class="btn-row">
        <button class="btn small" id="export">Export log (CSV)</button>
        <button class="btn small" id="redo">Redo setup with coach</button>
        <button class="btn small danger" id="signout">Sign out</button>
      </div>
      <p class="sub" style="margin-top:12px">Install: in Safari tap Share → Add to Home Screen.</p>
    </section>`;

  bindHousehold();
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
    ...(state.household ? {} : { staples: split('#staples') }),
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
  if (state.household) await updateDoc(doc(db, 'households', state.household.id), { pantry: split('#staples') });
  $('#saved-note').hidden = false;
  setTimeout(() => { const n = $('#saved-note'); if (n) n.hidden = true; }, 2000);
}

function otherNames() {
  const h = state.household;
  if (!h) return [];
  return (h.members || []).filter((m) => m !== state.user.uid).map((m) => (h.names || {})[m] || 'Member');
}

function householdHtml() {
  const h = state.household;
  const invite = state.invite ? `
    <div class="field" style="margin-top:10px"><label>Invite code · good for 3 days, one use</label>
      <div class="code">${esc(state.invite)}</div>
      <div class="btn-row"><button class="btn small" id="hh-share">Share code</button></div>
    </div>` : '';
  if (h) {
    const names = (h.members || []).map((m) => (h.names || {})[m] || 'Member');
    return `<section class="panel">
      <h2>Household</h2>
      <p class="sub">${esc(names.join(' · '))}</p>
      <p class="disclaimer">You share a pantry, and meals you eat together get the same numbers. Say "${esc(otherNames()[0] || 'Alexa')} and I both had…" and the coach logs it for both of you. Your weight, hunger, targets and chat stay private.</p>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small" id="hh-invite">Invite someone else</button>
        <button class="btn small danger" id="hh-leave">Leave household</button>
      </div>${invite}
      <div id="hh-error" class="error-inline" hidden></div>
    </section>`;
  }
  return `<section class="panel">
    <h2>Household</h2>
    <p class="disclaimer">Link with your partner or family to share a pantry and log meals you ate together for both of you. Your weight, hunger, targets and chat stay private.</p>
    <div class="btn-row" style="margin-top:10px"><button class="btn small" id="hh-invite">Invite someone</button></div>
    ${invite}
    <div class="field" style="margin-top:14px"><label>Have a code?</label>
      <div class="row-input"><input type="text" id="hh-code" placeholder="6-letter code" autocapitalize="characters" maxlength="8"><button class="btn small" id="hh-join">Join</button></div>
    </div>
    <div id="hh-error" class="error-inline" hidden></div>
  </section>`;
}

function bindHousehold() {
  const err = (m) => { const e = $('#hh-error'); if (e) { e.textContent = m; e.hidden = !m; } };
  const busy = (btn, on) => { if (btn) { btn.disabled = on; } };
  $('#hh-invite')?.addEventListener('click', async (ev) => {
    busy(ev.target, true); err('');
    try { state.invite = (await api('household', { action: 'invite' })).code; renderSettings(); }
    catch (e) { err(e.message); busy(ev.target, false); }
  });
  $('#hh-share')?.addEventListener('click', async () => {
    const text = `Join my household in Food Coach: open food-coach.netlify.app, go to the You tab, and enter code ${state.invite}`;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); err('Copied — paste it in a text.'); } } catch { /* cancelled */ }
  });
  $('#hh-join')?.addEventListener('click', async (ev) => {
    const code = $('#hh-code').value.trim();
    if (!code) return;
    busy(ev.target, true); err('');
    try { await api('household', { action: 'join', code }); state.invite = null; }
    catch (e) { err(e.message); busy(ev.target, false); }
  });
  $('#hh-leave')?.addEventListener('click', async (ev) => {
    if (!confirm('Leave this household? Your own log stays with you.')) return;
    busy(ev.target, true);
    try { await api('household', { action: 'leave' }); state.invite = null; }
    catch (e) { err(e.message); busy(ev.target, false); }
  });
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
