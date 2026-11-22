// The step 10 bans of eslint.config.js (adoption plan section 3.2), run against fixture text.
// Each case takes the rule entries and globals that eslint.config.js resolves for a real path, so
// the file globs are tested with the selectors: a block that took a rule away from a file group,
// or a missing exception, fails here. Every flagged case also checks that the message says what
// to use instead (section 3.4).
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

const RULES = [
  'no-restricted-syntax',
  'no-restricted-properties',
  'no-restricted-globals',
  'no-restricted-imports',
  'no-warning-comments',
] as const;
const repository = new ESLint({ cwd: repoRoot });

/** The messages of the restricted-* and warning-comment rules for `code` at `path`. */
async function flagged(path: string, code: string): Promise<string[]> {
  const resolved = (await repository.calculateConfigForFile(path)) as Linter.Config;
  const rules: Linter.RulesRecord = {};
  for (const rule of RULES) {
    const entry = resolved.rules?.[rule];
    if (entry !== undefined) rules[rule] = entry;
  }
  // Without type information: these rules read syntax and scope only. The globals decide what
  // no-restricted-globals sees as a global (window.localStorage, a local `fetch`).
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
          globals: resolved.languageOptions?.globals ?? {},
        },
        rules,
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

/** Expects exactly one message for `code` at `path`, matching `message`. */
async function expectOne(path: string, code: string, message: RegExp): Promise<void> {
  const messages = await flagged(path, code);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(message);
}

const BROWSER_PATHS = [
  'apps/portal/src/features/fixture.tsx',
  'apps/player-web/src/platform/fixture.ts',
  'apps/player-web/sw/sw.ts',
  'packages/app-render/src/fixture.ts',
] as const;

describe('web storage and HTML sinks in browser code', () => {
  const STORAGE = /Keep nothing in web storage: .*idb-store\.ts/;

  for (const path of BROWSER_PATHS) {
    it.each([
      "localStorage.setItem('a', 'b');",
      "window.localStorage.getItem('a');",
      "self.localStorage.getItem('a');",
      "globalThis.localStorage.getItem('a');",
      "window['localStorage'].getItem('a');",
      'sessionStorage.clear();',
      'window.sessionStorage.clear();',
      "const { localStorage: ls } = window; ls.setItem('a', 'b');",
      'const { sessionStorage } = globalThis;',
      "const { 'localStorage': ls } = self;",
      'let ls; ({ localStorage: ls } = window);',
    ])(`${path}: flags %s`, async (code) => {
      await expectOne(path, code, STORAGE);
    });

    it.each([
      ["el.insertAdjacentHTML('beforeend', s);", /Do not parse strings as HTML: .*textContent/],
      ['range.createContextualFragment(s);', /Do not parse strings as HTML: .*textContent/],
      ['el.style.cssText = s;', /Do not write a style as one string: .*setProperty/],
      ['el.innerHTML = s;', /Do not assign HTML strings; build DOM nodes or use textContent/],
    ])(`${path}: flags %s`, async (code, message) => {
      await expectOne(path, code, message);
    });
  }

  it.each([
    'apps/portal/src/features/fixture.test.tsx',
    'apps/player-web/src/core/fixture.test.ts',
  ])('flags storage taken apart from window in browser tests too, in %s', async (path) => {
    await expectOne(path, 'const { localStorage: ls } = window;', STORAGE);
  });

  it('leaves a local name, text insertion and single style properties alone', async () => {
    const code = [
      'const localStorage = new Map(); localStorage.get("a");',
      'const { location, document: doc } = window;',
      'const { localStorage: ls } = options;',
      "el.insertAdjacentText('beforeend', s);",
      "el.style.setProperty('color', c);",
      'el.textContent = s;',
    ].join('\n');
    for (const path of BROWSER_PATHS) expect(await flagged(path, code)).toEqual([]);
  });
});

