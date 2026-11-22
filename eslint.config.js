// ESLint flat config for the whole repository.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// A later config block replaces an earlier block's options for the same rule, so a file group
// that needs selectors from two lists composes one array from the named lists below.
// scripts/lib/test-hygiene-lint.test.ts runs each list against fixture text.

const NO_RAW_HTML = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is not allowed.',
  },
];

// Code that runs in a browser (portal, player, shared app renderer).
const BROWSER_FILES = [
  'apps/portal/**/*.{ts,tsx}',
  'apps/player-web/**/*.ts',
  // The shared app renderer runs in both of them.
  'packages/app-render/src/**/*.ts',
];
const BROWSER_RESTRICTED_PROPERTIES = [
  {
    property: 'innerHTML',
    message: 'Do not assign HTML strings; build DOM nodes or use textContent.',
  },
  { property: 'outerHTML', message: 'Do not assign HTML strings.' },
  { object: 'document', property: 'write', message: 'Do not use document.write.' },
];

// U-15: a declared skip, focus or expected failure turns a red run green, or hides every
// other test (adoption plan section 4.1). The chained forms cover test.describe.skip,
// it.concurrent.only, test.describe.serial.only and Playwright's test.step.skip; the last entry
// covers the options form.
const NO_SKIPPED_TESTS = [
  {
    selector:
      ':matches(MemberExpression[object.name=/^(it|test|describe|suite)$/], MemberExpression[object.property.name=/^(describe|concurrent|sequential|serial|parallel|step)$/]):matches([property.name=/^(skip|skipIf|runIf|todo|fixme|only|fails|fail)$/])',
    message:
      'A skipped, focused or expected-to-fail test is a red run (U-15): it hides a failure, or every other test. Fix the test or delete it in this change; there is no allow-list for a declared skip.',
  },
  {
    selector:
      'CallExpression:matches([callee.name=/^(it|test|describe|suite)$/], [callee.object.name=/^(it|test|describe|suite)$/]) > ObjectExpression > Property[key.name=/^(skip|todo|only|fails)$/]',
    message:
      'A skipped, focused or expected-to-fail test is a red run (U-15): it hides a failure, or every other test. Fix the test or delete it in this change; there is no allow-list for a declared skip.',
  },
];

// A random value in a test makes a failure impossible to replay. Passing Math.random itself to
// code under test is not a call and stays allowed.
const NO_RANDOM_IN_TESTS = [
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message:
      'Do not call Math.random() in a test: a failing run cannot be replayed. Use a fixed value, a seeded generator whose seed is in the test (seeded(), a mulberry32, in apps/player-web/src/core/playback.test.ts), or randomUUID() or randomBytes() from node:crypto for a value that only has to be unique.',
  },
];

// Every test file: the unit, component and integration projects, Playwright specs, their
// support files and the setup files vitest.config.ts names.
const TEST_FILES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test-support.ts',
  '**/*.test-support.tsx',
  '**/test/**/*.ts',
  'tests/**/*.ts',
  'apps/portal/src/componentTests.setup.ts',
  'scripts/vitest-integration-setup.ts',
];

// OTH-13: the integration project and the Playwright suite run against real services
// (tests/README.md); unit and component tests may still replace a module. packages/*/test
// also holds unit tests (vitest.config.ts), so only packages/db/test, which is integration
// code only, is named here.
const REAL_SERVICE_TEST_FILES = [
  '**/*.integration.test.ts',
  'apps/*/test/**/*.ts',
  'packages/db/test/**/*.ts',
  'tests/**/*.ts',
  'scripts/vitest-integration-setup.ts',
];
const NO_MODULE_MOCK = ['mock', 'doMock', 'importMock', 'stubGlobal'].map((property) => ({
  object: 'vi',
  property,
  message:
    'Integration and e2e tests use real services (OTH-13, tests/README.md). Inject a fault through startTestApp(..., { wrapPool }) with losingCommitAnswers or statementHolds, or the mail option, in apps/api/test/support.ts, instead of replacing a module or a global.',
}));

/** Files that match a glob of `outer` and a glob of `inner` (an inner array means "all of"). */
const both = (outer, inner) => outer.flatMap((o) => inner.map((i) => [o, i]));

