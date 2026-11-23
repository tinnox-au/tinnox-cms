/**
 * The addresses of the end-to-end stack. Here rather than in stack.ts so that
 * tests/playwright.config.ts can give them to the previews without loading stack.ts, which
 * reads the root .env. stack.ts re-exports them and checks every one is loopback (EAX-09).
 */
export const PORTAL_URL = 'http://localhost:5173';
export const PLAYER_URL = 'http://localhost:5174';
export const API_URL = 'http://localhost:4000';
/** Mailpit's web and HTTP API (15-alerts.spec.ts reads the run's e-mail there). */
export const MAILPIT_URL = 'http://127.0.0.1:8025';