describe('status wording in portal text (P2-04, DEC-33, SCR-17)', () => {
  const PATH = 'apps/portal/src/features/fixture.tsx';
  const ONLINE = /^Status wording stays honest \(P2-04\): .*lib\/screenStatus\.ts/;
  const DISPLAY = /^Operators see the word screen \(DEC-33\): write "screen"/;
  const OPERATOR = /^Customer-facing text does not say operator \(SCR-17\): .*TINNOX CMS/;

  it.each([
    ['<p>Online</p>', ONLINE],
    ['<p>This screen is offline.</p>', ONLINE],
    ["<p>{busy ? 'Offline' : 'Ready'}</p>", ONLINE],
    ['<Card title="Display settings" />', DISPLAY],
    ["<span aria-label={'All displays'} />", DISPLAY],
    ['<Dialog confirmLabel="Remove display" />', DISPLAY],
    ['<p>{`Set by the operator`}</p>', OPERATOR],
    ['<Field hint={`Ask an operator ${name}`} />', OPERATOR],
    ['<img alt="Operator photo" />', OPERATOR],
  ])('flags %s', async (jsx, message) => {
    await expectOne(PATH, `export const x = ${jsx};`, message);
  });

  it('leaves display as a CSS value, an id, a class, a test id and a name in code alone', async () => {
    const code = [
      'export const a = (',
      '  <div',
      '    className="display-grid"',
      '    data-testid="display-row"',
      "    style={{ display: 'flex' }}",
      '    aria-labelledby="sg-card-displays"',
      '    id="displays"',
      '  >',
      '    <p>{display.name}</p>',
      '    <p>Not reporting</p>',
      '    <p>Screens</p>',
      '  </div>',
      ');',
      "export const b = displayName(display, 'online');",
      "const operator = operatorOf(request); const mode = 'offline';",
    ].join('\n');
    expect(await flagged(PATH, code)).toEqual([]);
  });

  it('is for portal source only, not tests or the player', async () => {
    expect(await flagged('apps/portal/src/fixture.test.tsx', 'const x = <p>Online</p>;')).toEqual(
      [],
    );
    expect(
      await flagged('apps/player-web/src/platform/fixture.ts', "const s = 'offline';"),
    ).toEqual([]);
  });

  it('keeps the portal selectors next to the wording', async () => {
    const messages = await flagged(
      PATH,
      "const x = <p dangerouslySetInnerHTML={{ __html: '' }}>Online</p>; const c = (e as { a: 1 }).a;",
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        'dangerouslySetInnerHTML is not allowed.',
        expect.stringMatching(ONLINE),
        expect.stringMatching(/^Do not cast to an inline object type/),
      ]),
    );
    expect(messages).toHaveLength(3);
  });
});

