// The import boundaries of eslint.config.js (adoption plan section 3.1, step 7), run against
// fixture text. Each case takes the no-restricted-imports options that eslint.config.js resolves
// for a real path, so the generated blocks are tested with their globs: a block that took the
// rule away from a file group would fail here.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import { loadSpecifiers } from './load-specifiers.ts';

const RULE = 'no-restricted-imports';
const repository = new ESLint({ cwd: repoRoot });

/** The no-restricted-imports messages for `code` at `path`. */
async function flagged(path: string, code: string): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const entry = resolved[RULE];
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        // Every extension trackedCodeFiles lists, so the repository test of import() and require()
        // also lints .js and .cjs files; module syntax, so the synthetic static import parses.
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.js', '**/*.cjs'],
        languageOptions: {
          sourceType: 'module',
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: entry === undefined ? {} : { [RULE]: entry },
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const importOf = (specifier: string) => `import { x } from '${specifier}';`;

/** Every workspace of the root package.json, plus scripts. */
function workspaces(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('workspaces' in manifest) ||
    !Array.isArray(manifest.workspaces)
  ) {
    throw new Error('package.json has no workspaces array');
  }
  const dirs = manifest.workspaces.flatMap((entry: unknown): string[] => {
    if (typeof entry !== 'string') throw new Error('a workspace entry is not a string');
    if (!entry.endsWith('/*')) return [entry];
    const parent = entry.slice(0, -2);
    return readdirSync(join(repoRoot, parent), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => `${parent}/${dirent.name}`)
      .filter((dir) => existsSync(join(repoRoot, dir, 'package.json')));
  });
  return [...new Set([...dirs, 'scripts', 'tests'])].sort();
}

async function layerTable(): Promise<Record<string, unknown>> {
  // A computed specifier keeps the type checker away from the untyped config file.
  const config = pathToFileURL(join(repoRoot, 'eslint.config.js')).href;
  const loaded: unknown = await import(config);
  if (typeof loaded !== 'object' || loaded === null || !('IMPORT_LAYERS' in loaded)) {
    throw new Error('eslint.config.js exports no IMPORT_LAYERS');
  }
  const table = loaded.IMPORT_LAYERS;
  if (typeof table !== 'object' || table === null) throw new Error('IMPORT_LAYERS is no object');
  return { ...table };
}

// The first case of each of the next two describes loads eslint.config.js, once by import and
// once through ESLint, which a busy CI runner can stretch towards the unit project's 5 s default
// (GAP-1).
describe('the layer table', { timeout: 30_000 }, () => {
  it('has one row for every workspace of the root package.json, plus scripts and tests', async () => {
    expect(Object.keys(await layerTable()).sort()).toEqual(workspaces());
  });
});

const APP = /^'.*' import is restricted from being used by a pattern\. Apps are not libraries\./;
const RELATIVE = /Do not reach into another workspace by relative path\. Import '@tinnox\/<name>'/;
const DEEP = /Do not import a file inside another package\. Import its entry/;
const TEST_CODE = /Product code does not import test code\. Move what both need into a module/;
// LINT-3: the pg message names only what the file group may use instead.
const PG =
  /Only packages\/db talks to PostgreSQL\. Use createPool and the transaction openers of @tinnox\/db \(readOrg, changeOrg, changePreOrg\)/;
// The browser apps' sentence is true for their Node build files too (vite.config.ts, build/).
const PG_BROWSER =
  /^(?!.*@tinnox\/db).*Only packages\/db talks to PostgreSQL, and apps\/(portal|player-web) has no database connection\. Its browser code calls the API through apps\/(portal\/src\/api|player-web\/src\/platform\/api\.ts); its build files .* run in Node/;
const BROWSER_LAYER =
  /may import only .* Its browser code calls the API through .*; its build files/;
const PG_WORKER =
  /^(?!.*@tinnox\/db).*Only packages\/db talks to PostgreSQL\. The media worker has no database: .*job directory/;
const PG_PACKAGE =
  /Only packages\/db talks to PostgreSQL\. packages\/[a-z-]+ may not import @tinnox\/db: take the data you need as a parameter/;
// D19: the message says how to write the import that is allowed.
const TYPES_ONLY =
  /packages\/db takes only types from @tinnox\/contracts \(D19\): write `import type \{ \.\.\. \} from '@tinnox\/contracts'`, with `type` after `import`\. A value import would load @tinnox\/contracts, and zod with it/;
