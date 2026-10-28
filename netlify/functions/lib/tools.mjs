// Tool definitions the coach can call, and the code that writes them to Firestore.

export const WORKOUT_TYPES = [
  'Walking', 'Running', 'Cycling', 'Traditional Strength Training',
  'Functional Strength Training', 'HIIT', 'Yoga', 'Swimming', 'Elliptical',
  'Rowing', 'Hiking', 'Other',
];

const time = {
  type: 'string',
  description: 'Local time HH:MM (24h) when it happened, if the user said or implied one. Omit to use the time the message was sent.',
};

const date = {
  type: 'string',
  description: 'Local date YYYY-MM-DD, only when it was NOT today (e.g. "yesterday", or a pasted log from earlier days). Omit for today.',
};

const mealFields = {
  description: { type: 'string', description: 'Short plain description, e.g. "2 eggs, wheat toast, coffee w/ milk"' },
  meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'drink'] },
  date,
  time,
  items: {
    type: 'array',
    description: 'One entry per food in the meal, with its own nutrition. Meal totals are computed from these.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Food name, brand if given, e.g. "Whole Foods tomato Parmesan soup"' },
        qty: { type: 'string', description: 'Amount as given, e.g. "1.5 servings", "2 slices"' },
        calories: { type: 'number' },
        protein_g: { type: 'number' },
        fiber_g: { type: 'number' },
        fat_g: { type: 'number' },
        carbs_g: { type: 'number' },
      },
      required: ['name', 'qty', 'calories', 'protein_g', 'fiber_g'],
    },
  },
  calories: { type: 'number' },
  protein_g: { type: 'number' },
  fiber_g: { type: 'number' },
  fat_g: { type: 'number' },
  carbs_g: { type: 'number' },
  processing: {
    type: 'string',
    enum: ['whole', 'processed', 'ultraprocessed', 'mixed'],
    description: 'Overall processing level of the meal (NOVA-style).',
  },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  assumptions: {
    type: 'string',
    description: 'One short line on what you assumed where the input was vague, e.g. "1 tbsp butter; 1 serving soup = 1 cup". Omit if nothing was assumed.',
  },
};

