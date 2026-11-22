// The import boundaries of eslint.config.js (adoption plan section 3.1, step 7), run against
// fixture text. Each case takes the no-restricted-imports options that eslint.config.js resolves
// for a real path, so the generated blocks are tested with their globs: a block that took the
// rule away from a file group would fail here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

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
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
        languageOptions: {
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
const PG = /Only packages\/db talks to PostgreSQL\. Use createPool and withOrg from @tinnox\/db/;
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
      ['pg', PG],
    ],
    allowed: ['node:fs/promises', './local.ts'],
  },
  {
    path: 'packages/db/src/fixture.ts',
    forbidden: [['@tinnox/contracts', /packages\/db is a bottom layer/]],
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
      ['pg', PG],
      ['fastify', FASTIFY],
    ],
    allowed: ['@tinnox/contracts', 'sharp', 'node:child_process'],
  },
  {
    path: 'apps/portal/src/features/fixture.tsx',
    forbidden: [
      ['@tinnox/db', /apps\/portal may import only .*bundled for the browser: call the API/],
      ['@tinnox/delivery', /apps\/portal may import only @tinnox\/contracts, @tinnox\/domain/],
      ['@tinnox/player-web', APP],
      ['node:fs', BROWSER],
      ['fs', BROWSER],
      ['fs/promises', BROWSER],
      ['child_process', BROWSER],
      ['pg', PG],
      ['fastify', FASTIFY],
      ['../../../api/src/app.ts', RELATIVE],
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
      ['@tinnox/storage', /apps\/player-web may import only .*bundled for the browser/],
      ['node:crypto', BROWSER],
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

describe('pg outside packages/db (rule (g), D25)', () => {
  it.each([
    'apps/api/src/fixture.ts',
    'apps/api/scripts/fixture.mjs',
    'apps/media-worker/src/fixture.ts',
    'scripts/seed.ts',
    'scripts/lib/provision.ts',
    'packages/storage/src/fixture.ts',
  ])('flags pg in the non-test file %s', async (path) => {
    expect(await flagged(path, "import pg from 'pg';")).toEqual([expect.stringMatching(PG)]);
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
