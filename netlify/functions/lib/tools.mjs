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

const mealFields = {
  description: { type: 'string', description: 'Short plain description, e.g. "2 eggs, wheat toast, coffee w/ milk"' },
  meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'drink'] },
  time,
  items: {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, qty: { type: 'string' } },
      required: ['name'],
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
        weighin_rhythm: { type: 'string', enum: ['daily', 'few_per_week', 'weekly', 'never'] },
        reminder_level: { type: 'string', enum: ['quiet', 'normal', 'accountability'] },
        onboarded: { type: 'boolean' },
      },
    },
  },
];

const KIND_COLLECTION = { meal: 'meals', workout: 'workouts', weight: 'weighins', hunger: 'checkins' };

// Build a Date for an HH:MM local time on the user's local day.
function atLocalTime(clock, hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return clock.now;
  const [h, m] = hhmm.split(':').map(Number);
  const nowMin = clock.localMinutes;
  const deltaMin = (h * 60 + m) - nowMin;
  // A time "later" than now most likely means earlier today was meant wrongly; keep as given.
  return new Date(clock.now.getTime() + deltaMin * 60000);
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

// Execute one tool call. Returns { result (string for the model), entry (for the UI card) | null }.
export async function runTool(name, input, { userRef, clock, FieldValue, sourceMessageId }) {
  const base = { day: clock.day, createdAt: FieldValue.serverTimestamp(), sourceMessageId };

  switch (name) {
    case 'log_meal': {
      const at = atLocalTime(clock, input.time);
      const data = clean({ ...base, ...input, at, time: undefined });
      const ref = await userRef.collection('meals').add(data);
      return { result: `logged meal id=${ref.id}`, entry: { kind: 'meal', id: ref.id, ...strip(data) } };
    }
    case 'update_meal': {
      const { id, ...rest } = input;
      const ref = userRef.collection('meals').doc(id);
      const snap = await ref.get();
      if (!snap.exists) return { result: `no meal with id ${id}`, entry: null };
      const patch = clean({ ...rest, time: undefined, updatedAt: FieldValue.serverTimestamp() });
      if (rest.time) patch.at = atLocalTime(clock, rest.time);
      await ref.update(patch);
      const merged = { ...snap.data(), ...patch };
      return { result: `updated meal ${id}`, entry: { kind: 'meal', id, updated: true, ...strip(merged) } };
    }
    case 'log_workout': {
      const at = atLocalTime(clock, input.time);
      const data = clean({ ...base, ...input, at, time: undefined, source: 'chat' });
      const ref = await userRef.collection('workouts').add(data);
      return { result: `logged workout id=${ref.id}`, entry: { kind: 'workout', id: ref.id, ...strip(data) } };
    }
    case 'log_weight': {
      const at = atLocalTime(clock, input.time);
      const data = clean({ ...base, ...input, at, time: undefined });
      const ref = await userRef.collection('weighins').add(data);
      return { result: `logged weigh-in id=${ref.id}`, entry: { kind: 'weight', id: ref.id, ...strip(data) } };
    }
    case 'log_hunger': {
      const at = atLocalTime(clock, input.time);
      const data = clean({ ...base, ...input, at, time: undefined });
      const ref = await userRef.collection('checkins').add(data);
      return { result: `logged hunger check-in id=${ref.id}`, entry: { kind: 'hunger', id: ref.id, ...strip(data) } };
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
