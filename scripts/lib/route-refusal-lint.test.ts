// The step 28 rules of eslint.config.js (adoption plan section 2.2 item 4, D1, D20), run against
// fixture text: no API file outside the three of API_403_BUILDERS (all in apps/api/src/auth/)
// builds a 403, no API file sets an error status on the reply, and no API file outside
// apps/api/src/auth/ imports a role refusal, except the two route files of
// ROUTE_REFUSAL_IMPORTERS, each for its one refusal. Each case takes the rules
// eslint.config.js resolves for a real path, so the file globs are tested with the selectors: a
// later block that took the rule away from a route file, or the API's list from one, fails here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_ERROR_CODES, STATUS_OF } from '@tinnox/contracts';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

const RULES = ['no-restricted-syntax', 'no-restricted-imports'] as const;
const repository = new ESLint({ cwd: repoRoot });

/** The messages of the restricted-syntax and restricted-imports rules for `code` at `path`. */
async function flagged(path: string, code: string): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const rules: Linter.RulesRecord = {};
  for (const rule of RULES) {
    const entry = resolved[rule];
    if (entry !== undefined) rules[rule] = entry;
  }
  // Without type information: these rules read syntax only.
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules }],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const ROUTE_403 =
  /^Only apps\/api\/src\/auth\/ builds a 403 \(step 28, D1\): .*found\(row, 'The thing'\)/;
const ROLE_REFUSAL =
  /^An API file outside apps\/api\/src\/auth\/ does not refuse by role itself \(step 28, D20\): /;
const BY_NAME =
  /^An API file outside apps\/api\/src\/auth\/ imports apps\/api\/src\/auth\/permissions\.ts by name \(step 28, D20\): /;
const ALIAS =
  /^Import and re-export HttpError under its own name \(step 28, D1\): import \{ HttpError \} from '\.\.\/errors\.ts'/;
const NO_CONSTRUCTOR =
  /^Give a subclass of HttpError a constructor that calls super\(code, message\) \(step 28, D1\), so the lint can read its code; RefusedConflict in apps\/api\/src\/routes\/members\.ts is one\. Only apps\/api\/src\/auth\/ builds a 403/;
const REPLY_STATUS =
  /^Do not set an error status on the reply \(SEC-5 of the group C review\): throw new HttpError\(code, message\) from apps\/api\/src\/errors\.ts/;
const SQLSTATE = /^Do not read a SQLSTATE code here \(step 26\)/;

// The codes the rule refuses come from STATUS_OF, as the config reads them.
const CODES_403 = API_ERROR_CODES.filter((code) => STATUS_OF[code] === 403);
const OTHER_CODES = API_ERROR_CODES.filter((code) => STATUS_OF[code] !== 403);

// A route file, the two files that may import one refusal each, and publishing.ts.
const ROUTE_PATHS = [
  'apps/api/src/routes/fixture.ts',
  'apps/api/src/routes/members.ts',
  'apps/api/src/routes/audit.ts',
  'apps/api/src/publishing.ts',
] as const;
// D1: the rest of the API, outside auth/, builds no 403 either: a module a route imports, an
// API file that is the one place for something else (errors.ts), and a new file in auth/ that is
// not named in API_403_BUILDERS.
const API_PATHS = [
  ...ROUTE_PATHS,
  'apps/api/src/tags.ts',
  'apps/api/src/media/fixture.ts',
  'apps/api/src/errors.ts',
  'apps/api/src/auth/fixture.ts',
] as const;
// SEC-2 (group C review): every API file outside auth/ refuses an import of the role refusals,
// whichever block sets its list: a route file, a module a route calls (D6: tags.ts), the files
// excused from another rule (errors.ts, config.ts), an entry point and a reviewed client.
const IMPORT_BAN_PATHS = [
  ...ROUTE_PATHS,
  'apps/api/src/tags.ts',
  'apps/api/src/media/fixture.ts',
  'apps/api/src/errors.ts',
  'apps/api/src/config.ts',
  'apps/api/src/main.ts',
  'apps/api/src/mail.ts',
] as const;

const importOf = (name: string): string =>
  `import { ${name} } from '../auth/permissions.ts';\nexport const use = ${name};`;

