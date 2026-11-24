// The catalogue of the repository's own ESLint rules (adoption plan section 3.4, D16): a rule
// file that is not registered, has no RuleTester test, or is enabled in no block of
// eslint.config.js fails here. Also holds the order D16 needs in eslint.config.js: the check
// for a Node that runs TypeScript comes before the plugin is loaded.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../lib/env.ts';
import plugin from './index.ts';

const FOLDER = 'scripts/eslint-rules';
// The files of the folder that are not a rule.
const SUPPORT_FILES = new Set(['index.ts', 'create-rule.ts', 'typed.ts']);

/** The rule files of the folder, by rule name: every .ts file but tests and the support files. */
function ruleFiles(): string[] {
  return readdirSync(join(repoRoot, FOLDER))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => !SUPPORT_FILES.has(file))
    .map((file) => file.slice(0, -'.ts'.length))
    .sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The blocks of eslint.config.js, as ESLint gets them. */
async function configBlocks(): Promise<Record<string, unknown>[]> {
  // A computed specifier keeps the type checker away from the untyped config file.
  const config = pathToFileURL(join(repoRoot, 'eslint.config.js')).href;
  const loaded: unknown = await import(config);
  if (!isRecord(loaded) || !Array.isArray(loaded['default'])) {
    throw new Error('eslint.config.js exports no array of blocks');
  }
  return loaded['default'].filter(isRecord);
}

/** True when `entry` turns a rule on as an error ('error', 2, or either with options). */
function isError(entry: unknown): boolean {
  const severity: unknown = Array.isArray(entry) ? entry[0] : entry;
  return severity === 'error' || severity === 2;
}

describe('the rules of scripts/eslint-rules (D16)', { timeout: 30_000 }, () => {
  it('registers every rule file under its file name, and nothing else', () => {
    expect(ruleFiles()).not.toEqual([]);
    expect(
      Object.keys(plugin.rules).sort(),
      `every rule file of ${FOLDER} is imported in ${FOLDER}/index.ts and listed in its rules under the file's name`,
    ).toEqual(ruleFiles());
  });

  it.each(ruleFiles())('%s has RuleTester cases beside it', (name) => {
    const path = join(repoRoot, FOLDER, `${name}.test.ts`);
    expect(
      existsSync(path),
      `write ${FOLDER}/${name}.test.ts: valid and invalid cases run with ESLint's RuleTester, each invalid case pinning the message`,
    ).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(`from './${name}.ts'`);
    expect(text).toMatch(/\bnew RuleTester\(/);
    expect(text).toMatch(/\.run\(/);
    expect(text).toMatch(/\binvalid: \[/);
  });

  it.each(ruleFiles())('%s is enabled as an error in a block of eslint.config.js', async (name) => {
    const blocks = await configBlocks();
    const enabling = blocks.filter(
      (block) => isRecord(block['rules']) && isError(block['rules'][`tinnox/${name}`]),
    );
    expect(
      enabling,
      `turn the rule on in eslint.config.js: a block with plugins: { tinnox } and rules: { 'tinnox/${name}': 'error' }`,
    ).not.toEqual([]);
    for (const block of enabling) {
      // The block that turns a rule on also registers the plugin, under the name the rule id uses.
      const registered = isRecord(block['plugins']) ? block['plugins']['tinnox'] : undefined;
      const rules =
        isRecord(registered) && isRecord(registered['rules']) ? registered['rules'] : {};
      expect(Object.keys(rules)).toContain(name);
    }
  });

  it.each(ruleFiles())('%s points at its own file and names a remedy in every message', (name) => {
    const meta = plugin.rules[name]?.meta;
    expect(meta?.docs?.url).toBe(`${FOLDER}/${name}.ts`);
    const messages = Object.values(meta?.messages ?? {});
    expect(messages).not.toEqual([]);
    // Section 3.4: a message says what to do instead, so it is never one short sentence.
    for (const message of messages) expect(message.length).toBeGreaterThan(80);
  });
});

describe(
  'eslint.config.js on a Node that does not run TypeScript (D16)',
  { timeout: 30_000 },
  () => {
    const config = readFileSync(join(repoRoot, 'eslint.config.js'), 'utf8');

    it('checks process.features.typescript before it loads the plugin, and loads it with import()', () => {
      const guard = config.indexOf('if (!process.features.typescript)');
      const load = config.indexOf("await import('./scripts/eslint-rules/index.ts')");
      expect(guard).toBeGreaterThan(-1);
      expect(load).toBeGreaterThan(guard);
      // A static import is resolved before any statement runs, so the guard could never speak.
      expect(config).not.toMatch(/^import\b[^;]*eslint-rules/m);
      expect(config).not.toMatch(/\bfrom\s+['"][^'"]*eslint-rules/);
    });

    it('stops with a message that names the remedy, not with a loader error', () => {
      const run = spawnSync(
        process.execPath,
        [
          '--no-experimental-strip-types',
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'eslint.config.js')).href)});`,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        `eslint.config.js loads the lint rules in scripts/eslint-rules/*.ts, and this Node (${process.version}) does not run TypeScript files`,
      );
      expect(run.stderr).toContain('Use Node 22.18 or later, the floor of package.json engines');
      expect(run.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
    });
  },
);