export const TOOLS = [
  {
    name: 'log_meal',
    description: 'Record food or drink the user says they ate/drank. One call per meal or snack, with an items entry per food. Reuse the numbers from "Known foods" in the context for anything listed there, scaled to the amount.',
    input_schema: {
      type: 'object',
      properties: {
        ...mealFields,
        shared_with: {
          type: 'array',
          items: { type: 'string' },
          description: 'First names of household members who ate the same thing ("we both had…", "Alexa and I had…"). The meal is logged to their accounts too.',
        },
        their_portion: {
          type: 'number',
          description: 'Portion for the people in shared_with relative to the user, e.g. 0.75 if they had less. Default 1.',
        },
      },
      required: ['description', 'items', 'processing'],
    },
  },
  {
    name: 'update_meal',
    description: 'Correct a meal already logged (user says "it was 3 eggs", "that was yesterday"). Use the id from the context. Send only fields that change, with the full new totals.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, ...mealFields },
      required: ['id'],
    },
  },
  {
    name: 'log_workout',
    description: 'Record exercise the user did.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: WORKOUT_TYPES },
        date,
        time,
        duration_min: { type: 'number' },
        distance: { type: 'number' },
        distance_unit: { type: 'string', enum: ['mi', 'km'] },
        effort: { type: 'string', enum: ['easy', 'moderate', 'hard'] },
        notes: { type: 'string' },
      },
      required: ['type'],
    },
  },
  {
    name: 'log_weight',
    description: 'Record a weigh-in. Only if the user tracks weight.',
    input_schema: {
      type: 'object',
      properties: {
        weight: { type: 'number' },
        unit: { type: 'string', enum: ['lb', 'kg'] },
        date,
        time,
      },
      required: ['weight', 'unit'],
    },
  },
  {
    name: 'log_hunger',
    description: 'Record a hunger check-in whenever the user mentions being hungry, snacky, starving, or full. 1 = not hungry, 5 = starving.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'integer', minimum: 1, maximum: 5 },
        note: { type: 'string' },
        date,
        time,
      },
      required: ['level'],
    },
  },
  {
    name: 'delete_entry',
    description: 'Remove an entry the user says was wrong or a duplicate. Use the id from the context.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['meal', 'workout', 'weight', 'hunger'] },
        id: { type: 'string' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'update_pantry',
    description: 'Update the list of foods usually in the house ("bought salmon", "we\'re out of yogurt"). Shared with the household if the user is in one.',
    input_schema: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'save_profile',
    description: 'Save or update the user profile and targets. Use during onboarding once you have enough, and whenever the user changes goals, restrictions or preferences. Send only fields that change; set onboarded=true when onboarding is complete.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        sex: { type: 'string', enum: ['female', 'male', 'other'] },
        height: { type: 'string', description: 'e.g. 6\'0" or 183 cm' },
        units: { type: 'string', enum: ['lb', 'kg'] },
        goals: {
          type: 'array',
          items: { type: 'string', enum: ['eat_better', 'feel_full', 'lose', 'maintain', 'gain', 'fuel_training'] },
        },
        approach: { type: 'string', enum: ['maintenance', 'deficit'] },
        track_weight: { type: 'boolean' },
        goal_weight: { type: 'number' },
        restrictions: { type: 'array', items: { type: 'string' }, description: 'e.g. gluten-free, vegetarian, dairy-free' },
        allergies: { type: 'array', items: { type: 'string' } },
        dislikes: { type: 'array', items: { type: 'string' } },
        staples: { type: 'array', items: { type: 'string' }, description: 'Foods usually in the house' },
        targets: {
          type: 'object',
          properties: {
            calories_min: { type: 'number' },
            calories_max: { type: 'number' },
            protein_g: { type: 'number' },
            fiber_g: { type: 'number' },
            fat_g: { type: 'number' },
          },
        },
        hide_calories: { type: 'boolean' },
        workout_types: { type: 'array', items: { type: 'string', enum: WORKOUT_TYPES } },
        workouts_per_week: { type: 'number' },
        preferred_days: { type: 'array', items: { type: 'string' } },
        reminder_level: { type: 'string', enum: ['quiet', 'normal', 'accountability'] },
        onboarded: { type: 'boolean' },
      },
    },
  },
];

const KIND_COLLECTION = { meal: 'meals', workout: 'workouts', weight: 'weighins', hunger: 'checkins' };

