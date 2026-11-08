// Free and Plus tiers: what each plan includes, and which plan a person is on.
//
// Tiers stay off until TIERS_ENABLED=true, so everyone keeps every feature during the
// beta. After that: Plus if they pay (Stripe sets plan/planStatus) or are comped
// (users/{uid}.comp = true, set by hand in the Firebase console for friends and family).

export const PLANS = {
  free: {
    name: 'Free',
    get messagesPerDay() { return Number(process.env.FREE_MESSAGES_PER_DAY || 25); },
    photos: false,     // photo logging
    household: false,  // starting or inviting into a household (joining a Plus member's is free)
    smartModel: false, // questions and advice use the fast model
  },
  plus: {
    name: 'Plus',
    get messagesPerDay() { return Number(process.env.DAILY_MESSAGE_CAP || 150); },
    photos: true,
    household: true,
    smartModel: true,
  },
};

const PAID_STATUSES = ['active', 'trialing', 'past_due']; // past_due: Stripe is still retrying the card

export function tiersEnabled() {
  return process.env.TIERS_ENABLED === 'true';
}

export function planFor(profile) {
  if (!tiersEnabled()) return 'plus';
  const p = profile || {};
  if (p.comp === true) return 'plus';
  if (p.plan === 'plus' && PAID_STATUSES.includes(p.planStatus)) return 'plus';
  return 'free';
}

export function limitsFor(profile) {
  return PLANS[planFor(profile)];
}

// What the app needs to show the plan panel and lock features.
export function planSummary(profile) {
  const id = planFor(profile);
  const p = profile || {};
  return {
    plan: id,
    tiersEnabled: tiersEnabled(),
    comp: p.comp === true,
    paid: p.plan === 'plus' && PAID_STATUSES.includes(p.planStatus),
    renewsAt: p.planRenewsAt || null,
    cancelAtPeriodEnd: p.planCancelAtPeriodEnd === true,
    limits: { ...PLANS[id], messagesPerDay: PLANS[id].messagesPerDay },
    priceLabel: process.env.PLUS_PRICE_LABEL || '',
    billingReady: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
  };
}

export const UPGRADE = {
  photos: 'Photo logging is part of Plus. You can describe the meal in words and I\'ll log it the same way.',
  household: 'Households are part of Plus. Once you upgrade, you can invite your partner or family, and they join free.',
  cap: (n) => `That's today's ${n} messages on the free plan. It resets tomorrow, or Plus gives you more.`,
};