const SCRIPTS_LIB = /scripts\/lib holds the offline tools .*Move what both need into a package/;
const FASTIFY = /Only apps\/api serves HTTP\. Add the route under apps\/api\/src\/routes/;
const BROWSER =
  /This file is bundled for the browser, where Node modules do not exist\. Call the API/;
const DOMAIN = /packages\/domain is pure: it imports only @tinnox\/contracts .* as parameters/;
const CONTRACTS = /packages\/contracts holds schemas and types: it imports only zod/;
const ROUTE = /A route file imports no other route file \(D6\)\. Move the shared code to a module/;
const OUTSIDE_ROUTES =
  /Only apps\/api\/src\/app\.ts imports from routes\/ \(D6\)\. Import the shared/;

// One representative path per row of the table: a forbidden import, the message that says what
// to do instead, and imports the row allows.
const ROWS: readonly {
  path: string;
  forbidden: readonly (readonly [string, RegExp])[];
  allowed: readonly string[];
}[] = [
  {
    path: 'packages/contracts/src/fixture.ts',
    forbidden: [
      ['@tinnox/domain', /^.*packages\/contracts is a bottom layer/],
      ['node:crypto', CONTRACTS],
      ['@tinnox/api', APP],
    ],
    allowed: ['zod', 'zod/v4', './ids.ts'],
  },
  {
    path: 'packages/storage/src/fixture.ts',
    forbidden: [
      ['@tinnox/contracts', /packages\/storage is a bottom layer/],
      ['pg', PG_PACKAGE],
      ['../../../scripts/lib/env.ts', SCRIPTS_LIB],
    ],
    allowed: ['node:fs/promises', './local.ts'],
  },
  {
    path: 'packages/db/src/fixture.ts',
    forbidden: [
      // D19: a value import of the one package it takes types from.
      ['@tinnox/contracts', TYPES_ONLY],
      [
        '@tinnox/domain',
        /packages\/db is a bottom layer: it imports no @tinnox package at run time, and types only from @tinnox\/contracts \(import type\)/,
      ],
      ['../../../scripts/lib/env.ts', SCRIPTS_LIB],
    ],
    allowed: ['pg', 'node:crypto', './tx.ts'],
  },
  {
    path: 'packages/domain/src/fixture.ts',
    forbidden: [
      ['@tinnox/db', /packages\/domain may import only @tinnox\/contracts from @tinnox\/\*/],
      ['node:crypto', DOMAIN],
      ['crypto', DOMAIN],
      ['zod', DOMAIN],
      ['react', DOMAIN],
    ],
    allowed: ['@tinnox/contracts', './types.ts'],
  },
  {
    path: 'packages/domain/src/fixture.test.ts',
    forbidden: [['@tinnox/delivery', /packages\/domain may import only @tinnox\/contracts/]],
    allowed: ['vitest', '@tinnox/contracts', './fixtures.test-support.ts'],
  },
  {
    path: 'packages/app-render/src/fixture.ts',
    forbidden: [
      ['@tinnox/domain', /packages\/app-render may import only @tinnox\/contracts/],
      ['node:fs', BROWSER],
    ],
    allowed: ['@tinnox/contracts', 'uqr', './qr.ts'],
  },
  {
    path: 'packages/delivery/src/fixture.ts',
    forbidden: [
      ['@tinnox/db', /packages\/delivery may import only @tinnox\/contracts, @tinnox\/domain/],
      ['@tinnox/api', APP],
      ['../../db/src/index.ts', RELATIVE],
    ],
    allowed: ['@tinnox/contracts', '@tinnox/domain', 'node:path', './browser/index.ts'],
  },
  {
    path: 'apps/api/src/fixture.ts',
    forbidden: [
      ['@tinnox/portal', APP],
      ['@tinnox/app-render', /apps\/api may import only @tinnox\/contracts, @tinnox\/db/],
      ['pg', PG],
      ['@tinnox/db/src/pool.ts', DEEP],
      ['../../../packages/db/src/pool.ts', RELATIVE],
      ['../../../scripts/lib/provision.ts', SCRIPTS_LIB],
    ],
    allowed: [
      '@tinnox/db',
      '@tinnox/storage',
      '@tinnox/delivery',
      'fastify',
      '@fastify/cookie',
      './context.ts',
    ],
  },
  {
    path: 'apps/media-worker/src/fixture.ts',
    forbidden: [
      ['@tinnox/db', /apps\/media-worker may import only @tinnox\/contracts/],
      ['@tinnox/api/test-support', APP],
      ['pg', PG_WORKER],
      ['fastify', FASTIFY],
    ],
    allowed: ['@tinnox/contracts', 'sharp', 'node:child_process'],
  },
  {
    path: 'apps/portal/src/features/fixture.tsx',
    forbidden: [
      [
        '@tinnox/db',
        /apps\/portal may import only .* Its browser code calls the API through apps\/portal\/src\/api/,
      ],
      ['@tinnox/delivery', /apps\/portal may import only @tinnox\/contracts, @tinnox\/domain/],
      ['@tinnox/player-web', APP],
      ['node:fs', BROWSER],
      ['fs', BROWSER],
      ['fs/promises', BROWSER],
      ['child_process', BROWSER],
      ['pg', PG_BROWSER],
      ['fastify', FASTIFY],
      ['../../../api/src/app.ts', RELATIVE],
      ['../../../../scripts/lib/env.ts', SCRIPTS_LIB],
    ],
    allowed: [
      '@tinnox/contracts',
      '@tinnox/app-render',
      'react',
      '../../api/client.ts',
      // A portal feature folder named apps is not the apps/ directory.
      '../apps/AppPreview.tsx',
      '../../apps/AppPreview.tsx',
      // Bare builtin names that are also browser polyfills on npm stay allowed.
      'buffer',
      'events',
      'url',
    ],
  },
  {
    path: 'apps/player-web/src/platform/fixture.ts',
    forbidden: [
      [
        '@tinnox/storage',
        /apps\/player-web may import only .* Its browser code calls the API through apps\/player-web\/src\/platform\/api\.ts/,
      ],
      ['node:crypto', BROWSER],
      ['pg', PG_BROWSER],
    ],
    allowed: ['@tinnox/domain', '@tinnox/app-render', 'idb', '../core/machine.ts'],
  },
  {
    path: 'apps/player-web/sw/sw.ts',
    forbidden: [['node:path', BROWSER]],
    allowed: ['@tinnox/contracts'],
  },
  {
    path: 'tests/integration/fixture.test.ts',
    forbidden: [
      ['@tinnox/api/src/app.ts', APP],
      ['@tinnox/api', APP],
      ['@tinnox/delivery', /tests may import only @tinnox\/contracts, @tinnox\/db/],
      ['../../apps/api/src/auth/oidc.ts', RELATIVE],
      ['../../apps/api/test/support.ts', RELATIVE],
      ['fastify', FASTIFY],
    ],
    allowed: [
      '@tinnox/api/test-support',
      // The light entry of the API's names (CHK-9): a subpath of the harness's own entry.
      '@tinnox/api/test-support/runtime-env',
      '@tinnox/db',
      '@tinnox/app-render',
      'pg',
      './support.ts',
      // Not a workspace (section 3.1, rule (c)): provisioning's test reads scripts/lib directly.
      '../../scripts/lib/provision.ts',
    ],
  },
  {
    path: 'scripts/lib/fixture.ts',
    forbidden: [
      ['pg', PG],
      [
        '@tinnox/storage',
        /scripts may import only @tinnox\/contracts, @tinnox\/db, @tinnox\/domain/,
      ],
      ['@tinnox/api/test-support', APP],
      ['@tinnox/api/test-support/runtime-env', APP],
    ],
    allowed: ['@tinnox/db', '@tinnox/contracts', '@tinnox/domain', 'node:child_process'],
  },
];

