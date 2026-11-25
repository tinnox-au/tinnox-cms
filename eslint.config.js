// ESLint flat config for the whole repository.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// D16: the repository's own rules (scripts/eslint-rules/) are TypeScript, which Node runs by
// stripping the types: by default from 22.18, the floor of `engines` in package.json. `engines`
// is advice only, so this check is what holds the floor. It comes before the plugin is loaded,
// and the plugin is loaded with import(), because a static import is resolved before any
// statement of this file runs and would fail first, with an error that names no remedy.
if (!process.features.typescript) {
  throw new Error(
    `eslint.config.js loads the lint rules in scripts/eslint-rules/*.ts, and this Node (${process.version}) does not run TypeScript files: type stripping is on by default from Node 22.18 and off here. Use Node 22.18 or later, the floor of package.json engines (nvm install 22 && nvm use 22: .nvmrc names the 22 line, and an older 22 installed locally would fail here again), take --no-experimental-strip-types out of NODE_OPTIONS, and point an editor's ESLint extension at that Node (docs/dev-handoff.md).`,
  );
}
const { default: tinnox } = await import('./scripts/eslint-rules/index.ts');

// A later config block replaces an earlier block's options for the same rule, so a file group
// that needs selectors from two lists composes one array from the named lists below.
// The *-lint.test.ts files in scripts/lib run each list against fixture text (the step 10 bans:
// banned-patterns-lint.test.ts, which also holds the step 11 text-key rule).

const SRCDOC_MESSAGE =
  'Do not give a frame its document as a string: it is parsed as HTML. Point src at a page that is served, or build the nodes.';
const NO_RAW_HTML = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is not allowed.',
  },
  // React's srcDoc prop is the srcdoc property below, written as JSX.
  { selector: 'JSXAttribute[name.name=/^srcdoc$/i]', message: SRCDOC_MESSAGE },
];

// Code that runs in a browser (portal, player, shared app renderer).
const BROWSER_FILES = [
  'apps/portal/**/*.{ts,tsx}',
  'apps/player-web/**/*.ts',
  // The shared app renderer runs in both of them.
  'packages/app-render/src/**/*.ts',
];
// Web storage is readable by any script on the page and outlives the session (docs/dev-handoff.md,
// security rules). The bare globals are no-restricted-globals; every other way in is a property
// named localStorage or sessionStorage on any object (BROWSER_RESTRICTED_PROPERTIES), which
// no-restricted-properties reports for a member access (window., self., globalThis., an alias, a
// cast, document.defaultView?.) and for destructuring, a parameter included. So a local object
// with such a property is reported too: name it something else.
const WEB_STORAGE_MESSAGE =
  'Keep nothing in web storage: any script on the page can read it, and it outlives the session (docs/dev-handoff.md). The portal needs none, since its session is the HttpOnly cookie the API sets; the player keeps its state in IndexedDB through apps/player-web/src/platform/idb-store.ts.';
const NO_WEB_STORAGE = {
  globals: [
    { name: 'localStorage', message: WEB_STORAGE_MESSAGE },
    { name: 'sessionStorage', message: WEB_STORAGE_MESSAGE },
  ],
};

const HTML_PARSE_MESSAGE =
  'Do not parse strings as HTML: text from an operator or the API would run as markup. Build the nodes (document.createElement, append, textContent) or render with React.';
const STYLE_STRING_MESSAGE =
  'Do not write a style as one string: a value from an operator or the API could add declarations. Set each property (element.style.setProperty(name, value)) or use the style prop in React.';
// The ways to turn a string into markup, a style or a handler that lint can see. Not complete: a
// computed property name (el[name] = s), Reflect.set and a setAttribute whose name is not a
// literal are not seen, and are left to review.
const BROWSER_RESTRICTED_PROPERTIES = [
  {
    property: 'innerHTML',
    message: 'Do not assign HTML strings; build DOM nodes or use textContent.',
  },
  { property: 'outerHTML', message: 'Do not assign HTML strings.' },
  { object: 'document', property: 'write', message: 'Do not use document.write.' },
  { object: 'document', property: 'writeln', message: 'Do not use document.writeln.' },
  ...[
    'insertAdjacentHTML',
    'createContextualFragment',
    'setHTMLUnsafe',
    'parseHTMLUnsafe',
    // DOMParser: inline handlers in the parsed nodes run once they are inserted.
    'parseFromString',
  ].map((property) => ({ property, message: HTML_PARSE_MESSAGE })),
  { property: 'srcdoc', message: SRCDOC_MESSAGE },
  { property: 'cssText', message: STYLE_STRING_MESSAGE },
  { property: 'localStorage', message: WEB_STORAGE_MESSAGE },
  { property: 'sessionStorage', message: WEB_STORAGE_MESSAGE },
];
// The same sinks reached through a call, which no-restricted-properties does not see: a style, a
// frame document or an event handler set as an attribute, and Object.assign onto an element. A
// selector list, so it joins the no-restricted-syntax list of each file group that holds browser
// code.
const NO_HTML_SINK_CALLS = [
  {
    selector:
      "CallExpression[callee.property.name='setAttribute']:matches([arguments.0.value=/^(style|srcdoc)$/i], [arguments.0.value=/^on[a-z]+$/i])",
    message:
      "Do not set a style, a frame document or an event handler as an attribute string: a value from an operator or the API could add declarations, markup or code. For a style use element.style.setProperty(name, value) or React's style prop, for a handler addEventListener or React's on... prop, and for a frame point src at a page that is served.",
  },
  {
    selector:
      "CallExpression[callee.object.name='Object'][callee.property.name='assign'] > ObjectExpression > Property:matches([key.name=/^(innerHTML|outerHTML|srcdoc|cssText)$/], [key.value=/^(innerHTML|outerHTML|srcdoc|cssText)$/])",
    message: `${HTML_PARSE_MESSAGE} For a style, set each property with element.style.setProperty(name, value).`,
  },
];

// DEC-13 and DEC-15: data leaves the machine only through a reviewed client. The import half of
// the rule is the `outbound` facets of the import-boundary generator below, and
// outboundLoadSelectors holds the import() and require() half; this is the global half, for the
// API, the media worker and the server packages the API bundles (OUTBOUND_SOURCES).
const OUTBOUND_MESSAGE =
  'Outbound calls need a data-location review (DEC-13, DEC-15). The approved clients are auth/oidc.ts (identity provider, through IdentityProvider) and mail.ts (SMTP through createMailer, DEC-37); a new destination is reviewed first and then gets its own override in eslint.config.js.';
const OUTBOUND_GLOBAL_NAMES = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const NO_OUTBOUND_GLOBALS = {
  globals: OUTBOUND_GLOBAL_NAMES.map((name) => ({ name, message: OUTBOUND_MESSAGE })),
  checkGlobalObject: true,
};
// The same globals taken apart from the global object (const { fetch: f } = globalThis), also
// through a cast, which no-restricted-globals does not see. An alias of the global object
// (const g = globalThis; g.fetch(...)) is not seen either, and is left to review.
const OUTBOUND_KEY = `/^(${OUTBOUND_GLOBAL_NAMES.join('|')})$/`;
const GLOBAL_OBJECT = '/^(window|self|globalThis)$/';
const NO_OUTBOUND_GLOBAL_DESTRUCTURING = [
  {
    selector: [
      `VariableDeclarator:matches([init.name=${GLOBAL_OBJECT}], [init.expression.name=${GLOBAL_OBJECT}]) > ObjectPattern > Property:matches([key.name=${OUTBOUND_KEY}], [key.value=${OUTBOUND_KEY}])`,
      `AssignmentExpression:matches([right.name=${GLOBAL_OBJECT}], [right.expression.name=${GLOBAL_OBJECT}]) > ObjectPattern > Property:matches([key.name=${OUTBOUND_KEY}], [key.value=${OUTBOUND_KEY}])`,
    ].join(', '),
    message: OUTBOUND_MESSAGE,
  },
];

// Configuration is read once, at an entry point, and passed down (apps/api/src/config.ts), so a
// test can give any module its own values. The entry points and config modules named here are
// the only readers: the API's two entry points (loadConfig(runtimeEnv(process.env)), D5), the
// media worker's entry point, and scripts/lib/env.ts (requireEnv) for the offline tools, whose
// top-level scripts are entry points and outside this rule.
const ENV_FILES = [
  'apps/*/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'apps/player-web/sw/**/*.ts',
  'scripts/lib/**/*.ts',
];
const ENV_READERS = [
  'apps/api/src/main.ts',
  'apps/api/src/alerts-once.ts',
  'apps/media-worker/src/main.ts',
  'scripts/lib/env.ts',
];
const PROCESS_ENV_MESSAGE =
  'Read configuration at an entry point and pass it down: in apps/api take it from AppConfig (loadConfig in config.ts, called by main.ts and alerts-once.ts), in scripts/lib call requireEnv from scripts/lib/env.ts, and otherwise add a parameter. Only the files in ENV_READERS of eslint.config.js read process.env.';