describe('outbound calls in server source (DEC-13, DEC-15)', () => {
  const OUTBOUND = /^.*Outbound calls need a data-location review \(DEC-13, DEC-15\)\./;
  const importOf = (specifier: string) => `import { x } from '${specifier}';`;

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/auth/fixture.ts',
    'apps/media-worker/src/fixture.ts',
    'packages/storage/src/fixture.ts',
    'packages/db/src/fixture.ts',
    'packages/delivery/src/fixture.ts',
  ])('flags network modules, HTTP clients and the two reviewed clients in %s', async (path) => {
    for (const specifier of [
      'node:http',
      'https',
      'node:http2',
      'node:tls',
      'node:dgram',
      'dns',
      'node:dns/promises',
      'undici',
      'axios',
      'ws',
      '@aws-sdk/client-s3',
      'aws-sdk',
      '@smithy/node-http-handler',
      '@google-cloud/storage',
      '@azure/storage-blob',
      '@sendgrid/mail',
      'openid-client',
      'nodemailer',
    ]) {
      await expectOne(path, importOf(specifier), OUTBOUND);
    }
    await expectOne(path, "import { connect } from 'node:net';", OUTBOUND);
    await expectOne(path, "import * as net from 'node:net';", OUTBOUND);
  });

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/main.ts',
    'apps/api/src/alerts-once.ts',
    'apps/media-worker/src/fixture.ts',
    'packages/storage/src/fixture.ts',
    'packages/db/src/fixture.ts',
    'packages/delivery/src/fixture.ts',
  ])('flags import() and require() of the same modules in %s', async (path) => {
    for (const code of [
      "export const m = await import('node:https');",
      "export const m = await import('https');",
      'export const m = await import(`node:http`);',
      "export const m = await import('node:dns/promises');",
      "export const m = await import('node:net');",
      "export const m = await import('@aws-sdk/client-s3');",
      "export const m = await import('socket.io-client');",
      "export const m = await import('nodemailer');",
      "const require = createRequire(import.meta.url); export const m = require('undici');",
    ]) {
      await expectOne(path, code, OUTBOUND);
    }
    expect(await flagged(path, "export const m = await import('node:https');")).toEqual([
      expect.stringMatching(/import\(\) and require\(\) are held to the same rule/),
    ]);
  });

  it('allows import() of what a static import may load, and the reviewed client in its file', async () => {
    for (const path of ['apps/api/src/fixture.ts', 'apps/media-worker/src/fixture.ts']) {
      expect(
        await flagged(
          path,
          "export const a = await import('node:fs/promises'); export const b = await import('./local.ts');",
        ),
      ).toEqual([]);
    }
    expect(
      await flagged('apps/media-worker/src/fixture.ts', "await import('node:child_process');"),
    ).toEqual([]);
    expect(
      await flagged('apps/api/src/auth/oidc.ts', "export const m = await import('openid-client');"),
    ).toEqual([]);
    expect(
      await flagged('apps/api/src/mail.ts', "export const m = await import('nodemailer');"),
    ).toEqual([]);
    await expectOne('apps/api/src/mail.ts', "await import('openid-client');", OUTBOUND);
    await expectOne('apps/api/src/auth/oidc.ts', "await import('node:https');", OUTBOUND);
    await expectOne(
      'apps/api/src/fixture.ts',
      "await import('node:child_process');",
      /Only the media worker starts a child process/,
    );
  });

  it('keeps the API and product selectors next to the import() selectors', async () => {
    for (const path of ['apps/api/src/fixture.ts', 'apps/api/src/mail.ts']) {
      expect(await flagged(path, 'export const t = Date.now(); export const v = a!;')).toEqual([
        expect.stringMatching(/^Do not read the clock here/),
        expect.stringMatching(/^Do not assert a value is not null/),
      ]);
    }
    expect(
      await flagged('apps/api/src/main.ts', 'export const t = Date.now(); export const v = a!;'),
    ).toEqual([expect.stringMatching(/^Do not assert a value is not null/)]);
    await expectOne(
      'packages/db/src/fixture.ts',
      'export const v = (e as { a: 1 }).a;',
      /^Do not cast to an inline object type/,
    );
  });

  it('names the file that holds the reviewed client', async () => {
    expect(await flagged('apps/api/src/fixture.ts', importOf('nodemailer'))).toEqual([
      expect.stringMatching(/nodemailer is used only in apps\/api\/src\/mail\.ts\./),
    ]);
    expect(await flagged('apps/media-worker/src/fixture.ts', importOf('openid-client'))).toEqual([
      expect.stringMatching(/media worker needs none: it runs with no network/),
    ]);
  });

  it.each(['apps/api/src/fixture.ts', 'packages/storage/src/fixture.ts'])(
    'allows a type-only import, which opens no connection, in %s',
    async (path) => {
      for (const code of [
        "import type { IncomingMessage } from 'node:http';",
        "import { type IncomingMessage } from 'node:http';",
        "import type { Socket } from 'node:net';",
        "import type { Transporter } from 'nodemailer';",
      ]) {
        expect(await flagged(path, code)).toEqual([]);
      }
    },
  );

  it('flags a child process outside the media worker only', async () => {
    for (const path of ['apps/api/src/fixture.ts', 'packages/storage/src/fixture.ts']) {
      await expectOne(
        path,
        "import { execFile } from 'node:child_process';",
        /Only the media worker starts a child process/,
      );
    }
    expect(
      await flagged(
        'apps/media-worker/src/inspect.ts',
        "import { execFile } from 'node:child_process';",
      ),
    ).toEqual([]);
  });

  it('allows each reviewed client in its own file only', async () => {
    expect(await flagged('apps/api/src/auth/oidc.ts', importOf('openid-client'))).toEqual([]);
    expect(await flagged('apps/api/src/mail.ts', importOf('nodemailer'))).toEqual([]);
    await expectOne('apps/api/src/auth/oidc.ts', importOf('nodemailer'), OUTBOUND);
    await expectOne('apps/api/src/mail.ts', importOf('openid-client'), OUTBOUND);
    await expectOne('apps/api/src/mail.ts', importOf('node:https'), OUTBOUND);
  });

  it('keeps the layer rules in the two client files', async () => {
    await expectOne(
      'apps/api/src/mail.ts',
      importOf('pg'),
      /Only packages\/db talks to PostgreSQL/,
    );
    await expectOne(
      'apps/api/src/auth/oidc.ts',
      importOf('@tinnox/app-render'),
      /apps\/api may import only/,
    );
  });

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/routes/fixture.ts',
    'apps/media-worker/src/fixture.ts',
  ])('leaves address parsing, crypto, files and HTTP serving alone in %s', async (path) => {
    const code = [
      "import { isIP, isIPv6 } from 'node:net';",
      "import { randomUUID } from 'node:crypto';",
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
    ].join('\n');
    expect(await flagged(path, code)).toEqual([]);
  });

  it.each([
    'apps/api/src/fixture.ts',
    'apps/media-worker/src/fixture.ts',
    'packages/storage/src/fixture.ts',
    'packages/db/src/fixture.ts',
    'packages/delivery/src/fixture.ts',
  ])('flags the network globals in %s', async (path) => {
    for (const code of [
      'await fetch(url);',
      'await globalThis.fetch(url);',
      'new WebSocket(url);',
      'new EventSource(url);',
      'new XMLHttpRequest();',
    ]) {
      await expectOne(path, code, OUTBOUND);
    }
  });

  it.each([
    'apps/api/src/fixture.test.ts',
    'apps/api/test/fixture.integration.test.ts',
    'apps/api/scripts/live-check.mjs',
  ])('leaves tests and development scripts free to call out, in %s', async (path) => {
    expect(await flagged(path, "import http from 'node:http'; await fetch(url);")).toEqual([]);
  });
});