describe('import boundaries, one row per workspace (section 3.1)', { timeout: 30_000 }, () => {
  for (const row of ROWS) {
    it.each(row.forbidden)(`${row.path}: flags %s`, async (specifier, message) => {
      const messages = await flagged(row.path, importOf(specifier));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(message);
    });

    it(`${row.path}: allows ${row.allowed.join(', ')}`, async () => {
      expect(await flagged(row.path, row.allowed.map(importOf).join('\n'))).toEqual([]);
    });
  }

  it('sees re-exports and type-only imports too', async () => {
    const code = [
      "export * from '@tinnox/db';",
      "export { x } from '@tinnox/db';",
      "import type { Tx } from '@tinnox/db';",
    ].join('\n');
    expect(await flagged('apps/portal/src/fixture.ts', code)).toHaveLength(3);
  });

  // Rule (c): a sibling with the same parent is reached without an apps/ or packages/ segment.
  it.each([
    ['apps/portal/src/App.tsx', "import { buildApp } from '../../api/src/app.ts';", [RELATIVE]],
    [
      'packages/delivery/src/index.ts',
      "export { withOrg } from '../../db/src/index.ts';",
      [RELATIVE],
    ],
    ['apps/player-web/sw/sw.ts', "import { x } from '../../portal/src/main.tsx';", [RELATIVE]],
    ['apps/api/test/support.ts', "import { x } from '../../media-worker/src/main.ts';", [RELATIVE]],
    // The pure package's allow-list reports it as well.
    ['packages/domain/src/fixture.ts', importOf('../../db/src/pool.ts'), [RELATIVE, DOMAIN]],
  ])('flags the relative path into a sibling workspace in %s', async (path, code, messages) => {
    expect(await flagged(path, code)).toEqual(
      messages.map((m): unknown => expect.stringMatching(m)),
    );
  });

  it('leaves the Vite configuration and portal tests free to use Node modules', async () => {
    expect(await flagged('apps/portal/vite.config.ts', importOf('node:url'))).toEqual([]);
    expect(await flagged('apps/portal/src/styles/fixture.test.ts', importOf('node:fs'))).toEqual(
      [],
    );
  });
});

