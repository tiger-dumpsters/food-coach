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
};

export const TOOLS = [
  {
    name: 'log_meal',
    description: 'Record food or drink the user says they ate/drank. Estimate nutrition sensibly; one call per meal or snack.',
    input_schema: {
      type: 'object',
      properties: mealFields,
      required: ['description', 'calories', 'protein_g', 'fiber_g', 'processing'],
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
export async function runTool(name, input, { userRef, clock, FieldValue, sourceMessageId }) {
  if (LOG_TOOLS[name]) {
    const { col, kind, label, extra = {} } = LOG_TOOLS[name];
    const { day, at } = resolveWhen(clock, input.date, input.time);
    const data = clean({
      ...input, ...extra, date: undefined, time: undefined,
      day, at, createdAt: FieldValue.serverTimestamp(), sourceMessageId,
    });
    const ref = await userRef.collection(col).add(data);
    return { result: `logged ${label} id=${ref.id} on ${day}`, entry: { kind, id: ref.id, ...strip(data) } };
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

// Drop Firestore sentinels / Dates so the entry can go back to the browser as JSON.
function strip(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'createdAt' || k === 'updatedAt') continue;
    out[k] = v instanceof Date ? v.toISOString() : (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v);
  }
  return out;
}
