// ESLint flat config for the whole repository.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
// the only readers: the API's two entry points (loadConfig(process.env)), the media worker's
// entry point, and scripts/lib/env.ts (requireEnv) for the offline tools, whose top-level
// scripts are entry points and outside this rule.
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
      'Do not cast to MigratorPool: the brand says connectMigrator checked that the connection logs in and acts as tinnox_migrator. Call connectMigrator(connectionString, { applicationName }) from @tinnox/db and pass the pool it returns.',
  },
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

// AG-1.9, AG-1.17 (D5): product code never names the migrator, superuser or provisioning
// credentials. Step 12 adds loadConfig's refusal of these names, and with it the one override,
// apps/api/src/config.ts; until then nothing may name them.
const NO_CREDENTIAL_NAMES = [
  {
    selector: textMatching(
      '/MIGRATOR_URL|MIGRATOR_PASSWORD|POSTGRES_SUPERUSER|PROVISION_IDP_CLIENT_SECRET/',
    ),
    message:
      'Product code never names the migrator, superuser or provisioning credentials (AG-1.9, AG-1.17): they must never reach the API, the media worker or the player. Use AppConfig.databaseUrl, which connects as tinnox_app; offline tools connect as tinnox_migrator through connectMigrator in scripts/.',
  },
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
      'Only the offline tools in MIGRATOR_URL_READERS of eslint.config.js read the migrator URL (D4): the runner, the seed, provisioning and setup-dev. A new tool that must connect as tinnox_migrator calls connectMigrator from @tinnox/db and is added to that list with its reason.',
  },
];

// AG-2.3: the organisation comes from the verified session or the device credential, never from
// the request. Reports a read of an organisation-id key off a request part (request.body.orgId,
// request.headers['x-org-id'], const { orgId } = request.params), a request schema written in
// the API with such a key (the contracts test in packages/contracts covers the shared schemas),
// and a route's Body, Params, Querystring or Headers type with one. A value copied out of the
// request first (const input = request.body; input.orgId) is not seen: the OrgId type of
// adoption plan step 18 closes that.
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
// imports another app.
export const IMPORT_LAYERS = {
  'packages/contracts': [],
  'packages/storage': [],
  // Step 17 adds a type-only @tinnox/contracts import here (D19).
  'packages/db': [],
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
                ? browserAppAlternative(dir)
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
    return `Only packages/db talks to PostgreSQL. Use createPool and withOrg from @tinnox/db (connectMigrator for an offline tool); ${why}`;
  }
  // packages/app-render is bundled for the browser too, but a package may not import an app, so
  // it gets the package sentence below.
  if (dir === 'apps/portal' || dir === 'apps/player-web') {
    return `Only packages/db talks to PostgreSQL, and ${dir} has no database connection. ${browserAppAlternative(dir)}`;
  }
  if (dir === 'apps/media-worker') {
    return 'Only packages/db talks to PostgreSQL. The media worker has no database: it takes jobs from the API and reports verdicts through the job directory (inbox and outbox, described in apps/media-worker/src/main.ts).';
  }
  return `Only packages/db talks to PostgreSQL. ${dir} may not import @tinnox/db: take the data you need as a parameter from the caller, which reads it with withOrg.`;
}

/** The whole outbound half of a no-restricted-syntax list: loads and destructured globals. */
const outboundSyntax = (dir, allowed) => [
  ...outboundLoadSelectors(dir, allowed),
  ...NO_OUTBOUND_GLOBAL_DESTRUCTURING,
];

// Extra patterns for a subset of the files: each facet adds its patterns (or the patterns it
// gives for the workspace) to the workspace's own.
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
        regex: '(^|/)tests?/|\\.test(-support)?\\.tsx?$',
        message:
          'Product code does not import test code. Move what both need into a module that is not a test file, and import it from the test.',
      },
      ...(dir === 'packages/db' ? [] : [{ regex: '^pg(/|$)', message: pgMessage(dir) }]),
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

// The no-restricted-syntax lists of product code (apps/*/src, packages/*/src and the player's
// service worker, without tests) and of API source, which also reads no clock and no organisation
// id from the request.
const PRODUCT_SYNTAX = [
  ...NO_NON_NULL,
  ...NO_INLINE_CAST,
  ...NO_MIGRATOR_POOL_CAST,
  ...NO_CREDENTIAL_NAMES,
  ...NO_HTML_SINK_CALLS,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_LOADCONFIG_OPTIONS,
];
const API_SYNTAX = [
  ...NO_NON_NULL,
  ...NO_INLINE_CAST,
  ...NO_MIGRATOR_POOL_CAST,
  ...NO_CREDENTIAL_NAMES,
  ...NO_CLOCK,
  ...NO_ORG_FROM_REQUEST,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_LOADCONFIG_OPTIONS,
];

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
      'no-restricted-syntax': ['error', ...NO_NON_NULL, ...NO_MIGRATOR_POOL_CAST],
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
        ...NO_MIGRATOR_POOL_CAST,
        ...NO_HTML_SINK_CALLS,
      ],
    },
  },
  {
    files: INLINE_CAST_FILES,
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_NON_NULL,
        ...NO_INLINE_CAST,
        ...NO_MIGRATOR_POOL_CAST,
      ],
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
  // globals, one block per workspace as the patterns differ. In apps/api this block is the last
  // for the two entry points only; the API source blocks below carry the same selectors for the
  // rest.
  ...OUTBOUND_SOURCES.map((dir) => ({
    files: [`${dir}/src/**/*.ts`],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...PRODUCT_SYNTAX, ...outboundSyntax(dir, null)],
    },
  })),
  {
    // SEC-1: connectMigrator mints the MigratorPool brand here, after checking the role; the
    // rest of packages/db's list is unchanged.
    files: ['packages/db/src/migrate.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...PRODUCT_SYNTAX.filter((entry) => !NO_MIGRATOR_POOL_CAST.includes(entry)),
        ...outboundSyntax('packages/db', null),
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
  ...Object.entries(OUTBOUND_CLIENTS).map(([name, file]) => ({
    // Each reviewed client may load its own package.
    files: [file],
    rules: {
      'no-restricted-syntax': ['error', ...API_SYNTAX, ...outboundSyntax('apps/api', name)],
    },
  })),
  {
    // Scripts, the untyped .mjs ones included (this rule reads syntax only), but the offline tools
    // that connect as the migrator. Test files are outside, as everywhere (D4).
    files: ['scripts/**/*.{ts,mjs}'],
    ignores: [...TEST_FILES, ...MIGRATOR_URL_READERS],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_NON_NULL,
        ...NO_INLINE_CAST,
        ...NO_MIGRATOR_POOL_CAST,
        ...NO_MIGRATOR_URL,
        ...NO_GLOBAL_PROCESS_ENV,
      ],
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
        ...NO_MIGRATOR_POOL_CAST,
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
        ...NO_MIGRATOR_POOL_CAST,
        ...NO_HTML_SINK_CALLS,
      ],
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
        ...NO_BARE_KEYBOARD,
        ...NO_MIGRATOR_POOL_CAST,
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
        ...NO_MIGRATOR_POOL_CAST,
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