// The import half (import { env } from 'node:process') is the `env` facet of the import-boundary
// generator below. A default import of node:process (proc.env) is not seen: it is also how a file
// sets exitCode.
const NO_PROCESS_ENV = [{ object: 'process', property: 'env', message: PROCESS_ENV_MESSAGE }];
// LINT-5: process.env reached through the global object, which no-restricted-properties cannot
// match two levels deep. A selector list, so `typeof globalThis.process` (runtime detection) stays
// allowed. It joins the product, API, portal and scripts lists, which cover ENV_FILES; in an entry
// point it only asks for the plain spelling. A cast or an alias of the global object
// ((globalThis as G).process.env, const g = globalThis) is not seen.
const GLOBAL_PROCESS = `[object.name=${GLOBAL_OBJECT}]:matches([computed=false][property.name='process'], [property.value='process'])`;
const ENV_KEY = ":matches([computed=false][property.name='env'], [property.value='env'])";
const NO_GLOBAL_PROCESS_ENV = [
  {
    selector: [
      `MemberExpression${ENV_KEY} > MemberExpression.object${GLOBAL_PROCESS}`,
      `VariableDeclarator[init.object.name=${GLOBAL_OBJECT}]:matches([init.computed=false][init.property.name='process'], [init.property.value='process']) > ObjectPattern > Property:matches([key.name='env'], [key.value='env'])`,
    ].join(', '),
    message:
      'Write process.env, not globalThis.process.env: the process.env rule of eslint.config.js (ENV_READERS) must see every read. Where it applies, read configuration at an entry point and pass it down: AppConfig in apps/api, requireEnv from scripts/lib/env.ts in scripts/lib, and otherwise a parameter.',
  },
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

// D11 (adoption plan step 29): every fast-check run draws a fresh seed, so a property keeps
// exploring. A seed or path in the options of the runner replays one run for ever, and stops
// reproducing once a generator changes. The options object is matched as a direct child of the
// call (or under `as` or `satisfies`; a computed `fc['assert']` counts), so a generator's own fields (`fc.record({ path: fc.string() })`) pass. The second entry
// keeps the runner reachable as `fc`, the only name the first one sees (types may be imported by
// name). Not seen: options held in a variable or spread from one.
const FC_RUNNER_CALL =
  "CallExpression[callee.object.name='fc']:matches([callee.property.name=/^(assert|check|configureGlobal)$/], [callee.property.value=/^(assert|check|configureGlobal)$/])";
const FC_REPLAY_PROPERTY =
  'Property:matches([key.name=/^(seed|path)$/], [key.value=/^(seed|path)$/])';
const FC_REPLAY_SELECTOR = [
  `${FC_RUNNER_CALL} > ObjectExpression > ${FC_REPLAY_PROPERTY}`,
  `${FC_RUNNER_CALL} > TSAsExpression > ObjectExpression > ${FC_REPLAY_PROPERTY}`,
  `${FC_RUNNER_CALL} > TSSatisfiesExpression > ObjectExpression > ${FC_REPLAY_PROPERTY}`,
].join(', ');
const NO_FC_REPLAY = [
  {
    selector: FC_REPLAY_SELECTOR,
    message:
      'Do not commit a fast-check seed or path (D11): every run draws its own seed, and a replay stops reproducing once a generator changes. Add the shrunk counterexample that the failure printed as a plain example test in the same *.property.test.ts, beside its fix (as in packages/domain/src/layout.property.test.ts).',
  },
  {
    selector:
      "ImportDeclaration[source.value='fast-check'][importKind!='type'] > :matches(ImportSpecifier[importKind!='type'], ImportDefaultSpecifier[local.name!='fc'], ImportNamespaceSpecifier[local.name!='fc'])",
    message:
      "Import fast-check as `import fc from 'fast-check'` and call it through `fc` (fc.property, fc.assert, fc.integer): the lint that keeps seeds and paths out of committed tests (D11) sees runner calls on `fc` only.",
  },
];

// RCX-03 (adoption plan step 23): a status asserted as a range or as "not 401" passes on a 500, a
// 429 or any other answer nobody meant. Matched on expect(...) and expect.soft(...) whose subject
// reads a status: a `.status` or `.statusCode` member (optional, awaited or Playwright's
// `.status()` call included), or a name or a call whose name ends in "status"
// (`await manifestStatus(player)`). The forms: a comparison matcher, negated or not
// (`.not.toBeLessThan(400)` is `>= 400`); a negated toBe; a comparison inside expect()
// (`expect(response.status >= 400).toBe(true)`, alone or joined by && or ||); and toSatisfy,
// which can hold any range. A comparison on a member, by matcher or inside expect(), is refused
// unless its bound is a number that is not a status; the
// named forms and the negations only with a three-digit status literal, so a process's
// `expect(run.status).toBeGreaterThan(0)`, `expect(run.status).not.toBe(0)` and
// `expect(status).not.toBe('ready')` stay allowed. A list of exact answers
// (`expect([200, 204]).toContain(...)`, `toBeOneOf`) names what proves the code ran and is allowed;
// its negation (`expect([401, 403]).not.toContain(response.status)`,
// `expect(response.status).not.toBeOneOf([401])`) is refused. Since CHK-4 of the group C review a
// comparison inside expect() is also seen as `!==` or `!=` against a status literal
// (`expect(response.status !== 401).toBe(true)`) and behind `!` (`expect(!(status < 400))`).
// Since TST-5 an exact comparison asserted false is seen too
// (`expect(response.status === 401).toBe(false)`), and so, in the files that send real requests,
// is a response's `ok` asserted false (NO_RESPONSE_NOT_OK below). Not seen: arithmetic on the
// status (`Math.floor(status / 100)`), the status as text (`expect(String(status)).toMatch(/^4/)`),
// a comparison compared again (`expect(status < 400 === false)`) and a negation by a named
// constant (`.not.toBe(OK)`, left alone so `.not.toBe(previousStatus)` stays allowed).
const RANGE_STATUS_MESSAGE =
  "Assert the exact status: expect(response.status).toBe(204), or for an error expectError(response, 'not_found') from apps/api/test/support.ts (also exported by tests/integration/support.ts), which checks the status and the error code. A range or a 'not 401' passes on a crash or a rate limit (RCX-03).";
const STATUS_READ = (path) =>
  `:matches([${path}.property.name=/^(status|statusCode)$/], [${path}.expression.property.name=/^(status|statusCode)$/], [${path}.argument.property.name=/^(status|statusCode)$/], [${path}.callee.property.name='status'], [${path}.argument.callee.property.name='status'])`;
const STATUS_NAMED = (path) =>
  `:matches([${path}.name=/^status$|Status$/], [${path}.callee.name=/^status$|Status$/], [${path}.argument.callee.name=/^status$|Status$/])`;
const STATUS_SUBJECT = (path) => `:matches(${STATUS_READ(path)}, ${STATUS_NAMED(path)})`;
const HTTP_STATUS_LITERAL = (path) => `[${path}.raw=/^[1-5][0-9][0-9]$/]`;
const HTTP_STATUS_ARGUMENT = HTTP_STATUS_LITERAL('arguments.0');
// Anything but a literal that is not a status: `toBeLessThan(500)` and `toBeLessThan(limit)`, not
// an exit code's `toBeGreaterThan(0)`.
const NOT_OTHER_LITERAL = (path) =>
  `:not([${path}.type='Literal']:not([${path}.raw=/^[1-5][0-9][0-9]$/]))`;
const NOT_OTHER_LITERAL_ARGUMENT = NOT_OTHER_LITERAL('arguments.0');
const EXPECT_CALL = (path) =>
  `:matches([${path}.callee.name='expect'], [${path}.callee.object.name='expect'])`;
const COMPARISON_MATCHER =
  'CallExpression[callee.property.name=/^(toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual)$/]';
const STATUS_COMPARISON = `${COMPARISON_MATCHER}${EXPECT_CALL('callee.object')}`;
const STATUS_NEGATED_COMPARISON = `${COMPARISON_MATCHER}[callee.object.property.name='not']${EXPECT_CALL('callee.object.object')}`;
const STATUS_NEGATION = `CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual)$/][callee.object.property.name='not']${EXPECT_CALL('callee.object.object')}`;
const STATUS_SATISFY = `CallExpression[callee.property.name='toSatisfy']:matches(${EXPECT_CALL('callee.object')}, [callee.object.property.name='not']${EXPECT_CALL('callee.object.object')})`;
const RELATIONAL = (path) => `[${path}.type='BinaryExpression'][${path}.operator=/^[<>]=?$/]`;
const NOT_EQUAL = (path) => `[${path}.type='BinaryExpression'][${path}.operator=/^!==?$/]`;
// A comparison inside expect() takes the same bounds as the matcher forms: a status member against
// anything but a literal that is not a status (`>= serverError`, not `> 0`), a status name only
// against a status literal. It is found alone or as an operand of && or ||, two levels deep, so
// `expect(response.status >= 400 && response.status < 500).toBe(true)` is one report.
// A "not" (`!==`, `!=`) is refused only against a status literal, so `run.status !== 0` passes.
const RELATIONAL_STATUS = (path) =>
  `:matches(${RELATIONAL(path)}:matches(${STATUS_READ(`${path}.left`)}${NOT_OTHER_LITERAL(`${path}.right`)}, ${STATUS_READ(`${path}.right`)}${NOT_OTHER_LITERAL(`${path}.left`)}, ${STATUS_NAMED(`${path}.left`)}${HTTP_STATUS_LITERAL(`${path}.right`)}, ${STATUS_NAMED(`${path}.right`)}${HTTP_STATUS_LITERAL(`${path}.left`)}), ${NOT_EQUAL(path)}:matches(${STATUS_SUBJECT(`${path}.left`)}${HTTP_STATUS_LITERAL(`${path}.right`)}, ${STATUS_SUBJECT(`${path}.right`)}${HTTP_STATUS_LITERAL(`${path}.left`)}))`;
const RELATIONAL_STATUS_WITHIN = (path, depth) =>
  depth === 0
    ? RELATIONAL_STATUS(path)
    : `:matches(${RELATIONAL_STATUS(path)}, [${path}.type='LogicalExpression']:matches(${RELATIONAL_STATUS_WITHIN(`${path}.left`, depth - 1)}, ${RELATIONAL_STATUS_WITHIN(`${path}.right`, depth - 1)}), [${path}.type='UnaryExpression'][${path}.operator='!']${RELATIONAL_STATUS_WITHIN(`${path}.argument`, depth - 1)})`;
const STATUS_NEGATED_LIST = `CallExpression[callee.property.name=/^(toContain|toBeOneOf)$/][callee.object.property.name='not']${EXPECT_CALL('callee.object.object')}`;
// "Is false": toBe, toEqual or toStrictEqual with false, toBeFalsy, or the negation of true or of
// toBeTruthy, on expect() or expect.soft() whose argument `subject` matches; `subject` takes the
// path of that argument from the matcher call.
const ASSERTED_FALSE = (subject) =>
  `:matches(CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual)$/][arguments.0.raw='false']${EXPECT_CALL('callee.object')}${subject('callee.object.arguments.0')}, CallExpression[callee.property.name='toBeFalsy']${EXPECT_CALL('callee.object')}${subject('callee.object.arguments.0')}, CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual)$/][arguments.0.raw='true'][callee.object.property.name='not']${EXPECT_CALL('callee.object.object')}${subject('callee.object.object.arguments.0')}, CallExpression[callee.property.name='toBeTruthy'][callee.object.property.name='not']${EXPECT_CALL('callee.object.object')}${subject('callee.object.object.arguments.0')})`;
// An exact comparison of a status with a status literal, either way round: asserted false, it is
// "not 401" (`expect(response.status === 401).toBe(false)`).
const STATUS_EQUALS_LITERAL = (path) =>
  `[${path}.type='BinaryExpression'][${path}.operator=/^===?$/]:matches(${STATUS_SUBJECT(`${path}.left`)}${HTTP_STATUS_LITERAL(`${path}.right`)}, ${STATUS_SUBJECT(`${path}.right`)}${HTTP_STATUS_LITERAL(`${path}.left`)})`;
const NO_RANGE_STATUS = [
  {
    selector: `${STATUS_COMPARISON}${NOT_OTHER_LITERAL_ARGUMENT}${STATUS_READ('callee.object.arguments.0')}`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: `${STATUS_COMPARISON}${HTTP_STATUS_ARGUMENT}${STATUS_NAMED('callee.object.arguments.0')}`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: `${STATUS_NEGATED_COMPARISON}${NOT_OTHER_LITERAL_ARGUMENT}${STATUS_READ('callee.object.object.arguments.0')}`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: `${STATUS_NEGATED_COMPARISON}${HTTP_STATUS_ARGUMENT}${STATUS_NAMED('callee.object.object.arguments.0')}`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: `${STATUS_NEGATION}${HTTP_STATUS_ARGUMENT}${STATUS_SUBJECT('callee.object.object.arguments.0')}`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: `${STATUS_SATISFY}:matches(${STATUS_SUBJECT('callee.object.arguments.0')}, ${STATUS_SUBJECT('callee.object.object.arguments.0')})`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: `CallExpression:matches([callee.name='expect'], [callee.object.name='expect'])${RELATIONAL_STATUS_WITHIN('arguments.0', 2)}`,
    message: RANGE_STATUS_MESSAGE,
  },
  {
    selector: ASSERTED_FALSE(STATUS_EQUALS_LITERAL),
    message: RANGE_STATUS_MESSAGE,
  },
  {
    // The status on one side and a list that opens with a status literal on the other.
    selector: `${STATUS_NEGATED_LIST}:matches(${STATUS_SUBJECT('callee.object.object.arguments.0')}${HTTP_STATUS_LITERAL('arguments.0.elements.0')}, ${STATUS_SUBJECT('arguments.0')}${HTTP_STATUS_LITERAL('callee.object.object.arguments.0.elements.0')})`,
    message: RANGE_STATUS_MESSAGE,
  },
];

// TST-5 of the group C review: a response's `ok` asserted false (`expect(response.ok).toBe(false)`,
// Playwright's `expect(response.ok()).toBeFalsy()`) is "not 2xx", which a 500 or a 429 passes.
// Only in the files that send real requests (REAL_SERVICE_TEST_FILES): unit tests assert the `ok`
// of a result type (`expect(result.ok).toBe(false)` in apps/portal/src/lib), which is exact.
// The `ok` of a query's row (`expect(taken.rows[0]?.ok).toBe(false)`, packages/db/test) is a
// column, not a response, and is left alone; any other `ok` that is not a response's is
// asserted through its object, as the message says.
const ROW_ELEMENT = (path) =>
  `:matches([${path}.object.name='rows'], [${path}.object.property.name='rows'])`;
const NOT_ROW_OK = (path) =>
  `:not(${ROW_ELEMENT(`${path}.object`)}, ${ROW_ELEMENT(`${path}.object.expression`)}, ${ROW_ELEMENT(`${path}.expression.object`)})`;
const OK_READ = (path) =>
  `:matches([${path}.property.name='ok'], [${path}.expression.property.name='ok'], [${path}.callee.property.name='ok'], [${path}.argument.callee.property.name='ok'], [${path}.argument.property.name='ok'])${NOT_ROW_OK(path)}`;
const NO_RESPONSE_NOT_OK = [
  {
    selector: ASSERTED_FALSE(OK_READ),
    message: `${RANGE_STATUS_MESSAGE} An \`ok\` that is not an HTTP response's is asserted through its object: expect(result).toMatchObject({ ok: false }).`,
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
  'scripts/vitest-integration-file-setup.ts',
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
  'scripts/vitest-integration-file-setup.ts',
];
// Adoption plan section 3.5: no non-null assertion outside tests. Stated here rather than as
// @typescript-eslint/no-non-null-assertion, whose fixed message names no alternative (section 3.4).
const NO_NON_NULL = [
  {
    selector: 'TSNonNullExpression',
    message:
      'Do not assert a value is not null or undefined with `!`. Handle the missing case: narrow with a check or a type guard (and throw or return when it fails), or change the type so the value cannot be missing. Tests may use `!`.',
  },
];

// Adoption plan sections 3.2 and 3.4: a cast to an inline object type reaches a member the
// declared type lacks and hides it from the type checker (CX-04). Matched anywhere in the cast's
// type (alone, in a union or intersection, `as { ... }[]`, `as Array<{ ... }>`), once for the
// outermost literal, as `as` or as an angle-bracket assertion, which .ts files may still use;
// the parser drops the parentheses of `as ({ ... })`. The cast expression itself is not searched,
// so `tx.query<{ ok: boolean }>(...)` stays allowed.
const INLINE_CAST_FILES = [
  'apps/*/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  // The player's service worker is shipped product code outside src (plan correction).
  'apps/player-web/sw/**/*.ts',
  // D25: scripts get the inline-cast ban too.
  'scripts/**/*.ts',
];
const NO_INLINE_CAST = [
  {
    selector: [
      ':matches(TSAsExpression, TSTypeAssertion) > TSTypeLiteral.typeAnnotation',
      ':matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeLiteral:not(TSTypeLiteral TSTypeLiteral)',
    ].join(', '),
    message:
      'Do not cast to an inline object type to reach a member the declared type lacks. Add it to the interface (as ObjectStorage.removeStaleTempFiles, CX-04) or narrow with a type guard: an `in` check (`typeof value === "object" && value !== null && "id" in value`), or, in apps/api, packages/db and scripts, errorField(error, name) for a field of a thrown value (from @tinnox/db; from ./error-field.ts inside packages/db).',
  },
];

// SEC-1, D4: the MigratorPool brand is the proof that connectMigrator checked the role, and the
// provisioning commands rely on it alone, so nothing but connectMigrator may mint one. Matched
// anywhere in the cast's type (`as MigratorPool | undefined`, `as Promise<MigratorPool>`), in
// every file, tests included (no test needs one: they connect through connectMigrator too).
// packages/db/src/migrate.ts, where connectMigrator makes it, has its own block below. Not seen,
// and left to review: a value typed `any` assigned to a MigratorPool variable (not a cast), a cast
// to an alias of the type (`import { type MigratorPool as MP }`, then `as MP`), and `as never`,
// which this repository's tests use every day and which fits any parameter.
const MIGRATOR_POOL =
  ":matches([typeName.name='MigratorPool'], [typeName.right.name='MigratorPool'])";
const NO_MIGRATOR_POOL_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${MIGRATOR_POOL}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${MIGRATOR_POOL}`,
    ].join(', '),
    message:
      'Do not cast to MigratorPool: the brand says connectMigrator checked that the connection logs in and acts as tinnox_migrator. Call connectMigrator(connectionString, { applicationName }) from @tinnox/db/migrate and pass the pool it returns.',
  },
];

// D2, CX-01 (adoption plan section 2.1 A), AG-2.1 (step 18): a transaction handle says it came
// from one of the openers of packages/db/src/tx.ts (readOrg, and the ones changeOrg and
// changePreOrg run on), so everything written on it commits or rolls back together, and which
// of the two it is says whether an organisation is set: an OrgTx takes a tenant statement, a
// PreOrgTx only the sec.* wrappers. The audit writers and those wrappers
// rely on that alone, so nothing may make one by a cast: in every file, tests included, and in
// packages/db too, where run() and asDefiner build them without one. Tx is either of the two,
// OrgReadTx the read-only form of an OrgTx that the callback of readOrg receives (a cast from it
// to OrgTx would hand a read-only handle to what writes), and DefinerTx the handle asDefiner
// gives its work. Matched like MigratorPool above, with the same
// three forms left to review (a value typed `any`, an alias of the type, `as never`), and the
// forms every brand rule but OrgId's leaves (CHK-2): a cast to a type derived from the brand
// (`as typeof tx`, an indexed access, ReturnType or Parameters), a generic identity helper given
// the brand as its type argument (`brand<OrgTx>(raw)`), and a constructor's type arguments.
const HANDLE = '/^(Tx|OrgTx|OrgReadTx|PreOrgTx|DefinerTx)$/';
const TX = `:matches([typeName.name=${HANDLE}], [typeName.right.name=${HANDLE}])`;
const NO_TX_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${TX}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${TX}`,
    ].join(', '),
    message:
      'Do not cast to a transaction handle (Tx, OrgTx, OrgReadTx, PreOrgTx, DefinerTx): the type says the handle is inside a transaction, so an audit row written on it commits with the change it records, and whether an organisation is set, so a tenant statement runs under row-level security. Use the tx that the callback of readOrg receives (an OrgReadTx) or of changeOrg (an OrgTx; an operator route calls changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts), or, before the organisation is known, the one the callback of changePreOrg receives (a PreOrgTx, for the sec.* wrappers) and the OrgTx its enterOrg returns, all from @tinnox/db. A test opens one with withOrg or inTx from @tinnox/db/testing. A refusal with no change to pair with is written with auditStandalone(ctx.db, event).',
  },
];
// OTH-12: a SqlFragment says the text was written in the source (sql`...`, sqlParameter, joinSql
// in packages/db/src/sql.ts), which is what lets tinnox/sql-fragments allow it inside a statement.
// A cast would let any string in. Matched like the two above, with the same forms left to
// review (the three, and those CHK-2 lists above NO_TX_CAST); packages/db/src/sql.ts, where the
// three makers are, has its own block below.
const SQL_FRAGMENT = ":matches([typeName.name='SqlFragment'], [typeName.right.name='SqlFragment'])";
const NO_SQL_FRAGMENT_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${SQL_FRAGMENT}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${SQL_FRAGMENT}`,
    ].join(', '),
    message:
      'Do not cast to SqlFragment: the type says the text was written in the source, so it may be put into a statement. Make one with sql`...`, sqlParameter(position) or joinSql(parts, separator) from @tinnox/db, and pass every value as a parameter ($1, $2).',
  },
];
// AG-2.3 (adoption plan step 18, D25): an OrgId says the database named the organisation (for a
// verified session, a device credential, a completed pairing, a media job, a confirmation link
// or the alert check's list), and readOrg, changeOrg and enterOrg take nothing else. So a
// string from a path, a query, a body or a header never becomes one, and nothing but
// packages/db/src/org-id.ts (its own block below) may say that a value is one. In every file,
// tests included: a test names its organisation with testOrgId from '@tinnox/db/testing', and
// scripts are in scope like the rest (D25). Reported:
//   - a cast, matched like MigratorPool above (`as OrgId`, `as unknown as OrgId`, `<OrgId>id`,
//     `as OrgId | null`, `as Promise<OrgId>`);
//   - a type predicate or an assertion signature (`value is OrgId`, `asserts value is OrgId`),
//     which says the same thing as a cast, for every caller;
//   - the type arguments of a call (`tx.query<{ org_id: OrgId }>(...)`, `z.custom<OrgId>()`,
//     `app.get<{ Params: { id: OrgId } }>(...)`): pg, zod and Fastify take such an argument on
//     trust, so it is a cast by another name. expectTypeOf and its matchers (vitest) are let
//     through: they only compare types.
//   - the annotated type of a query result (`const r: QueryResult<{ org_id: OrgId }> =
//     await tx.query(...)`, or destructured: `const { rows }: QueryResult<...>`), which fills in
//     the row type the rule above refuses (SEC-4).
// Not seen, and left to review: the three forms the MigratorPool rule leaves (a value typed
// `any`, which the no-unsafe-* rules of typescript-eslint report where it is used; an alias of
// the type; `as never`); a cast to a named type that contains an OrgId (`body as SessionLookup`);
// a cast to a type derived from one (`as typeof someOrg`, `as SessionLookup['orgId']`,
// `as Parameters<typeof readOrg>[1]`, `as ReturnType<...>`); a named row type given to query
// (`type Row = { org_id: OrgId }`, then `query<Row>`); a generic helper whose `as T` is inferred
// (`const id: OrgId = brand(value)`); the type arguments of a constructor (`new Box<OrgId>()`,
// left out on purpose: `new Map<OrgId, string[]>()` is a collection); a local function named
// like a matcher of expectTypeOf; and TypeScript's own unsound forms (an overload signature that
// returns OrgId over a body that returns a string, a string written into an OrgId[] through a
// string[] alias of it, or into an object through a wider property type). A selector cannot
// follow a named type to its declaration, and refusing OrgId in every interface would refuse the
// fields that rightly carry one (ServeObjectInput.orgId). AGENTS.md section 2 lists them for review. A
// cast to `import('@tinnox/db').OrgId` is refused by consistent-type-imports instead.
const ORG_ID = ":matches([typeName.name='OrgId'], [typeName.right.name='OrgId'])";
const TYPE_ONLY_CALL =
  ":matches([callee.name='expectTypeOf'], [callee.property.name=/^to(EqualTypeOf|MatchTypeOf|MatchObjectType|Extend)$/])";
const NO_ORG_ID_FORGERY = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${ORG_ID}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${ORG_ID}`,
      `TSTypePredicate TSTypeReference${ORG_ID}`,
      `CallExpression:not(${TYPE_ONLY_CALL}) > TSTypeParameterInstantiation TSTypeReference${ORG_ID}`,
      `VariableDeclarator > :matches(Identifier, ObjectPattern, ArrayPattern).id > TSTypeAnnotation TSTypeReference:matches([typeName.name='QueryResult'], [typeName.right.name='QueryResult']) TSTypeReference${ORG_ID}`,
    ].join(', '),
    message:
      'Do not make an OrgId here (AG-2.3): not by a cast, a type predicate, or a type argument of a call such as the row type of query(), nor by the annotated type of a query result (QueryResult<{ org_id: OrgId }>). The type says the database named the organisation. In the API it comes from operatorOf(request).orgId, the device credential (deviceByTokenHash) or another lookup of packages/db/src/sec.ts, never from the request; a lookup that is missing is added there. An offline tool that creates an organisation calls newOrgId(), and one that looks a member or an invite up reads its org_id through asDefiner (both from @tinnox/db/migrate). A test names its organisation with testOrgId(id) from @tinnox/db/testing.',
  },
];
// SCR-34 (adoption plan steps 19 and 20): a WritePermit says that what judged the caller issued
// it (for an operator the role guard, whose re-check of the member's role is the first statement
// of the change), and changeOrg of @tinnox/db runs no change without one. A cast would let a
// write past that check as far as the types go (changeOrg then refuses the value when it runs:
// it holds no terms). In every file, tests included, and in packages/db too, where
// issueWritePermit builds one without a cast. Matched like MigratorPool above, with the same
// forms left to review (the three, and those CHK-2 lists above NO_TX_CAST).
const WRITE_PERMIT = ":matches([typeName.name='WritePermit'], [typeName.right.name='WritePermit'])";
const NO_WRITE_PERMIT_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${WRITE_PERMIT}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${WRITE_PERMIT}`,
    ].join(', '),
    message:
      'Do not cast to WritePermit: the type says the role guard issued the permit, so the role is read again as the first statement of the change (SCR-34). An operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues the permit and gives it to changeOrg; a change with no operator behind it calls changeAsDevice (apps/api/src/auth/device.ts), changeAsJob (apps/api/src/jobs.ts) or changeOrgAsMigrator (@tinnox/db/migrate), which do the same for what judged it. A test issues one with issueWritePermit({ recheck, stated, statedIn }) from @tinnox/db.',
  },
];
// SCR-34 (adoption plan step 20): a VerifiedDevice says the device-credential check returned it
// (verifyDeviceCredential in apps/api/src/auth/device.ts), and changeAsDevice issues the permit
// of a player's change to nothing else. A cast would let a handler that resolved no credential
// change an organisation as far as the types go (changeAsDevice then refuses the value when it
// runs: it carries no mark). In every file, tests included. Matched like MigratorPool above,
// with the same forms left to review (the three, and those CHK-2 lists above NO_TX_CAST).
const VERIFIED_DEVICE =
  ":matches([typeName.name='VerifiedDevice'], [typeName.right.name='VerifiedDevice'])";
