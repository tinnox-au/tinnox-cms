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
    `eslint.config.js loads the lint rules in scripts/eslint-rules/*.ts, and this Node (${process.version}) does not run TypeScript files: type stripping is on by default from Node 22.18 and off here. Use the Node that .nvmrc names (nvm use; package.json engines says >=22.18.0), take --no-experimental-strip-types out of NODE_OPTIONS, and point an editor's ESLint extension at that Node (docs/dev-handoff.md).`,
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
// three forms left to review (a value typed `any`, an alias of the type, `as never`).
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
// A cast would let any string in. Matched like the two above, with the same three forms left to
// review; packages/db/src/sql.ts, where the three makers are, has its own block below.
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
// Not seen, and left to review: the three forms the MigratorPool rule leaves (a value typed
// `any`, which the no-unsafe-* rules of typescript-eslint report where it is used; an alias of
// the type; `as never`); a cast to a named type that contains an OrgId (`body as SessionLookup`);
// a named row type given to query (`type Row = { org_id: OrgId }`, then `query<Row>`); and a
// generic helper whose `as T` is inferred (`const id: OrgId = brand(value)`). A selector cannot
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
    ].join(', '),
    message:
      'Do not make an OrgId here (AG-2.3): not by a cast, a type predicate, or a type argument of a call such as the row type of query(). The type says the database named the organisation. In the API it comes from operatorOf(request).orgId, the device credential (deviceByTokenHash) or another lookup of packages/db/src/sec.ts, never from the request; a lookup that is missing is added there. An offline tool that creates an organisation calls newOrgId(), and one that looks a member or an invite up reads its org_id through asDefiner (both from @tinnox/db/migrate). A test names its organisation with testOrgId(id) from @tinnox/db/testing.',
  },
];
// SCR-34 (adoption plan steps 19 and 20): a WritePermit says that what judged the caller issued
// it (for an operator the role guard, whose re-check of the member's role is the first statement
// of the change), and changeOrg of @tinnox/db runs no change without one. A cast would let a
// write past that check as far as the types go (changeOrg then refuses the value when it runs:
// it holds no terms). In every file, tests included, and in packages/db too, where
// issueWritePermit builds one without a cast. Matched like MigratorPool above, with the same
// three forms left to review.
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
// with the same three forms left to review.
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
// same three forms left to review.
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
// three forms left to review.
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
// Tests are outside: they call the functions raw to test them. Not seen: a name put together at
// run time ('sec.' + name).
const NO_RAW_SEC = [
  {
    selector: stringMatching('/\\bsec\\.[a-z_]+\\s*\\(/'),
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
// its reason. Three of the reasons are not "before the organisation is known",
// which is what the rule in AGENTS.md says: the list records what each file really does. A file
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
// matches, so an entry opens nothing else in its file.
export const QUERY_OFF_TRANSACTION = {
  'apps/api/src/alerts.ts': [
    {
      sql: '^SELECT pg_try_advisory_lock\\(hashtextextended\\(\\$1, 0\\)\\) AS ok$',
      reason: 'session lock; removed by `withSessionLock` in step 22',
    },
    {
      sql: '^SELECT pg_advisory_unlock\\(hashtextextended\\(\\$1, 0\\)\\) AS ok$',
      reason: 'session lock; removed by `withSessionLock` in step 22',
    },
  ],
};

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
      ...dbEntryPatterns(dir),
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
        regex: '(^|/)jobs\\.ts$',
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
  ...NO_BRAND_CAST,
  ...NO_CREDENTIAL_NAMES,
  ...NO_HTML_SINK_CALLS,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_LOADCONFIG_OPTIONS,
  ...NO_RAW_SEC,
  ...NO_ROLE_SWITCH,
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
];
// The list of the offline tools (D25: scripts get the database rules too). The tools that read
// the migrator URL get it as it is; every other script also gets NO_MIGRATOR_URL.
const SCRIPTS_SYNTAX = [
  ...NO_NON_NULL,
  ...NO_INLINE_CAST,
  ...NO_BRAND_CAST,
  ...NO_GLOBAL_PROCESS_ENV,
  ...NO_RAW_SEC,
  ...NO_ROLE_SWITCH,
];

// The files of packages/db that are the one place for something the rest may not write, with the
// list each is excused from. The rest of the package's list is unchanged for them.
const DB_ONE_PLACES = {
  // SEC-1: connectMigrator mints the MigratorPool brand here, after checking the role.
  'packages/db/src/migrate.ts': NO_MIGRATOR_POOL_CAST,
  // AG-2.2: the typed wrappers of the sec.* functions.
  'packages/db/src/sec.ts': NO_RAW_SEC,
  // D25: asDefiner, the one role switch.
  'packages/db/src/definer.ts': NO_ROLE_SWITCH,
  // OTH-12: sql, sqlParameter and joinSql make the SqlFragment.
  'packages/db/src/sql.ts': NO_SQL_FRAGMENT_CAST,
  // AG-2.3: mintOrgId and the rows asDefiner reads make the OrgId.
  'packages/db/src/org-id.ts': NO_ORG_ID_FORGERY,
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
  ...Object.entries(DB_ONE_PLACES).map(([file, excused]) => ({
    files: [file],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...PRODUCT_SYNTAX.filter((entry) => !excused.includes(entry)),
        ...outboundSyntax('packages/db', null),
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
  ...Object.entries(OUTBOUND_CLIENTS).map(([name, file]) => ({
    // Each reviewed client may load its own package.
    files: [file],
    rules: {
      'no-restricted-syntax': ['error', ...API_SYNTAX, ...outboundSyntax('apps/api', name)],
    },
  })),
  {
    // D5: the rest of the API's list is unchanged for the files that refuse the credential names.
    files: CREDENTIAL_NAME_REFUSERS,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...API_SYNTAX.filter((entry) => !NO_CREDENTIAL_NAMES.includes(entry)),
        ...outboundSyntax('apps/api', null),
      ],
    },
  },
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
        ...NO_BRAND_CAST,
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
