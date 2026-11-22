import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMIT_ENV_VARS } from '@tinnox/contracts';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  isAdministratorName,
  loadConfig,
  REPO_ROOT,
  REVIEWED_SMTP_HOSTS,
  RUNTIME_ENV_NAMES,
  runtimeEnv,
  type LoadConfigOptions,
} from './config.ts';

const strong = (label: string): string => `${label}-9f2c7a1d4b8e6035a7c1d9e2f4b6a8c0e1d3f5a7`;

const development: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://tinnox_app:dev-local-password@127.0.0.1:54329/tinnox',
  API_PUBLIC_ORIGIN: 'http://localhost:4000',
  PORTAL_ORIGIN: 'http://localhost:5173',
  PLAYER_ORIGIN: 'http://localhost:5174',
  SESSION_SECRET: 'dev-session-secret-0123456789abcdef0123456789abcdef',
  MEDIA_URL_HMAC_SECRET: 'dev-media-secret-0123456789abcdef0123456789abcdef',
  PAIRING_CLIENT_KEY_SECRET: 'dev-pairing-secret-0123456789abcdef0123456789abcdef',
  OIDC_ISSUER: 'http://localhost:8080/realms/tinnox-dev',
  OIDC_CLIENT_ID: 'tinnox-portal-bff',
  OIDC_CLIENT_SECRET: 'dev-client-secret-0123456789abcdef',
  OIDC_REDIRECT_URI: 'http://localhost:5173/api/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'http://localhost:5173/',
};

const production: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: `postgres://tinnox_app:${strong('db')}@db.internal:5432/tinnox`,
  API_PUBLIC_ORIGIN: 'https://api.signage.example',
  PORTAL_ORIGIN: 'https://portal.signage.example',
  PLAYER_ORIGIN: 'https://player.signage.example',
  SESSION_SECRET: strong('session'),
  MEDIA_URL_HMAC_SECRET: strong('media'),
  PAIRING_CLIENT_KEY_SECRET: strong('pairing'),
  OIDC_ISSUER: 'https://id.signage.example/realms/operators',
  OIDC_CLIENT_ID: 'portal',
  OIDC_CLIENT_SECRET: strong('client'),
  OIDC_REDIRECT_URI: 'https://portal.signage.example/api/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'https://portal.signage.example/',
  OIDC_MFA_AMR_VALUES: 'otp, mfa',
};

/** A test-only stand-in for REVIEWED_SMTP_HOSTS, so no real host is listed for a test. */
const reviewed: LoadConfigOptions = { reviewedSmtpHosts: ['smtp.reviewed.example'] };