// Import boundaries (adoption plan section 3.1, step 7). One row per workspace of the root
// package.json, plus scripts: the @tinnox packages its files may import. It records the real
// graph; scripts/lib/import-boundaries-lint.test.ts fails when a workspace has no row.
// No package imports an app, and no app imports another app.
export const IMPORT_LAYERS = {
  'packages/contracts': [],
  'packages/storage': [],
  // Step 17 adds a type-only @tinnox/contracts import here (D19).
  'packages/db': [],
  'packages/domain': ['contracts'],
  'packages/app-render': ['contracts'],
  'packages/delivery': ['contracts', 'domain'],
  'apps/api': ['contracts', 'db', 'storage', 'domain', 'delivery'],
  // Not declared in its package.json yet; the manifest check of step 9 adds it.
  'apps/media-worker': ['contracts'],
  'apps/portal': ['contracts', 'domain', 'app-render'],
  'apps/player-web': ['contracts', 'domain', 'app-render'],
  // The API's test harness is the one app entry anything may import (apps/api/package.json).
  tests: ['contracts', 'db', 'domain', 'app-render', 'api/test-support'],
  scripts: ['contracts', 'db', 'domain'],
};

// Every file ESLint parses as code. A glob without an extension would make ESLint lint JSON,
// Markdown and SQL as JavaScript.
const CODE_FILES = '**/*.{ts,tsx,js,mjs,cjs}';

// The @tinnox names that are apps, never libraries: every workspace under apps/, and tests.
const APP_PACKAGES = [
  ...Object.keys(IMPORT_LAYERS)
    .filter((dir) => dir.startsWith('apps/'))
    .map((dir) => dir.slice('apps/'.length)),
  'tests',
];

/** A regular expression that matches any of `names` as a whole specifier or its subpath. */
const anyOf = (names) => `(${names.map((name) => name.replace(/[.+]/g, '\\$&')).join('|')})(/|$)`;

// The last segment of every workspace under apps/ or packages/. A relative path between two
// workspaces with the same parent ('../../api/src/app.ts' from apps/portal/src) names no apps/ or
// packages/ segment, only `../` steps and the sibling's directory name.
const WORKSPACE_LEAVES = Object.keys(IMPORT_LAYERS)
  .filter((dir) => dir.includes('/'))
  .map((dir) => dir.slice(dir.indexOf('/') + 1));

// The top-level folders of a workspace that hold code (src, test, player-web's sw and build). A
// relative path must name one after the workspace, so a portal feature folder called apps or api
// ('../../api/client.ts', '../../apps/AppPreview.tsx') is not a workspace.
const WORKSPACE_CODE = '/(src|test|sw|build)(/|$)';

/** The patterns every file of the workspace `dir` gets. */
function layerPatterns(dir) {
  const allowed = IMPORT_LAYERS[dir];
  const allowedApps = allowed.filter((name) => APP_PACKAGES.includes(name.split('/')[0]));
  const packages = allowed.filter((name) => !allowedApps.includes(name));
  const browser = dir === 'apps/portal' || dir === 'apps/player-web';
  return [
    {
      // An allowed package, or an app (the next entry's message), is not this entry's to report.
      regex: `^@tinnox/(?!${anyOf([...packages, ...APP_PACKAGES])})`,
      message:
        packages.length === 0
          ? `${dir} is a bottom layer and imports no @tinnox package. Take what you need as a parameter, or move the code into this package.`
          : `${dir} may import only ${packages.map((name) => `@tinnox/${name}`).join(', ')} from @tinnox/* (adoption plan section 3.1). ${
              browser
                ? 'This file is bundled for the browser: call the API through apps/portal/src/api or apps/player-web/src/platform/api.ts.'
                : 'Take what you need as a parameter, or move the shared code into a package both may import.'
            }`,
    },
    {
      regex: `^@tinnox/${allowedApps.length === 0 ? '' : `(?!${anyOf(allowedApps)})`}${anyOf(APP_PACKAGES)}`,
      message:
        "Apps are not libraries. Move the shared code into a package under packages/ and import that; tests reach the API's harness only as '@tinnox/api/test-support'.",
    },
    {
      // An app's files are the previous entry's to report.
      regex: `^@tinnox/(?!${anyOf(APP_PACKAGES)})[a-z-]+/(src|test)(/|$)`,
      message:
        "Do not import a file inside another package. Import its entry ('@tinnox/<name>', or a path its package.json exports) and export what you need from its src/index.ts.",
    },
    {
      // Through apps/ or packages/ (from tests or scripts, or across the two parents), or straight
      // to a sibling with the same parent.
      regex: `^\\.{1,2}/(.*/)?(apps|packages)/[a-z-]+${WORKSPACE_CODE}|^(\\.\\./)+(${WORKSPACE_LEAVES.join('|')})${WORKSPACE_CODE}`,
      message:
        "Do not reach into another workspace by relative path. Import '@tinnox/<name>' and export what you need from its src/index.ts (or its package.json exports).",
    },
    // Rule (g): only apps/api serves HTTP, tests included.
    ...(dir === 'apps/api'
      ? []
      : [
          {
            regex: '^(fastify|fastify-plugin|@fastify/[^/]+)(/|$)',
            message:
              'Only apps/api serves HTTP. Add the route under apps/api/src/routes and call it over HTTP; shared request and response shapes go in @tinnox/contracts.',
          },
        ]),
  ];
}

