import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import {
  dependencyProblems,
  isDevelopmentFile,
  packageOf,
  parseFacts,
  parseManifest,
  referencesOf,
  type DependencyInput,
  type LoadedByName,
  type Manifest,
  type PackageFacts,
  type Unit,
} from './workspace-deps.ts';

/**
 * Declared packages that nothing shows as used but that stay on purpose, keyed
 * "<unit dir> <package>", each with its reason. A stale entry fails the test.
 */
const ALLOWED_UNUSED: Readonly<Record<string, string>> = {
  'tests axe-core':
    'Pins the axe rule engine that @axe-core/playwright loads (it asks for ~4.14.0), so a lockfile refresh cannot change which accessibility rules the e2e scan applies.',
};

/**
 * Declared packages that a file loads by name instead of importing, keyed "<unit dir> <package>".
 * The entry fails when the file stops naming the package. Only these strings count as use.
 */
const LOADED_BY_NAME: Readonly<Record<string, LoadedByName>> = {
  'apps/api pino-pretty': {
    file: 'apps/api/src/logger.ts',
    reason:
      'pino starts it as the transport target by name when pretty logs are on (local development only, hence devDependencies).',
  },
};

/**
 * The kind of every unit: the root and every workspace of the root package.json (CHK-7). A new
 * workspace fails the repository test until it has an entry, because an unclassified browser
 * workspace would be read as Node code and a bare 'events' or 'buffer' import would pass.
 * - development: nothing ships (the root's shared tooling, scripts and configs; the test suites);
 * - browser: Vite bundles it for a browser (the portal, the player, the app renderer both embed);
 * - node: runs on Node, or is a shared package read as Node code.
 */
const UNIT_KIND: Readonly<Record<string, 'node' | 'browser' | 'development'>> = {
  '.': 'development',
  tests: 'development',
  'apps/api': 'node',
  'apps/media-worker': 'node',
  'apps/player-web': 'browser',
  'apps/portal': 'browser',
  'packages/app-render': 'browser',
  'packages/contracts': 'node',
  'packages/db': 'node',
  'packages/delivery': 'node',
  'packages/domain': 'node',
  'packages/storage': 'node',
};

const NO_FACTS: PackageFacts = { bins: [], peers: [] };

function manifest(fields: Partial<Manifest> & { name: string }): Manifest {
  return { dependencies: {}, devDependencies: {}, scripts: {}, ...fields };
}

function input(
  units: Unit[],
  files: Record<string, string>,
  options: Partial<Pick<DependencyInput, 'facts' | 'allowedUnused' | 'loadedByName'>> = {},
): DependencyInput {
  return {
    units,
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    facts: options.facts ?? (() => NO_FACTS),
    allowedUnused: options.allowedUnused ?? {},
    loadedByName: options.loadedByName ?? {},
  };
}

const rootWith = (devDependencies: Record<string, string> = {}): Unit => ({
  dir: '.',
  developmentOnly: true,
  browser: false,
  manifest: manifest({ name: 'root', devDependencies }),
});
const ROOT = rootWith();

const worker = (fields: Partial<Manifest> = {}): Unit => ({
  dir: 'apps/worker',
  developmentOnly: false,
  browser: false,
  manifest: manifest({ name: '@tinnox/worker', ...fields }),
});

describe('packageOf', () => {
  it('names the package of a bare specifier, scoped or not, with a subpath or a query', () => {
    expect(packageOf('zod')).toBe('zod');
    expect(packageOf('vitest/config')).toBe('vitest');
    expect(packageOf('@tinnox/api/test-support')).toBe('@tinnox/api');
    expect(packageOf('@fontsource-variable/inter/files/a.woff2')).toBe(
      '@fontsource-variable/inter',
    );
    expect(packageOf('lucide-react?raw')).toBe('lucide-react');
  });

  it('skips paths, Node built-ins, URLs and subpath imports', () => {
    for (const specifier of [
      './a.ts',
      '../b',
      '/c',
      'node:fs',
      'fs',
      'path/posix',
      'https://x',
      'virtual:pwa',
      '#internal',
      '@scope',
    ]) {
      expect(packageOf(specifier), specifier).toBeUndefined();
    }
  });

  it('reads a bare built-in name as the npm package in browser code, never node:', () => {
    expect(packageOf('events', true)).toBe('events');
    expect(packageOf('buffer/', true)).toBe('buffer');
    expect(packageOf('node:events', true)).toBeUndefined();
  });
});

