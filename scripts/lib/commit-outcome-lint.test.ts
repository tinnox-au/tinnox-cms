// The commit-outcome rules of eslint.config.js (adoption plan section 2.3, step 27; SCX-03), run
// against fixture text: outside the one function that implements it, no source of the API, the
// offline tools or packages/db tests an error for CommitOutcomeUnknownError, and outside the
// API's error handler none imports the predicate that does the same. settle() of @tinnox/db is
// what they use instead. And no API source imports the two steps of a keyed publish, which
// changeOncePerKey of apps/api/src/publishing.ts takes in order. Each case takes the rules eslint.config.js resolves for a real path, so
// the file globs are tested with the selectors: a later block that took the rule away from one
// of the API's own blocks (the entry points, the reviewed clients, config.ts) fails here.
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

const repository = new ESLint({ cwd: repoRoot });

/** The messages of the restricted-syntax rule for `code` at `path`. */
async function flagged(path: string, code: string): Promise<string[]> {
  const resolved = ((await repository.calculateConfigForFile(path)) as Linter.Config).rules ?? {};
  const rules: Linter.RulesRecord = {};
  const entry = resolved['no-restricted-syntax'];
  if (entry !== undefined) rules['no-restricted-syntax'] = entry;
  // Without type information: the rule reads syntax only.
  const fixture = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules }],
  });
  const [result] = await fixture.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.message);
}

const TEST_FOR_CLASS =
  /^Do not test for CommitOutcomeUnknownError \(SCX-03, step 27\)\. Wrap the change in settle\(\) from @tinnox\/db \(packages\/db\/src\/outcome\.ts\): .*'committed': .*'rolled_back': only here delete files or stored objects, then throw ended\.error\. 'unknown': .* throw ended\.unconfirmed/;
const PREDICATE =
  /^isCommitOutcomeUnknown is for the API's error handler \(apps\/api\/src\/errors\.ts\), .* wraps the change in settle\(\) from @tinnox\/db \(packages\/db\/src\/outcome\.ts\) and switches on ended\.end: 'committed', 'rolled_back' and 'unknown' \(SCX-03, step 27\)/;

// Every kind of block that sets the API's list (a route file, the pipeline and the alert check
// of the row, the entry points, a reviewed client, the files excused from another rule), and
// both kinds for the offline tools (one that reads the migrator URL, one that does not).
const API_PATHS = [
  'apps/api/src/routes/fixture.ts',
  'apps/api/src/media/pipeline.ts',
  'apps/api/src/alerts.ts',
  'apps/api/src/publishing.ts',
  'apps/api/src/auth/permissions.ts',
  'apps/api/src/main.ts',
  'apps/api/src/alerts-once.ts',
  'apps/api/src/mail.ts',
  'apps/api/src/auth/oidc.ts',
  'apps/api/src/config.ts',
] as const;
const SCRIPT_PATHS = ['scripts/provision-member.ts', 'scripts/lib/provision.ts'] as const;
const DB_PATHS = [
  'packages/db/src/tx.ts',
  'packages/db/src/outcome.ts',
  // The runner is one of the package's one-place files, with a list of its own.
  'packages/db/src/migrate.ts',
] as const;

// The first case loads eslint.config.js, which a busy CI runner can stretch towards the unit
// project's 5 s default (GAP-1).
describe(
  'no test for CommitOutcomeUnknownError outside settle() (step 27)',
  { timeout: 30_000 },
  () => {
    const HAND_WRITTEN = [
      // The upload route as it was: bytes discarded unless the class is seen.
      'try { await change(); } catch (error) { if (!(error instanceof CommitOutcomeUnknownError)) await discard(); throw error; }',
      // The pipeline as it was.
      'let keep = false; try { keep = await change(); } catch (error) { keep = error instanceof CommitOutcomeUnknownError; throw error; }',
      // The provisioning script as it was.
      "if (error instanceof CommitOutcomeUnknownError) console.error('outcome unknown');",
      'const unknown = error instanceof db.CommitOutcomeUnknownError;',
    ];
    for (const path of [...API_PATHS, ...SCRIPT_PATHS, ...DB_PATHS, 'apps/api/src/errors.ts']) {
      it.each(HAND_WRITTEN)(`flags %s in ${path}`, async (code) => {
        const messages = await flagged(path, code);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(TEST_FOR_CLASS);
      });
    }

    it('leaves the one function that implements it, and tests, alone', async () => {
      const code =
        'export const is = (error: unknown) => error instanceof CommitOutcomeUnknownError;';
      for (const path of [
        'packages/db/src/commit-outcome.ts',
        'packages/db/src/tx.test.ts',
        'apps/api/src/errors.test.ts',
        'apps/api/test/fixture.integration.test.ts',
        'tests/integration/fixture.test.ts',
      ]) {
        expect(await flagged(path, code), path).toEqual([]);
      }
    });

    it('leaves settle() and other instanceof tests alone', async () => {
      for (const code of [
        "const ended = await settle(change); switch (ended.end) { case 'committed': break; case 'rolled_back': throw ended.error; case 'unknown': throw ended.unconfirmed; }",
        'if (error instanceof HttpError) throw error;',
        'if (ended.error instanceof RefusedError) report(ended.error);',
        "import { settle, type CommitOutcomeUnknownError, type TxEnd } from '@tinnox/db';",
      ]) {
        expect(await flagged('apps/api/src/routes/fixture.ts', code), code).toEqual([]);
        expect(await flagged('scripts/provision-member.ts', code), code).toEqual([]);
      }
    });
  },
);