describe('process.env outside the entry points and config modules', () => {
  const ENV =
    /^'process\.env' is restricted from being used\. Read configuration at an entry point/;

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/config.ts',
    'apps/media-worker/src/inspect.ts',
    'packages/db/src/fixture.ts',
    'apps/player-web/sw/sw.ts',
    'scripts/lib/provision.ts',
  ])('flags it in %s', async (path) => {
    await expectOne(path, "const v = process.env['A'];", ENV);
    await expectOne(path, 'const { env } = process;', /process\.env' is restricted/);
  });

  it('keeps the browser restricted properties beside it', async () => {
    const messages = await flagged(
      'apps/portal/src/features/fixture.tsx',
      'el.innerHTML = process.env.A;',
    );
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(ENV),
        expect.stringMatching(/'innerHTML' is restricted/),
      ]),
    );
  });

  it.each([
    'apps/api/src/main.ts',
    'apps/api/src/alerts-once.ts',
    'apps/media-worker/src/main.ts',
    'scripts/lib/env.ts',
    'scripts/check-migrations.ts',
    'apps/api/src/config.test.ts',
    'apps/api/test/support.ts',
    'tests/integration/support.ts',
  ])('allows it in the entry point, config module or test %s', async (path) => {
    expect(await flagged(path, "const v = process.env['A'];")).toEqual([]);
  });
});