// The first case loads eslint.config.js, which a busy CI runner can stretch towards the unit
// project's 5 s default (GAP-1).
describe(
  'no 403 built outside the constructors of auth/ (step 28, D1)',
  { timeout: 30_000 },
  () => {
    it('reads the 403 codes from STATUS_OF', () => {
      expect(CODES_403).toEqual([
        'forbidden',
        'csrf_failed',
        'origin_not_allowed',
        'url_expired',
        'url_signature_invalid',
      ]);
    });

    for (const path of API_PATHS) {
      it.each(CODES_403)(`flags new HttpError('%s') in ${path}`, async (code) => {
        const messages = await flagged(path, `throw new HttpError('${code}', 'No.');`);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(ROUTE_403);
      });

      it.each([
        // A template literal with no substitution is the same code.
        'throw new HttpError(`forbidden`, `No.`);',
        // CHK-1 (group C review): the code under `as` or `satisfies`, and a 403 by statusCode.
        "throw new HttpError('forbidden' as const, 'No.');",
        "throw new HttpError('csrf_failed' satisfies ApiErrorCode, 'No.');",
        "class Refusal extends HttpError { constructor() { super('url_expired' as const, 'No.'); } }",
        'throw Object.assign(new Error(), { statusCode: 403 });',
        "class Refusal extends HttpError { constructor() { super('url_expired', 'No.'); } }",
        'class Refusal extends HttpError { constructor() { super(`url_expired`, `No.`); } }',
        "export const Refusal = class extends HttpError { constructor() { super('forbidden', 'No.'); } };",
      ])(`flags %s in ${path}`, async (code) => {
        const messages = await flagged(path, code);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(ROUTE_403);
      });
    }

    for (const path of ROUTE_PATHS) {
      it(`keeps the rest of the API's list in ${path}`, async () => {
        const messages = await flagged(path, "if (code === '23505') throw nameTaken();");
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(SQLSTATE);
      });
    }

    for (const path of API_PATHS) {
      it.each([
        "import { HttpError as E } from '../errors.ts';\nthrow new E('forbidden', 'No.');",
        // A re-export under another name, which another file imports by that name.
        "export { HttpError as Answer } from '../errors.ts';",
        "export { HttpError as 'Answer' } from '../errors.ts';",
        // A default export, which the importer names as it likes (`import Answer from`).
        "import { HttpError } from '../errors.ts';\nexport default HttpError;",
        "export { HttpError as default } from '../errors.ts';",
      ])(`flags HttpError under another name, %s, in ${path}`, async (code) => {
        const messages = await flagged(path, code);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(ALIAS);
      });

      // A subclass with no constructor inherits HttpError's, so `new Refusal('forbidden', ...)`
      // passes the code to no super() the lint can read.
      it.each([
        "class Refusal extends HttpError {}\nthrow new Refusal('forbidden', 'Not yours.');",
        'export const Refusal = class extends HttpError { readonly extra = 1; };',
      ])(`flags a subclass of HttpError with no constructor, %s, in ${path}`, async (code) => {
        const messages = await flagged(path, code);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(NO_CONSTRUCTOR);
      });
    }

    it.each(OTHER_CODES)("leaves new HttpError('%s') alone in a route file", async (code) => {
      expect(
        await flagged('apps/api/src/routes/fixture.ts', `throw new HttpError('${code}', 'No.');`),
      ).toEqual([]);
    });

    it('leaves alone a template literal with a substitution and an unrelated .forbidden', async () => {
      const code = [
        'throw new HttpError(`${code}`, `No.`);',
        'export const n = STATUS_OF.forbidden + counts.forbidden;',
        "throw new HttpError('not_found' as const, 'No.');",
        'export const s = { statusCode: reply.statusCode };',
        "import { HttpError } from '../errors.ts';",
        "export { HttpError } from '../errors.ts';",
        'export default routes;',
        "class Conflict extends HttpError { constructor() { super('conflict', 'No.'); } }",
        'class Other extends Error {}',
      ].join('\n');
      expect(await flagged('apps/api/src/routes/fixture.ts', code)).toEqual([]);
    });

    it.each([
      // The 403s live in auth/: the role guard, the origin and CSRF checks, the player protocol's.
      'apps/api/src/auth/permissions.ts',
      'apps/api/src/auth/session.ts',
      'apps/api/src/auth/player-refusals.ts',
      // Tests build every answer.
      'apps/api/src/routes/fixture.test.ts',
      'apps/api/test/fixture.integration.test.ts',
    ])('leaves %s alone', async (path) => {
      expect(await flagged(path, "throw new HttpError('forbidden', 'No.');")).toEqual([]);
      expect(await flagged(path, importOf('PermissionDeniedError'))).toEqual([]);
    });
  },
);