const NO_VERIFIED_DEVICE_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${VERIFIED_DEVICE}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${VERIFIED_DEVICE}`,
    ].join(', '),
    message:
      "Do not cast to VerifiedDevice: the type says the device-credential check accepted the credential of this request, and the permit of a player's change is issued to nothing else (SCR-34). Resolve the credential with verifyDeviceCredential(unscoped, tokenHash) from apps/api/src/auth/device.ts and pass the device it returns to changeAsDevice(ctx, request, device, fn); a test gets one the same way, from a pool that answers the lookup.",
  },
];
// SCR-34 (adoption plan step 20, review): an AuditStatement says it was read from the table that
// holds the statement of a route, a job or a command (STATEMENT_ISSUERS below), and changePreOrg
// and changeOrgAsMigrator hold a change to nothing else, as changeOrg holds one to its permit. A
// cast would hold a change to a statement its caller wrote (both refuse the value when they run:
// it carries no mark). In every file, tests included. Matched like MigratorPool above, with the
// same forms left to review (the three, and those CHK-2 lists above NO_TX_CAST).
const AUDIT_STATEMENT =
  ":matches([typeName.name='AuditStatement'], [typeName.right.name='AuditStatement'])";
const NO_AUDIT_STATEMENT_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${AUDIT_STATEMENT}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${AUDIT_STATEMENT}`,
    ].join(', '),
    message:
      'Do not cast to AuditStatement: the type says the statement was read from the table of its route, job or command, so the change is compared with what that table says it audits (SCR-34). A route outside the operator table passes routeStatement(request), a job jobStatement(name), a refusal refusalStatement(request, audit) (all apps/api/src/route-audit.ts), and a provisioning command provisionStatement(command) (scripts/lib/provision.ts). A test makes one with issueAuditStatement({ stated, statedIn }) from @tinnox/db.',
  },
];
// DEC-23 (adoption plan step 22): a PlannedPublication says a planner of @tinnox/domain accepted
// the draft, the route's capability check included, and createPublication (apps/api/src/
// publishing.ts) takes nothing else. markPlanned, its one maker, is off the package entry; a cast
// would forge one all the same. In every file, tests included; packages/domain/src/planned.ts,
// where markPlanned is, has its own block below. Matched like MigratorPool above, with the same
// forms left to review (the three, and those CHK-2 lists above NO_TX_CAST).
const PLANNED_PUBLICATION =
  ":matches([typeName.name='PlannedPublication'], [typeName.right.name='PlannedPublication'])";
const NO_PLANNED_PUBLICATION_CAST = [
  {
    selector: [
      `:matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation${PLANNED_PUBLICATION}`,
      `:matches(TSAsExpression, TSTypeAssertion) > .typeAnnotation TSTypeReference${PLANNED_PUBLICATION}`,
    ].join(', '),
    message:
      "Do not cast to PlannedPublication: the type says a planner accepted the draft, so the route's capability check ran (DEC-23). Pass the draft that planPublication, planSchedulePublication or planLayoutPublication from @tinnox/domain returned (in apps/api, the draft of planDraft or assessDisplays in apps/api/src/publishing.ts). A test of @tinnox/domain stands in for a planner with markPlanned from packages/domain/src/planned.ts.",
  },
];
// The types only packages/db (and, for PlannedPublication, packages/domain) may make.
const NO_BRAND_CAST = [
  ...NO_MIGRATOR_POOL_CAST,
  ...NO_TX_CAST,
  ...NO_SQL_FRAGMENT_CAST,
  ...NO_ORG_ID_FORGERY,
  ...NO_WRITE_PERMIT_CAST,
  ...NO_VERIFIED_DEVICE_CAST,
  ...NO_AUDIT_STATEMENT_CAST,
  ...NO_PLANNED_PUBLICATION_CAST,
];

// Adoption plan section 3.2: the API reads the time from one injected clock, so tests can set it.
// main.ts and alerts-once.ts create that clock and are outside this rule. `new Date(value)` is a
// conversion, not a clock read, and stays allowed.
const NO_CLOCK = [
  {
    selector: [
      "MemberExpression[object.name='Date'][property.name='now']",
      "NewExpression[callee.name='Date'][arguments.length=0]",
      "CallExpression[callee.name='Date']",
    ].join(', '),
    message:
      'Do not read the clock here: use the injected clock, ctx.now() (AppContext.now in apps/api/src/context.ts), or take a `now` option or parameter from the caller, as MediaPipelineOptions.now and runDisplayAlerts({ now }) do, so tests can set the time. Only main.ts and alerts-once.ts create the clock.',
  },
];

// D23, DEC-13: loadConfig's second argument stands in for REVIEWED_SMTP_HOSTS so the config tests
// need no real host on the list. Passed from product code, it would let production send mail
// through a host the provider review never saw, without the diff to the list that review gates.
// config.test.ts is a test file, outside the product blocks this joins. A renamed import is
// reported too, so the call cannot hide under another name.
const NO_LOADCONFIG_OPTIONS = [
  {
    selector: [
      "CallExpression[arguments.length>1]:matches([callee.name='loadConfig'], [callee.property.name='loadConfig'])",
      "ImportSpecifier[imported.name='loadConfig'][local.name!='loadConfig']",
    ].join(', '),
    message:
      'Call loadConfig(env) with the environment only, under its own name (D23): its second argument replaces REVIEWED_SMTP_HOSTS and is for apps/api/src/config.test.ts. To send mail through a new host, get its provider through the data-location review under DEC-13 and add the host to REVIEWED_SMTP_HOSTS in apps/api/src/config.ts.',
  },
];

/** Selectors for a string, template text or name in code that matches `regex` (selector syntax). */
const textMatching = (regex) =>
  [
    `Literal[value=${regex}]`,
    `TemplateElement[value.raw=${regex}]`,
    `Identifier[name=${regex}]`,
  ].join(', ');

/** Selectors for a string or template text that matches `regex` (selector syntax). */
const stringMatching = (regex) =>
  [`Literal[value=${regex}]`, `TemplateElement[value.raw=${regex}]`].join(', ');

// AG-2.2 (adoption plan sections 2.4 and 3.2): a sec.* function is called through its typed
// wrapper in packages/db/src/sec.ts and nowhere else, so each is named once, with the handle it
// needs (any handle for a lookup, a PreOrgTx or an OrgTx for a change) and what it returns.
// Matched in string and template text of product code and scripts; packages/db/src/sec.ts has
// its own block below.
// Tests are outside: they call the functions raw to test them. The schema may be quoted and
// spaced from the dot (`"sec" . session_revoke(`, CHK-10). Not seen: a name put together at run
// time ('sec.' + name).
const NO_RAW_SEC = [
  {
    selector: stringMatching('/\\b"?sec"?\\s*\\.\\s*"?[a-z_][a-z0-9_]*"?\\s*\\(/i'),
    message:
      'Call sec.* through a typed wrapper in packages/db/src/sec.ts (exported from @tinnox/db); add the wrapper if it is missing. It names the function once, types what it returns (an organisation as an OrgId) and says which handle it takes: any handle for a lookup (poolAsTx(ctx.db) or a tx), a PreOrgTx for a change before the organisation is known, an OrgTx for one that needs the organisation.',
  },
];

// D25: the database role is switched in one place, asDefiner in packages/db/src/definer.ts (the
// '@tinnox/db/migrate' entry), which has its own block below. Matched in string and template
// text that starts with the statement, or has it after a semicolon: SET ROLE, SET LOCAL ROLE,
// SET SESSION ROLE, RESET ROLE, the same for SESSION AUTHORIZATION, and set_config('role', ...).
// So a sentence that mentions the statement (the messages of scripts/lib/migrations-check.ts) and
// `UPDATE membership SET role = $2` pass. Only a string or the first text of a template starts a
// statement: the text after an interpolation (`UPDATE ${TABLE} SET role = $2`) continues one, so
// there the statement counts only after a semicolon. Tests are outside: they arrange data as the
// definer. The incident scripts under scripts/*.sql are SQL and are not linted. Not seen: the
// statement behind a SQL comment or inside a DO block, and text put together at run time.
const ROLE_STATEMENT =
  "\\s*(SET\\s+((LOCAL|SESSION)\\s+)?|RESET\\s+)(ROLE|SESSION\\s+AUTHORIZATION)\\b|\\bset_config\\s*\\(\\s*'(role|session_authorization)'";
const NO_ROLE_SWITCH = [
  {
    selector: [
      `Literal[value=/(^|;)${ROLE_STATEMENT}/i]`,
      `TemplateElement:first-child[value.raw=/(^|;)${ROLE_STATEMENT}/i]`,
      `TemplateElement:not(:first-child)[value.raw=/;${ROLE_STATEMENT}/i]`,
    ].join(', '),
    message:
      'Do not switch the database role here (D25): the only SET ROLE text is in asDefiner (packages/db/src/definer.ts, exported from @tinnox/db/migrate). An offline tool that holds a MigratorPool calls asDefiner(pool, tx, work) inside its transaction, and the switch ends with `work`. The API never switches role: it reads across organisations only through the typed sec.* wrappers of @tinnox/db.',
  },
];

// SEC-1 (group B review): run() in packages/db/src/tx.ts sets the organisation of a transaction
// once, from the OrgId its opener took, and begins and ends the transaction around its callback,
// so the audit rows commit with the change. tinnox_app may set any app.org_id, so the database
// cannot refuse text sent on the handle that sets it again or ends the transaction early
// (control matrix B4): this rule does, in API source and the offline tools; packages/db/src,
// where run() is, is outside. Matched where a statement starts, as NO_ROLE_SWITCH is:
//   - SET, SET LOCAL, SET SESSION or RESET of app.org_id, in any case and any quoting
//     (`"app.org_id"`, `"app".org_id`, `app . "org_id"`), and anywhere in the text
//     set_config('app.org_id' and an UPDATE of pg_settings that names 'app.org_id';
//   - a transaction-control statement written in capitals, as every statement of this repository
//     is (BEGIN, START TRANSACTION, COMMIT, END, ABORT, ROLLBACK, SAVEPOINT, RELEASE SAVEPOINT,
//     SET TRANSACTION, PREPARE TRANSACTION), and the same in any case where it is the first
//     argument of a call to query(). A bare word must stand alone (`'COMMIT'`, `'END;'`) or be
//     followed by one of its own keywords, so a sentence that starts with one and an event name
//     ('end', 'abort') pass. A string that is nothing but a bare word is not SQL until it is
//     sent, so outside query() it counts only as the value of a constant in capitals
//     (`const DONE = 'COMMIT'`), the form a statement is kept in; a literal type
//     (`type Phase = 'COMMIT' | 'ROLLBACK'`), a comparison or a lower-case variable passes.
// Tests are outside: they open and end transactions of their own to arrange data. Not seen: the
// name of the setting passed as a parameter (`set_config($1, $2, true)`), a lower-case statement
// kept in a variable, a bare word kept in a variable not named in capitals, the statement behind
// a SQL comment or inside a DO block, and text put together at run time. AGENTS.md section 2
// lists them for review.
const ORG_STATEMENT =
  '\\s*(SET\\s+((LOCAL|SESSION)\\s+)?|RESET\\s+)("app\\.org_id"|"?app"?\\s*\\.\\s*"?org_id\\b)|\\bset_config\\s*\\(\\s*\'app\\.org_id\'|\\bUPDATE\\s+("?pg_catalog"?\\s*\\.\\s*)?"?pg_settings\\b[\\s\\S]*\'app\\.org_id\'';
const TRANSACTION_STATEMENT =
  '\\s*(BEGIN(\\s*(;|$)|\\s+(WORK|TRANSACTION|READ|ISOLATION|NOT|DEFERRABLE)\\b)|START\\s+TRANSACTION\\b|(COMMIT|END|ABORT|ROLLBACK)(\\s*(;|$)|\\s+(WORK|TRANSACTION|AND|PREPARED|TO)\\b)|SAVEPOINT\\s+\\w|RELEASE\\s+SAVEPOINT\\b|SET\\s+(TRANSACTION|SESSION\\s+CHARACTERISTICS)\\b|PREPARE\\s+TRANSACTION\\b)';
/** The statement given to query(), as a node of `type`. */
const queryStatement = (type) =>
  `CallExpression[callee.property.name='query'] > ${type}.arguments:first-child`;
/** A whole string that is one transaction word and nothing else. */
const BARE_TRANSACTION_WORD = '/^\\s*(BEGIN|COMMIT|END|ABORT|ROLLBACK)\\s*;?\\s*$/';
/** A constant named in capitals, the form a statement is kept in. */
const CONSTANT = 'VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/]';
const NO_TRANSACTION_TEXT = [
  {
    selector: [
      `Literal[value=/(^|;)${ORG_STATEMENT}/i]`,
      `TemplateElement:first-child[value.raw=/(^|;)${ORG_STATEMENT}/i]`,
      `TemplateElement:not(:first-child)[value.raw=/;${ORG_STATEMENT}/i]`,
    ].join(', '),
    message:
      'Do not set app.org_id in SQL text (SEC-1): run() in packages/db/src/tx.ts sets the organisation of a transaction once, from the OrgId its opener took, and row-level security trusts it. Read with readOrg(ctx.db, orgId, fn) and change through changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), changeAsDevice, changeAsJob or changeOrgAsMigrator, each with the OrgId of a lookup of packages/db/src/sec.ts. Work in another organisation is a transaction of its own, opened after this one has returned.',
  },
  {
    selector: [
      `Literal:not(TSLiteralType > Literal)[value=/(^|;)${TRANSACTION_STATEMENT}/]:not([value=${BARE_TRANSACTION_WORD}])`,
      `${CONSTANT} > Literal.init[value=${BARE_TRANSACTION_WORD}]`,
      `TemplateElement:first-child[value.raw=/(^|;)${TRANSACTION_STATEMENT}/]:not([value.raw=${BARE_TRANSACTION_WORD}])`,
      `${CONSTANT} > TemplateLiteral.init > TemplateElement:first-child[value.raw=${BARE_TRANSACTION_WORD}]`,
      `TemplateElement:not(:first-child)[value.raw=/;${TRANSACTION_STATEMENT}/]`,
      `${queryStatement('Literal')}[value=/(^|;)${TRANSACTION_STATEMENT}/i]`,
      `${queryStatement('TemplateLiteral')} > TemplateElement:first-child[value.raw=/(^|;)${TRANSACTION_STATEMENT}/i]`,
    ].join(', '),
    message:
      'Do not begin, end or mark a transaction in SQL text (SEC-1): run() in packages/db/src/tx.ts begins the transaction before its callback and commits or rolls it back after, so the audit rows the change returns commit with it (AGENTS.md section 3). Return from the callback to commit, and throw to roll back. Work that must commit on its own is a transaction of its own (readOrg, changeAsOperator, changeAsDevice, changeAsJob, changeOrgAsMigrator), opened after this one has returned.',
  },
];

// EAX-06 (adoption plan step 22): a session-level advisory lock outlives the transactions that
// work under it, so losing its connection loses the lock while that work goes on. It is taken by
// withSessionLock in packages/db/src/session-lock.ts, which hands the work a signal that aborts
// when the connection is lost and never returns the connection to the pool still holding the
// lock. Matched in string and template text of product code and scripts, but packages/db/src,
// where the helper and the migration runner's own lock (on the connection that does the work)
// live: pg_advisory_lock, pg_try_advisory_lock, pg_advisory_unlock and their _shared forms, and
// pg_advisory_unlock_all. The transaction locks (pg_advisory_xact_lock) do not match: they end
// with their transaction. Tests are outside: they hold the lock as a second runner would. Not
// seen: a name put together at run time.
const NO_SESSION_LOCK = [
  {
    selector: stringMatching('/\\bpg_(try_)?advisory_(lock|unlock)(_shared|_all)?\\s*\\(/i'),
    message:
      'Take a session lock through withSessionLock, so work on other connections stops when the lock is lost (EAX-06): withSessionLock(ctx.db, name, (signal) => work) from @tinnox/db (packages/db/src/session-lock.ts) holds the lock on a connection of its own, aborts the signal when that connection is lost, and gives the lock back; add the name to its SessionLock type. A lock that only guards the statements of one transaction is pg_advisory_xact_lock in that transaction (withCountedLimit for a counted ceiling).',
  },
];

// Step 26 (adoption plan section 2.3): what a database error means is decided in one place,
// classifyDbError in packages/db/src/outcome.ts, so no API source reads a SQLSTATE code (the
// classes of integrity, transaction rollback, access, object state and operator intervention), in
// string or template text: a route names the registered constraint it maps in the constraints
// option of changeAsOperator, and the rest ask the classifier. The migration runner
// (packages/db/src/migrate.ts) is held to it too: its lock wait asks isLockTimeout. Tests are
// outside: they build the errors the classifier reads. A whole class tested by its prefix
// (`code.startsWith('23')`) is refused too (CHK-2 of the group C review). Not seen: a code put
// together at run time, kept in a constant of another package, written as a regular expression
// (`/^23505$/`) or with escapes in a template (`\x323505`).
const CONSTRAINT_READ =
  'Do not read the constraint of a database error in API source (step 26): add the constraint to CONSTRAINTS in packages/db/src/constraints.ts and map it in the constraints option of changeAsOperator(ctx, request, fn, { constraints: { name: () => error } }) (apps/api/src/auth/permissions.ts), which reads it through classifyDbError of @tinnox/db.';
const SQLSTATE_MESSAGE =
  'Do not read a SQLSTATE code here (step 26): classifyDbError(error) from @tinnox/db (packages/db/src/outcome.ts) says what a database error means. To answer a constraint violation, add the constraint to CONSTRAINTS in packages/db/src/constraints.ts and map it in the constraints option of changeAsOperator(ctx, request, fn, { constraints: { name: () => error } }) (apps/api/src/auth/permissions.ts). Otherwise ask the classifier: classifyDbError(error)?.kind (denied, transient, other), or isLockTimeout(classifyDbError(error)) for a lock wait past lock_timeout.';