describe('the clock in apps/api/src', () => {
  const CLOCK = /^Do not read the clock here: use the injected clock, ctx\.now\(\)/;

  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/src/routes/fixture.ts',
    'apps/api/src/media/pipeline.ts',
  ])('flags every clock read in %s', async (path) => {
    for (const code of [
      'const t = Date.now();',
      'const d = new Date();',
      'const d = new Date;',
      'const s = Date();',
      'const now = Date.now;',
    ]) {
      await expectOne(path, code, CLOCK);
    }
  });

  it('leaves conversions and the injected clock alone', async () => {
    const code = [
      'const a = new Date(0);',
      'const b = new Date(seconds * 1000);',
      'const c = ctx.now();',
      'const d = Date.parse(s);',
      'const e = Date.UTC(2026, 0, 1);',
    ].join('\n');
    expect(await flagged('apps/api/src/routes/fixture.ts', code)).toEqual([]);
  });

  it.each([
    'apps/api/src/main.ts',
    'apps/api/src/alerts-once.ts',
    'apps/api/src/fixture.test.ts',
    'apps/api/test/support.ts',
    'apps/media-worker/src/fixture.ts',
    'packages/db/src/fixture.ts',
  ])('leaves %s alone', async (path) => {
    expect(await flagged(path, 'const d = new Date(); const t = Date.now();')).toEqual([]);
  });

  it('keeps the other API selectors beside it', async () => {
    const messages = await flagged(
      'apps/api/src/fixture.ts',
      'const t = Date.now(); const n = v!.a; const c = (e as { a: 1 }).a;',
    );
    expect(messages).toHaveLength(3);
  });
});

describe('credential names (AG-1.9, AG-1.17, D4, D5)', () => {
  const CREDENTIAL =
    /^Product code never names the migrator, superuser or provisioning credentials/;
  const MIGRATOR = /^Only the offline tools in MIGRATOR_URL_READERS of eslint\.config\.js/;

  it.each([
    'apps/api/src/fixture.ts',
    // No override yet: step 12 adds it with loadConfig's refusal (D5).
    'apps/api/src/config.ts',
    'apps/api/src/main.ts',
    'apps/media-worker/src/main.ts',
    'apps/portal/src/features/fixture.tsx',
    'apps/player-web/sw/sw.ts',
    'packages/db/src/migrate.ts',
  ])('flags them in %s', async (path) => {
    for (const code of [
      "requireEnv('DATABASE_MIGRATOR_URL');",
      'const p = env.TINNOX_MIGRATOR_PASSWORD;',
      "const s = 'POSTGRES_SUPERUSER_PASSWORD';",
      'const k = `PROVISION_IDP_CLIENT_SECRET`;',
    ]) {
      await expectOne(path, code, CREDENTIAL);
    }
  });

  it.each(['apps/api/src/config.test.ts', 'packages/db/test/support.ts'])(
    'leaves the test file %s alone',
    async (path) => {
      expect(await flagged(path, "need('TEST_DATABASE_MIGRATOR_URL');")).toEqual([]);
    },
  );

  it.each(['scripts/fixture.ts', 'scripts/lib/provision.ts', 'scripts/reset-dev.mjs'])(
    'flags the migrator URL in %s, a script that is not a migrator tool',
    async (path) => {
      await expectOne(path, "requireEnv('DATABASE_MIGRATOR_URL');", MIGRATOR);
      await expectOne(path, 'const u = env.TEST_DATABASE_MIGRATOR_URL;', MIGRATOR);
    },
  );

  it.each([
    'scripts/migrate.ts',
    'scripts/seed.ts',
    'scripts/provision-member.ts',
    'scripts/setup-dev.mjs',
    'scripts/vitest-integration-setup.ts',
    'scripts/lib/fixture.test.ts',
  ])('allows it in %s', async (path) => {
    expect(await flagged(path, "requireEnv('DATABASE_MIGRATOR_URL');")).toEqual([]);
  });

  it('keeps the script selectors beside it', async () => {
    const messages = await flagged(
      'scripts/lib/fixture.ts',
      "requireEnv('DATABASE_MIGRATOR_URL'); const n = v!.a; const c = (e as { a: 1 }).a;",
    );
    expect(messages).toHaveLength(3);
  });
});

