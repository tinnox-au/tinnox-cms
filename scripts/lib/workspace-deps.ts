// Manifest drift (adoption plan section 3.1, step 9): every package a workspace's files import is
// declared in its package.json, in the right section, and every declared package is used. npm
// hoists every workspace into one node_modules, so an undeclared import resolves locally and
// fails only where a workspace is installed alone (the media worker image). Read by
// scripts/lib/workspace-deps.test.ts over the real repository; the rules are pure.
//
// A unit is a workspace, or the root for every file outside the workspaces (scripts, configs).
//   - A runtime file's import must be under the unit's "dependencies".
//   - A development file's import (tests, test support, configs, build plugins, offline scripts,
//     type declarations, and every file of a development-only unit) may be under the unit's
//     "dependencies" or "devDependencies", or under the root "devDependencies", which hold the
//     tooling every workspace shares (Vitest, TypeScript, ESLint).
//   - A declared package is used when the unit imports it, an npm script of the unit runs one of
//     its commands, a file the loaded-by-name list names still names it in a string (pino loads
//     its transport that way), it is the @types package of something the unit uses, or it is a
//     peer of a package the unit uses. The root's devDependencies count uses anywhere in the
//     repository. Any other string is not evidence: a test or fixture that only mentions a
//     package must not keep an unused entry alive.
//   - In a browser workspace a bare built-in name ('events', 'buffer') is the npm package Vite
//     bundles, so it must be declared; only a `node:` specifier is the Node built-in there.
//   - A "dependencies" entry that only development files use belongs under "devDependencies".
import { builtinModules } from 'node:module';
import ts from 'typescript';