const SIDE_EFFECTS = '@typescript-eslint/no-import-type-side-effects';

/** The messages of no-import-type-side-effects for `code` at `path`, as eslint.config.js resolves the rule there. */
async function inlineTypeImportsFlagged(path: string, code: string): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const entry = resolved[SIDE_EFFECTS];
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        plugins: { '@typescript-eslint': tseslint.plugin },
        languageOptions: { sourceType: 'module', parser: tseslint.parser },
        rules: entry === undefined ? {} : { [SIDE_EFFECTS]: entry },
      },
    ],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

describe('the type-only import of packages/db (D19)', { timeout: 30_000 }, () => {
  const DB_FILES = ['packages/db/src/sec.ts', 'packages/db/test/fixture.integration.test.ts'];

  it.each(DB_FILES)('lets %s import and re-export types of @tinnox/contracts', async (path) => {
    const code = [
      "import type { AuditAction } from '@tinnox/contracts';",
      "export type { AuditEventOf } from '@tinnox/contracts';",
      'export type A = AuditAction;',
    ].join('\n');
    expect(await flagged(path, code)).toEqual([]);
    expect(await inlineTypeImportsFlagged(path, code)).toEqual([]);
  });

  it.each([
    "import { AUDIT_ACTIONS } from '@tinnox/contracts';",
    // One value among the names makes the whole statement a value import.
    "import { AUDIT_ACTIONS, type AuditAction } from '@tinnox/contracts';",
    "import * as contracts from '@tinnox/contracts';",
    "import '@tinnox/contracts';",
    "export { AUDIT_ACTIONS } from '@tinnox/contracts';",
    "export * from '@tinnox/contracts';",
  ])('flags the value import %s', async (code) => {
    for (const path of DB_FILES) {
      expect(await flagged(path, code)).toEqual([expect.stringMatching(TYPES_ONLY)]);
    }
  });

  it('flags the inline form, which type stripping leaves behind as an import of the package', async () => {
    const code = "import { type AuditAction } from '@tinnox/contracts';";
    for (const path of DB_FILES) {
      // allowTypeImports reads the names, so the layer rule lets this form pass...
      expect(await flagged(path, code)).toEqual([]);
      // ...and this rule is what refuses it.
      expect(await inlineTypeImportsFlagged(path, code)).toEqual([
        expect.stringMatching(
          /leave behind a side effect import at runtime\. Convert this to a top-level type qualifier/,
        ),
      ]);
    }
  });

  it('opens no other package and no file inside the package', async () => {
    const path = 'packages/db/src/sec.ts';
    expect(await flagged(path, "import type { Role } from '@tinnox/domain';")).toEqual([
      expect.stringMatching(/packages\/db is a bottom layer/),
    ]);
    expect(
      await flagged(path, "import type { AuditAction } from '@tinnox/contracts/src/audit.ts';"),
    ).toEqual([expect.stringMatching(DEEP)]);
  });

  it('leaves every other workspace without the inline-form rule and with its own layer row', async () => {
    const code = "import { type Role } from '@tinnox/contracts';";
    expect(await inlineTypeImportsFlagged('apps/api/src/fixture.ts', code)).toEqual([]);
    expect(
      await flagged(
        'packages/storage/src/fixture.ts',
        "import type { Role } from '@tinnox/contracts';",
      ),
    ).toEqual([
      expect.stringMatching(/packages\/storage is a bottom layer and imports no @tinnox package\./),
    ]);
  });
});