describe(
  'the commit-outcome predicate outside the error handler (step 27, D9)',
  { timeout: 30_000 },
  () => {
    const IMPORTS = [
      "import { isCommitOutcomeUnknown } from '@tinnox/db';",
      "import { classifyDbError, isCommitOutcomeUnknown } from '@tinnox/db';",
      // An alias is the same import.
      "import { isCommitOutcomeUnknown as unknownOutcome } from '@tinnox/db';",
    ];
    for (const path of [...API_PATHS, ...SCRIPT_PATHS]) {
      it.each(IMPORTS)(`flags %s in ${path}`, async (code) => {
        const messages = await flagged(path, code);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(PREDICATE);
      });
    }

    it('leaves the namespace import of @tinnox/db to the CHK-6 rule, which refuses it', async () => {
      const code =
        "import * as db from '@tinnox/db'; if (!db.isCommitOutcomeUnknown(error)) await discard();";
      for (const path of [...API_PATHS, ...SCRIPT_PATHS]) {
        const messages = await flagged(path, code);
        expect(messages, path).toHaveLength(1);
        expect(messages[0], path).toMatch(/not as a namespace \(CHK-6\)/);
      }
    });

    it('leaves the error handler, packages/db and tests their import', async () => {
      for (const path of [
        // D9: the handler answers 500 commit_outcome_unknown and undoes nothing.
        'apps/api/src/errors.ts',
        // The migration runner reports its own COMMIT.
        'packages/db/src/migrate.ts',
        'apps/api/src/errors.test.ts',
        'packages/db/test/fixture.integration.test.ts',
      ]) {
        expect(await flagged(path, IMPORTS[0] ?? ''), path).toEqual([]);
      }
    });
  },
);

const HAND_KEYED =
  /^Do not lock or look up an Idempotency-Key by hand \(step 27\)\. Publish through changeOncePerKey\(ctx, request, \{ displayId, key, replay, publish \}\) from apps\/api\/src\/publishing\.ts/;

describe('the keyed-publish steps outside changeOncePerKey (step 27)', { timeout: 30_000 }, () => {
  const IMPORTS = [
    // The publish and push routes as they were: lock, look up, retry by hand.
    "import { lockPublishKey, findPublicationByKey } from '../publishing.ts';",
    "import { findPublicationByKey } from './publishing.ts';",
    "import { lockPublishKey as lockKey } from '../publishing.ts';",
    // A namespace import is seen where it is used.
    "import * as p from '../publishing.ts'; await p.lockPublishKey(tx, d, k);",
    "import * as p from './publishing.ts'; const found = await p.findPublicationByKey(tx, d, k);",
  ];
  for (const path of API_PATHS) {
    it.each(IMPORTS)(`flags %s in ${path}`, async (code) => {
      const messages = await flagged(path, code);
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) expect(message).toMatch(HAND_KEYED);
    });
  }

  it('leaves the helper and the tests of the handle types alone', async () => {
    for (const [path, code] of [
      [
        'apps/api/src/routes/fixture.ts',
        "import { changeOncePerKey, idempotencyKeyOf } from '../publishing.ts';",
      ],
      [
        'apps/api/src/read-handles.test.ts',
        "import { lockPublishKey, findPublicationByKey } from './publishing.ts';",
      ],
    ] as const) {
      expect(await flagged(path, code), path).toEqual([]);
    }
  });
});