const NO_SQLSTATE_LITERAL = [
  {
    selector: [
      stringMatching('/^(23|40|42|55|57)[0-9A-Z]{3}$/'),
      "CallExpression[callee.property.name='startsWith'][arguments.0.value=/^(23|40|42|55|57)$/]",
    ].join(', '),
    message: SQLSTATE_MESSAGE,
  },
];
// CHK-2 (group C review): the import ban on violatedConstraint (no-restricted-imports below) does
// not see the constraint read straight off the error, with errorField of @tinnox/db, a property
// read after an `in` check or a destructured key (`const { constraint } = error`). No API source
// reads a property named `constraint` today. API source only: the offline tools are not held to
// the registry (provisioning reads a constraint name).
const NO_CONSTRAINT_READ = [
  {
    selector: [
      "CallExpression[callee.name='errorField'][arguments.1.value='constraint']",
      "MemberExpression[computed=false][property.name='constraint']",
      "MemberExpression[property.value='constraint']",
      "BinaryExpression[operator='in'][left.value='constraint']",
      "ObjectPattern > Property:matches([key.name='constraint'], [key.value='constraint'])",
    ].join(', '),
    message: CONSTRAINT_READ,
  },
];

// Step 27 (adoption plan section 2.3, SCX-03): how a change ended is read in one place, settle()
// of packages/db/src/outcome.ts, which gives 'committed', 'rolled_back' or 'unknown', and
// switch-exhaustiveness-check fails a switch that leaves one out. So no file of the API, the
// offline tools or packages/db tests an error for CommitOutcomeUnknownError itself: a catch that
// does is where stored bytes were deleted, or could be mailed, for a transaction that may have
// committed. The one test of the class is unconfirmedCommit in packages/db/src/commit-outcome.ts
// (DB_ONE_PLACES). Tests are outside: they build the error and assert on it. Since CHK-3 of the
// group C review, the class may be imported only as a type, so it cannot be tested under another
// name (`import { CommitOutcomeUnknownError as E }`), and its name may not be written as a string,
// so `error.name === 'CommitOutcomeUnknownError'` is refused too; packages/db/src/index.ts passes
// it on with `export { ... } from`, which imports nothing into that file. A namespace or dynamic
// import of @tinnox/db, which would carry the class under another name, is refused in the API and
// the offline tools (CHK-6, NO_GATED_REEXPORT). Not seen: inside packages/db, the class taken
// from a namespace import of ./commit-outcome.ts into a variable (`const E = ns.CommitOutcome...`).
const NO_COMMIT_OUTCOME_TEST = [
  {
    selector: [
      "BinaryExpression[operator='instanceof']:matches([right.name='CommitOutcomeUnknownError'], [right.property.name='CommitOutcomeUnknownError'])",
      "ImportDeclaration:not([importKind='type']) > ImportSpecifier[imported.name='CommitOutcomeUnknownError']:not([importKind='type'])",
      "Literal[value='CommitOutcomeUnknownError']",
    ].join(', '),
    message:
      "Do not test for CommitOutcomeUnknownError (SCX-03, step 27). Wrap the change in settle() from @tinnox/db (packages/db/src/outcome.ts): `const ended = await settle(changeAsOperator(ctx, request, fn))`, then `switch (ended.end)` with all three cases. 'committed': use ended.value; only here send e-mail. 'rolled_back': only here delete files or stored objects, then throw ended.error. 'unknown': COMMIT did not confirm, so keep what the rows may own, send nothing, and throw ended.unconfirmed, which the API answers 500 commit_outcome_unknown (D9).",
  },
];
// The predicate is the same test under another name. It stays for the one caller that answers an
// unknown outcome and has nothing to undo, the API's error handler (D9); COMMIT_OUTCOME_ANSWERERS
// names it. packages/db is outside: the migration runner reports its own COMMIT with it. This
// rule goes beyond the plan's: D9 gave the handler the predicate so that it needs no exemption
// from the instanceof rule above, and it has none; without this rule any caller could ask the
// predicate in place of settle(), so the handler's excusal here is the one this step adds. The
// name is refused wherever it is taken (CHK-3 of the group C review): an import (aliased too), a
// re-export under another name, a property of a namespace or of a dynamic import, and a
// destructured key. Not seen: a computed key (`db['isCommitOutcomeUnknown']`).
const NO_COMMIT_OUTCOME_PREDICATE = [
  {
    selector: [
      "ImportSpecifier[imported.name='isCommitOutcomeUnknown']",
      "ExportSpecifier[local.name='isCommitOutcomeUnknown']",
      "MemberExpression[property.name='isCommitOutcomeUnknown']",
      "Property[key.name='isCommitOutcomeUnknown']",
    ].join(', '),
    message:
      "isCommitOutcomeUnknown is for the API's error handler (apps/api/src/errors.ts), which answers 500 commit_outcome_unknown and has nothing to undo (D9). A caller that does anything after its change (deletes stored bytes, sends e-mail, runs again) wraps the change in settle() from @tinnox/db (packages/db/src/outcome.ts) and switches on ended.end: 'committed', 'rolled_back' and 'unknown' (SCX-03, step 27). Only 'rolled_back' may delete files or stored objects; 'unknown' throws ended.unconfirmed.",
  },
];
// Step 27: a publish under an Idempotency-Key goes through changeOncePerKey of
// apps/api/src/publishing.ts, which takes the key lock, looks up what the key already made and
// runs again only after a known rollback. Its two steps stay exported for the handle-type test
// (apps/api/src/read-handles.test.ts), so the rest of the API may not import them and write that
// order, or a retry, by hand. publishing.ts declares them and imports neither, so nothing is
// excused; tests are outside. A namespace import is seen where it is used (`p.lockPublishKey`).
// Not seen: the same SQL written out, a computed or destructured name (`p['lockPublishKey']`,
// `const { lockPublishKey } = p`), and a route that maps publication_idempotency in the
// constraints option of changeAsOperator.
const NO_HAND_KEYED_PUBLISH = [
  {
    selector: [
      'ImportSpecifier[imported.name=/^(lockPublishKey|findPublicationByKey)$/]',
      'MemberExpression[property.name=/^(lockPublishKey|findPublicationByKey)$/]',
    ].join(', '),
    message:
      'Do not lock or look up an Idempotency-Key by hand (step 27). Publish through changeOncePerKey(ctx, request, { displayId, key, replay, publish }) from apps/api/src/publishing.ts: it takes the key lock, replays what the key already made, and runs once more only when the change is known to have rolled back.',
  },
];

// Step 28 (adoption plan section 2.2 item 4, D1, D20): a 403 is built only in apps/api/src/auth/,
// so no route answers 403 after its own lookup. Row-level security hides another organisation's
// row, so a route answers "no row" with found() or notFound() (apps/api/src/errors.ts), and the
// 403s are named constructors of three files (API_403_BUILDERS): the role guard's (forbidden,
// before the handler runs) and assertStillAllowed's (PermissionDeniedError, after reading only the
// caller's own member row) in auth/permissions.ts, the origin and CSRF checks in auth/session.ts
// and the player protocol's three in auth/player-refusals.ts. NO_API_403 is in the API's list, so
// every other API file, not only the routes, is refused (D1). HttpError takes its status from its
// code (STATUS_OF of @tinnox/contracts), so the codes this refuses are read from that table, not
// written here: a new 403 code is refused here once it is added there. Since CHK-1 of the group C
// review it also sees the code under `as` or `satisfies` and an error object given
// `statusCode: 403`, which the error handler would answer as `forbidden`; NO_HTTP_ERROR_ALIAS
// refuses HttpError imported or re-exported under another name, and a subclass of it with no
// constructor of its own, whose calls pass the code to no super() it can read. And NO_REPLY_ERROR_STATUS (SEC-5) refuses an error status set on the reply
// itself, in every API file: an answer sent that way bypasses HttpError, so nothing ties its
// status to its code.
// The role refusals may not be imported into an API file outside apps/api/src/auth/ either
// (NO_ROUTE_REFUSAL, in the API's list since SEC-2 of the group C review), so neither a route nor
// a module it calls (tags.ts) can refuse by role after its own lookup; ROUTE_REFUSAL_IMPORTERS
// names the two route files that may, and why. That ban is written as selectors here, not in
// no-restricted-imports as the plan has it: that rule's lists are built per combination of facets
// (importBoundaryBlocks), where an allow-list by file would double the API's blocks; the selectors
// also see a re-export. A namespace import, an `export *` or a dynamic import of
// auth/permissions.ts (any extension spelling, CHK-5) is refused outright, since a name taken from
// it is not seen. The cross-organisation conformance test (tests/integration/cross-org.test.ts,
// step 23) holds that another organisation's id answers exactly like a never-issued id, so no 403
// or other answer depends on a row the caller cannot see. Whether a 403 of auth/ is decided before
// the lookup of the caller's own row it cannot tell, since neither of its ids finds a row: that
// stays a review question (AGENTS.md section 2, D1). Not seen: a code held in a variable or chosen
// by a condition (`new HttpError(code, ...)`), also when a subclass's constructor passes it on to
// super(code, ...), HttpError reached through a namespace
// (`new errors.HttpError(...)`), held in a variable (`const E = HttpError`) or built with
// Reflect.construct, and a refusal built in auth/ under another name and imported elsewhere.
const { STATUS_OF } = await import('./packages/contracts/src/errors.ts');
const CODES_WITH_STATUS_403 = Object.keys(STATUS_OF).filter((code) => STATUS_OF[code] === 403);
const API_403_BUILDERS = [
  'apps/api/src/auth/permissions.ts',
  'apps/api/src/auth/session.ts',
  'apps/api/src/auth/player-refusals.ts',
];
const ROLE_REFUSALS = ['forbidden', 'requirePermission', 'PermissionDeniedError'];
const CODE_403 = `/^(${CODES_WITH_STATUS_403.join('|')})$/`;
// The first argument as a string literal or as a template literal with no substitution, bare or
// under `as` or `satisfies` (`'forbidden' as const`).
const CODE_403_ARGUMENT = `:matches([arguments.0.value=${CODE_403}], [arguments.0.quasis.0.value.cooked=${CODE_403}][arguments.0.expressions.length=0], [arguments.0.type=/^TS(As|Satisfies)Expression$/][arguments.0.expression.value=${CODE_403}])`;
const API_403_MESSAGE = `Only apps/api/src/auth/ builds a 403 (step 28, D1): a row of another organisation is invisible, so answer a missing row with found(row, 'The thing') or notFound('The thing') from apps/api/src/errors.ts. The codes with status 403 (${CODES_WITH_STATUS_403.join(', ')}; STATUS_OF in packages/contracts/src/errors.ts) are built by named constructors decided before any lookup: the role guard (auth/permissions.ts), the origin and CSRF checks (auth/session.ts) and the player protocol's refusals (auth/player-refusals.ts). A new refusal of that kind is a named constructor in apps/api/src/auth/, its file in API_403_BUILDERS in eslint.config.js.`;
const NO_API_403 = [
  {
    selector: [
      `NewExpression[callee.name='HttpError']${CODE_403_ARGUMENT}`,
      `:matches(ClassDeclaration, ClassExpression)[superClass.name='HttpError'] CallExpression[callee.type='Super']${CODE_403_ARGUMENT}`,
      "Property[key.name='statusCode'][value.value=403]",
    ].join(', '),
    message: API_403_MESSAGE,
  },
];
// Not excused for API_403_BUILDERS: no API file needs HttpError under another name, nor a
// subclass of it with no constructor, which is HttpError under another name too. A default
// export of it (`export default HttpError`) is the same dodge, since the importer names it, so it
// is refused too; with it refused, `import X from` or `import { default as X }` cannot reach
// HttpError.
const NO_HTTP_ERROR_ALIAS = [
  {
    selector:
      ":matches(ClassDeclaration, ClassExpression)[superClass.name='HttpError']:not(:has(MethodDefinition[kind='constructor']))",
    message: `Give a subclass of HttpError a constructor that calls super(code, message) (step 28, D1), so the lint can read its code; RefusedConflict in apps/api/src/routes/members.ts is one. ${API_403_MESSAGE}`,
  },
  {
    selector: [
      "ImportSpecifier[imported.name='HttpError']:not([local.name='HttpError'])",
      "ExportSpecifier[local.name='HttpError']:not([exported.name='HttpError'])",
      "ExportDefaultDeclaration[declaration.name='HttpError']",
    ].join(', '),
    message: `Import and re-export HttpError under its own name (step 28, D1): import { HttpError } from '../errors.ts', so the lint can read the code of each new HttpError(code, message) and see that none has status 403. ${API_403_MESSAGE}`,
  },
];
// The status as a number, bare or under `as` or `satisfies`, given to code() or status() or
// assigned to statusCode. Not seen: a status held in a variable or chosen by a condition
// (`reply.code(ok ? 200 : 403)`), the form errors.ts's own send() and the readiness route
// (routes/ops.ts) need.
const NO_REPLY_ERROR_STATUS = [
  {
    selector: [
      'CallExpression[callee.property.name=/^(code|status)$/]:matches([arguments.0.value>=400], [arguments.0.expression.value>=400])',
      "AssignmentExpression[left.property.name='statusCode']:matches([right.value>=400], [right.expression.value>=400])",
    ].join(', '),
    message:
      "Do not set an error status on the reply (SEC-5 of the group C review): throw new HttpError(code, message) from apps/api/src/errors.ts, or found(row, 'The thing') or notFound('The thing') for a missing row. HttpError takes its status from the code (STATUS_OF in packages/contracts/src/errors.ts), and the error handler sends the envelope; a status set by code(), status() or statusCode is checked against no code.",
  },
];
/** The step 28 import ban of an API file that may import the role refusals in `allowed`. */
function noRouteRefusal(allowed = []) {
  const banned = ROLE_REFUSALS.filter((name) => !allowed.includes(name));
  const name = `/^(${banned.join('|')})$/`;
  // Any extension spelling: NodeNext resolves '../auth/permissions.js' to the .ts file (CHK-5).
  const permissions = '/auth.permissions(\\.[cm]?[jt]s)?$/';
  return [
    {
      selector: [
        `ImportSpecifier[imported.name=${name}]`,
        `ExportSpecifier[local.name=${name}]`,
      ].join(', '),
      message: `An API file outside apps/api/src/auth/ does not refuse by role itself (step 28, D20): ${banned.join(', ')} of apps/api/src/auth/permissions.ts are for the role guard, which decides from ROUTE_PERMISSIONS before the handler runs. Give the route the keys it needs in its ROUTE_PERMISSIONS row (all(...) for keys it needs together); changeAsOperator(ctx, request, fn) checks them again inside the write. A refusal decided after the target is read is allowed only for the people routes' rank, self and grant rules (docs/portal-v2/stage-c.md section 1.6), in routes/members.ts; routes/audit.ts keeps its unreachable unknown-role check: ROUTE_REFUSAL_IMPORTERS in eslint.config.js.`,
    },
    {
      selector: [
        `ImportDeclaration[source.value=${permissions}] > ImportNamespaceSpecifier`,
        `ExportAllDeclaration[source.value=${permissions}]`,
        `ImportExpression[source.value=${permissions}]`,
      ].join(', '),
      message: `An API file outside apps/api/src/auth/ imports apps/api/src/auth/permissions.ts by name (step 28, D20): import { changeAsOperator, ... } from '../auth/permissions.ts', so the lint can see that none of the names is a role refusal (${ROLE_REFUSALS.join(', ')}), which only the role guard uses. A route gets the keys it needs from its ROUTE_PERMISSIONS row.`,
    },
  ];
}
const NO_ROUTE_REFUSAL = noRouteRefusal();
/** Whether `file` is in apps/api/src/auth/, where the role refusals live and may be imported. */
const inAuth = (file) => file.startsWith('apps/api/src/auth/');
// The route files that may import a role refusal, which one, and why (step 28, section 2.2 item 4).
const ROUTE_REFUSAL_IMPORTERS = {
  // The people routes' rank, self and grant rules are the one 403 allowed after a lookup
  // (docs/portal-v2/stage-c.md section 1.6, D20). refused() builds it as a PermissionDeniedError,
  // which carries the audit row's record. The target is read under row-level security first, so
  // another organisation's id still answers 404 (tests/integration/cross-org.test.ts).
  'apps/api/src/routes/members.ts': ['PermissionDeniedError'],
  // GET /api/audit refuses a session whose role it cannot read. Unreachable: the role guard has
  // already refused an unknown role, before the handler (auth/permissions.ts, permissionGuard).
  'apps/api/src/routes/audit.ts': ['forbidden'],
};

// The API files that may ask the predicate, and why.
const COMMIT_OUTCOME_ANSWERERS = [
  // The error handler: the last reader of every error of a request. It answers a COMMIT that did
  // not confirm with 500 commit_outcome_unknown (GET and HEAD: internal_error) and undoes nothing
  // (D9, adoption plan step 24).
  'apps/api/src/errors.ts',
];

// EAX-08: a security exemption is decided on an address, never on a name. A loopback name or
// literal, in any case, is refused where API code compares a host with it: an equality test, a
// switch case, a list or Set to look it up in, and the argument of endsWith, startsWith or
// includes (`.localhost`, `127.`), which is how the old isLoopbackHost of config.ts was written,
// and, since CHK-5, a constant that holds one (`const LOCAL = 'localhost'`), an object key to look
// a host up by (`{ localhost: true }`) and a regular expression that names one
// (`/^(localhost|127\.0\.0\.1)$/i`). Only the files in LOOPBACK_NAME_ALLOWED may. Not seen: a
// prefix compared by equality (`host.slice(0, 4) === '127.'`) and text put together at run time.
const LOOPBACK_TEXT = '/^(localhost|127\\.0\\.0\\.1|\\[?::1\\]?)$/i';
const LOOPBACK_AFFIX = '/^(\\.?localhost|127\\.(0\\.0\\.1)?|\\[?::1\\]?)$/i';
const NO_LOOPBACK_NAME = [
  {
    selector: [
      `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=${LOOPBACK_TEXT}]`,
      `BinaryExpression[operator=/^[!=]==?$/] > TemplateLiteral > TemplateElement[value.raw=${LOOPBACK_TEXT}]`,
      `SwitchCase > Literal.test[value=${LOOPBACK_TEXT}]`,
      `SwitchCase > TemplateLiteral.test > TemplateElement[value.raw=${LOOPBACK_TEXT}]`,
      `ArrayExpression > Literal[value=${LOOPBACK_TEXT}]`,
      `ArrayExpression > TemplateLiteral > TemplateElement[value.raw=${LOOPBACK_TEXT}]`,
      `CallExpression[callee.property.name=/^(endsWith|startsWith|includes)$/] > Literal.arguments[value=${LOOPBACK_AFFIX}]`,
      `CallExpression[callee.property.name=/^(endsWith|startsWith|includes)$/] > TemplateLiteral.arguments > TemplateElement[value.raw=${LOOPBACK_AFFIX}]`,
      `VariableDeclarator > Literal.init[value=${LOOPBACK_TEXT}]`,
      `VariableDeclarator > TemplateLiteral.init > TemplateElement[value.raw=${LOOPBACK_TEXT}]`,
      `Property > Literal.key[value=${LOOPBACK_TEXT}]`,
      `Property > Identifier.key[name=/^localhost$/i]`,
      `Literal[regex.pattern=/localhost|127\\\\?\\.0|::1/i]`,
    ].join(', '),
    message:
      "Use isLoopbackAddress from '@tinnox/contracts': a name is loopback only once it is resolved, and the one rule for an address is shared with the end-to-end stack (EAX-08). Only the files in LOOPBACK_NAME_ALLOWED of eslint.config.js (apps/api/src/config.ts, for the development origins and issuer on 'localhost') may compare a host with a loopback name.",
  },
];

