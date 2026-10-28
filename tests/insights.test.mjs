import { test } from 'node:test';
import assert from 'node:assert';
import { hungerHeatmap, weakSpots, keepsYouFull } from '../public/js/insights.js';

const at = (d, h, m = 0) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);
const TZ = 'America/New_York';

test('heat map buckets hunger by weekday and 2-hour window', () => {
  // 2026-10-26 is a Monday
  const g = hungerHeatmap([{ at: at('2026-10-26', 15, 30), level: 4 }, { at: at('2026-10-26', 15, 50), level: 3 }, { at: at('2026-10-26', 9), level: 2 }], TZ);
  assert.equal(g[0][4].count, 2); // Mon, 2–4 pm
  assert.equal(g[0][4].score, 3);
  assert.equal(g[0][1].count, 0); // level 2 ignored
});

test('weak spots find repeated ultraprocessed snacks', () => {
  const meals = ['2026-10-26', '2026-10-27', '2026-10-28'].map((d) => ({ at: at(d, 16, 10), day: d, meal: 'snack', processing: 'ultraprocessed', description: 'chips' }));
  const w = weakSpots(meals, TZ);
  assert.equal(w[0].days, 'Weekdays');
  assert.equal(w[0].label, '4–6 pm');
  assert.equal(w[0].count, 3);
  assert.deepEqual(w[0].examples, ['chips']);
});

test('keeps-you-full ranks smoothie below eggs', () => {
  const meals = [], checkins = [];
  for (const d of ['2026-10-26', '2026-10-27']) {
    meals.push({ at: at(d, 7), day: d, items: [{ name: 'smoothie' }] }, { at: at(d, 12), day: d, items: [{ name: 'salad' }] });
    checkins.push({ at: at(d, 8, 30), day: d, level: 4 });
  }
  for (const d of ['2026-10-28', '2026-10-29']) meals.push({ at: at(d, 7), day: d, items: [{ name: 'eggs' }] }, { at: at(d, 12), day: d, items: [{ name: 'salad' }] });
  const r = keepsYouFull(meals, checkins);
  const by = Object.fromEntries(r.map((x) => [x.food, x.avgHours]));
  assert.equal(by.smoothie, 1.5);
  assert.equal(by.eggs, 5);
  assert.ok(r.findIndex((x) => x.food === 'eggs') < r.findIndex((x) => x.food === 'smoothie'));
});