// Node builtins that only make sense on a server (files, processes, sockets, the host): rule (f)
// bans their bare names as well as every node: specifier. A fixed list, so lint does not change
// with the Node version that runs it.
const NODE_ONLY_MODULES = [
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'fs',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'readline',
  'tls',
  'worker_threads',
];

// Extra patterns for a subset of the files: each facet adds its patterns (or the patterns it
// gives for the workspace) to the workspace's own.
// `only` and `except` name the workspaces a facet can touch, and facets of one `group` match
// disjoint files, so the generator makes no block that can match nothing.
const IMPORT_FACETS = [
  {
    // Non-test files. Rule (h): they import no test code. Rule (g), D25: outside packages/db they
    // import no pg, scripts included; test files and test support may (they arrange data with
    // their own clients).
    files: [CODE_FILES],
    ignores: TEST_FILES,
    patterns: (dir) => [
      {
        regex: '(^|/)tests?/|\\.test(-support)?\\.tsx?$',
        message:
          'Product code does not import test code. Move what both need into a module that is not a test file, and import it from the test.',
      },
      ...(dir === 'packages/db'
        ? []
        : [
            {
              regex: '^pg(/|$)',
              message:
                'Only packages/db talks to PostgreSQL. Use createPool and withOrg from @tinnox/db (connectMigrator for an offline tool); a direct pg client skips the tinnox_app role check and the row_security and timeout start-up parameters.',
            },
          ]),
    ],
  },
  {
    // Rule (f): browser source, without its tests and the Vite configuration (both run in Node).
    only: ['apps/portal', 'apps/player-web', 'packages/app-render'],
    files: BROWSER_FILES,
    ignores: [...TEST_FILES, '**/vite.config.ts'],
    patterns: [
      {
        // Every node: specifier (the plan's rule), and the bare names of the server-only modules.
        // The other bare builtin names (buffer, events, url, util, process, path, assert, ...) are
        // also npm packages that browsers use as polyfills, so they stay allowed.
        regex: `^(node:|${anyOf(NODE_ONLY_MODULES)})`,
        message:
          'This file is bundled for the browser, where Node modules do not exist. Call the API through apps/portal/src/api or apps/player-web/src/platform/api.ts, and use web APIs (crypto.subtle, URL, TextEncoder).',
      },
    ],
  },
  {
    // Rule (d): replaces the old deny-list of Node modules and frameworks with an allow-list.
    only: ['packages/domain'],
    files: ['packages/domain/src/**'],
    ignores: TEST_FILES,
    patterns: [
      {
        regex: '^(?!@tinnox/|\\./)',
        message:
          'packages/domain is pure: it imports only @tinnox/contracts and its own files. Take time, ids and I/O results as parameters (prototype-m0.md section 3).',
      },
    ],
  },
  {
    // Rule (e).
    only: ['packages/contracts'],
    files: ['packages/contracts/src/**'],
    ignores: TEST_FILES,
    patterns: [
      {
        regex: '^(?!zod(/|$)|@tinnox/|\\./)',
        message:
          'packages/contracts holds schemas and types: it imports only zod and its own files. Put code that needs anything else in the package that uses it.',
      },
    ],
  },
  {
    // Rule (i), D6: a route file imports no other route file. The rule compares the specifier
    // text and never resolves it, so it needs both halves: './media.ts' and '../routes/media.ts'.
    only: ['apps/api'],
    group: 'api-routes',
    files: ['apps/api/src/routes/**'],
    patterns: [
      {
        regex: '^\\./|(^|/)routes/',
        message:
          'A route file imports no other route file (D6). Move the shared code to a module outside routes/ (as display-state.ts, media/rows.ts, tags.ts or publishing.ts) and import it from there.',
      },
    ],
  },
  {
    // Rule (i), D6: only app.ts registers the routes; tests included.
    only: ['apps/api'],
    group: 'api-routes',
    files: ['apps/api/**'],
    ignores: ['apps/api/src/app.ts', 'apps/api/src/routes/**'],
    patterns: [
      {
        regex: '(^|/)routes/',
        message:
          'Only apps/api/src/app.ts imports from routes/ (D6). Import the shared module instead (as display-state.ts, media/rows.ts, tags.ts or publishing.ts); if the code is still in a route file, move it out of routes/ first.',
      },
    ],
  },
];