describe('pg outside packages/db (rule (g), D25)', () => {
  it.each([
    ['apps/api/src/fixture.ts', PG],
    ['apps/api/scripts/fixture.mjs', PG],
    ['scripts/seed.ts', PG],
    ['scripts/lib/provision.ts', PG],
    ['apps/media-worker/src/fixture.ts', PG_WORKER],
    ['packages/storage/src/fixture.ts', PG_PACKAGE],
    ['packages/delivery/src/fixture.ts', PG_PACKAGE],
    // A package may not import an app, so app-render is not told to call the apps' API clients.
    ['packages/app-render/src/fixture.ts', PG_PACKAGE],
    ['apps/player-web/sw/sw.ts', PG_BROWSER],
    // The Vite configuration and the player's build plugin run in Node, not in the browser: the
    // message must not tell them they are bundled.
    ['apps/portal/vite.config.ts', PG_BROWSER],
    ['apps/player-web/vite.config.ts', PG_BROWSER],
    ['apps/player-web/build/shell-plugin.mjs', PG_BROWSER],
  ])(
    'flags pg in the non-test file %s, naming what it may use instead (LINT-3)',
    async (path, message) => {
      expect(await flagged(path, "import pg from 'pg';")).toEqual([expect.stringMatching(message)]);
    },
  );

  it('names the build files in the layer message of the Vite configuration, which is not bundled', async () => {
    expect(
      await flagged('apps/portal/vite.config.ts', "import { createPool } from '@tinnox/db';"),
    ).toEqual([expect.stringMatching(BROWSER_LAYER)]);
  });

  it.each([
    'packages/db/src/pool.ts',
    'packages/db/test/fixture.integration.test.ts',
    'apps/api/test/support.ts',
    'apps/api/src/fixture.test.ts',
    'tests/integration/support.ts',
    'tests/e2e/support/database.ts',
    'scripts/lib/fixture.test.ts',
    'scripts/vitest-integration-setup.ts',
  ])('allows pg in %s, which arranges data with its own client', async (path) => {
    expect(await flagged(path, "import pg from 'pg';")).toEqual([]);
  });
});

describe('test code (rule (h))', () => {
  it.each([
    ['packages/domain/src/fixture.ts', './fixtures.test-support.ts'],
    ['apps/portal/src/fixture.tsx', './testFrame.test-support.ts'],
    ['apps/api/src/fixture.ts', '../test/support.ts'],
    ['apps/api/src/fixture.ts', './security.test.ts'],
    ['scripts/lib/fixture.ts', '../../tests/integration/support.ts'],
  ])('flags a test import in the non-test file %s', async (path, specifier) => {
    expect(await flagged(path, importOf(specifier))).toEqual([expect.stringMatching(TEST_CODE)]);
  });

  it.each([
    ['apps/portal/src/componentTests.setup.ts', './testFrame.test-support.ts'],
    ['packages/domain/src/fixture.test.ts', './fixtures.test-support.ts'],
    ['apps/api/test/fixture.integration.test.ts', './support.ts'],
  ])('lets the test file %s import test support', async (path, specifier) => {
    expect(await flagged(path, importOf(specifier))).toEqual([]);
  });
});

describe('route files (rule (i), D6)', () => {
  it.each(['./media.ts', '../routes/media.ts', '../../src/routes/media.ts'])(
    'flags %s in a route file',
    async (specifier) => {
      const messages = await flagged('apps/api/src/routes/playlists.ts', importOf(specifier));
      expect(messages).toEqual([expect.stringMatching(ROUTE)]);
    },
  );

  it('lets a route file import the shared modules outside routes/', async () => {
    const code = [
      '../display-state.ts',
      '../media/rows.ts',
      '../tags.ts',
      '../publishing.ts',
      '../auth/permissions.ts',
    ]
      .map(importOf)
      .join('\n');
    expect(await flagged('apps/api/src/routes/playlists.ts', code)).toEqual([]);
  });

  it.each([
    ['apps/api/src/publishing.ts', './routes/media.ts'],
    ['apps/api/src/security.test.ts', './routes/media.ts'],
    ['apps/api/src/media/rows.ts', '../routes/media.ts'],
    ['apps/api/test/fixture.integration.test.ts', '../src/routes/media.ts'],
  ])('flags an import from routes/ in %s', async (path, specifier) => {
    expect(await flagged(path, importOf(specifier))).toEqual([
      expect.stringMatching(OUTSIDE_ROUTES),
    ]);
  });

  it('lets apps/api/src/app.ts register the routes', async () => {
    expect(await flagged('apps/api/src/app.ts', importOf('./routes/media.ts'))).toEqual([]);
  });
});