// EAX-08: the API files that may compare a host with a loopback name, and why.
const LOOPBACK_NAME_ALLOWED = [
  // isLoopback accepts the development name `localhost` for an http origin and issuer
  // (.env.example), beside isLoopbackAddress; it refuses *.localhost.
  'apps/api/src/config.ts',
];

// AG-1.9, AG-1.17 (D5): product code never names the migrator, superuser or provisioning
// credentials. The one override is CREDENTIAL_NAME_REFUSERS below.
const NO_CREDENTIAL_NAMES = [
  {
    selector: textMatching(
      '/MIGRATOR_URL|MIGRATOR_PASSWORD|POSTGRES_SUPERUSER|PROVISION_IDP_CLIENT_SECRET/',
    ),
    message:
      'Product code never names the migrator, superuser or provisioning credentials (AG-1.9, AG-1.17): they must never reach the API, the media worker or the player. Use AppConfig.databaseUrl, which connects as tinnox_app; offline tools connect as tinnox_migrator through connectMigrator (@tinnox/db/migrate) in scripts/.',
  },
];

// D5: the files that may spell those names, and why. A file joins only to refuse a name, never to
// read its value.
const CREDENTIAL_NAME_REFUSERS = [
  // loadConfig refuses, in every mode, an environment that holds an administrator credential, and
  // its message must say which name it found (isAdministratorName). It reads no value of one: the
  // configuration is built from RUNTIME_ENV_NAMES only.
  'apps/api/src/config.ts',
];

// D4: the migrator URL is read only by the offline tools that connect as tinnox_migrator. Test
// files are outside the rule, as in apps and packages: the integration setup
// (scripts/vitest-integration-setup.ts) resets the test database with it.
const MIGRATOR_URL_READERS = [
  // The migration runner's command (runMigrations, through connectMigrator).
  'scripts/migrate.ts',
  // The development seed (connectMigrator).
  'scripts/seed.ts',
  // TINNOX's provisioning script, run from a controlled host (connectMigrator).
  'scripts/provision-member.ts',
  // Writes the generated migrator URLs and passwords into the root .env; connects to nothing.
  'scripts/setup-dev.mjs',
];
const NO_MIGRATOR_URL = [
  {
    selector: textMatching('/MIGRATOR_URL/'),
    message:
      'Only the offline tools in MIGRATOR_URL_READERS of eslint.config.js read the migrator URL (D4): the runner, the seed, provisioning and setup-dev. A new tool that must connect as tinnox_migrator calls connectMigrator from @tinnox/db/migrate and is added to that list with its reason.',
  },
];

// AG-2.3: the organisation comes from the verified session or the device credential, never from
// the request. Reports a read of an organisation-id key off a request part (request.body.orgId,
// request.headers['x-org-id'], const { orgId } = request.params), a request schema written in
// the API with such a key (the contracts test in packages/contracts covers the shared schemas),
// and a route's Body, Params, Querystring or Headers type with one. It reads names only, so a
// value copied out of the request first (const input = request.body; input.orgId), a cast, a
// destructured handler parameter and an API-local schema built with .extend or .merge are not
// seen (LINT-6). The OrgId type holds those (adoption plan step 18): whatever the value is
// called and however it left the request, it is a string, and readOrg and changeOrg take an OrgId
// (apps/api/src/org-from-request.test.ts). This selector stays as the earlier and plainer
// message for the direct forms.
const ORG_KEY = '/^(x-)?org(ani[sz]ation)?[-_]?id$/i';
const REQUEST_PART = '/^(body|params|query|headers|cookies)$/';
const NO_ORG_FROM_REQUEST = [
  {
    selector: [
      `MemberExpression[object.property.name=${REQUEST_PART}]:matches([property.name=${ORG_KEY}], [property.value=${ORG_KEY}])`,
      `VariableDeclarator[init.property.name=${REQUEST_PART}] > ObjectPattern > Property:matches([key.name=${ORG_KEY}], [key.value=${ORG_KEY}])`,
      `CallExpression[callee.object.name='z'] > ObjectExpression > Property:matches([key.name=${ORG_KEY}], [key.value=${ORG_KEY}])`,
      `TSPropertySignature[key.name=/^(Body|Params|Querystring|Headers)$/] TSPropertySignature:matches([key.name=${ORG_KEY}], [key.value=${ORG_KEY}])`,
    ].join(', '),
    message:
      'The organisation comes from operatorOf(request).orgId or the device credential, never from the request (AG-2.3). Drop the field from the request and use the verified session or device.',
  },
];

// P2-04, DEC-33, SCR-17: words a person reads in the portal. Matched in JSX text; in a string or
// template written straight into an element or a fragment (`{'...'}`, <>{'...'}</>); in a string
// that is a branch of a conditional or the right side of && or || written there, up to three
// conditionals deep (`{a ? '...' : b ? '...' : '...'}`), never a string in a comparison such as
// `{status === 'offline' ? ... : ...}`; and in the same forms in the attributes that are read out
// or shown: the aria attributes that hold text, title, alt, placeholder, the text props of the
// portal's own components named in SHOWN_ATTRIBUTE (label, description, heading, hint, summary,
// message, note, lead, caption, legend, a Tooltip's content, a Field's error, a row's meta), and
// any prop named ...Label, ...Title, ...Hint, ...Text, ...Message or ...Description. Not seen: text
// built in a plain .ts module (the lib/*.test.ts suites check those strings), a template inside a
// conditional, text passed through a variable or a function (a .map callback included), and any
// other attribute (ids in aria-labelledby, class names, test ids), so `display` stays free as a
// CSS property and a domain name in code. A component prop outside the list that the component
// reads out is not seen either: Avatar's `name` becomes its aria-label when `labelled` is set.
const SHOWN_ATTRIBUTE =
  '/^(aria-(label|description|roledescription|valuetext|placeholder)|title|alt|placeholder|label|description|heading|hint|summary|message|note|lead|caption|legend|content|error|meta|[a-z]+(Label|Title|Hint|Text|Message|Description))$/';
// A conditional or logical expression, and the positions in one that hold a value a person reads.
const BRANCHING = ':matches(ConditionalExpression, LogicalExpression)';
const BRANCH = ':matches(.consequent, .alternate, .right)';
/** Selectors for portal text a person reads that matches `regex`. */
const shownText = (regex) => {
  // Child combinators only, so a string inside a nested call, element or comparison is not taken.
  const inContainer = (container) => [
    `${container} > Literal[value=${regex}]`,
    `${container} > TemplateLiteral > TemplateElement[value.raw=${regex}]`,
    `${container} > ${BRANCHING} > Literal[value=${regex}]`,
    `${container} > ${BRANCHING} > ${BRANCHING}${BRANCH} > Literal${BRANCH}[value=${regex}]`,
    `${container} > ${BRANCHING} > ${BRANCHING}${BRANCH} > ${BRANCHING}${BRANCH} > Literal${BRANCH}[value=${regex}]`,
  ];
  return [
    `JSXText[value=${regex}]`,
    ...inContainer(':matches(JSXElement, JSXFragment) > JSXExpressionContainer'),
    `JSXAttribute[name.name=${SHOWN_ATTRIBUTE}] > Literal[value=${regex}]`,
    ...inContainer(`JSXAttribute[name.name=${SHOWN_ATTRIBUTE}] > JSXExpressionContainer`),
  ].join(', ');
};
const STATUS_WORDING = [
  {
    selector: shownText('/\\b(online|offline)\\b/i'),
    message:
      'Status wording stays honest (P2-04): never call a screen online or offline; say what the player last reported, with the summaries in apps/portal/src/lib/screenStatus.ts.',
  },
  {
    selector: shownText('/\\bdisplays?\\b/i'),
    message:
      'Operators see the word screen (DEC-33): write "screen" in portal text. The code, API and database keep display.',
  },
  {
    selector: shownText('/\\boperators?\\b/i'),
    message:
      'Customer-facing text does not say operator (SCR-17): say what set it ("Set in TINNOX CMS") or name the person or role.',
  },
];

// LYX-04: a list key taken from display text. Screen and playlist names are not unique; React
// warns about siblings with equal keys and, when the list updates, can show a row twice or drop
// one. Matched when the key is one of these names written bare (`key={name}`), as section 3.2 of
// the adoption plan specifies; a member such as `key={row.name}` is not seen.
const NO_TEXT_KEYS = [
  {
    selector:
      "JSXAttribute[name.name='key'] > JSXExpressionContainer > Identifier[name=/^(name|line|label|title|message|text)$/]",
    message:
      'Key a list by the row id, or by index for plain strings from the API. Screen and playlist names are not unique and React drops rows with equal keys (LYX-04).',
  },
];

// SCR-16: a bare userEvent.keyboard() first looks the test frame up by name, which can still be
// the previous file's frame as it goes away ("Frame was detached").
const NO_BARE_KEYBOARD = [
  {
    selector: "CallExpression[callee.object.name='userEvent'][callee.property.name='keyboard']",
    message:
      'Type into the element: userEvent.type(locator, text) (keys such as {Enter} included). A bare userEvent.keyboard() looks the test frame up by name first and fails now and then with "Frame was detached" (SCR-16).',
  },
];

/** The integration mock ban, with `instead` saying how the file group injects a fault. */
const noModuleMock = (instead) =>
  ['mock', 'doMock', 'importMock', 'stubGlobal'].map((property) => ({
    object: 'vi',
    property,
    message: `Integration and e2e tests use real services (OTH-13, tests/README.md). ${instead}`,
  }));
const NO_MODULE_MOCK = noModuleMock(
  'Inject a fault through startTestApp(..., { wrapPool }) with losingCommitAnswers or statementHolds, or the mail option, in apps/api/test/support.ts, instead of replacing a module or a global.',
);
// packages/db may not import the API's harness (the layer table), so its tests are pointed at
// their own helpers.
const NO_MODULE_MOCK_DB = noModuleMock(
  'Wrap or replace the pool you pass to the function under test, or hold a lock with the helpers in packages/db/test/support.ts (stillWaiting, twoTransactions, asSuperuser), instead of replacing a module or a global.',
);

/** Files that match a glob of `outer` and a glob of `inner` (an inner array means "all of"). */
const both = (outer, inner) => outer.flatMap((o) => inner.map((i) => [o, i]));

// Import boundaries (adoption plan section 3.1, step 7). One row per workspace of the root
// package.json, plus scripts: the @tinnox packages its files may import. It records the real
// graph; scripts/lib/import-boundaries-lint.test.ts fails when a workspace has no row, and
// scripts/lib/workspace-deps.test.ts when an import is not declared in the workspace's
// package.json (the root package.json for scripts). No package imports an app, and no app
// imports another app. An entry made with typesOnly() opens the package for `import type` alone.
/** A row entry for a package the workspace takes types from and never a value. */
const typesOnly = (name) => ({ typesOnly: name });
export const IMPORT_LAYERS = {
  'packages/contracts': [],
  'packages/storage': [],
  // D19: AuditInput is typed by the AuditAction union and the event shapes of
  // packages/contracts/src/audit.ts, their one source. Types only, so nothing of contracts, zod
  // included, loads with the database package; its package.json still lists @tinnox/contracts
  // under dependencies, because the manifest test counts a type-only import in a runtime file.
  'packages/db': [typesOnly('contracts')],
  'packages/domain': ['contracts'],
  'packages/app-render': ['contracts'],
  'packages/delivery': ['contracts', 'domain'],
  'apps/api': ['contracts', 'db', 'storage', 'domain', 'delivery'],
  'apps/media-worker': ['contracts'],
  'apps/portal': ['contracts', 'domain', 'app-render'],
  'apps/player-web': ['contracts', 'domain', 'app-render'],
  // The API's test harness is the one app entry anything may import (apps/api/package.json).
  tests: ['contracts', 'db', 'domain', 'app-render', 'api/test-support'],
  scripts: ['contracts', 'db', 'domain'],
};

// The entries of @tinnox/db beside its root (the "exports" of packages/db/package.json), and what
// may not import each (adoption plan step 15). The root entry is the runtime API, and a workspace
// whose row above names `db` may import it. scripts/lib/db-access-lint.test.ts fails when this
// table and the package's exports differ, and packages/db/src/entries.test.ts when the root entry
// reaches a module of another entry.
export const DB_ENTRIES = {
  // AG-1.10, D4: connectMigrator, MigratorPool, runMigrations, resetTestDatabase and asDefiner.
  // The API holds the tinnox_app connection only, so nothing in an app's source may import what
  // works on the migrator's. Scripts and tests may.
  migrate: {
    refusedIn: (dir) => dir.startsWith('apps/'),
    message:
      '@tinnox/db/migrate is for the offline tools that connect as tinnox_migrator: the migration runner, the seed and provisioning under scripts/, and tests (AG-1.10). The API holds only the tinnox_app connection, as the Database of createDatabase (AppContext.db): use readOrg, changeOrg (through changeAsOperator in apps/api/src/auth/permissions.ts) and the typed sec.* wrappers from @tinnox/db. Work that needs the migrator is a script under scripts/, run from a controlled host.',
  },
  // What only tests may use: refused in every file that is not a test.
  testing: {
    refusedIn: () => true,
    message:
      '@tinnox/db/testing is for test files only. Outside a test, open the transaction with readOrg or changeOrg from @tinnox/db (an operator route calls changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts), or with changePreOrg while a credential is still being resolved to its organisation (the files of PRE_ORG_CHANGE_FILES in eslint.config.js).',
  },
};

/** The packages a workspace may import values from, and the ones it takes types from only. */
const valueLayers = (dir) => IMPORT_LAYERS[dir].filter((entry) => typeof entry === 'string');
const typeOnlyLayers = (dir) =>
  IMPORT_LAYERS[dir].flatMap((entry) => (typeof entry === 'string' ? [] : [entry.typesOnly]));

/** The entry bans of DB_ENTRIES for the non-test files of the workspace `dir`. */
function dbEntryPatterns(dir) {
  // A workspace that may not import @tinnox/db at all is told so by its layer row.
  if (!IMPORT_LAYERS[dir].includes('db')) return [];
  return Object.entries(DB_ENTRIES)
    .filter(([, entry]) => entry.refusedIn(dir))
    .map(([name, entry]) => ({ regex: `^@tinnox/db/${name}(/|$)`, message: entry.message }));
}

// AG-2.2: poolAsTx runs with no organisation, so row-level security shows a tenant read nothing
// and nobody notices. It is for sec.* calls only, and only these files may import it, each with
// its reason. The same files hold the sec.* wrappers that read or change every organisation
// (CROSS_ORG_WRAPPERS below, SEC-2): they take any handle, a transaction an operator route
// already holds included, so the import is what keeps them to these files. Three of the reasons are not "before the organisation is known",
// which is what the list was first written for: the list records what each file really does. A file
// leaves the list when its use is gone. The handle of poolAsTx has a query, which
// tinnox/no-query-off-transaction refuses in these files. withoutOrg, which ran with no
// organisation too, is no longer exported by @tinnox/db since step 20 (tinnox/no-legacy-transaction
// refuses the name everywhere in these workspaces). Test files are outside the rule. Not seen: the
// name taken from a dynamic import (`const { poolAsTx } = await import('@tinnox/db')`).
export const UNSCOPED_HELPER_FILES = {
  'apps/api/src/auth/session.ts':
    'before the organisation is known: poolAsTx for sessionByIdHash, which resolves the session cookie to its member and organisation',
  'apps/api/src/routes/auth.ts':
    'before the organisation is known: poolAsTx for the one-time login state of a sign-in (loginStatePut, loginStateTake), kept before any member is identified',
  'apps/api/src/routes/player.ts':
    'before the organisation is known: poolAsTx for verifyDeviceCredential (apps/api/src/auth/device.ts) and deviceByRegistrationId, which resolve a device credential or a signed media URL to its organisation',
  'apps/api/src/alerts.ts':
    'not before the organisation is known, but across all of them: poolAsTx for displayAlertOrgs, the list of organisations the alert check then enters one by one with changeAsJob and readOrg',
  'apps/api/src/housekeeping.ts':
    'not before the organisation is known, but across all of them: poolAsTx for the purges of expired sessions, old pairing sessions and heartbeat history (sessionPurgeExpired, pairingPurge, heartbeatLogPurge)',
  'apps/api/src/media/pipeline.ts':
    'not before the organisation is known, but across all of them: poolAsTx for mediaProcessingJobs, the queue of media waiting for validation; each job is then handled inside readOrg and changeAsJob',
};
const UNSCOPED_HELPERS = ['poolAsTx'];
// SEC-2 (group B review): the wrappers of packages/db/src/sec.ts that work across organisations.
// displayAlertOrgs and mediaProcessingJobs name an OrgId for every organisation, and
// deviceByRegistrationId one for a registration id that is no secret, so readOrg would take
// any of them from a route; the three purges delete in every organisation with no audit row;
// membershipByOidcSub reads a member of any organisation by a subject the caller chose. A lookup
// by the hash of a secret (sessionByIdHash, deviceByTokenHash, alertRecipientByTokenHash) proves
// the caller holds that secret, and stays open to every file.
const CROSS_ORG_WRAPPERS = [
  'displayAlertOrgs',
  'mediaProcessingJobs',
  'deviceByRegistrationId',
  'sessionPurgeExpired',
  'pairingPurge',
  'heartbeatLogPurge',
  'membershipByOidcSub',
];