/** Every combination of the facets in `list` that can meet, the empty one first, longer ones later. */
const combinations = (list) =>
  list
    .reduce((sets, item) => [...sets, ...sets.map((set) => [...set, item])], [[]])
    .filter((set) => set.every((a) => !set.some((b) => a !== b && a.group && a.group === b.group)))
    .sort((a, b) => a.length - b.length);

/**
 * The no-restricted-imports blocks: for each workspace, one block per combination of the facets
 * that apply to it, each with the complete pattern list (a later block replaces the options of
 * an earlier one, so a file always gets the block of exactly the facets it matches).
 */
function importBoundaryBlocks() {
  return Object.keys(IMPORT_LAYERS).flatMap((dir) => {
    const facets = IMPORT_FACETS.filter(
      (facet) => (facet.only?.includes(dir) ?? true) && !facet.except?.includes(dir),
    );
    return combinations(facets).map((set) => ({
      // All of: the workspace and one glob of each facet in the set.
      files: set.reduce(
        (paths, facet) => paths.flatMap((path) => facet.files.map((glob) => [...path, glob])),
        [[`${dir}/${CODE_FILES}`]],
      ),
      ignores: set.flatMap((facet) => facet.ignores ?? []),
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              ...layerPatterns(dir),
              ...set.flatMap((facet) =>
                typeof facet.patterns === 'function' ? facet.patterns(dir) : facet.patterns,
              ),
            ],
          },
        ],
      },
    }));
  });
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'data/**',
      'infra/.generated/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // local, gitignored run state and check scripts (outside every tsconfig)
      'tests/.run/**',
      // local git worktrees: second copies of the repository, which double the memory of a lint run
      '.claude/worktrees/**',
      // approved restyle mockups (docs only, kept as the client approved them)
      'docs/portal-v2/restyle-mockups/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Unhandled promises are the commonest source of silent failures in server and player code.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
      'no-eval': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Server-side code and tooling.
    files: [
      'apps/api/**/*.ts',
      'apps/media-worker/**/*.ts',
      'packages/**/*.ts',
      'scripts/**/*.ts',
      'tests/**/*.ts',
      '*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  ...importBoundaryBlocks(),
  {
    // The domain must stay free of platform code (prototype-m0.md section 3); its imports are
    // held by the import-boundary blocks above.
    files: ['packages/domain/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'indexedDB',
        'caches',
        'localStorage',
        'sessionStorage',
        'fetch',
        'process',
      ],
    },
  },
  {
    files: BROWSER_FILES,
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
    rules: {
      // Operator bearer tokens and session data must never be put in web storage (brief section 6).
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Do not use localStorage; see the security rules in docs/dev-handoff.md.',
        },
        { name: 'sessionStorage', message: 'Do not use sessionStorage.' },
      ],
      'no-restricted-properties': ['error', ...BROWSER_RESTRICTED_PROPERTIES],
    },
  },
  {
    files: ['apps/portal/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-syntax': ['error', ...NO_RAW_HTML],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test-support.ts', '**/test/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...NO_SKIPPED_TESTS, ...NO_RANDOM_IN_TESTS],
    },
  },
  {
    // Portal test files keep the portal's own selectors (see the note at the top of this file).
    files: both(['apps/portal/**'], TEST_FILES),
    rules: {
      'no-restricted-syntax': ['error', ...NO_RAW_HTML, ...NO_SKIPPED_TESTS, ...NO_RANDOM_IN_TESTS],
    },
  },
  {
    files: REAL_SERVICE_TEST_FILES,
    rules: {
      'no-restricted-properties': ['error', ...NO_MODULE_MOCK],
    },
  },
  {
    // Browser code keeps its own restricted properties (see the note at the top of this file).
    files: both(BROWSER_FILES, REAL_SERVICE_TEST_FILES),
    rules: {
      'no-restricted-properties': ['error', ...BROWSER_RESTRICTED_PROPERTIES, ...NO_MODULE_MOCK],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
