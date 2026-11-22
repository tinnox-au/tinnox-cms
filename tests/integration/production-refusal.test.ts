/**
 * D19 and brief section 6: the real API entry point, started with NODE_ENV=production
 * and the development configuration, must exit without ever listening.
 */
import { describe, expect, it } from 'vitest';
import { developmentEnv, freePort, listening, runApiEntryPoint } from './support.ts';

const runApi = (env: Record<string, string>) => runApiEntryPoint('src/main.ts', env);

describe('production start-up', () => {
  const devEnv = developmentEnv();

  it('has a generated development configuration to test with', () => {
    expect(devEnv['SESSION_SECRET'] ?? '').toMatch(/^dev-/);
  });

  it('refuses the development configuration and names each problem without printing a value', async () => {
    const port = await freePort();
    const result = await runApi({ ...devEnv, NODE_ENV: 'production', API_PORT: String(port) });
    expect(result.code).toBe(1);
    expect(await listening(port)).toBe(false);
    for (const expected of [
      'SESSION_SECRET is a development or placeholder value',
      'MEDIA_URL_HMAC_SECRET is a development or placeholder value',
      'OIDC_CLIENT_SECRET is a development or placeholder value',
      'OIDC_ISSUER points at the development realm tinnox-dev',
      'must use https in production',
      'production requires MFA evidence',
    ]) {
      expect(result.output).toContain(expected);
    }
    for (const name of [
      'SESSION_SECRET',
      'MEDIA_URL_HMAC_SECRET',
      'PAIRING_CLIENT_KEY_SECRET',
      'OIDC_CLIENT_SECRET',
      'TINNOX_APP_PASSWORD',
    ]) {
      const value = devEnv[name] ?? '';
      expect(value.length).toBeGreaterThan(8);
      expect(result.output, `${name} must not be printed`).not.toContain(value);
    }
  });

  it('still refuses when only one development setting is left', async () => {
    // Fixed values, so a failing run can be replayed; the name keeps them distinct, as the
    // configuration requires of the three signing secrets.
    const strong = (name: string): string => 'k'.repeat(8) + name + 'Zq9'.repeat(12);
    const production: Record<string, string> = {
      ...devEnv,
      NODE_ENV: 'production',
      API_PUBLIC_ORIGIN: 'https://api.cms.example',
      PORTAL_ORIGIN: 'https://portal.cms.example',
      PLAYER_ORIGIN: 'https://player.cms.example',
      OIDC_ISSUER: 'https://id.example/realms/tinnox',
      OIDC_REDIRECT_URI: 'https://portal.cms.example/api/auth/callback',
      OIDC_POST_LOGOUT_REDIRECT_URI: 'https://portal.cms.example/',
      OIDC_MFA_ACR_VALUES: 'mfa',
      OIDC_CLIENT_SECRET: strong('oidc'),
      SESSION_SECRET: strong('session'),
      MEDIA_URL_HMAC_SECRET: strong('media'),
      PAIRING_CLIENT_KEY_SECRET: strong('pairing'),
    };
    const cases: [string, Record<string, string>, string][] = [
      [
        'a development session secret',
        { SESSION_SECRET: devEnv['SESSION_SECRET'] ?? '' },
        'SESSION_SECRET is a development or placeholder value',
      ],
      [
        'the development realm',
        { OIDC_ISSUER: 'https://id.example/realms/tinnox-dev' },
        'development realm',
      ],
      [
        'a plain-http portal',
        { PORTAL_ORIGIN: 'http://portal.cms.example' },
        'PORTAL_ORIGIN must use https in production',
      ],
      ['no MFA evidence', { OIDC_MFA_ACR_VALUES: '' }, 'production requires MFA evidence'],
      [
        'a development SMTP password',
        { SMTP_USER: 'alerts', SMTP_PASSWORD: 'dev-smtp-password' },
        'SMTP_PASSWORD is a development or placeholder value',
      ],
    ];
    for (const [what, override, message] of cases) {
      const port = await freePort();
      const result = await runApi({ ...production, ...override, API_PORT: String(port) });
      expect(result.code, what).toBe(1);
      expect(result.output, what).toContain(message);
      expect(await listening(port), what).toBe(false);
    }
  }, 120_000);
});