export interface Manifest {
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

export interface Unit {
  /** The workspace directory from the repository root, or '.' for the root. */
  readonly dir: string;
  readonly manifest: Manifest;
  /** Nothing in the unit ships, so every file counts as a development file. */
  readonly developmentOnly: boolean;
  /** Vite bundles the unit for a browser, where a bare built-in name resolves to an npm package. */
  readonly browser: boolean;
}

/** A tracked file, its path from the repository root with forward slashes. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** What an installed package's own package.json says, for the evidence of use. */
export interface PackageFacts {
  /** The commands it installs under node_modules/.bin. */
  readonly bins: readonly string[];
  /** Its peerDependencies, optional ones included. */
  readonly peers: readonly string[];
}

export interface DependencyInput {
  /** The root first, then every workspace. */
  readonly units: readonly Unit[];
  readonly files: readonly SourceFile[];
  readonly facts: (name: string) => PackageFacts;
  /**
   * Declared packages that nothing in the repository shows as used but that stay on purpose,
   * keyed "<unit dir> <package>", each with its reason.
   */
  readonly allowedUnused: Readonly<Record<string, string>>;
  /**
   * Declared packages that a file loads by name at run time instead of importing, keyed
   * "<unit dir> <package>": the file must name the package in a string literal, or the entry is
   * stale. A workspace's entry names one of its own files; the root's may name any file.
   */
  readonly loadedByName: Readonly<Record<string, LoadedByName>>;
}

export interface LoadedByName {
  readonly file: string;
  readonly reason: string;
}

function fieldsOf(value: unknown): Map<string, unknown> {
  return new Map(typeof value === 'object' && value !== null ? Object.entries(value) : []);
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    [...fieldsOf(value)].filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** The fields of a parsed package.json that the rules read; a missing field reads as empty. */
export function parseManifest(json: unknown): Manifest {
  const fields = fieldsOf(json);
  const name = fields.get('name');
  return {
    name: typeof name === 'string' ? name : '',
    dependencies: stringRecord(fields.get('dependencies')),
    devDependencies: stringRecord(fields.get('devDependencies')),
    scripts: stringRecord(fields.get('scripts')),
  };
}

/** The evidence fields of an installed package's package.json. */
export function parseFacts(json: unknown): PackageFacts {
  const fields = fieldsOf(json);
  const name = fields.get('name');
  const bin = fields.get('bin');
  // A string bin installs one command named after the package, without its scope.
  const bins =
    typeof bin === 'string'
      ? [typeof name === 'string' ? name.replace(/^@[^/]+\//, '') : '']
      : [...fieldsOf(bin).keys()];
  return { bins, peers: [...fieldsOf(fields.get('peerDependencies')).keys()] };
}

const BUILTINS = new Set(builtinModules);
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CSS_FILE = /\.css$/;

// Files that never run in the product: tests and their support and setup, type declarations
// (read by the compiler only), tool configs, and the workspace directories for tests, fixtures,
// offline scripts and build plugins.
const DEVELOPMENT_FILE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.test-support\.[cm]?[jt]sx?$/,
  /\.setup\.[cm]?[jt]sx?$/,
  /\.d\.[cm]?ts$/,
  /(^|\/)[^/]+\.config\.[cm]?[jt]s$/,
  /^(test|tests|test-fixtures|e2e|scripts|build)\//,
];

/** @param path a path from the workspace directory */
export function isDevelopmentFile(path: string): boolean {
  return DEVELOPMENT_FILE.some((pattern) => pattern.test(path));
}

/**
 * The package a module specifier names, or undefined for a relative or absolute path, a Node
 * built-in, a URL or a subpath import. In browser code a bare built-in name is a package.
 */
export function packageOf(specifier: string, browser = false): string | undefined {
  const bare = specifier.split('?')[0] ?? '';
  if (bare === '' || /^[./#~]/.test(bare) || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return undefined;
  const parts = bare.split('/');
  const name = bare.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  if ((!browser && BUILTINS.has(name)) || (bare.startsWith('@') && parts.length < 2)) {
    return undefined;
  }
  return name;
}

function isBuiltin(specifier: string, browser: boolean): boolean {
  return specifier.startsWith('node:') || (!browser && BUILTINS.has(specifier.split('/')[0] ?? ''));
}

/** One module reference in a file. */
export interface Reference {
  readonly specifier: string;
  /** A `/// <reference types>` directive: compile time only, so a development use. */
  readonly typesOnly: boolean;
}

/**
 * The module references of a file: static and dynamic imports, re-exports, require calls and
 * type reference directives in code; `@import` and scoped `url()` values in CSS (Vite resolves
 * those through node_modules; any other bare `url()` is relative in CSS).
 */
export function referencesOf(file: SourceFile): Reference[] {
  if (CODE_FILE.test(file.path)) {
    const info = ts.preProcessFile(file.text, true, true);
    return [
      ...info.importedFiles.map((ref) => ({ specifier: ref.fileName, typesOnly: false })),
      ...info.typeReferenceDirectives.map((ref) => ({ specifier: ref.fileName, typesOnly: true })),
    ];
  }
  if (CSS_FILE.test(file.path)) {
    const found: Reference[] = [];
    for (const match of file.text.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)) {
      if (match[1] !== undefined) found.push({ specifier: match[1], typesOnly: false });
    }
    for (const match of file.text.matchAll(/url\(\s*['"]?(@[^'")\s]+)/g)) {
      if (match[1] !== undefined) found.push({ specifier: match[1], typesOnly: false });
    }
    return found;
  }
  return [];
}

/** The package a `/// <reference types>` directive loads: `node` is @types/node. */
function typesPackageOf(specifier: string): string | undefined {
  return specifier === 'node' ? '@types/node' : packageOf(specifier);
}

/** The package an @types package describes: @types/node is node, @types/a__b is @a/b. */
function typedPackage(name: string): string | undefined {
  if (!name.startsWith('@types/')) return undefined;
  const rest = name.slice('@types/'.length);
  return rest.includes('__') ? `@${rest.replace('__', '/')}` : rest;
}

function manifestPath(dir: string): string {
  return dir === '.' ? 'package.json' : `${dir}/package.json`;
}

/** The deepest unit whose directory holds the file; the root holds the rest. */
function unitOf(path: string, units: readonly Unit[], root: Unit): Unit {
  const holders = units.filter((unit) => unit.dir !== '.' && path.startsWith(`${unit.dir}/`));
  return holders.sort((a, b) => b.dir.length - a.dir.length)[0] ?? root;
}

interface Uses {
  /** The first runtime file that imports the package, by package. */
  runtimeImports: Map<string, string>;
  /** The first development file that imports the package, by package. */
  developmentImports: Map<string, string>;
  /** Packages a loaded-by-name entry vouches for: true when its file is a runtime file. */
  loadedByName: Map<string, boolean>;
  /** Whether a file imports a Node built-in, which @types/node describes. */
  builtins: boolean;
}

function emptyUses(): Uses {
  return {
    runtimeImports: new Map(),
    developmentImports: new Map(),
    loadedByName: new Map(),
    builtins: false,
  };
}

/** The words of the npm scripts of the given units. */
function scriptWords(units: readonly Unit[]): Set<string> {
  return new Set(
    units.flatMap((unit) =>
      Object.values(unit.manifest.scripts).flatMap((script) => script.split(/[\s;&|()"'=]+/)),
    ),
  );
}

function runsCommandOf(name: string, words: ReadonlySet<string>, facts: PackageFacts): boolean {
  return (
    facts.bins.some((bin) => words.has(bin)) ||
    [...words].some((word) => word.includes(`node_modules/${name}/`))
  );
}

/** Whether the text holds the package name as a whole string literal. */
function namesInString(text: string, name: string): boolean {
  return [...text.matchAll(/(['"`])([^'"`\n]*)\1/g)].some((match) => match[2] === name);
}

/** The path of a file from its unit's directory. */
function insideUnit(path: string, unit: Unit): string {
  return unit.dir === '.' ? path : path.slice(unit.dir.length + 1);
}

function addHint(unit: Unit, name: string, section: 'dependencies' | 'devDependencies'): string {
  const where = `${manifestPath(unit.dir)} "${section}"`;
  if (name.startsWith('@tinnox/')) {
    return `add "${name}": "*" to ${where} (a workspace package is referenced as "*")`;
  }
  const workspace = unit.dir === '.' ? '' : ` -w ${unit.manifest.name}`;
  const dev = section === 'devDependencies' ? ' --save-dev' : '';
  const builtin =
    unit.browser && BUILTINS.has(name)
      ? `; for the Node built-in write 'node:${name}' (in a browser workspace a bare '${name}' is the npm package)`
      : '';
  return `add it to ${where} with npm install ${name}${dev}${workspace} (.npmrc saves the exact version)${builtin}`;
}

/** One problem per undeclared import, misplaced entry, unused entry and stale allow-list entry. */
export function dependencyProblems(input: DependencyInput): string[] {
  const root = input.units.find((unit) => unit.dir === '.');
  if (root === undefined) throw new Error('dependencyProblems needs the root unit');
  const uses = new Map(input.units.map((unit) => [unit.dir, emptyUses()]));
  const everywhere = emptyUses();

  for (const file of input.files) {
    const unit = unitOf(file.path, input.units, root);
    const unitUses = uses.get(unit.dir);
    if (unitUses === undefined) continue;
    const development = unit.developmentOnly || isDevelopmentFile(insideUnit(file.path, unit));
    for (const reference of referencesOf(file)) {
      if (!reference.typesOnly && isBuiltin(reference.specifier, unit.browser)) {
        unitUses.builtins = everywhere.builtins = true;
        continue;
      }
      const name = reference.typesOnly
        ? typesPackageOf(reference.specifier)
        : packageOf(reference.specifier, unit.browser);
      if (name === undefined || name === unit.manifest.name) continue;
      for (const target of [unitUses, everywhere]) {
        const imports =
          development || reference.typesOnly ? target.developmentImports : target.runtimeImports;
        if (!imports.has(name)) imports.set(name, file.path);
      }
    }
  }

  const problems: string[] = [];

  // A loaded-by-name entry counts only while its package is declared and its file still names it.
  for (const [key, entry] of Object.entries(input.loadedByName)) {
    const [dir, name] = key.split(' ');
    const unit = input.units.find((each) => each.dir === dir);
    const unitUses = unit === undefined ? undefined : uses.get(unit.dir);
    const file = input.files.find((each) => each.path === entry.file);
    const fileUnit = file === undefined ? undefined : unitOf(file.path, input.units, root);
    if (
      unit === undefined ||
      unitUses === undefined ||
      name === undefined ||
      !(name in unit.manifest.dependencies || name in unit.manifest.devDependencies) ||
      file === undefined ||
      fileUnit === undefined ||
      (unit.dir !== '.' && fileUnit !== unit) ||
      !namesInString(file.text, name)
    ) {
      problems.push(
        `LOADED_BY_NAME in scripts/lib/workspace-deps.test.ts lists "${key}", but ${dir === '.' ? 'package.json' : `${dir}/package.json`} no longer declares it or ${entry.file} no longer names '${name}' in a string: correct or remove the entry`,
      );
      continue;
    }
    const atRuntime =
      !fileUnit.developmentOnly && !isDevelopmentFile(insideUnit(file.path, fileUnit));
    for (const target of [unitUses, everywhere]) {
      target.loadedByName.set(name, (target.loadedByName.get(name) ?? false) || atRuntime);
    }
  }
  const declaredByRoot = new Set([
    ...Object.keys(root.manifest.dependencies),
    ...Object.keys(root.manifest.devDependencies),
  ]);

  for (const unit of input.units) {
    const unitUses = uses.get(unit.dir) ?? emptyUses();
    const { dependencies, devDependencies } = unit.manifest;
    const path = manifestPath(unit.dir);

    // Every import is declared, in the right section.
    for (const [name, file] of unitUses.runtimeImports) {
      if (name in dependencies) continue;
      problems.push(
        name in devDependencies
          ? `${file} imports '${name}' at run time, but ${path} lists it under "devDependencies": move it to "dependencies"`
          : `${file} imports '${name}', which ${path} does not declare: ${addHint(unit, name, 'dependencies')}`,
      );
    }
    for (const [name, file] of unitUses.developmentImports) {
      if (unitUses.runtimeImports.has(name)) continue;
      if (name in dependencies || name in devDependencies || declaredByRoot.has(name)) continue;
      const shared =
        unit.dir === '.'
          ? ''
          : ', or to the root package.json "devDependencies" if every workspace shares it as tooling';
      problems.push(
        `${file} imports '${name}', which ${path} does not declare: ${addHint(unit, name, 'devDependencies')}${shared}`,
      );
    }

    // Every declared package is used. The root's tooling serves every workspace.
    const scope = unit.dir === '.' ? everywhere : unitUses;
    const words = scriptWords(unit.dir === '.' ? input.units : [unit]);
    const declared = [...Object.keys(dependencies), ...Object.keys(devDependencies)];
    const runtime = new Set<string>();
    const used = new Set<string>();
    for (const name of declared) {
      if (scope.runtimeImports.has(name) || scope.loadedByName.get(name) === true) {
        runtime.add(name);
      }
      if (
        runtime.has(name) ||
        scope.developmentImports.has(name) ||
        scope.loadedByName.has(name) ||
        runsCommandOf(name, words, input.facts(name)) ||
        (name === '@types/node' && scope.builtins)
      ) {
        used.add(name);
      }
    }
    // What the unit uses or imports (declared here or at the root) makes its peers used, at run
    // time when it is, and its @types package used. Repeat until nothing changes, for a peer that
    // has peers of its own.
    for (let changed = true; changed;) {
      changed = false;
      const users = new Set([
        ...used,
        ...scope.runtimeImports.keys(),
        ...scope.developmentImports.keys(),
      ]);
      const mark = (name: string, atRuntime: boolean): void => {
        if (!declared.includes(name)) return;
        if (!used.has(name) || (atRuntime && !runtime.has(name))) {
          used.add(name);
          if (atRuntime) runtime.add(name);
          changed = true;
        }
      };
      for (const user of users) {
        const atRuntime = runtime.has(user) || scope.runtimeImports.has(user);
        for (const peer of input.facts(user).peers) mark(peer, atRuntime);
      }
      for (const name of declared) {
        const typed = typedPackage(name);
        if (typed !== undefined && users.has(typed)) mark(name, false);
      }
    }

    for (const name of declared) {
      const key = `${unit.dir} ${name}`;
      if (!used.has(name)) {
        if (key in input.allowedUnused) continue;
        problems.push(
          `${path} declares '${name}', but nothing in ${unit.dir === '.' ? 'the repository' : unit.dir} imports it, runs its command or needs it as a peer: remove it (npm uninstall ${name}${unit.dir === '.' ? '' : ` -w ${unit.manifest.name}`}); if a file loads it by name, add "${key}" with that file to LOADED_BY_NAME in scripts/lib/workspace-deps.test.ts; if it stays on purpose, add "${key}" with the reason to ALLOWED_UNUSED there`,
        );
      } else if (name in dependencies && !unit.developmentOnly && !runtime.has(name)) {
        problems.push(
          `${path} lists '${name}' under "dependencies", but only development files use it (first: ${scope.developmentImports.get(name) ?? 'an npm script or a peer'}): move it to "devDependencies"`,
        );
      }
      if (used.has(name) && key in input.allowedUnused) {
        problems.push(
          `ALLOWED_UNUSED in scripts/lib/workspace-deps.test.ts lists "${key}", which is now used: remove the entry`,
        );
      }
    }
  }

  for (const key of Object.keys(input.allowedUnused)) {
    const [dir, name] = key.split(' ');
    const unit = input.units.find((each) => each.dir === dir);
    if (
      unit === undefined ||
      name === undefined ||
      !(name in unit.manifest.dependencies || name in unit.manifest.devDependencies)
    ) {
      problems.push(
        `ALLOWED_UNUSED in scripts/lib/workspace-deps.test.ts lists "${key}", which no package.json declares: remove the entry`,
      );
    }
  }
  return problems;
}