// SEC-5 (group C review): an answer whose status is set on the reply bypasses HttpError, so
// nothing ties its status to its code. Every API file, auth/ and the handler included.
describe('no error status set on the reply (SEC-5)', { timeout: 30_000 }, () => {
  for (const path of [
    ...API_PATHS,
    'apps/api/src/auth/permissions.ts',
    'apps/api/src/auth/session.ts',
    'apps/api/src/main.ts',
  ]) {
    it.each([
      "return reply.code(403).send(apiError('forbidden', 'Not yours.'));",
      "return reply.status(404).send(apiError('not_found', 'x'));",
      'void reply.code(503);',
      // The status under `as` or `satisfies`, and one assigned to statusCode.
      'void reply.code(403 as const);',
      'void reply.status(404 satisfies number);',
      'reply.statusCode = 403;',
      'reply.statusCode = 500 as const;',
    ])(`flags %s in ${path}`, async (code) => {
      const messages = await flagged(path, code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(REPLY_STATUS);
    });
  }

  it('leaves a success, a redirect, a computed status and the handler alone', async () => {
    const code = [
      'void reply.code(201);',
      'return reply.code(204).send();',
      'return reply.code(304).send();',
      "void reply.code(ready ? 200 : 503).header('cache-control', 'no-store');",
      'return reply.code(statusCode).send(body);',
      'void reply.code(201 as const);',
      'reply.statusCode = 200;',
      'this.statusCode = STATUS_OF[code];',
    ].join('\n');
    for (const path of ['apps/api/src/routes/fixture.ts', 'apps/api/src/errors.ts']) {
      expect(await flagged(path, code), path).toEqual([]);
    }
  });
});

describe('no role refusal imported outside auth/ (step 28, D20)', { timeout: 30_000 }, () => {
  const ALLOWED: Readonly<Record<string, string>> = {
    'apps/api/src/routes/members.ts': 'PermissionDeniedError',
    'apps/api/src/routes/audit.ts': 'forbidden',
  };

  for (const path of IMPORT_BAN_PATHS) {
    it.each(['forbidden', 'requirePermission', 'PermissionDeniedError'])(
      `flags %s in ${path} unless the file is named for it`,
      async (name) => {
        const messages = await flagged(path, importOf(name));
        if (ALLOWED[path] === name) {
          expect(messages).toEqual([]);
        } else {
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatch(ROLE_REFUSAL);
        }
      },
    );
  }

  it('flags a re-export', async () => {
    const code = "export { requirePermission } from '../auth/permissions.ts';";
    const messages = await flagged('apps/api/src/routes/fixture.ts', code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(ROLE_REFUSAL);
  });

  // A name taken from a namespace, an `export *` or a dynamic import is not seen, so the import
  // itself is refused, in every API file outside auth/, the two named route files included.
  for (const path of IMPORT_BAN_PATHS) {
    it.each([
      "import * as permissions from '../auth/permissions.ts';\nthrow permissions.forbidden();",
      "export * from '../auth/permissions.ts';",
      "const { forbidden: f } = await import('../auth/permissions.ts');\nthrow f();",
      "const p = await import('./auth/permissions');",
      // CHK-5 (group C review): NodeNext resolves the .js spelling to the .ts file.
      "import * as permissions from '../auth/permissions.js';\nthrow permissions.forbidden();",
      "export * from '../auth/permissions.mjs';",
    ])(`flags %s in ${path}`, async (code) => {
      const messages = await flagged(path, code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(BY_NAME);
    });
  }

  it('leaves the other names of auth/permissions.ts alone', async () => {
    const code =
      "import { changeAsOperator, parseRole, type ConstraintAnswers } from '../auth/permissions.ts';";
    expect(await flagged('apps/api/src/routes/fixture.ts', code)).toEqual([]);
    expect(await flagged('apps/api/src/tags.ts', code)).toEqual([]);
  });

  // auth/ defines the refusals and the guard that uses them: its files, whichever block sets
  // their list (a 403 builder, a reviewed client, any other), may import them.
  it.each([
    'apps/api/src/auth/fixture.ts',
    'apps/api/src/auth/permission-audit.ts',
    'apps/api/src/auth/permissions.ts',
    'apps/api/src/auth/oidc.ts',
  ])('leaves an import of the role refusals alone in %s', async (path) => {
    for (const name of ['forbidden', 'requirePermission', 'PermissionDeniedError']) {
      expect(await flagged(path, importOf(name)), name).toEqual([]);
    }
    expect(await flagged(path, "import * as permissions from './permissions.ts';")).toEqual([]);
  });

  // Each entry of ROUTE_REFUSAL_IMPORTERS is still needed, and is all the file needs: its own
  // text passes under its own entry, and is refused once, at its import, as a route file named
  // for nothing.
  it.each(Object.entries(ALLOWED))('%s still imports %s, and nothing else', async (file, name) => {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    expect((await flagged(file, text)).filter((m) => ROLE_REFUSAL.test(m))).toEqual([]);
    const refused = (await flagged('apps/api/src/routes/fixture.ts', text)).filter((m) =>
      ROLE_REFUSAL.test(m),
    );
    expect(refused).toHaveLength(1);
    expect(text).toMatch(
      new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\.\\./auth/permissions\\.ts'`),
    );
  });
});