// SCR-34 (adoption plan steps 19 and 20): changeOrg of @tinnox/db runs no change without a
// WritePermit, and issueWritePermit makes one from any re-check and any statement, so only what
// judges the caller of a change may import it. One file per kind of caller, each with its
// reason: every one issues its permit inside a function that takes the proof (the request the
// role guard let through, the device the credential check returned, the pool connectMigrator
// checked), carries the audit statement of the route, job or command, and never hands the
// permit out. A new kind of caller is a new entry here, decided in its pull request; a route,
// a job or a tool never issues its own. Test files are outside the rule. Not seen: the names
// taken from a dynamic import. The last entry is in packages/db, which the import rule does not
// read: packages/db/src/entries.test.ts holds that no other file of the package issues a permit.
export const WRITE_PERMIT_ISSUERS = {
  'apps/api/src/auth/permissions.ts':
    'the role guard: changeAsOperator issues the permit of an operator write from what permissionGuard resolved for the request, and checks the role again as the first statement of the change',
  'apps/api/src/auth/refusal.ts':
    'the refusal record of the guards (SCR-32, D2): recordRefusal issues a permit that reads no role again, because the request is already refused, and gives the transaction one refusal event and no callback, so nothing but that audit row is written',
  'apps/api/src/auth/device.ts':
    "the device-credential check: changeAsDevice issues the permit of a player's change to the VerifiedDevice that verifyDeviceCredential returned and to nothing else; a player has no role to read again (D8)",
  'apps/api/src/jobs.ts':
    "the entry of the jobs that run with no request: changeAsJob issues the permit of a change by the alert check or the media pipeline, held to the job's row of JOB_AUDIT; only the files of JOB_CHANGE_FILES may import it",
  'packages/db/src/migrate.ts':
    'the migrator connection of the offline tools: changeOrgAsMigrator issues the permit of a provisioning or seed change to the pool that connectMigrator checked; the API cannot import this entry (AG-1.10)',
};
const PERMIT_MAKERS = ['issueWritePermit'];

// SCR-34 (adoption plan step 20, review): changePreOrg and changeOrgAsMigrator take an
// AuditStatement where changeOrg takes a permit, and issueAuditStatement makes one from any
// actions, so only the files whose helpers read a statement from its table may import it, each
// with its reason. A route, a job or a tool never writes its own: a new table of statements is
// a new entry here, decided in its pull request. Test files are outside the rule. Not seen: the
// names taken from a dynamic import. The last entry is in packages/db, which the import rule does
// not read: packages/db/src/entries.test.ts holds that no other file of the package makes one.
export const STATEMENT_ISSUERS = {
  'apps/api/src/route-audit.ts':
    'the audit tables of the routes and the jobs: routeStatement reads the entry of a route in OTHER_ROUTE_AUDIT, jobStatement the row of a job in JOB_AUDIT, and refusalStatement the guards of a route with the actions of its row that D2 lets a refusal record on its own (ATTEMPT_AUDITED_ACTIONS: an upload)',
  'scripts/lib/provision.ts':
    'the provisioning commands: provisionStatement reads the audits of a command from its row in PROVISION_COMMANDS, the table the audit-failure cases of tests/integration/provision-member.test.ts go through',
  'packages/db/src/migrate.ts':
    "the development seed's statement (step 20): seedStatement names no action, and changeOrgAsMigrator grants unaudited('development_seed') to that statement alone, by identity; the API cannot import this entry (AG-1.10), and only scripts/seed.ts names seedStatement (scripts/lib/legacy-transaction-lint.test.ts)",
};
const STATEMENT_MAKERS = ['issueAuditStatement'];

// SCR-34 (adoption plan step 20): changeAsJob of apps/api/src/jobs.ts changes any organisation
// with no role check and no credential, because a job has neither. Nothing in its arguments
// proves the caller is a job, so only the two job files may import that module, each with its
// reason; an operator route that reached for it would skip the role guard. Test files are
// outside the rule. Not seen: a dynamic import.
export const JOB_CHANGE_FILES = {
  'apps/api/src/alerts.ts':
    'the alert check: it runs on a timer with no request, enters every organisation that displayAlertOrgs names, and claims the offline and back-online transitions of its screens',
  'apps/api/src/media/pipeline.ts':
    'the media pipeline: it runs on a timer with no request, takes the jobs that mediaProcessingJobs names in every organisation, and records the verdict of each validation',
};

// SCR-34 (adoption plan step 19): changePreOrg hands its callback enterOrg, which turns any OrgId
// into a handle that writes, with no permit and no role check: operatorOf(request).orgId would
// do. So an operator write could skip the role guard through it, and only the files whose
// transactions really start before the organisation is known may import it, each with its
// reason. withResolvedOrg, which it runs on, is no longer exported by @tinnox/db since step 20
// (tinnox/no-legacy-transaction refuses the name everywhere in these workspaces). Inside these
// files that misuse is left to review (alert-recipients.ts holds operator routes too). Test files
// are outside the rule. Not seen: the name taken from a dynamic import.
export const PRE_ORG_CHANGE_FILES = {
  'apps/api/src/routes/auth.ts':
    'sign-in and sign-out: the identity, or the session being ended, is resolved to its member and organisation inside the transaction that records it, so no role has been checked yet',
  'apps/api/src/routes/player.ts':
    'pairing: a pairing session belongs to no organisation while it is created and polled, and its polling token is resolved to the organisation that claimed it inside the transaction that registers the display; a device has no role',
  'apps/api/src/routes/alert-recipients.ts':
    'the confirmation link of an alert address: its token is resolved to the organisation and recipient inside the transaction that confirms it, with no session',
  'scripts/lib/provision.ts':
    'the provisioning commands, run by TINNOX from a controlled host: each reads its member or invite as tinnox_definer and enters that organisation; there is no operator',
};
const PRE_ORG_OPENERS = ['changePreOrg'];

// D25: newOrgId (the '@tinnox/db/migrate' entry) names an organisation that is being created,
// so it turns any string into an OrgId. Only these offline tools may import it, each with its
// reason; a tool that works on an organisation that exists reads its org_id through asDefiner.
// The API cannot import the entry at all (DB_ENTRIES), and test files, which this leaves alone,
// have testOrgId. Not seen: the name taken from a dynamic import.
export const NEW_ORG_ID_FILES = {
  'scripts/lib/provision.ts':
    'org-create makes a new customer organisation, and gives it a fresh id before its first row is written',
  'scripts/seed.ts':
    'the development seed creates its two synthetic organisations under fixed ids, so documentation, tests and repeated runs agree',
};

// The workspaces whose product code can hold a database handle: the rows of IMPORT_LAYERS that
// name `db`, without tests (the API and the offline tools). The query rules below cover their
// non-test files, the unscoped-helper list their imports.
const DB_CALLERS = Object.keys(IMPORT_LAYERS).filter(
  (dir) => dir !== 'tests' && IMPORT_LAYERS[dir].includes('db'),
);
// An app's product code is its src folder; scripts has no such folder.
const DB_CALLER_FILES = DB_CALLERS.map((dir) =>
  dir.startsWith('apps/') ? `${dir}/src/**/*.ts` : `${dir}/**/*.ts`,
);

// AG-2.1: the statements tinnox/no-query-off-transaction lets a file send off a transaction,
// each with its reason. The rule takes a statement only when it is a string literal the pattern
// matches, so an entry opens nothing else in its file. Empty since adoption plan step 22: the
// alert check's session lock, the last entry, is taken by withSessionLock of @tinnox/db.
export const QUERY_OFF_TRANSACTION = {};

// AG-3.1, D25: the statements tinnox/no-raw-audit-insert lets a file write for itself, each with
// its reason. Everything else returns its audit rows from its change, and changeOrg or
// changePreOrg writes them with auditScoped or auditUnscoped, which packages/db/src/sec.ts
// (AUDIT_WRITERS below) holds. An entry is one whole statement, written
// as a string or a template with nothing interpolated, that the pattern matches from its first
// character to its last, so it opens nothing else in its file.
export const RAW_AUDIT_INSERTS = {
  'scripts/lib/provision.ts': [
    {
      sql: "^\\s*WITH closed AS \\(\\s*UPDATE public\\.member_invite i SET status = 'expired'\\s+WHERE i\\.status = 'pending' AND i\\.expires_at <= now\\(\\)\\s+RETURNING i\\.id, i\\.org_id, i\\.role\\s*\\)\\s*INSERT INTO public\\.audit_event \\(org_id, actor_type, actor_id, action, object_type, object_id, result, detail\\)\\s+SELECT closed\\.org_id, 'system', NULL, 'invite\\.cancel', 'invite', closed\\.id::text, 'success',\\s+jsonb_build_object\\('role', closed\\.role, 'reason', 'expired', 'executedBy', \\$1::text\\)\\s+FROM closed\\s*$",
      reason:
        "provisioning's `pending`: one statement as tinnox_definer expires the pending invites of every organisation and writes an invite.cancel row for each, so the expiry and its audit rows cannot come apart (D25; the provisioning exception of AGENTS.md section 1). auditScoped writes for one organisation, the one of its transaction",
    },
  ],
};
// The one file that holds INSERT INTO audit_event for everybody else: auditScoped (the unscoped
// writer calls sec.audit_unscoped, a function of the migrations).
const AUDIT_WRITERS = ['packages/db/src/sec.ts'];