describe('bare userEvent.keyboard in component tests (SCR-16)', () => {
  const KEYBOARD = /^Type into the element: userEvent\.type\(locator, text\)/;

  it.each([
    'apps/portal/src/features/fixture.test.tsx',
    'apps/portal/src/lib/fixture.test-support.ts',
    'apps/portal/src/session/fixture.test-support.tsx',
  ])('flags it in %s', async (path) => {
    await expectOne(path, "await userEvent.keyboard('Winter');", KEYBOARD);
  });

  it('allows typing into an element', async () => {
    expect(
      await flagged(
        'apps/portal/src/features/fixture.test.tsx',
        "await userEvent.type(field, 'Winter{Enter}');",
      ),
    ).toEqual([]);
  });

  it("allows settleTestFrame's Shift press and keeps that file's other test rules", async () => {
    const path = 'apps/portal/src/testFrame.test-support.ts';
    expect(await flagged(path, "await userEvent.keyboard('{Shift}');")).toEqual([]);
    await expectOne(path, "it.skip('a', () => {});", /^A skipped, focused or expected-to-fail/);
  });
});

describe('the organisation id from the request (AG-2.3)', () => {
  const ORG = /^The organisation comes from operatorOf\(request\)\.orgId or the device credential/;

  it.each([
    'const id = request.body.orgId;',
    'const id = request.params.org_id;',
    'const id = request.query.organisationId;',
    "const id = request.headers['x-org-id'];",
    'const id = req.raw.headers.orgId;',
    'const { orgId } = request.body;',
    "const { 'org_id': id } = request.query;",
    'const Body = z.object({ orgId: z.string() });',
    'app.get<{ Params: { orgId: string } }>(path, handler);',
  ])('flags %s', async (code) => {
    await expectOne('apps/api/src/routes/fixture.ts', code, ORG);
  });

  it('applies to the rest of API source too', async () => {
    await expectOne('apps/api/src/auth/fixture.ts', 'const id = request.body.orgId;', ORG);
  });

  it('leaves the session, the device and other keys alone', async () => {
    const code = [
      'const a = operatorOf(request).orgId;',
      'const b = device.orgId; const c = session.orgId; const d = job.orgId;',
      'const e = request.params.id;',
      "const f = await tx.query<{ org_id: string }>('SELECT org_id FROM display');",
      'const g = z.object({ id: z.string() });',
      'app.get<{ Params: { id: string } }>(path, handler);',
    ].join('\n');
    expect(await flagged('apps/api/src/routes/fixture.ts', code)).toEqual([]);
  });
});

describe('warning comments', () => {
  it.each([
    ['apps/api/src/fixture.ts', '// TODO: later'],
    ['apps/portal/src/features/fixture.tsx', '/* FIXME */'],
    ['packages/db/src/fixture.ts', '// a HACK around the pool'],
    ['scripts/fixture.mjs', '// XXX'],
    ['tests/integration/fixture.test.ts', '// todo'],
  ])('flags %s: %s', async (path, comment) => {
    await expectOne(
      path,
      `${comment}\nexport const a = 1;`,
      /^Unexpected '(todo|fixme|hack|xxx)' comment/,
    );
  });

  it('leaves words that only contain a term alone', async () => {
    expect(
      await flagged(
        'apps/api/src/fixture.ts',
        '// Todos are hacky to fix; see xxxx.\nexport const a = 1;',
      ),
    ).toEqual([]);
  });
});
