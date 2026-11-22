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
  {
    // The domain must stay free of platform code (prototype-m0.md section 3).
    files: ['packages/domain/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'http', 'https', 'net'],
              message: 'packages/domain must not use Node APIs.',
            },
            {
              group: ['@tinnox/*', '!@tinnox/contracts'],
              message: 'packages/domain may depend only on @tinnox/contracts.',
            },
            {
              group: ['react', 'react-dom', 'fastify', 'pg', 'idb'],
              message: 'packages/domain must stay framework-free.',
            },
          ],
        },
      ],
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