// OTH-12: the two places in packages/db that hand query() a statement another file wrote, and
// the local name it has there. tinnox/sql-fragments checks the statement where it is written.
export const SQL_PASS_THROUGH = {
  // The handles of run() and poolAsTx send the statement their caller gave them.
  'packages/db/src/tx.ts': ['text'],
  // The runner sends each migration file as it is; `npm run check:migrations` reads the files.
  'packages/db/src/migrate.ts': ['sql'],
  // The handle asDefiner gives its work sends the statement the offline tool wrote.
  'packages/db/src/definer.ts': ['text'],
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

/**
 * What a file of the browser app `dir` uses instead of a server module. The workspace also holds
 * build files that run in Node and are never bundled (vite.config.ts, player-web's build/), so the
 * sentence must be true for them as well.
 */
function browserAppAlternative(dir) {
  const client =
    dir === 'apps/portal' ? 'apps/portal/src/api' : 'apps/player-web/src/platform/api.ts';
  return `Its browser code calls the API through ${client}; its build files (vite.config.ts${dir === 'apps/player-web' ? ', build/' : ''}) run in Node at build time and take what they need from the environment Vite gives (loadEnv from vite).`;
}

/** The patterns every file of the workspace `dir` gets. */
function layerPatterns(dir) {
  const allowed = valueLayers(dir);
  const typeOnly = typeOnlyLayers(dir);
  const typeOnlyNames = typeOnly.map((name) => `@tinnox/${name}`).join(', ');
  const allowedApps = allowed.filter((name) => APP_PACKAGES.includes(name.split('/')[0]));
  const packages = allowed.filter((name) => !allowedApps.includes(name));
  const browser = dir === 'apps/portal' || dir === 'apps/player-web';
  return [
    {
      // An allowed package, a types-only one (the entries below) or an app (the next entry's
      // message) is not this entry's to report.
      regex: `^@tinnox/(?!${anyOf([...packages, ...typeOnly, ...APP_PACKAGES])})`,
      message:
        packages.length === 0
          ? typeOnly.length === 0
            ? `${dir} is a bottom layer and imports no @tinnox package. Take what you need as a parameter, or move the code into this package.`
            : `${dir} is a bottom layer: it imports no @tinnox package at run time, and types only from ${typeOnlyNames} (import type). Take what you need as a parameter, or move the code into this package.`
          : `${dir} may import only ${packages.map((name) => `@tinnox/${name}`).join(', ')} from @tinnox/* (adoption plan section 3.1). ${
              browser
                ? browserAppAlternative(dir)
                : 'Take what you need as a parameter, or move the shared code into a package both may import.'
            }`,
    },
    ...typeOnly.map((name) => ({
      // D19: `import type` passes; a value import, a re-export and a side-effect import do not.
      regex: `^@tinnox/${anyOf([name])}`,
      allowTypeImports: true,
      message: `${dir} takes only types from @tinnox/${name} (D19): write \`import type { ... } from '@tinnox/${name}'\`, with \`type\` after \`import\`. A value import would load @tinnox/${name}, and zod with it, whenever ${dir} loads. Take a value you need as a parameter from the caller.`,
    })),
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
    // LINT-12: the root scripts/ is not a workspace, so the entry above does not see it. Only the
    // root scripts has a lib/ folder; apps/api/scripts (live-check.mjs) stays reachable.
    ...(dir === 'tests' || dir === 'scripts'
      ? []
      : [
          {
            regex: '^(\\.\\./)+scripts/lib/',
            message:
              'scripts/lib holds the offline tools (the migrator connection, the seed, provisioning); only scripts/ and tests/ import it. Move what both need into a package under packages/ and import it from both.',
          },
        ]),
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

// DEC-13, DEC-15 (adoption plan section 3.2, step 10): the server source that may open a
// connection off the machine only through a reviewed client: the API, the media worker, and the
// packages the API bundles (plan correction: the row names API and worker source only, but an S3
// client is expected in packages/storage, storage.ts). packages/db's own connection is the
// database (pg), which is not an outbound client here. packages/domain and packages/contracts
// import nothing but their allow-lists, and browser code cannot use Node modules (rule (f)).
const OUTBOUND_SOURCES = [
  'apps/api',
  'apps/media-worker',
  'packages/db',
  'packages/storage',
  'packages/delivery',
];
// The two reviewed clients, each allowed in one file only.
const OUTBOUND_CLIENTS = {
  // The identity provider (DEC-13): discovery, token exchange and logout, behind IdentityProvider.
  'openid-client': 'apps/api/src/auth/oidc.ts',
  // Alert e-mail over SMTP (DEC-37), to the host of SMTP_HOST. In production that host must be in
  // REVIEWED_SMTP_HOSTS (apps/api/src/config.ts), which only the provider review under DEC-13
  // adds to (D23).
  nodemailer: 'apps/api/src/mail.ts',
};

/** The outbound patterns of the workspace `dir`, for a file that may use the client `allowed`. */
function outboundPatterns(dir, allowed) {
  const message =
    dir === 'apps/media-worker'
      ? `${OUTBOUND_MESSAGE} The media worker needs none: it runs with no network (network_mode: none in infra/docker-compose.yml) and talks to the API through the job directory.`
      : OUTBOUND_MESSAGE;
  // A type-only import opens no connection (import type { IncomingMessage } from 'node:http').
  return [
    {
      // The Node network modules and the common HTTP, socket and cloud clients. Not exhaustive: a
      // client missing here is caught in review of the package.json change that adds it, and
      // then added to this list.
      regex:
        '^((node:)?(dgram|dns|http|http2|https|tls)|undici|axios|got|ky|node-fetch|cross-fetch|isomorphic-fetch|superagent|needle|request|ws|socket\\.io-client|aws-sdk|googleapis|@(aws-sdk|smithy|google-cloud|azure|sendgrid)/[^/]+)(/|$)',
      allowTypeImports: true,
      message,
    },
    {
      // isIP and its variants only parse a string (config.ts, auth/failure-guard.ts).
      regex: '^(node:)?net$',
      allowImportNames: ['isIP', 'isIPv4', 'isIPv6'],
      allowTypeImports: true,
      message: `${message} From node:net, only isIP, isIPv4 and isIPv6 may be imported.`,
    },
    ...Object.entries(OUTBOUND_CLIENTS)
      .filter(([name]) => name !== allowed)
      .map(([name, file]) => ({
        regex: `^${name}(/|$)`,
        allowTypeImports: true,
        message: `${message} ${name} is used only in ${file}.`,
      })),
    // Only the worker starts a child process: ffprobe on local files only
    // (-protocol_whitelist file, apps/media-worker/src/inspect.ts) inside a container with no
    // network, so its child processes reach nothing.
    ...(dir === 'apps/media-worker'
      ? []
      : [
          {
            regex: '^(node:)?child_process$',
            allowTypeImports: true,
            message: `${message} Only the media worker starts a child process: media is inspected by apps/media-worker through the job directory (apps/api/src/media/pipeline.ts).`,
          },
        ]),
  ];
}

/**
 * The same patterns as no-restricted-syntax selectors for import(), require(), a require made by
 * createRequire and called at once, and process.getBuiltinModule, which no-restricted-imports does
 * not see (adoption plan section 3.1). A literal or a template with no expression is checked; a
 * computed specifier (import(name)) cannot be read by lint, and neither can a require that
 * createRequire made under another name (const load = createRequire(...); load('undici')); both
 * are left to review. Every load is reported, as a dynamic import cannot be type-only or name its
 * imports. The layer rules hold import() and require() through a unit test over the files
 * instead (scripts/lib/import-boundaries-lint.test.ts).
 */
function outboundLoadSelectors(dir, allowed) {
  return outboundPatterns(dir, allowed).map(({ regex, message }) => {
    // esquery reads a selector regex up to the first unescaped slash.
    const specifier = `/${regex.replaceAll('/', '\\x2f')}/`;
    return {
      selector: [
        `ImportExpression[source.value=${specifier}]`,
        `ImportExpression[source.quasis.length=1][source.quasis.0.value.cooked=${specifier}]`,
        `CallExpression[callee.name='require'][arguments.0.value=${specifier}]`,
        `CallExpression[callee.type='CallExpression'][callee.callee.name='createRequire'][arguments.0.value=${specifier}]`,
        `CallExpression[callee.property.name='getBuiltinModule'][arguments.0.value=${specifier}]`,
      ].join(', '),
      message: `${message} import() and require() are held to the same rule as a static import.`,
    };
  });
}

/**
 * The message for pg in the workspace `dir`, naming only what that workspace may use (LINT-3):
 * @tinnox/db where the layer table allows it, and otherwise the workspace's own way.
 */
function pgMessage(dir) {
  const why =
    'a direct pg client skips the tinnox_app role check and the row_security and timeout start-up parameters.';
  if (IMPORT_LAYERS[dir].includes('db')) {
    // Only an offline tool may use the migrator's entry (DB_ENTRIES).
    const offline = dir.startsWith('apps/')
      ? ''
      : ' (connectMigrator from @tinnox/db/migrate for an offline tool that needs tinnox_migrator)';
    return `Only packages/db talks to PostgreSQL. Use createDatabase and the transaction openers of @tinnox/db (readOrg, changeOrg, changePreOrg)${offline}; ${why}`;
  }
  // packages/app-render is bundled for the browser too, but a package may not import an app, so
  // it gets the package sentence below.
  if (dir === 'apps/portal' || dir === 'apps/player-web') {
    return `Only packages/db talks to PostgreSQL, and ${dir} has no database connection. ${browserAppAlternative(dir)}`;
  }
  if (dir === 'apps/media-worker') {
    return 'Only packages/db talks to PostgreSQL. The media worker has no database: it takes jobs from the API and reports verdicts through the job directory (inbox and outbox, described in apps/media-worker/src/main.ts).';
  }
  return `Only packages/db talks to PostgreSQL. ${dir} may not import @tinnox/db: take the data you need as a parameter from the caller, which reads it with readOrg.`;
}

/** The whole outbound half of a no-restricted-syntax list: loads and destructured globals. */
const outboundSyntax = (dir, allowed) => [
  ...outboundLoadSelectors(dir, allowed),
  ...NO_OUTBOUND_GLOBAL_DESTRUCTURING,
];

// The no-restricted-syntax list of the test files that run against real services; the seeders'
// block adds to it.
const REAL_SERVICE_TEST_SYNTAX = [
  ...NO_SKIPPED_TESTS,
  ...NO_RANDOM_IN_TESTS,
  ...NO_FC_REPLAY,
  ...NO_RANGE_STATUS,
  ...NO_RESPONSE_NOT_OK,
  ...NO_BRAND_CAST,
  ...NO_HTML_SINK_CALLS,
];

// D13, step 34: the seeders of the migrate-forward chain (packages/db/test/levels).
const SEEDER_FILES = ['packages/db/test/levels/**'];
const SEEDER_LOADER_MESSAGE =
  'A seeder of the migrate-forward chain is plain SQL through the client it is given (D13): it reads no file and loads no module by a path lint cannot check. Write the rows with inOrg, asDefiner, id and bytes32 of ./sql.ts, and import earlier seeders (./seed-NNNN.ts) with a static import.';
const SEEDER_BANNED_MODULES = [
  'node:module',
  'module',
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
].map((name) => ({ name, message: SEEDER_LOADER_MESSAGE }));
// A computed import() (a template with an expression, a variable, a URL, a concatenation) names a
// module the import rules cannot read. Only the seeders refuse it: the rest of the tree loads a
// computed path where it must (levels.ts loads each seeder so).
const NO_COMPUTED_IMPORT = [
  { selector: "ImportExpression[source.type!='Literal']", message: SEEDER_LOADER_MESSAGE },
];

// Extra patterns for a subset of the files: each facet adds its patterns (or the patterns it
// gives for the workspace) to the workspace's own, and its `paths`, if any.
// `only` and `except` name the workspaces a facet can touch, and facets of one `group` match
// disjoint files and are never combined. Facets of different groups are combined whether or not
// their files can meet, so a few generated blocks match nothing (the route-file facet with a
// client file); they are harmless.
const IMPORT_FACETS = [
  {
    // Non-test files. Rule (h): they import no test code. Rule (g), D25: outside packages/db they
    // import no pg, scripts included; test files and test support may (they arrange data with
    // their own clients).
    files: [CODE_FILES],
    ignores: TEST_FILES,
    patterns: (dir) => [
      {
        // Any extension spelling: TypeScript resolves './x.test.js' to x.test.ts (SEC-3).
        regex: '(^|/)tests?/|\\.test(-support)?\\.[cm]?[jt]sx?$',
        message:
          'Product code does not import test code. Move what both need into a module that is not a test file, and import it from the test.',
      },
      ...(dir === 'packages/db' ? [] : [{ regex: '^pg(/|$)', message: pgMessage(dir) }]),
      ...dbEntryPatterns(dir),
      // Step 26: API source reads no constraint name; the constraints option maps one.
      ...(dir === 'apps/api'
        ? [{ regex: '^@tinnox/db$', importNames: ['violatedConstraint'], message: CONSTRAINT_READ }]
        : []),
    ],
  },
  {
    // AG-2.2: the unscoped helpers, outside the files that may import them. Only the workspaces
    // that may import @tinnox/db at all; tests are test files, which this leaves alone.
    only: DB_CALLERS,
    files: [CODE_FILES],
    ignores: [...TEST_FILES, ...Object.keys(UNSCOPED_HELPER_FILES)],
    patterns: [
      {
        regex: '^@tinnox/db$',
        importNames: UNSCOPED_HELPERS,
        message:
          'poolAsTx runs without an organisation (AG-2.2). Use readOrg(ctx.db, orgId, fn) for a read, or changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts for an operator change (it runs changeOrg of @tinnox/db), where row-level security limits every statement to that organisation. If the organisation really is not known yet (a credential is still being resolved, or a sec.* wrapper works across every organisation), add this file to UNSCOPED_HELPER_FILES in eslint.config.js with its reason, and say why in the pull request.',
      },
      {
        regex: '^@tinnox/db$',
        importNames: CROSS_ORG_WRAPPERS,
        message:
          'This sec.* wrapper reads or changes every organisation (SEC-2): it names an OrgId the caller did not prove, or deletes across organisations with no audit row. A route reads its own organisation with readOrg(ctx.db, operatorOf(request).orgId, fn), and a player route resolves its device with verifyDeviceCredential (apps/api/src/auth/device.ts). Only the files of UNSCOPED_HELPER_FILES in eslint.config.js call these: the alert check (displayAlertOrgs), the media pipeline (mediaProcessingJobs), the signed media URL of routes/player.ts (deviceByRegistrationId, after its signature is checked) and housekeeping (the purges). A new caller is added there with its reason, in its pull request.',
      },
    ],
  },
  {
    // SCR-34: the permit of a write, outside the role guard that issues it.
    only: DB_CALLERS,
    files: [CODE_FILES],
    ignores: [...TEST_FILES, ...Object.keys(WRITE_PERMIT_ISSUERS)],
    patterns: [
      {
        regex: '^@tinnox/db$',
        importNames: PERMIT_MAKERS,
        message:
          'Only what judges the caller of a change issues its WritePermit (SCR-34; the files of WRITE_PERMIT_ISSUERS in eslint.config.js). An operator route calls changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts and returns { value, audit }; it never holds the permit. A change with no operator behind it does not make a permit of its own either: a player route calls changeAsDevice(ctx, request, device, fn) with the device verifyDeviceCredential returned (apps/api/src/auth/device.ts), the alert check and the media pipeline call changeAsJob(db, job, orgId, fn) (apps/api/src/jobs.ts), an offline tool calls changeOrgAsMigrator(pool, orgId, statement, fn) from @tinnox/db/migrate, and a refusal that changed nothing is written with recordRefusal(ctx, request, session, event) (apps/api/src/auth/refusal.ts). A caller of a kind none of these fits is decided in its pull request, as a new entry of WRITE_PERMIT_ISSUERS.',
      },
    ],
  },
  {
    // SCR-34: the maker of an audit statement, outside the files that read the tables.
    only: DB_CALLERS,
    files: [CODE_FILES],
    ignores: [...TEST_FILES, ...Object.keys(STATEMENT_ISSUERS)],
    patterns: [
      {
        regex: '^@tinnox/db$',
        importNames: STATEMENT_MAKERS,
        message:
          'Only the helpers that read a statement from its table make an AuditStatement (SCR-34; the files of STATEMENT_ISSUERS in eslint.config.js), so a change is never held to a statement its caller wrote. A route outside the operator table passes routeStatement(request) to changePreOrg, a job runs through changeAsJob(db, job, orgId, fn) (jobStatement), a refusal through recordRefusal(ctx, request, session, event) (refusalStatement; all three in apps/api/src/route-audit.ts and its callers), and a provisioning command passes provisionStatement(command) from scripts/lib/provision.ts to changeOrgAsMigrator or changePreOrg. A new table of statements is decided in its pull request, as a new entry of STATEMENT_ISSUERS.',
      },
    ],
  },
  {
    // SCR-34: the entry of the jobs, outside the two job files.
    only: ['apps/api'],
    files: [CODE_FILES],
    ignores: [...TEST_FILES, ...Object.keys(JOB_CHANGE_FILES)],
    patterns: [
      {
        // The module whatever the extension spelling: TypeScript (NodeNext) and tsx resolve
        // '../jobs.js' to jobs.ts (SEC-3).
        regex: '(^|/)jobs(\\.[cm]?[jt]s)?$',
        message:
          'apps/api/src/jobs.ts is the entry of the jobs that run with no request (SCR-34): changeAsJob changes an organisation with no role check and no credential, so only the alert check and the media pipeline may import it (JOB_CHANGE_FILES in eslint.config.js). An operator route calls changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts, which checks the role again first; a player route calls changeAsDevice(ctx, request, device, fn) from apps/api/src/auth/device.ts; a read calls readOrg(ctx.db, orgId, fn) from @tinnox/db. A new job gets its row in JOB_AUDIT (apps/api/src/route-audit.ts) and its file in JOB_CHANGE_FILES with its reason, in its pull request.',
      },
    ],
  },
  {
    // SCR-34: the openers that enter an organisation without a permit, outside the files whose
    // transactions start before the organisation is known.
    only: DB_CALLERS,
    files: [CODE_FILES],
    ignores: [...TEST_FILES, ...Object.keys(PRE_ORG_CHANGE_FILES)],
    patterns: [
      {
        regex: '^@tinnox/db$',
        importNames: PRE_ORG_OPENERS,
        message:
          'changePreOrg is for a transaction that starts before the organisation is known (SCR-34): its enterOrg gives a handle that writes for any OrgId, with no permit and no role check. An operator change calls changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts, which checks the role again first, and returns { value, audit }; a read calls readOrg(ctx.db, orgId, fn) from @tinnox/db. If this file really resolves a credential to its organisation inside the transaction, add it to PRE_ORG_CHANGE_FILES in eslint.config.js with its reason, and say why in the pull request.',
      },
    ],
  },
  {
    // D25: newOrgId, outside the two offline tools that create an organisation.
    only: ['scripts'],
    files: [CODE_FILES],
    ignores: [...TEST_FILES, ...Object.keys(NEW_ORG_ID_FILES)],
    patterns: [
      {
        regex: '^@tinnox/db/migrate$',
        importNames: ['newOrgId'],
        message:
          'newOrgId names an organisation that is being created: only org-create in scripts/lib/provision.ts and the seed call it (D25). For an organisation that exists, read the org_id of its member or invite inside asDefiner(pool, tx, (definer) => definer.query(...)) from @tinnox/db/migrate: the row comes back with org_id as an OrgId, which enterOrg takes. A new tool that really creates organisations is added to NEW_ORG_ID_FILES in eslint.config.js with its reason.',
      },
    ],
  },
  {
    // process.env read through an import (see NO_PROCESS_ENV).
    except: ['tests'],
    files: ENV_FILES,
    ignores: [...TEST_FILES, ...ENV_READERS],
    patterns: [{ regex: '^(node:)?process$', importNames: ['env'], message: PROCESS_ENV_MESSAGE }],
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
    // D13, step 34: a seeder of the migrate-forward chain is plain SQL valid at its own level. A
    // helper of today (createOrg, a sec.* wrapper) writes today's columns, so an old level's
    // fixture written with one breaks when the helper changes (it did once: the 0011 fixture of
    // migration-0012.integration.test.ts had to pass { role: 'operator' } after 0013). The rule
    // compares the specifier text: '..' anywhere, or an absolute path, leaves the folder. The
    // loaders that take a specifier the rule cannot read are banned outright: node:module
    // (createRequire), the file system (readFileSync of another file) here, and a computed
    // import() by NO_COMPUTED_IMPORT.
    only: ['packages/db'],
    files: SEEDER_FILES,
    paths: SEEDER_BANNED_MODULES,
    patterns: [
      {
        regex: '^(@tinnox/|/|file:)|(^|/)\\.\\.(/|$)',
        message:
          "A seeder of the migrate-forward chain imports only from its own folder, packages/db/test/levels (D13): write the rows in plain SQL valid at the seeder's level through the client it is given, with inOrg, asDefiner, id and bytes32 of ./sql.ts, and take ids of earlier levels from their seeders (./seed-NNNN.ts). Helpers of @tinnox/* and of packages/db/test write today's columns, which an old level does not have.",
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
  {
    // DEC-13, DEC-15: server source opens no outbound connection...
    only: OUTBOUND_SOURCES,
    group: 'outbound',
    files: ['apps/*/src/**', 'packages/*/src/**'],
    ignores: [...TEST_FILES, ...Object.values(OUTBOUND_CLIENTS)],
    patterns: (dir) => outboundPatterns(dir, null),
  },
  ...Object.entries(OUTBOUND_CLIENTS).map(([name, file]) => ({
    // ...except through its one reviewed client, in that client's file.
    only: ['apps/api'],
    group: 'outbound',
    files: [file],
    patterns: (dir) => outboundPatterns(dir, name),
  })),
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
            ...(set.some((facet) => facet.paths)
              ? { paths: set.flatMap((facet) => facet.paths ?? []) }
              : {}),
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

// CHK-6 (group B review): the import rules above hold each gated name to the files of its list,
// and ignore those files. A listed file that re-exported the name would pass it to a file on no
// list, so no file of the API or the offline tools re-exports one, nor everything of @tinnox/db,
// @tinnox/db/migrate or the entry of the jobs. A selector cannot follow an export back to its
// import, so the name is imported under its own name, and those modules by name, not as a
// namespace: an alias (`import { poolAsTx as open }`, then `export { open }`) or a namespace
// (`import * as db`, then `export { db }`) would carry it past the re-export check. A dynamic
// import of those modules is refused for the same reason (CHK-8 of the group C review): the import
// rules' importNames see only a static import, so `const { poolAsTx } = await import('@tinnox/db')`
// would pass them. Nothing in the tree needs any of these. Not seen: a name passed on as a value
// (`export const open = poolAsTx`).
const GATED_NAMES = [
  ...UNSCOPED_HELPERS,
  ...CROSS_ORG_WRAPPERS,
  ...PERMIT_MAKERS,
  ...STATEMENT_MAKERS,
  ...PRE_ORG_OPENERS,
  'newOrgId',
  'changeAsJob',
];
const GATED_NAME = `/^(${GATED_NAMES.join('|')})$/`;
// esquery reads a selector regex up to the first slash, so a slash is written \x2f.
const GATED_MODULE = '/^@tinnox\\x2fdb(\\x2fmigrate)?$|(^|\\x2f)jobs(\\.[cm]?[jt]s)?$/';
const NO_GATED_REEXPORT = [
  {
    selector: [
      `ExportSpecifier[local.name=${GATED_NAME}]`,
      `ExportAllDeclaration[source.value=${GATED_MODULE}]`,
    ].join(', '),
    message:
      'Do not re-export a name the import rules hold to a list (CHK-6): poolAsTx and the cross-organisation sec.* wrappers (UNSCOPED_HELPER_FILES), issueWritePermit (WRITE_PERMIT_ISSUERS), issueAuditStatement (STATEMENT_ISSUERS), changePreOrg (PRE_ORG_CHANGE_FILES), newOrgId (NEW_ORG_ID_FILES) and changeAsJob (JOB_CHANGE_FILES), all in eslint.config.js. A re-export hands the name to files on no list. Import it in the file that calls it, and add that file to the list with its reason in its pull request; import the other names of @tinnox/db by name, not with export *.',
  },
  {
    selector: [
      `ImportSpecifier[imported.name=${GATED_NAME}]:not([local.name=${GATED_NAME}])`,
      `ImportDeclaration[source.value=${GATED_MODULE}] > ImportNamespaceSpecifier`,
      `ImportExpression[source.value=${GATED_MODULE}]`,
      `ImportExpression[source.quasis.length=1][source.quasis.0.value.cooked=${GATED_MODULE}]`,
    ].join(', '),
    message:
      "Import a name the import rules hold to a list under its own name, and @tinnox/db, @tinnox/db/migrate and the entry of the jobs (apps/api/src/jobs.ts) by name with a static import, not as a namespace and not with import() (CHK-6): the re-export check reads the name of what a file exports, and the import rules see only a static import, so an alias, a namespace or a dynamic import would carry poolAsTx, a cross-organisation sec.* wrapper, issueWritePermit, issueAuditStatement, changePreOrg, newOrgId or changeAsJob past them. Write `import { poolAsTx } from '@tinnox/db'` and call poolAsTx(...).",
  },
];

// The no-restricted-syntax lists of product code (apps/*/src, packages/*/src and the player's
// service worker, without tests) and of API source, which also reads no clock and no organisation
// id from the request.
const PRODUCT_SYNTAX = [
  ...NO_NON_NULL,
  ...NO_INLINE_CAST,
  ...NO_BRAND_CAST,
  ...NO_CREDENTIAL_NAMES,
  ...NO_HTML_SINK_CALLS,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_LOADCONFIG_OPTIONS,
  ...NO_RAW_SEC,
  ...NO_ROLE_SWITCH,
  ...NO_SESSION_LOCK,
];
const API_SYNTAX = [
  ...NO_NON_NULL,
  ...NO_INLINE_CAST,
  ...NO_BRAND_CAST,
  ...NO_CREDENTIAL_NAMES,
  ...NO_CLOCK,
  ...NO_ORG_FROM_REQUEST,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_LOADCONFIG_OPTIONS,
  ...NO_RAW_SEC,
  ...NO_ROLE_SWITCH,
  ...NO_TRANSACTION_TEXT,
  ...NO_GATED_REEXPORT,
  ...NO_SESSION_LOCK,
  ...NO_LOOPBACK_NAME,
  ...NO_SQLSTATE_LITERAL,
  ...NO_CONSTRAINT_READ,
  ...NO_COMMIT_OUTCOME_TEST,
  ...NO_COMMIT_OUTCOME_PREDICATE,
  ...NO_HAND_KEYED_PUBLISH,
  ...NO_API_403,
  ...NO_HTTP_ERROR_ALIAS,
  ...NO_REPLY_ERROR_STATUS,
  ...NO_ROUTE_REFUSAL,
];
// SEC-2 (group C review): apps/api/src/auth/ holds the role refusals, so its files keep the rest
// of the API's list without the ban on importing them.
const authSyntax = (file, list) =>
  inAuth(file) ? list.filter((entry) => !NO_ROUTE_REFUSAL.includes(entry)) : list;
// The list of the offline tools (D25: scripts get the database rules too). The tools that read
// the migrator URL get it as it is; every other script also gets NO_MIGRATOR_URL.
const SCRIPTS_SYNTAX = [
  ...NO_NON_NULL,
  ...NO_INLINE_CAST,
  ...NO_BRAND_CAST,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_RAW_SEC,
  ...NO_ROLE_SWITCH,
  ...NO_TRANSACTION_TEXT,
  ...NO_GATED_REEXPORT,
  ...NO_SESSION_LOCK,
  ...NO_COMMIT_OUTCOME_TEST,
  ...NO_COMMIT_OUTCOME_PREDICATE,
];
// EAX-06: packages/db holds withSessionLock and the migration runner's lock, so the product list
// of its source leaves out NO_SESSION_LOCK. Step 27: it holds the commit-outcome error, so its
// source gets the ban on testing for the class, outside the one file that does (DB_ONE_PLACES).
const DB_SYNTAX = [
  ...PRODUCT_SYNTAX.filter((entry) => !NO_SESSION_LOCK.includes(entry)),
  ...NO_COMMIT_OUTCOME_TEST,
];

// The files of packages/db that are the one place for something the rest may not write, with the
// list each is excused from. The rest of the package's list is unchanged for them.
const MIGRATION_RUNNER = 'packages/db/src/migrate.ts';
const DB_ONE_PLACES = {
  // SEC-1: connectMigrator mints the MigratorPool brand here, after checking the role.
  [MIGRATION_RUNNER]: NO_MIGRATOR_POOL_CAST,
  // AG-2.2: the typed wrappers of the sec.* functions.
  'packages/db/src/sec.ts': NO_RAW_SEC,
  // D25: asDefiner, the one role switch.
  'packages/db/src/definer.ts': NO_ROLE_SWITCH,
  // OTH-12: sql, sqlParameter and joinSql make the SqlFragment.
  'packages/db/src/sql.ts': NO_SQL_FRAGMENT_CAST,
  // AG-2.3: mintOrgId and the rows asDefiner reads make the OrgId.
  'packages/db/src/org-id.ts': NO_ORG_ID_FORGERY,
  // SCX-03: unconfirmedCommit, the one test for CommitOutcomeUnknownError, which settle() reads.
  'packages/db/src/commit-outcome.ts': NO_COMMIT_OUTCOME_TEST,
};

// The API files that are the one place for something the rest of the API may not write, and the
// list each is excused from (D5, EAX-08, D9, D1). A file may be in more than one.
const API_ONE_PLACES = [
  [CREDENTIAL_NAME_REFUSERS, NO_CREDENTIAL_NAMES],
  [LOOPBACK_NAME_ALLOWED, NO_LOOPBACK_NAME],
  [COMMIT_OUTCOME_ANSWERERS, NO_COMMIT_OUTCOME_PREDICATE],
  // Step 28 (D1): the named constructors of the 403s.
  [API_403_BUILDERS, NO_API_403],
];
const API_ONE_PLACE_FILES = [...new Set(API_ONE_PLACES.flatMap(([files]) => files))];
const apiExcusals = (file) =>
  API_ONE_PLACES.flatMap(([files, entries]) => (files.includes(file) ? entries : []));

// CHK-12: the one-place excusals of the no-restricted-syntax lists above, by file, so that
// scripts/lib/db-access-lint.test.ts can show each is still needed: it lints the file's text with
// every excused entry switched back on and expects each to fire there.
export const ONE_PLACE_EXCUSALS = {
  ...DB_ONE_PLACES,
  'packages/domain/src/planned.ts': NO_PLANNED_PUBLICATION_CAST,
  ...Object.fromEntries(API_ONE_PLACE_FILES.map((file) => [file, apiExcusals(file)])),
};

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
      // Adoption plan section 3.5: a new member of a closed union fails lint at every switch over
      // it. A `default:` branch does not count as handling the members it does not name.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false },
      ],
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
    // D19: where a workspace takes types only, the import is written `import type { ... }`. The
    // inline form, `import { type X } from '...'`, passes allowTypeImports and still loads the
    // package at run time: type stripping removes the names and leaves the import.
    files: Object.keys(IMPORT_LAYERS)
      .filter((dir) => typeOnlyLayers(dir).length > 0)
      .map((dir) => `${dir}/**/*.ts`),
    rules: {
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
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
      'no-restricted-globals': ['error', NO_WEB_STORAGE],
      'no-restricted-properties': ['error', ...BROWSER_RESTRICTED_PROPERTIES],
    },
  },
  {
    // DEC-13, DEC-15: the global half of the outbound rule (the imports are in the generated
    // blocks above). No other no-restricted-globals block matches these files.
    files: OUTBOUND_SOURCES.map((dir) => `${dir}/src/**/*.ts`),
    ignores: TEST_FILES,
    rules: {
      'no-restricted-globals': ['error', NO_OUTBOUND_GLOBALS],
    },
  },
  {
    files: ENV_FILES,
    ignores: [...TEST_FILES, ...ENV_READERS],
    rules: {
      'no-restricted-properties': ['error', ...NO_PROCESS_ENV],
    },
  },
  {
    // Browser code keeps its own restricted properties (see the note at the top of this file).
    files: both(BROWSER_FILES, ENV_FILES),
    ignores: TEST_FILES,
    rules: {
      'no-restricted-properties': ['error', ...BROWSER_RESTRICTED_PROPERTIES, ...NO_PROCESS_ENV],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...NO_NON_NULL, ...NO_BRAND_CAST],
    },
  },
  {
    files: ['apps/portal/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Portal test files get the test blocks below, which replace this list.
      'no-restricted-syntax': [
        'error',
        ...NO_RAW_HTML,
        ...NO_NON_NULL,
        ...NO_BRAND_CAST,
        ...NO_HTML_SINK_CALLS,
      ],
    },
  },
  {
    files: INLINE_CAST_FILES,
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...NO_NON_NULL, ...NO_INLINE_CAST, ...NO_BRAND_CAST],
    },
  },
  {
    // Product code: INLINE_CAST_FILES without scripts.
    files: [
      'apps/*/src/**/*.{ts,tsx}',
      'packages/*/src/**/*.{ts,tsx}',
      'apps/player-web/sw/**/*.ts',
    ],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...PRODUCT_SYNTAX],
    },
  },
  // DEC-13, DEC-15: the import() and require() half of the outbound rule, and the destructured
  // globals, one block per workspace as the patterns differ. In apps/api the API source blocks
  // below, the one of the two entry points included, carry the same selectors.
  ...OUTBOUND_SOURCES.map((dir) => ({
    files: [`${dir}/src/**/*.ts`],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...(dir === 'packages/db' ? DB_SYNTAX : PRODUCT_SYNTAX),
        ...outboundSyntax(dir, null),
      ],
    },
  })),
  ...Object.entries(DB_ONE_PLACES).map(([file, excused]) => ({
    files: [file],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...DB_SYNTAX.filter((entry) => !excused.includes(entry)),
        ...outboundSyntax('packages/db', null),
        // Step 26: the runner's lock wait asks isLockTimeout, as the API does.
        ...(file === MIGRATION_RUNNER ? NO_SQLSTATE_LITERAL : []),
      ],
    },
  })),
  {
    // DEC-23: markPlanned makes the PlannedPublication here. The rest of the product list is
    // unchanged for it.
    files: ['packages/domain/src/planned.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...PRODUCT_SYNTAX.filter((entry) => !NO_PLANNED_PUBLICATION_CAST.includes(entry)),
      ],
    },
  },
  {
    // API source but its two entry points, which create the clock, and the two reviewed clients.
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      ...TEST_FILES,
      'apps/api/src/main.ts',
      'apps/api/src/alerts-once.ts',
      ...Object.values(OUTBOUND_CLIENTS),
    ],
    rules: {
      'no-restricted-syntax': ['error', ...API_SYNTAX, ...outboundSyntax('apps/api', null)],
    },
  },
  {
    // Step 28, SEC-2: auth/ may import the role refusals it defines (NO_ROUTE_REFUSAL).
    files: ['apps/api/src/auth/**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...authSyntax('apps/api/src/auth/', API_SYNTAX),
        ...outboundSyntax('apps/api', null),
      ],
    },
  },
  ...Object.entries(ROUTE_REFUSAL_IMPORTERS).map(([file, allowed]) => ({
    // Each keeps the rest of the API's list, and may import only its own refusal.
    files: [file],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...API_SYNTAX.filter((entry) => !NO_ROUTE_REFUSAL.includes(entry)),
        ...noRouteRefusal(allowed),
        ...outboundSyntax('apps/api', null),
      ],
    },
  })),
  {
    // CHK-4: the two entry points keep the rest of the API's list (the loopback-name and
    // organisation-from-request rules included); only the clock rule is off, since they make it.
    files: ['apps/api/src/main.ts', 'apps/api/src/alerts-once.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...API_SYNTAX.filter((entry) => !NO_CLOCK.includes(entry)),
        ...outboundSyntax('apps/api', null),
      ],
    },
  },
  ...Object.entries(OUTBOUND_CLIENTS).map(([name, file]) => ({
    // Each reviewed client may load its own package.
    files: [file],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...authSyntax(file, API_SYNTAX),
        ...outboundSyntax('apps/api', name),
      ],
    },
  })),
  // D5, EAX-08, D9 and D1: a file that refuses the credential names, may name a loopback host,
  // answers an unknown commit outcome or builds a 403 keeps the rest of the API's list. One block per file,
  // because flat config replaces the option list and a file may be in more than one list.
  ...API_ONE_PLACE_FILES.map((file) => {
    const excused = apiExcusals(file);
    const client = Object.entries(OUTBOUND_CLIENTS).find(([, path]) => path === file)?.[0] ?? null;
    return {
      files: [file],
      rules: {
        'no-restricted-syntax': [
          'error',
          ...authSyntax(file, API_SYNTAX).filter((entry) => !excused.includes(entry)),
          ...outboundSyntax('apps/api', client),
        ],
      },
    };
  }),
  {
    // Scripts, the untyped .mjs ones included (this rule reads syntax only), but the offline tools
    // that connect as the migrator. Test files are outside, as everywhere (D4).
    files: ['scripts/**/*.{ts,mjs}'],
    ignores: [...TEST_FILES, ...MIGRATOR_URL_READERS],
    rules: {
      'no-restricted-syntax': ['error', ...SCRIPTS_SYNTAX, ...NO_MIGRATOR_URL],
    },
  },
  {
    // The tools that read the migrator URL keep the rest of the scripts' list.
    files: MIGRATOR_URL_READERS,
    rules: {
      'no-restricted-syntax': ['error', ...SCRIPTS_SYNTAX],
    },
  },
  {
    // Portal source keeps the portal's own selectors (see the note at the top of this file).
    files: ['apps/portal/src/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_RAW_HTML,
        ...NO_NON_NULL,
        ...NO_INLINE_CAST,
        ...NO_BRAND_CAST,
        ...NO_CREDENTIAL_NAMES,
        ...STATUS_WORDING,
        ...NO_TEXT_KEYS,
        ...NO_HTML_SINK_CALLS,
        ...NO_GLOBAL_PROCESS_ENV,
      ],
    },
  },
  {
    // Test files may use `!`: NO_NON_NULL is not in their lists.
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-syntax': [
        'error',
        ...NO_SKIPPED_TESTS,
        ...NO_RANDOM_IN_TESTS,
        ...NO_FC_REPLAY,
        ...NO_RANGE_STATUS,
        ...NO_BRAND_CAST,
        ...NO_HTML_SINK_CALLS,
      ],
    },
  },
  {
    // The test files that send real requests also refuse a response's `ok` asserted false.
    files: REAL_SERVICE_TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...REAL_SERVICE_TEST_SYNTAX],
    },
  },
  {
    // D13, step 34: the seeders also refuse an import() whose specifier lint cannot read.
    files: SEEDER_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...REAL_SERVICE_TEST_SYNTAX, ...NO_COMPUTED_IMPORT],
    },
  },
  {
    // Portal test files keep the portal's own selectors (see the note at the top of this file).
    files: both(['apps/portal/**'], TEST_FILES),
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_RAW_HTML,
        ...NO_SKIPPED_TESTS,
        ...NO_RANDOM_IN_TESTS,
        ...NO_FC_REPLAY,
        ...NO_RANGE_STATUS,
        ...NO_BARE_KEYBOARD,
        ...NO_BRAND_CAST,
        ...NO_HTML_SINK_CALLS,
      ],
    },
  },
  {
    // The one bare key press (SCR-16): settleTestFrame presses Shift with nothing rendered, to
    // retry the provider's frame lookup until it finds this file's frame. There is no element to
    // type into yet, and the retry is the fix for the failure the rule guards against.
    files: ['apps/portal/src/testFrame.test-support.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_RAW_HTML,
        ...NO_SKIPPED_TESTS,
        ...NO_RANDOM_IN_TESTS,
        ...NO_FC_REPLAY,
        ...NO_RANGE_STATUS,
        ...NO_BRAND_CAST,
        ...NO_HTML_SINK_CALLS,
      ],
    },
  },
  {
    files: REAL_SERVICE_TEST_FILES,
    rules: {
      'no-restricted-properties': ['error', ...NO_MODULE_MOCK],
    },
  },
  {
    // packages/db's tests are pointed at their own helpers (LINT-3).
    files: ['packages/db/test/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...NO_MODULE_MOCK_DB],
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
    // U-3: no transaction inside another's callback, or inside a function that takes a
    // transaction handle (scripts/eslint-rules/no-nested-transaction.ts). Every code file, tests
    // included: run() in packages/db/src/tx.ts refuses the same thing at run time. A rule of its
    // own, so no other block replaces its options.
    files: [CODE_FILES],
    plugins: { tinnox },
    rules: {
      'tinnox/no-nested-transaction': 'error',
    },
  },
  {
    // AG-2.1: a statement is sent only on a transaction handle
    // (scripts/eslint-rules/no-query-off-transaction.ts). The API's source and the offline tools
    // (D25: scripts with no exception); tests arrange data on clients of their own.
    files: DB_CALLER_FILES,
    ignores: TEST_FILES,
    plugins: { tinnox },
    rules: {
      'tinnox/no-query-off-transaction': 'error',
    },
  },
  ...Object.entries(QUERY_OFF_TRANSACTION).map(([file, allowed]) => ({
    files: [file],
    plugins: { tinnox },
    rules: {
      'tinnox/no-query-off-transaction': ['error', { allowed }],
    },
  })),
  {
    // CU-02: the job directory is a contract between two uids, so what is written there gets its
    // mode from the exchange-file helpers, not from a `mode` option the umask reduces
    // (scripts/eslint-rules/exchange-files.ts). The API's media folder and the media worker; the
    // two helpers are the one place that writes. A rule of its own, so no other block replaces
    // its options.
    files: ['apps/api/src/media/**/*.ts', 'apps/media-worker/src/**/*.ts'],
    ignores: [
      ...TEST_FILES,
      'apps/api/src/media/exchange-file.ts',
      'apps/media-worker/src/exchange-file.ts',
    ],
    plugins: { tinnox },
    rules: {
      'tinnox/exchange-files': 'error',
    },
  },
  {
    // AG-3.1, SCR-34 (adoption plan steps 19 and 20): no legacy transaction API in the API's
    // source and the offline tools, with no file excepted
    // (scripts/eslint-rules/no-legacy-transaction.ts). packages/db/src builds the new API on it,
    // and tests arrange data with withOrg from @tinnox/db/testing. A rule of its own, so no
    // other block replaces its options.
    files: DB_CALLER_FILES,
    ignores: TEST_FILES,
    plugins: { tinnox },
    rules: {
      'tinnox/no-legacy-transaction': 'error',
    },
  },
  {
    // AG-3.1, D25: an audit row is written by auditScoped or auditUnscoped (called by changeOrg
    // and changePreOrg), never by a statement of the file's own
    // (scripts/eslint-rules/no-raw-audit-insert.ts). The API's source, the offline tools and
    // packages/db; tests write rows raw to test the table's own rules.
    files: [...DB_CALLER_FILES, 'packages/db/src/**/*.ts'],
    ignores: [...TEST_FILES, ...AUDIT_WRITERS],
    plugins: { tinnox },
    rules: {
      'tinnox/no-raw-audit-insert': 'error',
    },
  },
  ...Object.entries(RAW_AUDIT_INSERTS).map(([file, allowed]) => ({
    files: [file],
    plugins: { tinnox },
    rules: {
      'tinnox/no-raw-audit-insert': ['error', { allowed }],
    },
  })),
  {
    // OTH-12: the statement given to query() is text from the source
    // (scripts/eslint-rules/sql-fragments.ts). The same files, and packages/db, which holds the
    // sec.* wrappers and the runner.
    files: [...DB_CALLER_FILES, 'packages/db/src/**/*.ts'],
    ignores: TEST_FILES,
    plugins: { tinnox },
    rules: {
      'tinnox/sql-fragments': 'error',
    },
  },
  ...Object.entries(SQL_PASS_THROUGH).map(([file, passThrough]) => ({
    files: [file],
    plugins: { tinnox },
    rules: {
      'tinnox/sql-fragments': ['error', { passThrough }],
    },
  })),
  {
    // A marker of unfinished work is a decision nobody recorded. ESLint's message for this rule is
    // fixed; the shortcut ledger of adoption plan step 48 (not yet written) is where an accepted
    // shortcut goes instead. Only a marker that opens a comment is reported, after any spaces,
    // stars and slashes (`// TODO: ...`, `/* FIXME */`, a JSDoc comment whose first line is
    // ` * XXX`), so prose that mentions the word (to hack a cookie, Vitest's it.todo, a
    // 4xx xxx xxx placeholder) stays allowed. ESLint reads a block comment as one text, so a
    // marker that opens a later line of it is not seen.
    files: [CODE_FILES],
    rules: {
      'no-warning-comments': [
        'error',
        { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'start', decoration: ['*', '/'] },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