describe('the root scripts/lib (LINT-12)', () => {
  it('leaves a workspace its own scripts folder, and lets scripts and tests import scripts/lib', async () => {
    expect(
      await flagged('apps/api/test/fixture.ts', importOf('../scripts/live-check.mjs')),
    ).toEqual([]);
    expect(
      await flagged('apps/api/src/routes/fixture.ts', importOf('../../scripts/live-check.mjs')),
    ).toEqual([]);
    expect(await flagged('scripts/fixture.ts', importOf('./lib/provision.ts'))).toEqual([]);
    expect(await flagged('scripts/lib/fixture.ts', importOf('../lib/env.ts'))).toEqual([]);
  });
});

/**
 * The no-restricted-imports messages for each import() and require() in `code`, each linted as
 * the static import `import '<specifier>';` at `path` (LINT-1): the rule sees only static
 * imports, and a dynamic one is held to the same layer rules.
 */
async function loadsFlagged(path: string, code: string): Promise<string[]> {
  const messages: string[] = [];
  for (const specifier of loadSpecifiers(path, code)) {
    messages.push(...(await flagged(path, `import ${JSON.stringify(specifier)};`)));
  }
  return messages;
}

/** Every tracked file ESLint parses as code. */
function trackedCodeFiles(): string[] {
  const listed = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split('\0')
    .filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path))
    .filter((path) => existsSync(join(repoRoot, path)));
}

describe('import() and require() (LINT-1)', { timeout: 30_000 }, () => {
  it.each([
    ['apps/api/src/publishing.ts', "export const m = await import('pg');", PG],
    [
      'apps/api/src/publishing.ts',
      "export const m = await import('./routes/media.ts');",
      OUTSIDE_ROUTES,
    ],
    [
      'apps/api/src/publishing.ts',
      "export const m = await import('../test/support.ts');",
      TEST_CODE,
    ],
    ['apps/api/src/routes/displays.ts', "export const m = await import('./media.ts');", ROUTE],
    [
      'apps/portal/src/features/displays/DisplaysPage.tsx',
      "export const m = await import('@tinnox/db');",
      /apps\/portal may import only .* Its browser code calls the API/,
    ],
    [
      'apps/portal/src/features/displays/DisplaysPage.tsx',
      'export const m = await import(`@tinnox/db`);',
      /apps\/portal may import only .* Its browser code calls the API/,
    ],
    ['apps/player-web/src/app.ts', "export const m = await import('node:fs');", BROWSER],
    ['packages/delivery/src/index.ts', "export const m = await import('@tinnox/api');", APP],
    ['apps/media-worker/src/video.ts', "export const m = await import('fastify');", FASTIFY],
    ['scripts/lib/fixture.ts', "const pg = require('pg');", PG],
    // .js and .cjs files are linted too, not only the extensions the fixtures above use.
    ['apps/api/scripts/fixture.cjs', "const pg = require('pg');", PG],
    ['apps/api/scripts/fixture.js', "export const m = await import('pg');", PG],
  ])('flags the load in %s: %s', async (path, code, message) => {
    expect(await loadsFlagged(path, code)).toEqual([expect.stringMatching(message)]);
  });

  it("allows the portal's lazy routes and a load the layer rules allow", async () => {
    expect(
      await loadsFlagged(
        'apps/portal/src/App.tsx',
        "const page = () => import('./features/dashboard/DashboardPage.tsx');",
      ),
    ).toEqual([]);
    expect(
      await loadsFlagged('apps/api/src/config.test.ts', "const f = await import('fastify');"),
    ).toEqual([]);
  });

  it('holds every import() and require() in the repository to the rules of a static import', async () => {
    const problems: string[] = [];
    for (const path of trackedCodeFiles()) {
      if (await repository.isPathIgnored(path)) continue;
      const text = readFileSync(join(repoRoot, path), 'utf8');
      // Cheap filter first: parse only files that can hold a load.
      if (!/\b(import|require)\s*\(/.test(text)) continue;
      for (const message of await loadsFlagged(path, text)) problems.push(`${path}: ${message}`);
    }
    expect(
      problems,
      'an import() or require() must pass the rule its static form would: follow the message, as for a static import',
    ).toEqual([]);
  });
});
