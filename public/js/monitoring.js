// Error reporting from the app (Sentry). Paste the project's DSN below to turn it on.
// The DSN is designed to be public; it only lets the app send error reports.
// Sentry's loader is tiny and only downloads the full SDK when an error happens,
// so this doesn't slow the app down. No chat text, food logs, or emails are sent.
export const SENTRY_DSN = 'https://00eef66098b0f144de28bb57c156b10d@o4512404956971008.ingest.us.sentry.io/4512404977745920';

const m = /^https:\/\/([^@]+)@/.exec(SENTRY_DSN);
if (m) {
  window.sentryOnLoad = () => {
    window.Sentry.init({
      dsn: SENTRY_DSN,
      environment: location.hostname === 'gethungerhush.com' ? 'production' : location.hostname,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeBreadcrumb: (b) => (b.category === 'console' || b.category === 'ui.input' ? null : b),
    });
  };
  const s = document.createElement('script');
  s.src = `https://js.sentry-cdn.com/${m[1]}.min.js`;
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
}

// Called by app.js once someone signs in: an anonymous ID only (no name or email).
export function identify(uid) {
  try { window.Sentry?.setUser?.(uid ? { id: uid } : null); } catch {}
}