describe('referencesOf', () => {
  it('reads static, dynamic, re-export, require and type reference forms, not strings', () => {
    const text = [
      '/// <reference types="vite/client" />',
      "import type { A } from 'a';",
      "export * from 'b';",
      "const c = await import('c');",
      "const d = require('d');",
      'const fixture = "import x from \'not-an-import\'";',
    ].join('\n');
    expect(referencesOf({ path: 'x.ts', text })).toEqual([
      { specifier: 'a', typesOnly: false },
      { specifier: 'b', typesOnly: false },
      { specifier: 'c', typesOnly: false },
      { specifier: 'd', typesOnly: false },
      { specifier: 'vite/client', typesOnly: true },
    ]);
  });

  it('reads @import and scoped url() values in CSS', () => {
    const text =
      "@import './local.css';\n@import 'pkg/base.css';\nsrc: url('@fontsource-variable/inter/a.woff2') format('woff2'), url(img.png);";
    expect(referencesOf({ path: 'a.css', text }).map((ref) => ref.specifier)).toEqual([
      './local.css',
      'pkg/base.css',
      '@fontsource-variable/inter/a.woff2',
    ]);
  });
});

describe('isDevelopmentFile', () => {
  it('tells tests, configs, declarations and tool directories from shipped source', () => {
    for (const path of [
      'src/a.test.ts',
      'src/b.test-support.ts',
      'src/componentTests.setup.ts',
      'src/env.d.ts',
      'build/plugin.d.mts',
      'vite.config.ts',
      'test/support.ts',
      'test-fixtures/generate.mjs',
      'scripts/check.mjs',
    ]) {
      expect(isDevelopmentFile(path), path).toBe(true);
    }
    for (const path of ['src/main.ts', 'sw/sw.ts', 'src/testing.ts']) {
      expect(isDevelopmentFile(path), path).toBe(false);
    }
  });
});

