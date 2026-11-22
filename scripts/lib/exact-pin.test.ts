import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import { npmrcProblems, pinProblems } from './exact-pin.ts';

const WORKSPACES = new Set(['@tinnox/contracts']);

describe('pinProblems (OTH-11)', () => {
  it('passes exact versions, prereleases and workspace references as "*"', () => {
    expect(
      pinProblems(
        'package.json',
        {
          dependencies: { zod: '4.6.7', '@tinnox/contracts': '*' },
          devDependencies: { vitest: '5.1.0', next: '1.0.0-beta.2+build.5' },
          optionalDependencies: { fsevents: '2.3.3' },
        },
        WORKSPACES,
      ),
    ).toEqual([]);
  });

  it('fails a range, a tag, a URL and a non-workspace "*", in every section', () => {
    expect(
      pinProblems(
        'apps/x/package.json',
        {
          dependencies: { a: '^1.2.3', b: '~1.2.3', c: '>=1.0.0 <2', d: '1.x', e: '*' },
          devDependencies: { f: 'latest', g: 'github:o/r', h: 'file:../h', i: 'npm:j@1.0.0' },
          optionalDependencies: { k: 'v1.2.3' },
        },
        WORKSPACES,
      ).map((problem) => problem.split(',')[0]),
    ).toEqual([
      'apps/x/package.json: "dependencies"."a" is "^1.2.3"',
      'apps/x/package.json: "dependencies"."b" is "~1.2.3"',
      'apps/x/package.json: "dependencies"."c" is ">=1.0.0 <2"',
      'apps/x/package.json: "dependencies"."d" is "1.x"',
      'apps/x/package.json: "dependencies"."e" is "*"',
      'apps/x/package.json: "devDependencies"."f" is "latest"',
      'apps/x/package.json: "devDependencies"."g" is "github:o/r"',
      'apps/x/package.json: "devDependencies"."h" is "file:../h"',
      'apps/x/package.json: "devDependencies"."i" is "npm:j@1.0.0"',
      'apps/x/package.json: "optionalDependencies"."k" is "v1.2.3"',
    ]);
  });

  it('says what to do instead', () => {
    expect(
      pinProblems('package.json', { devDependencies: { 'fast-check': '^4.0.0' } }, WORKSPACES),
    ).toEqual([
      'package.json: "devDependencies"."fast-check" is "^4.0.0", a range, not one exact version: pin the version package-lock.json resolves (npm ls fast-check), for example with npm install fast-check@<version>, which .npmrc saves exactly',
    ]);
  });

  it('keeps workspace references in the form they have', () => {
    expect(
      pinProblems(
        'tests/package.json',
        { devDependencies: { '@tinnox/contracts': '0.0.0' } },
        WORKSPACES,
      ),
    ).toEqual([
      'tests/package.json: "devDependencies"."@tinnox/contracts" is "0.0.0"; reference a workspace package as "*", as every other workspace reference does',
    ]);
  });

  it('fails a section that is not an object', () => {
    expect(pinProblems('package.json', { dependencies: ['zod'] }, WORKSPACES)).toEqual([
      'package.json: "dependencies" is not an object of package names and versions',
    ]);
  });
});

describe('npmrcProblems', () => {
  it('passes save-exact=true and fails its absence', () => {
    expect(npmrcProblems('save-exact=true\nfund=false\n')).toEqual([]);
    expect(npmrcProblems('# save-exact=true\nfund=false\n')).toEqual([
      '.npmrc does not set save-exact=true: add that line, so npm install writes exact versions',
    ]);
  });
});

describe('the repository (OTH-11)', () => {
  const manifests = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .stdout.split('\0')
    .filter((path) => /(^|\/)package\.json$/.test(path))
    .map((path) => ({
      path,
      json: JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown,
    }));
  const workspaces = new Set(
    manifests
      .filter(({ path }) => path !== 'package.json')
      .map(({ json }) =>
        typeof json === 'object' && json !== null && 'name' in json ? json.name : undefined,
      )
      .filter((name): name is string => typeof name === 'string'),
  );

  it('finds the root manifest and the workspace manifests', () => {
    expect(manifests.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['package.json', 'apps/api/package.json', 'tests/package.json']),
    );
  });

  it('pins every dependency of every package.json to one exact version', () => {
    expect(manifests.flatMap(({ path, json }) => pinProblems(path, json, workspaces))).toEqual([]);
  });

  it('keeps save-exact in .npmrc', () => {
    expect(npmrcProblems(readFileSync(join(repoRoot, '.npmrc'), 'utf8'))).toEqual([]);
  });
});