function problems(
  env: Record<string, string | undefined>,
  options: LoadConfigOptions = {},
): string[] {
  try {
    loadConfig(env, options);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe('loadConfig in development', () => {
  it('accepts the generated loopback configuration', () => {
    const config = loadConfig(development);
    expect(config.secureCookies).toBe(false);
    expect(config.sessionCookieName).toBe('tinnox_session');
    expect(config.oidc.allowInsecureRequests).toBe(true);
    expect(config.port).toBe(4000);
    expect(config.mediaRoot.endsWith('/data/media')).toBe(true);
    expect(config.limits.maxUploadBytes).toBe(200 * 1024 * 1024);
  });

  it('refuses plain http anywhere but loopback, even outside production', () => {
    expect(
      problems({ ...development, PORTAL_ORIGIN: 'http://portal.example.com' }).join(' '),
    ).toContain('PORTAL_ORIGIN may use http only on a loopback host');
    expect(
      problems({ ...development, OIDC_ISSUER: 'http://id.example.com/realms/x' }).join(' '),
    ).toContain('OIDC_ISSUER may use http only on a loopback host');
  });

  it('refuses the same origin for portal and player', () => {
    expect(
      problems({ ...development, PLAYER_ORIGIN: development['PORTAL_ORIGIN'] }).join(' '),
    ).toContain('must be different origins');
  });

  it('refuses a redirect URI that is not the callback route on a known origin', () => {
    for (const uri of [
      'http://localhost:5173/api/auth/other',
      'http://localhost:9999/api/auth/callback',
      'http://localhost:5173/api/auth/callback?next=/x',
    ]) {
      expect(problems({ ...development, OIDC_REDIRECT_URI: uri }).join(' ')).toContain(
        'OIDC_REDIRECT_URI must be',
      );
    }
    expect(
      problems({ ...development, OIDC_REDIRECT_URI: 'http://localhost:4000/api/auth/callback' }),
    ).toEqual([]);
  });

  it('refuses to run as any database role but tinnox_app', () => {
    expect(
      problems({
        ...development,
        DATABASE_URL: 'postgres://tinnox_migrator:x@127.0.0.1:54329/tinnox',
      }).join(' '),
    ).toContain('must connect as the runtime role tinnox_app');
  });

  it('refuses short or reused secrets and invalid limits', () => {
    expect(problems({ ...development, SESSION_SECRET: 'short' }).join(' ')).toContain(
      'SESSION_SECRET',
    );
    expect(
      problems({ ...development, MEDIA_URL_HMAC_SECRET: development['SESSION_SECRET'] }).join(' '),
    ).toContain('three different values');
    expect(problems({ ...development, LIMIT_MAX_UPLOAD_BYTES: '-5' }).join(' ')).toContain(
      'LIMIT_MAX_UPLOAD_BYTES',
    );
    expect(
      problems({ ...development, SESSION_IDLE_TIMEOUT_SECONDS: '90000' }).length,
    ).toBeGreaterThan(0);
  });

  it('never puts a secret value in an error message', () => {
    const text = problems({ ...development, NODE_ENV: 'production' }).join(' ');
    for (const name of [
      'SESSION_SECRET',
      'MEDIA_URL_HMAC_SECRET',
      'PAIRING_CLIENT_KEY_SECRET',
      'OIDC_CLIENT_SECRET',
    ]) {
      expect(text).not.toContain(development[name]);
    }
    expect(text).not.toContain('dev-local-password');
  });
});

describe('loadConfig in production (D19)', () => {
  it('accepts a complete https configuration with real secrets', () => {
    const config = loadConfig(production);
    expect(config.secureCookies).toBe(true);
    expect(config.sessionCookieName).toBe('__Host-tinnox_session');
    expect(config.loginCookieName).toBe('__Host-tinnox_login');
    expect(config.oidc.allowInsecureRequests).toBe(false);
    expect(config.oidc.mfaAmrValues).toEqual(['otp', 'mfa']);
    // No SMTP_HOST, no e-mail: production starts without alerts.
    expect(config.mail).toBeNull();
  });

  it('refuses the whole development configuration, naming every reason', () => {
    const found = problems({ ...development, NODE_ENV: 'production' });
    const text = found.join('\n');
    for (const expected of [
      'SESSION_SECRET is a development or placeholder value',
      'MEDIA_URL_HMAC_SECRET is a development or placeholder value',
      'PAIRING_CLIENT_KEY_SECRET is a development or placeholder value',
      'OIDC_CLIENT_SECRET is a development or placeholder value',
      'DATABASE_URL password is a development or placeholder value',
      'OIDC_ISSUER must use https in production',
      'OIDC_ISSUER points at the development realm tinnox-dev',
      'API_PUBLIC_ORIGIN must use https in production',
      'PORTAL_ORIGIN must use https in production',
      'PLAYER_ORIGIN must use https in production',
      'OIDC_REDIRECT_URI must use https in production',
      'production requires MFA evidence',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it.each([
    ['SESSION_SECRET', 'dev-0123456789abcdef0123456789abcdef0123456789'],
    ['MEDIA_URL_HMAC_SECRET', 'DEV-0123456789abcdef0123456789abcdef0123456789'],
    ['PAIRING_CLIENT_KEY_SECRET', 'change-me-change-me-change-me-change-me'],
    ['OIDC_CLIENT_SECRET', 'dev-0123456789abcdef0123456789abcdef'],
    ['DATABASE_URL', 'postgres://tinnox_app:dev-password@db.internal:5432/tinnox'],
  ])('refuses a development value in %s', (name, value) => {
    expect(problems({ ...production, [name]: value }).join(' ')).toContain(
      'development or placeholder value',
    );
  });

  it.each([
    ['API_PUBLIC_ORIGIN', 'http://api.signage.example'],
    ['PORTAL_ORIGIN', 'http://localhost:5173'],
    ['PLAYER_ORIGIN', 'http://127.0.0.1:5174'],
    ['OIDC_ISSUER', 'http://localhost:8080/realms/operators'],
  ])('refuses plain http for %s, loopback included', (name, value) => {
    expect(problems({ ...production, [name]: value }).join(' ')).toContain(
      `${name} must use https in production`,
    );
  });

  it('refuses the development realm even over https', () => {
    expect(
      problems({ ...production, OIDC_ISSUER: 'https://id.signage.example/realms/tinnox-dev' }).join(
        ' ',
      ),
    ).toContain('development realm');
  });

  it('refuses to start without an MFA evidence requirement', () => {
    const { OIDC_MFA_AMR_VALUES: _removed, ...withoutMfa } = production;
    expect(problems(withoutMfa).join(' ')).toContain('production requires MFA evidence');
    expect(problems({ ...withoutMfa, OIDC_MFA_ACR_VALUES: 'urn:example:mfa' })).toEqual([]);
  });
});

describe('e-mail (SMTP)', () => {
  it('is off without SMTP_HOST', () => {
    expect(loadConfig(development).mail).toBeNull();
  });

  it('reads the Mailpit settings setup-dev writes', () => {
    expect(
      loadConfig({
        ...development,
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1025',
        MAIL_FROM: 'alerts@tinnox-dev.invalid',
      }).mail,
    ).toEqual({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
      user: null,
      password: null,
      from: 'alerts@tinnox-dev.invalid',
    });
  });

  it('needs MAIL_FROM with SMTP_HOST, and the user and password together', () => {
    const found = problems({ ...development, SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u' });
    expect(found).toContain('MAIL_FROM is required when SMTP_HOST is set');
    expect(found).toContain('SMTP_USER and SMTP_PASSWORD must be set together');
    expect(
      problems({ ...development, SMTP_HOST: 'h', MAIL_FROM: 'not an address' }).join(' '),
    ).toContain('MAIL_FROM must be an e-mail address');
  });

  it('refuses a development SMTP password in production, without printing it', () => {
    const found = problems(
      {
        ...production,
        SMTP_HOST: 'smtp.reviewed.example',
        MAIL_FROM: 'alerts@signage.example',
        SMTP_USER: 'AKIAEXAMPLE',
        SMTP_PASSWORD: 'dev-smtp-password',
      },
      reviewed,
    );
    expect(found).toEqual(['SMTP_PASSWORD is a development or placeholder value']);
    expect(found.join(' ')).not.toContain('dev-smtp-password');
  });

  it('accepts a provider over STARTTLS or implicit TLS in production', () => {
    const smtp = {
      ...production,
      SMTP_HOST: 'smtp.reviewed.example',
      MAIL_FROM: 'alerts@signage.example',
      SMTP_USER: 'AKIAEXAMPLE',
      SMTP_PASSWORD: strong('smtp'),
    };
    expect(loadConfig(smtp, reviewed).mail?.secure).toBe(false);
    expect(
      loadConfig({ ...smtp, SMTP_PORT: '465', SMTP_SECURE: 'true' }, reviewed).mail?.secure,
    ).toBe(true);
  });
});

describe('production mail host (D23, DEC-13)', () => {
  const smtp = {
    ...production,
    MAIL_FROM: 'alerts@signage.example',
    SMTP_USER: 'AKIAEXAMPLE',
    SMTP_PASSWORD: strong('smtp'),
  };
  const refusal = 'SMTP_HOST is not a reviewed mail host';

  it('lists no host until the provider review names an Australian endpoint', () => {
    expect(REVIEWED_SMTP_HOSTS).toEqual([]);
    expect(
      problems({ ...smtp, SMTP_HOST: 'email-smtp.ap-southeast-2.amazonaws.com' }).join(' '),
    ).toContain(refusal);
  });

  it('accepts a listed host', () => {
    expect(loadConfig({ ...smtp, SMTP_HOST: 'smtp.reviewed.example' }, reviewed).mail?.host).toBe(
      'smtp.reviewed.example',
    );
  });

  it.each([
    ['an unlisted public mail host', 'smtp.unreviewed.example'],
    ['a loopback address, which could relay anywhere', '127.0.0.1'],
    ['a loopback name', 'localhost'],
    ['a subdomain of a listed host (no wildcard)', 'eu.smtp.reviewed.example'],
    ['a listed host with a suffix', 'smtp.reviewed.example.attacker.example'],
  ])('refuses %s, saying what to do and never printing the host', (_what, host) => {
    const found = problems({ ...smtp, SMTP_HOST: host }, reviewed);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(refusal);
    expect(found[0]).toContain('REVIEWED_SMTP_HOSTS (apps/api/src/config.ts)');
    expect(found[0]).toContain('DEC-13');
    expect(found[0]).not.toContain(host);
  });

  it('compares lower-cased, so a case variant of a listed host is that host; nothing else is', () => {
    expect(problems({ ...smtp, SMTP_HOST: 'SMTP.Reviewed.EXAMPLE' }, reviewed)).toEqual([]);
    // Matched exactly: not even the same name with the root's trailing dot.
    expect(problems({ ...smtp, SMTP_HOST: 'SMTP.REVIEWED.EXAMPLE.' }, reviewed)).toEqual([
      expect.stringContaining(refusal),
    ]);
  });

  it('leaves development and the test suites free to use Mailpit or any host', () => {
    for (const mode of ['development', 'test']) {
      for (const host of ['127.0.0.1', 'smtp.unreviewed.example']) {
        expect(
          problems({
            ...development,
            NODE_ENV: mode,
            SMTP_HOST: host,
            MAIL_FROM: 'alerts@tinnox-dev.invalid',
          }),
        ).toEqual([]);
      }
    }
  });
});

describe('the allow-listed configuration input (D5, AG-1.9, AG-1.17)', () => {
  // The names .env.example sets: what `npm run setup` writes into the root .env. Read line by
  // line: parseEnv of Node 23.10 takes a last commented line (`# NAME=value`) for a name.
  const documented = [
    ...readFileSync(join(REPO_ROOT, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm),
  ]
    .map((match) => match[1] ?? '')
    .sort();
  const administratorNames = documented.filter(isAdministratorName);
  // Made up here: nothing may print them.
  const credential = (name: string): string => `value-of-${name.toLowerCase()}-7c1d9e2f4b6a8c0e`;

  it('reads the keys of EnvSchema and the LIMIT_ names, and no administrator name', () => {
    for (const name of ['DATABASE_URL', 'SESSION_SECRET', 'SMTP_PASSWORD', 'TRUST_PROXY']) {
      expect(RUNTIME_ENV_NAMES).toContain(name);
    }
    for (const name of Object.values(LIMIT_ENV_VARS)) expect(RUNTIME_ENV_NAMES).toContain(name);
    expect(RUNTIME_ENV_NAMES.filter(isAdministratorName)).toEqual([]);
  });

  it('finds every administrator name of .env.example, and none is a name the API reads', () => {
    expect(administratorNames).toEqual([
      'DATABASE_MIGRATOR_URL',
      'KC_BOOTSTRAP_ADMIN_PASSWORD',
      'POSTGRES_SUPERUSER_PASSWORD',
      'PROVISION_IDP_CLIENT_ID',
      'PROVISION_IDP_CLIENT_SECRET',
      'TEST_DATABASE_MIGRATOR_URL',
      'TINNOX_MIGRATOR_PASSWORD',
    ]);
    for (const name of administratorNames) expect(RUNTIME_ENV_NAMES).not.toContain(name);
    // The optional one that .env.example only mentions in a comment.
    expect(isAdministratorName('PROVISION_IDP_ISSUER')).toBe(true);
  });

  it("has a decision for every name of .env.example: read by the API, refused, or another tool's", () => {
    // Names of the containers, the seed and the tests. They hold no administrator credential,
    // and the API does not read them. A new name in .env.example belongs in EnvSchema (the API
    // reads it), in the administrator names of config.ts (the API refuses it) or here.
    const otherTools = [
      'DEV_ADMIN_OIDC_SUB',
      'DEV_EDITOR_OIDC_SUB',
      'DEV_OPERATOR_OIDC_SUB',
      'DEV_SECOND_ORG_OIDC_SUB',
      'DEV_VIEWER_OIDC_SUB',
      'KC_BOOTSTRAP_ADMIN_USERNAME',
      'POSTGRES_HOST_PORT',
      'TEST_DATABASE_URL',
      'TINNOX_APP_PASSWORD',
    ];
    expect(
      documented.filter((name) => !RUNTIME_ENV_NAMES.includes(name) && !isAdministratorName(name)),
    ).toEqual(otherTools);
  });

  it.each(['development', 'test', 'production'])(
    'refuses each administrator name in %s, by name and without its value',
    (mode) => {
      const base = mode === 'production' ? production : { ...development, NODE_ENV: mode };
      expect(problems(base)).toEqual([]);
      for (const name of [...administratorNames, 'PROVISION_IDP_ISSUER']) {
        const found = problems({ ...base, [name]: credential(name) });
        expect(found, name).toHaveLength(1);
        expect(found[0], name).toMatch(new RegExp(`^${name} is set in the environment`));
        expect(found[0], name).toContain(
          'Start the process with its own environment, not the whole root .env',
        );
        expect(found[0], name).toContain('RUNTIME_ENV_NAMES in apps/api/src/config.ts');
        expect(found[0], name).not.toContain(credential(name));
      }
    },
  );

  it('names every administrator name at once, beside the other problems', () => {
    const whole = Object.fromEntries(administratorNames.map((name) => [name, credential(name)]));
    const found = problems({ ...development, ...whole, DATABASE_URL: undefined });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(new RegExp(`^${administratorNames.join(', ')} are set in`));
    expect(found[1]).toContain('DATABASE_URL');
    for (const name of administratorNames) {
      expect(found.join(' ')).not.toContain(credential(name));
    }
  });

  it('treats a blank administrator name as not set, like every other name', () => {
    expect(
      problems({ ...development, DATABASE_MIGRATOR_URL: '', PROVISION_IDP_ISSUER: ' ' }),
    ).toEqual([]);
  });

  it('builds the same configuration whatever other names the environment holds', () => {
    const others = {
      PATH: '/usr/bin',
      TEST_DATABASE_URL: 'postgres://tinnox_app:other@127.0.0.1:1/other_test',
      TINNOX_APP_PASSWORD: 'other',
      DEV_OPERATOR_OIDC_SUB: '00000000-0000-4000-8000-000000000000',
      MAX_UPLOAD_BYTES: '1',
    };
    expect(loadConfig({ ...development, ...others })).toEqual(loadConfig(development));
  });

  describe('runtimeEnv', () => {
    const file = {
      ...development,
      LOG_LEVEL: 'debug',
      SMTP_HOST: '127.0.0.1',
      MAIL_FROM: 'alerts@tinnox-dev.invalid',
      LIMIT_MAX_PLAYLIST_ITEMS: '50',
      TEST_DATABASE_URL: 'postgres://tinnox_app:other@127.0.0.1:1/other_test',
      ...Object.fromEntries(administratorNames.map((name) => [name, credential(name)])),
    };

    it('takes the names the API reads from the root .env, and nothing else', () => {
      const env = runtimeEnv({}, file);
      expect(Object.keys(env).sort()).toEqual(
        [
          ...Object.keys(development),
          'LIMIT_MAX_PLAYLIST_ITEMS',
          'LOG_LEVEL',
          'MAIL_FROM',
          'SMTP_HOST',
        ].sort(),
      );
      // The whole development file, administrator credentials included, starts the API.
      const config = loadConfig(env);
      expect(config.logLevel).toBe('debug');
      expect(config.limits.maxPlaylistItems).toBe(50);
      expect(config.mail?.host).toBe('127.0.0.1');
    });

    it('lets the process environment win, even with an empty value', () => {
      const env = runtimeEnv({ LOG_LEVEL: 'warn', SMTP_HOST: '', PATH: '/usr/bin' }, file);
      expect(env['LOG_LEVEL']).toBe('warn');
      expect(env['SMTP_HOST']).toBe('');
      expect(env['PATH']).toBe('/usr/bin');
      const config = loadConfig(env);
      expect(config.logLevel).toBe('warn');
      expect(config.mail).toBeNull();
    });

    it('passes an administrator name of the process environment on, so loadConfig refuses it', () => {
      const name = 'DATABASE_MIGRATOR_URL';
      const found = problems(runtimeEnv({ [name]: credential(name) }, file));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^DATABASE_MIGRATOR_URL is set in the environment/);
    });

    it('is the process environment alone where there is no root .env (a deployment)', () => {
      expect(runtimeEnv(production, {})).toEqual(production);
    });
  });
});

describe('DATABASE_URL start-up settings', () => {
  it.each(['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'])(
    "refuses %s in the query, which pg would put in place of createPool's own",
    (parameter) => {
      const marker = 'value-that-must-not-be-printed';
      for (const base of [development, production]) {
        const found = problems({
          ...base,
          DATABASE_URL: `${base['DATABASE_URL']}?${parameter}=${marker}`,
        });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(new RegExp(`^DATABASE_URL sets ${parameter} in its query`));
        expect(found[0]).toContain('remove that parameter from the connection string');
        expect(found[0]).not.toContain(marker);
      }
    },
  );

  it('leaves other query parameters alone', () => {
    expect(
      problems({
        ...production,
        DATABASE_URL: `${production['DATABASE_URL']}?sslmode=verify-full`,
      }),
    ).toEqual([]);
  });
});

describe('TRUST_PROXY', () => {
  it('refuses "true" in every mode, because the client controls the leftmost X-Forwarded-For entry', () => {
    expect(problems({ ...development, TRUST_PROXY: 'true' }).join(' ')).toMatch(/TRUST_PROXY=true/);
    expect(problems({ ...production, TRUST_PROXY: 'true' }).join(' ')).toMatch(/TRUST_PROXY=true/);
  });

  it('accepts no proxy, or explicit proxy addresses and ranges', () => {
    expect(loadConfig(development).trustProxy).toBe(false);
    expect(loadConfig({ ...development, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...production, TRUST_PROXY: '10.0.0.0/8, 192.0.2.7' }).trustProxy).toBe(
      '10.0.0.0/8,192.0.2.7',
    );
    expect(loadConfig({ ...development, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(loadConfig({ ...development, TRUST_PROXY: '2001:db8::/32' }).trustProxy).toBe(
      '2001:db8::/32',
    );
  });

  it('refuses malformed or over-broad values', () => {
    for (const value of [
      'yes',
      '1',
      '11',
      '0.0.0.0/0',
      '10.0.0.0/4',
      '::/0',
      '10.0.0.1/33',
      'proxy.internal',
      '1.2.3.4/8/9',
    ]) {
      expect(problems({ ...development, TRUST_PROXY: value }).join(' '), value).toMatch(
        /TRUST_PROXY/,
      );
    }
  });

  it('with the proxy listed, a client cannot choose its own address through X-Forwarded-For', async () => {
    const { default: Fastify } = await import('fastify');
    const config = loadConfig({ ...development, TRUST_PROXY: '10.0.0.2' });
    const app = Fastify({ trustProxy: config.trustProxy });
    app.get('/ip', (request) => ({ ip: request.ip }));
    try {
      const spoofed = await app.inject({
        url: '/ip',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      });
      // The proxy (10.0.0.2) appended the real client; the client's own entry is ignored.
      expect(spoofed.json()).toEqual({ ip: '203.0.113.9' });
    } finally {
      await app.close();
    }
  });
});
