# Food Coach (beta)

A food and fitness coach you chat with. Log meals, workouts, weigh-ins and hunger in plain language; the coach turns them into structured data, spots gaps and hunger patterns, and suggests what to eat next.

**Stack:** static PWA on Netlify · Firebase Auth + Firestore · one Netlify function (`netlify/functions/chat.mjs`) that calls the Claude API.

## How it fits together

- `public/` — the app (no build step). Reads the user's own data straight from Firestore.
- `netlify/functions/chat.mjs` — verifies the Firebase ID token, loads the user's context (profile, today, last 14 days, hunger check-ins linked to the meal before them), calls Claude with logging tools, writes entries + both chat messages to Firestore.
- `netlify/functions/lib/prompt.mjs` — the coach's instructions and context builder.
- `netlify/functions/lib/tools.mjs` — `log_meal`, `update_meal`, `log_workout`, `log_weight`, `log_hunger`, `delete_entry`, `save_profile`.
- `netlify/functions/household.mjs` — invite codes, join, leave for household mode.
- `public/js/insights.js` — hunger heat map, weak spots, keeps-you-full (used by the Trends tab and the coach).
- `firestore.rules` — each user can read/write only `users/{their uid}/…`; household members can read their household (names, pantry, shared-meal food numbers) and edit its pantry.

Data lives under `users/{uid}`: the profile doc, plus `messages`, `meals`, `workouts`, `weighins`, `checkins`.
Households live under `households/{id}` (members, names, pantry, `foods` from shared meals); invite codes under `invites/{code}` (server-only).

## Setup

1. **Firebase:** enable Google sign-in and Firestore. Paste the web `firebaseConfig` into `public/js/firebase-config.js`. Publish `firestore.rules` (Firestore → Rules). Add the Netlify domain under Authentication → Settings → Authorized domains.
2. **Netlify env vars** (Site configuration → Environment variables):
   - `ANTHROPIC_API_KEY` — from console.anthropic.com
   - `FIREBASE_SERVICE_ACCOUNT` — the full JSON from Firebase → Project settings → Service accounts → Generate new private key
   - `ALLOWED_EMAILS` — comma-separated beta testers (leave empty to allow anyone with Google)
   - optional `MODEL_FAST` / `MODEL_SMART` — override the default models
3. Deploy (Netlify builds on every push to `main`).

## Local checks

```
npm install
npm run check   # syntax
npm test        # chat function with Firebase + Claude mocked
```