describe('dependencyProblems', () => {
  it('passes a unit whose imports are declared in the right section and all used', () => {
    const unit = worker({ dependencies: { zod: '4.6.7' }, devDependencies: { sharp: '0.35.5' } });
    expect(
      dependencyProblems(
        input([rootWith({ vitest: '5.1.0' }), unit], {
          'apps/worker/src/main.ts': "import { z } from 'zod';",
          'apps/worker/src/main.test.ts':
            "import sharp from 'sharp';\nimport { it } from 'vitest';",
        }),
      ),
    ).toEqual([]);
  });

  it('flags a runtime import the manifest does not declare (the media worker and @tinnox/contracts)', () => {
    expect(
      dependencyProblems(
        input([ROOT, worker()], {
          'apps/worker/src/main.ts': "import { x } from '@tinnox/contracts';",
        }),
      ),
    ).toEqual([
      'apps/worker/src/main.ts imports \'@tinnox/contracts\', which apps/worker/package.json does not declare: add "@tinnox/contracts": "*" to apps/worker/package.json "dependencies" (a workspace package is referenced as "*")',
    ]);
  });

  it('flags a runtime import declared only under devDependencies', () => {
    expect(
      dependencyProblems(
        input([ROOT, worker({ devDependencies: { zod: '4.6.7' } })], {
          'apps/worker/src/main.ts': "import { z } from 'zod';",
        }),
      ),
    ).toEqual([
      'apps/worker/src/main.ts imports \'zod\' at run time, but apps/worker/package.json lists it under "devDependencies": move it to "dependencies"',
    ]);
  });

  it('flags a development import nobody declares, and accepts root tooling', () => {
    expect(
      dependencyProblems(
        input([rootWith({ vitest: '5.1.0' }), worker()], {
          'apps/worker/test/support.ts': "import sharp from 'sharp';\nimport { vi } from 'vitest';",
        }),
      ),
    ).toEqual([
      'apps/worker/test/support.ts imports \'sharp\', which apps/worker/package.json does not declare: add it to apps/worker/package.json "devDependencies" with npm install sharp --save-dev -w @tinnox/worker (.npmrc saves the exact version), or to the root package.json "devDependencies" if every workspace shares it as tooling',
    ]);
  });

  it('flags a runtime dependency that only tests import (pg in the API)', () => {
    expect(
      dependencyProblems(
        input([ROOT, worker({ dependencies: { pg: '8.23.1' } })], {
          'apps/worker/src/logger.test.ts': "import pg from 'pg';",
        }),
      ),
    ).toEqual([
      'apps/worker/package.json lists \'pg\' under "dependencies", but only development files use it (first: apps/worker/src/logger.test.ts): move it to "devDependencies"',
    ]);
  });

  it('flags a declared package nothing uses, even when a test or fixture names it in a string (fastify-plugin in the API)', () => {
    expect(
      dependencyProblems(
        input([ROOT, worker({ dependencies: { 'fastify-plugin': '6.0.1' } })], {
          'apps/worker/src/main.ts': "import x from './x.ts';",
          'apps/worker/src/main.test.ts':
            "const fixture = { dependencies: { 'fastify-plugin': '6.0.1' } };",
        }),
      ),
    ).toEqual([
      'apps/worker/package.json declares \'fastify-plugin\', but nothing in apps/worker imports it, runs its command or needs it as a peer: remove it (npm uninstall fastify-plugin -w @tinnox/worker); if a file loads it by name, add "apps/worker fastify-plugin" with that file to LOADED_BY_NAME in scripts/lib/workspace-deps.test.ts; if it stays on purpose, add "apps/worker fastify-plugin" with the reason to ALLOWED_UNUSED there',
    ]);
  });

  it('counts a command in an npm script, a listed name loaded at run time, an @types package and a peer as use', () => {
    const unit = worker({
      dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
      devDependencies: { vite: '8.3.8', 'pino-pretty': '13.2.0', '@types/react': '19.3.0' },
      scripts: { build: 'vite build' },
    });
    const facts = (name: string): PackageFacts =>
      name === 'vite'
        ? { bins: ['vite'], peers: [] }
        : name === 'react-dom'
          ? { bins: [], peers: ['react'] }
          : NO_FACTS;
    expect(
      dependencyProblems(
        input(
          [ROOT, unit],
          {
            'apps/worker/src/main.tsx': "import { createRoot } from 'react-dom/client';",
            'apps/worker/src/logger.ts': "const transport = { target: 'pino-pretty' };",
          },
          {
            facts,
            loadedByName: {
              'apps/worker pino-pretty': { file: 'apps/worker/src/logger.ts', reason: 'transport' },
            },
          },
        ),
      ),
    ).toEqual([]);
  });

  it('fails a loaded-by-name entry whose file no longer names the package, or that another workspace holds', () => {
    const unit = worker({ devDependencies: { 'pino-pretty': '13.2.0' } });
    const other: Unit = {
      ...worker(),
      dir: 'apps/other',
      manifest: manifest({ name: '@tinnox/other' }),
    };
    const stale = (file: string): string =>
      `LOADED_BY_NAME in scripts/lib/workspace-deps.test.ts lists "apps/worker pino-pretty", but apps/worker/package.json no longer declares it or ${file} no longer names 'pino-pretty' in a string: correct or remove the entry`;
    const unused =
      'apps/worker/package.json declares \'pino-pretty\', but nothing in apps/worker imports it, runs its command or needs it as a peer: remove it (npm uninstall pino-pretty -w @tinnox/worker); if a file loads it by name, add "apps/worker pino-pretty" with that file to LOADED_BY_NAME in scripts/lib/workspace-deps.test.ts; if it stays on purpose, add "apps/worker pino-pretty" with the reason to ALLOWED_UNUSED there';
    for (const file of [
      'apps/worker/src/logger.ts',
      'apps/other/src/logger.ts',
      'apps/worker/src/gone.ts',
    ]) {
      expect(
        dependencyProblems(
          input(
            [ROOT, unit, other],
            {
              'apps/worker/src/logger.ts': "const transport = { target: 'pino' };",
              'apps/other/src/logger.ts': "const transport = { target: 'pino-pretty' };",
            },
            { loadedByName: { 'apps/worker pino-pretty': { file, reason: 'transport' } } },
          ),
        ),
        file,
      ).toEqual([stale(file), unused]);
    }
  });

  it('counts the root tooling used anywhere, and @types/node by any Node built-in', () => {
    const root: Unit = {
      dir: '.',
      developmentOnly: true,
      browser: false,
      manifest: manifest({
        name: 'root',
        devDependencies: { vitest: '5.1.0', '@types/node': '22.20.5', unused: '1.0.0' },
      }),
    };
    expect(
      dependencyProblems(
        input([root, worker()], {
          'apps/worker/src/a.test.ts':
            "import { it } from 'vitest';\nimport { join } from 'node:path';",
        }),
      ),
    ).toEqual([
      'package.json declares \'unused\', but nothing in the repository imports it, runs its command or needs it as a peer: remove it (npm uninstall unused); if a file loads it by name, add ". unused" with that file to LOADED_BY_NAME in scripts/lib/workspace-deps.test.ts; if it stays on purpose, add ". unused" with the reason to ALLOWED_UNUSED there',
    ]);
  });

  it('flags a runtime dependency that only an npm script or a peer uses', () => {
    const unit = worker({
      dependencies: { tsx: '4.23.15' },
      scripts: { start: 'tsx src/main.ts' },
    });
    expect(
      dependencyProblems(
        input(
          [ROOT, unit],
          {},
          { facts: (name) => (name === 'tsx' ? { bins: ['tsx'], peers: [] } : NO_FACTS) },
        ),
      ),
    ).toEqual([
      'apps/worker/package.json lists \'tsx\' under "dependencies", but only development files use it (first: an npm script or a peer): move it to "devDependencies"',
    ]);
  });

  it('holds an allow-listed entry, and fails one no manifest declares or something now uses', () => {
    const unit = worker({ devDependencies: { 'axe-core': '4.14.0' } });
    const allowedUnused = { 'apps/worker axe-core': 'pin' };
    expect(dependencyProblems(input([ROOT, unit], {}, { allowedUnused }))).toEqual([]);
    expect(dependencyProblems(input([ROOT, worker()], {}, { allowedUnused }))).toEqual([
      'ALLOWED_UNUSED in scripts/lib/workspace-deps.test.ts lists "apps/worker axe-core", which no package.json declares: remove the entry',
    ]);
    expect(
      dependencyProblems(
        input(
          [ROOT, unit],
          { 'apps/worker/src/a.test.ts': "import axe from 'axe-core';" },
          { allowedUnused },
        ),
      ),
    ).toEqual([
      'ALLOWED_UNUSED in scripts/lib/workspace-deps.test.ts lists "apps/worker axe-core", which is now used: remove the entry',
    ]);
  });

  it('requires a polyfill a browser workspace imports by a bare built-in name, and counts it as used', () => {
    const portal = (fields: Partial<Manifest> = {}): Unit => ({
      dir: 'apps/portal',
      developmentOnly: false,
      browser: true,
      manifest: manifest({ name: '@tinnox/portal', ...fields }),
    });
    const files = {
      'apps/portal/src/bus.ts': "import { EventEmitter } from 'events';",
      'apps/portal/vite.config.ts': "import { fileURLToPath } from 'node:url';",
    };
    expect(
      dependencyProblems(input([ROOT, portal({ dependencies: { events: '3.3.0' } })], files)),
    ).toEqual([]);
    expect(dependencyProblems(input([ROOT, portal()], files))).toEqual([
      "apps/portal/src/bus.ts imports 'events', which apps/portal/package.json does not declare: add it to apps/portal/package.json \"dependencies\" with npm install events -w @tinnox/portal (.npmrc saves the exact version); for the Node built-in write 'node:events' (in a browser workspace a bare 'events' is the npm package)",
    ]);
    // In Node code the same name is the built-in, so a declared polyfill there is unused.
    expect(
      dependencyProblems(
        input([ROOT, worker({ dependencies: { events: '3.3.0' } })], {
          'apps/worker/src/bus.ts': "import { EventEmitter } from 'events';",
        }),
      ),
    ).toHaveLength(1);
  });

  it('treats every file of a development-only unit as development', () => {
    const tests: Unit = {
      dir: 'tests',
      developmentOnly: true,
      browser: false,
      manifest: manifest({ name: '@tinnox/tests', devDependencies: { pg: '8.23.1' } }),
    };
    expect(
      dependencyProblems(
        input([ROOT, tests], { 'tests/e2e/support/database.ts': "import pg from 'pg';" }),
      ),
    ).toEqual([]);
  });
});

