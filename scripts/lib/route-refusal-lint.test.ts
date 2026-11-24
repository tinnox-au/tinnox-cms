// The step 28 rules of eslint.config.js (adoption plan section 2.2 item 4, D1, D20), run against
// fixture text: no API file outside the three of API_403_BUILDERS (all in apps/api/src/auth/)
// builds a 403, and a route file imports no role refusal, except the two files of
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
const ROLE_REFUSAL = /^A route file does not refuse by role itself \(step 28, D20\): /;
const BY_NAME =
  /^A route file imports apps\/api\/src\/auth\/permissions\.ts by name \(step 28, D20\): /;
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

    it.each(OTHER_CODES)("leaves new HttpError('%s') alone in a route file", async (code) => {
      expect(
        await flagged('apps/api/src/routes/fixture.ts', `throw new HttpError('${code}', 'No.');`),
      ).toEqual([]);
    });

    it('leaves alone a template literal with a substitution and an unrelated .forbidden', async () => {
      const code = [
        'throw new HttpError(`${code}`, `No.`);',
        'export const n = STATUS_OF.forbidden + counts.forbidden;',
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

describe('no role refusal imported into a route file (step 28, D20)', { timeout: 30_000 }, () => {
  const ALLOWED: Readonly<Record<string, string>> = {
    'apps/api/src/routes/members.ts': 'PermissionDeniedError',
    'apps/api/src/routes/audit.ts': 'forbidden',
  };

  for (const path of ROUTE_PATHS) {
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
  // itself is refused, in every route file, the two named ones included.
  for (const path of ROUTE_PATHS) {
    it.each([
      "import * as permissions from '../auth/permissions.ts';\nthrow permissions.forbidden();",
      "export * from '../auth/permissions.ts';",
      "const { forbidden: f } = await import('../auth/permissions.ts');\nthrow f();",
      "const p = await import('./auth/permissions');",
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
