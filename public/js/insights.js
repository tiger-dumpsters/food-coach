// Hunger insights, shared by the app (Trends tab) and the coach (server context).
// Pure functions: give them plain objects with `at` as a Date (local time is derived
// with the supplied hour/weekday helpers so the server can pass the user's timezone).

export const BUCKETS = [
  { label: '6a', from: 6, to: 8 }, { label: '8a', from: 8, to: 10 }, { label: '10a', from: 10, to: 12 },
  { label: '12p', from: 12, to: 14 }, { label: '2p', from: 14, to: 16 }, { label: '4p', from: 16, to: 18 },
  { label: '6p', from: 18, to: 20 }, { label: '8p', from: 20, to: 22 }, { label: '10p', from: 22, to: 24 },
];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function bucketIndex(hour) {
  return BUCKETS.findIndex((b) => hour >= b.from && hour < b.to);
}

export function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { hour: Number(p.hour), weekday: wd };
}

// 7 x 9 grid (weekday x 2-hour bucket). Each cell sums hunger levels >= 3 so a
// "starving" counts more than "a little hungry".
export function hungerHeatmap(checkins, tz) {
  const grid = WEEKDAYS.map(() => BUCKETS.map(() => ({ score: 0, count: 0 })));
  for (const c of checkins) {
    if (!c.at || !(c.level >= 3)) continue;
    const { hour, weekday } = localParts(c.at, tz);
    const b = bucketIndex(hour);
    if (b < 0 || weekday < 0) continue;
    grid[weekday][b].score += c.level - 2; // 3→1, 4→2, 5→3
    grid[weekday][b].count += 1;
  }
  return grid;
}

// When ultraprocessed snacks happen. Returns the top windows, e.g.
// { days: 'Weekdays', label: '4–6 pm', count: 4 }.
export function weakSpots(meals, tz, top = 3) {
  const cells = new Map();
  for (const m of meals) {
    if (!m.at || m.processing !== 'ultraprocessed') continue;
    if (m.meal && !['snack', 'drink'].includes(m.meal)) continue;
    const { hour, weekday } = localParts(m.at, tz);
    const b = bucketIndex(hour);
    if (b < 0) continue;
    const group = weekday >= 5 ? 'Weekends' : 'Weekdays';
    const key = `${group}|${b}`;
    const cur = cells.get(key) || { days: group, bucket: b, count: 0, examples: [] };
    cur.count += 1;
    if (cur.examples.length < 3 && m.description && !cur.examples.includes(m.description)) cur.examples.push(m.description);
    cells.set(key, cur);
  }
  return [...cells.values()]
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((c) => ({ ...c, label: bucketRange(c.bucket) }));
}

export function bucketRange(b) {
  const f = (h) => (h === 12 ? '12' : h === 24 ? '12' : String(h % 12));
  const ap = (h) => (h < 12 || h === 24 ? 'am' : 'pm');
  const { from, to } = BUCKETS[b];
  return `${f(from)}–${f(to)} ${ap(to === 24 ? 23 : to)}`;
}

function key(name) {
  return String(name || '').toLowerCase()
    .replace(/\b(whole foods|wf|365|trader joe'?s|homemade|organic|plain|small|large|medium)\b/g, ' ')
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// How long each food keeps you going: hours from a meal to the next hunger check-in
// (level >= 3) or the next time you ate, same day, max 6 h. Foods seen at least
// `minSeen` times are ranked.
export function keepsYouFull(meals, checkins, { minSeen = 2, maxHours = 6 } = {}) {
  const eats = meals.filter((m) => m.at && m.meal !== 'drink').sort((a, b) => a.at - b.at);
  const hungry = checkins.filter((c) => c.at && c.level >= 3).sort((a, b) => a.at - b.at);
  const byFood = new Map();
  for (let i = 0; i < eats.length; i++) {
    const m = eats[i];
    const nextEat = eats.slice(i + 1).find((x) => x.day === m.day && x.at - m.at > 20 * 60e3);
    const nextHunger = hungry.find((c) => c.day === m.day && c.at > m.at);
    const candidates = [nextEat?.at, nextHunger?.at].filter(Boolean);
    if (!candidates.length) continue; // e.g. dinner with nothing after
    const hours = Math.min(maxHours, (Math.min(...candidates) - m.at) / 3600e3);
    const names = (m.items?.length ? m.items.map((it) => it.name) : [m.description])
      .map(key).filter((k) => k && k.length > 2);
    for (const n of new Set(names)) {
      const cur = byFood.get(n) || { food: n, hours: [], label: n };
      cur.hours.push(hours);
      byFood.set(n, cur);
    }
  }
  const ranked = [...byFood.values()]
    .filter((f) => f.hours.length >= minSeen)
    .map((f) => ({ food: f.food, seen: f.hours.length, avgHours: f.hours.reduce((a, h) => a + h, 0) / f.hours.length }))
    .sort((a, b) => b.avgHours - a.avgHours);
  return ranked;
}