// Resolve when something happened: { day: 'YYYY-MM-DD', at: Date } in the user's local time.
// `date` (optional) is a local date; `time` (optional) is local HH:MM. Missing time on a
// past date defaults to noon so it still lands on the right day.
export function resolveWhen(clock, date, hhmm) {
  const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= clock.day;
  const day = validDate ? date : clock.day;
  const dayOffset = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${clock.day}T00:00:00Z`)) / 864e5);
  let minutes;
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    minutes = h * 60 + m;
  } else {
    minutes = day === clock.day ? clock.localMinutes : 12 * 60;
  }
  const deltaMin = dayOffset * 1440 + (minutes - clock.localMinutes);
  return { day, at: new Date(clock.now.getTime() + deltaMin * 60000) };
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

const LOG_TOOLS = {
  log_meal: { col: 'meals', kind: 'meal', label: 'meal' },
  log_workout: { col: 'workouts', kind: 'workout', label: 'workout', extra: { source: 'chat' } },
  log_weight: { col: 'weighins', kind: 'weight', label: 'weigh-in' },
  log_hunger: { col: 'checkins', kind: 'hunger', label: 'hunger check-in' },
};

// Execute one tool call. Returns { result (string for the model), entry (for the UI card) | null }.
// Meal totals always equal the sum of the items, so the same foods give the same totals.
export function withItemTotals(input) {
  const items = Array.isArray(input.items) ? input.items.filter(i => i && typeof i.calories === 'number') : [];
  if (!items.length) return input;
  const sum = (k) => Math.round(items.reduce((a, i) => a + (Number(i[k]) || 0), 0) * 10) / 10;
  const out = { ...input, calories: Math.round(sum('calories')), protein_g: sum('protein_g'), fiber_g: sum('fiber_g') };
  if (items.some(i => typeof i.fat_g === 'number')) out.fat_g = sum('fat_g');
  if (items.some(i => typeof i.carbs_g === 'number')) out.carbs_g = sum('carbs_g');
  return out;
}

// Normalized key for matching the same food across meals.
export function foodKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Scale a meal's items for someone who had a different portion.
export function scaleMeal(meal, factor) {
  if (!factor || factor === 1) return meal;
  const f = (v) => (typeof v === 'number' ? Math.round(v * factor * 10) / 10 : v);
  const items = (meal.items || []).map((it) => ({
    ...it, qty: `${it.qty} ×${factor}`,
    calories: f(it.calories), protein_g: f(it.protein_g), fiber_g: f(it.fiber_g), fat_g: f(it.fat_g), carbs_g: f(it.carbs_g),
  }));
  return withItemTotals({ ...meal, items });
}

// Save a shared meal's item numbers to the household food library, so the same shared
// food gets the same numbers in every member's log.
async function saveFoods(household, items, uid, FieldValue) {
  if (!household?.ref || !Array.isArray(items)) return;
  await Promise.all(items.filter((it) => it && typeof it.calories === 'number' && it.name).map((it) => {
    const id = `${foodKey(it.name)}|${String(it.qty || '').toLowerCase().trim()}`.replace(/\//g, '-').slice(0, 300);
    return household.ref.collection('foods').doc(id).set({
      name: it.name, qty: it.qty || '', calories: it.calories, protein_g: it.protein_g ?? null,
      fiber_g: it.fiber_g ?? null, fat_g: it.fat_g ?? null, carbs_g: it.carbs_g ?? null,
      by: uid, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }));
}

export async function runTool(name, input, ctx) {
  const { userRef, clock, FieldValue, sourceMessageId, household, me } = ctx;
  if (name === 'log_meal' || name === 'update_meal') input = withItemTotals(input);
  if (LOG_TOOLS[name]) {
    const { col, kind, label, extra = {} } = LOG_TOOLS[name];
    const { day, at } = resolveWhen(clock, input.date, input.time);
    const { shared_with: sharedWith, their_portion: portion, ...fields } = input;
    const data = clean({
      ...fields, ...extra, date: undefined, time: undefined,
      day, at, createdAt: FieldValue.serverTimestamp(), sourceMessageId,
    });
    const ref = await userRef.collection(col).add(data);
    const entry = { kind, id: ref.id, ...strip(data) };
    let note = '';
    if (name === 'log_meal' && Array.isArray(sharedWith) && sharedWith.length) {
      const res = await shareMeal({ ...ctx, data, sharedWith, portion });
      entry.sharedWith = res.names;
      note = res.names.length ? `; also logged for ${res.names.join(', ')}` : `; could not share (${res.reason})`;
      // Only foods from shared meals go in the household library; everyone's own log stays private.
      if (res.names.length) await saveFoods(household, data.items, me?.uid, FieldValue).catch((e) => console.error('saveFoods', e.message));
    }
    return { result: `logged ${label} id=${ref.id} on ${day}${note}`, entry };
  }

  switch (name) {
    case 'update_meal': {
      const { id, date: d, time: t, ...rest } = input;
      const ref = userRef.collection('meals').doc(id);
      const snap = await ref.get();
      if (!snap.exists) return { result: `no meal with id ${id}`, entry: null };
      const patch = clean({ ...rest, updatedAt: FieldValue.serverTimestamp() });
      if (d || t) Object.assign(patch, resolveWhen(clock, d || snap.data().day, t));
      await ref.update(patch);
      const merged = { ...snap.data(), ...patch };
      return { result: `updated meal ${id}`, entry: { kind: 'meal', id, updated: true, ...strip(merged) } };
    }
    case 'update_pantry': {
      const add = (input.add || []).map((x) => String(x).trim()).filter(Boolean);
      const remove = new Set((input.remove || []).map((x) => foodKey(x)));
      const target = household?.ref || userRef;
      const field = household?.ref ? 'pantry' : 'staples';
      const snap = await target.get();
      const cur = (snap.exists ? snap.data()[field] : null) || [];
      const next = [...cur.filter((x) => !remove.has(foodKey(x)))];
      for (const a of add) if (!next.some((x) => foodKey(x) === foodKey(a))) next.push(a);
      await target.set({ [field]: next }, { merge: true });
      return { result: `pantry now: ${next.join(', ') || '(empty)'}`, entry: { kind: 'pantry', add, remove: input.remove || [], shared: !!household?.ref } };
    }
    case 'delete_entry': {
      const col = KIND_COLLECTION[input.kind];
      if (!col) return { result: 'unknown kind', entry: null };
      await userRef.collection(col).doc(input.id).delete();
      return { result: `deleted ${input.kind} ${input.id}`, entry: { kind: input.kind, id: input.id, deleted: true } };
    }
    case 'save_profile': {
      const patch = clean(input);
      if (patch.targets) {
        // merge nested targets rather than replace
        for (const [k, v] of Object.entries(patch.targets)) patch[`targets.${k}`] = v;
        delete patch.targets;
      }
      patch.updatedAt = FieldValue.serverTimestamp();
      await userRef.set({}, { merge: true });
      await userRef.update(patch);
      return { result: 'profile saved', entry: { kind: 'profile', fields: Object.keys(input) } };
    }
    default:
      return { result: `unknown tool ${name}`, entry: null };
  }
}

// Copy a shared meal into other household members' logs, with a note in their chat.
async function shareMeal({ db, household, me, FieldValue, data, sharedWith, portion }) {
  if (!household?.ref) return { names: [], reason: 'not in a household' };
  const wanted = sharedWith.map((n) => String(n).toLowerCase().trim());
  const targets = household.members.filter((m) => m.uid !== me.uid &&
    wanted.some((w) => w === 'household' || w === 'everyone' || m.name.toLowerCase().startsWith(w) || w.startsWith(m.name.toLowerCase())));
  if (!targets.length) return { names: [], reason: `no household member named ${sharedWith.join(', ')}` };
  const factor = typeof portion === 'number' && portion > 0 && portion <= 3 ? portion : 1;
  const base = scaleMeal({ ...data }, factor);
  await Promise.all(targets.map(async (t) => {
    const uref = db.collection('users').doc(t.uid);
    const copy = clean({ ...base, sourceMessageId: null, sharedFrom: { uid: me.uid, name: me.name }, createdAt: FieldValue.serverTimestamp() });
    const ref = await uref.collection('meals').add(copy);
    await uref.collection('messages').add({
      role: 'assistant',
      text: `${me.name} logged a shared ${data.meal || 'meal'} for you: ${data.description}. If your portion was different, just tell me.`,
      entries: [{ kind: 'meal', id: ref.id, ...strip(copy) }],
      shared: true, day: data.day, createdAt: FieldValue.serverTimestamp(),
    });
  }));
  return { names: targets.map((t) => t.name) };
}

// Drop Firestore sentinels / Dates so the entry can go back to the browser as JSON.
function strip(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'createdAt' || k === 'updatedAt') continue;
    out[k] = v instanceof Date ? v.toISOString() : (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v);
  }
  return out;
}
