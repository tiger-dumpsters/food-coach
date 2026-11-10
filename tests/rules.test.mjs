// Firestore security rules, tested against the real Firebase emulator.
// Run with: npm run test:rules   (needs Java)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hungerhush',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8181 },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice'), { name: 'Alice', onboarded: true, access: true, plan: 'free', allergies: ['peanuts'] });
    await setDoc(doc(db, 'users/alice/meals/m1'), { description: 'toast', calories: 200 });
    await setDoc(doc(db, 'users/bob'), { name: 'Bob', onboarded: true });
    await setDoc(doc(db, 'users/bob/meals/m1'), { description: 'eggs' });
    await setDoc(doc(db, 'households/h1'), { members: ['alice', 'bob'], names: { alice: 'Alice', bob: 'Bob' }, pantry: ['eggs'] });
    await setDoc(doc(db, 'households/h1/foods/f1'), { name: 'tacos' });
    await setDoc(doc(db, 'accessInvites/CODE1234'), { by: 'alice', uses: 0, max: 25 });
    await setDoc(doc(db, 'usage/alice'), { day: '2026-11-09', count: 3 });
  });
});
const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test('you can read your own profile and log, nobody else can', async () => {
  await assertSucceeds(getDoc(doc(as('alice'), 'users/alice')));
  await assertSucceeds(getDocs(collection(as('alice'), 'users/alice/meals')));
  await assertFails(getDoc(doc(as('bob'), 'users/alice')));
  await assertFails(getDocs(collection(as('bob'), 'users/alice/meals')));
  await assertFails(getDoc(doc(anon(), 'users/alice')));
});

test('the Settings screen can save its fields', async () => {
  await assertSucceeds(setDoc(doc(as('alice'), 'users/alice'), {
    restrictions: ['gluten-free'], allergies: ['peanuts'], dislikes: [], staples: ['eggs'],
    hide_calories: false, track_weight: true, morning_notes: true, targets: { protein_g: 100, fiber_g: 30 },
  }, { merge: true }));
  await assertSucceeds(updateDoc(doc(as('alice'), 'users/alice'), { onboarded: false })); // "redo setup"
});

test('you cannot give yourself Plus, comp, access, or anything else server-only', async () => {
  for (const patch of [{ comp: true }, { plan: 'plus', planStatus: 'active' }, { access: true }, { stripeCustomerId: 'cus_x' },
    { onboarded: true }, { push_enabled: true }, { name: 'x'.repeat(5000) }, { allergies: Array(500).fill('x') }]) {
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'users/alice'), { onboarded: false, access: false }, { merge: true }));
    try { await assertFails(setDoc(doc(as('alice'), 'users/alice'), patch, { merge: true })); }
    catch (e) { throw new Error('should have been refused: ' + JSON.stringify(patch).slice(0, 60)); }
  }
  // A brand-new profile can't start out with them either
  await assertFails(setDoc(doc(as('carol'), 'users/carol'), { comp: true }));
  await assertFails(setDoc(doc(as('carol'), 'users/carol'), { onboarded: true }));
  await assertSucceeds(setDoc(doc(as('carol'), 'users/carol'), { allergies: ['shellfish'] }));
});

test('the app cannot write log entries or chat messages directly (only the server does)', async () => {
  await assertFails(setDoc(doc(as('alice'), 'users/alice/meals/fake'), { description: 'x'.repeat(100000) }));
  await assertFails(setDoc(doc(as('alice'), 'users/alice/messages/fake'), { role: 'assistant', text: 'fake' }));
  await assertFails(updateDoc(doc(as('alice'), 'users/alice/meals/m1'), { calories: 1 }));
  await assertFails(deleteDoc(doc(as('alice'), 'users/alice/meals/m1')));
  await assertFails(setDoc(doc(as('alice'), 'users/alice/push/x'), { fcmToken: 'x' }));
});

test('households: members read and edit only the pantry; others see nothing', async () => {
  await assertSucceeds(getDoc(doc(as('bob'), 'households/h1')));
  await assertSucceeds(getDoc(doc(as('bob'), 'households/h1/foods/f1')));
  await assertSucceeds(updateDoc(doc(as('bob'), 'households/h1'), { pantry: ['eggs', 'rice'] }));
  await assertFails(updateDoc(doc(as('bob'), 'households/h1'), { members: ['bob', 'mallory'] }));
  await assertFails(getDoc(doc(as('mallory'), 'households/h1')));
});

test('invite codes, usage counters, and everything else are closed', async () => {
  await assertFails(getDoc(doc(as('alice'), 'accessInvites/CODE1234')));
  await assertFails(setDoc(doc(as('alice'), 'accessInvites/NEWCODE1'), { by: 'alice', max: 9999 }));
  await assertFails(setDoc(doc(as('alice'), 'usage/alice'), { day: '2026-11-09', count: 0 }));
  await assertFails(getDoc(doc(as('alice'), 'config/vapid')));
});