// The repository: every workspace of the root package.json, plus the root for the rest.
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

function workspaceDirs(): string[] {
  const globs = parseManifestWorkspaces(readJson('package.json'));
  return globs.flatMap((entry) => {
    if (!entry.endsWith('/*')) return [entry];
    const parent = entry.slice(0, -2);
    return readdirSync(join(repoRoot, parent), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => `${parent}/${dirent.name}`)
      .filter((dir) => existsSync(join(repoRoot, dir, 'package.json')));
  });
}

function parseManifestWorkspaces(json: unknown): string[] {
  const workspaces =
    typeof json === 'object' && json !== null && 'workspaces' in json ? json.workspaces : undefined;
  if (!Array.isArray(workspaces)) throw new Error('package.json has no workspaces array');
  return workspaces.filter((entry): entry is string => typeof entry === 'string');
}

function repositoryInput(): DependencyInput {
  const units: Unit[] = ['.', ...workspaceDirs()].map((dir) => ({
    dir,
    developmentOnly: UNIT_KIND[dir] === 'development',
    browser: UNIT_KIND[dir] === 'browser',
    manifest: parseManifest(readJson(dir === '.' ? 'package.json' : `${dir}/package.json`)),
  }));
  const files = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .stdout.split('\0')
    .filter((path) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$/.test(path))
    .filter((path) => existsSync(join(repoRoot, path)))
    .map((path) => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }));
  const facts = (name: string): PackageFacts => {
    const path = join('node_modules', name, 'package.json');
    return existsSync(join(repoRoot, path)) ? parseFacts(readJson(path)) : NO_FACTS;
  };
  return { units, files, facts, allowedUnused: ALLOWED_UNUSED, loadedByName: LOADED_BY_NAME };
}

describe('the repository (step 9, manifest drift)', () => {
  const repository = repositoryInput();

  it('gives the root and every workspace a kind in UNIT_KIND, and lists no other (CHK-7)', () => {
    expect(
      repository.units.map((unit) => unit.dir).sort(),
      'give each workspace its kind in UNIT_KIND in scripts/lib/workspace-deps.test.ts, and remove an entry whose workspace is gone',
    ).toEqual(Object.keys(UNIT_KIND).sort());
  });

  it('declares every import in its workspace, in the right section, and uses every entry', () => {
    expect(dependencyProblems(repository)).toEqual([]);
  });
});
