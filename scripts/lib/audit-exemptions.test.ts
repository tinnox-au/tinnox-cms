// AUD-3 (group B review): the audit-debt guard of the integration database lets every DELETE on
// display_alert through (EXEMPT_SHAPES in packages/db/src/audit-debt-guard.ts), because the
// alert check's silent close is the one write of that shape step 20 kept unaudited as built.
// The guard cannot tell that close from any other delete, so this test holds the claim its
// reason makes: no other source file deletes from display_alert. Rows a display delete removes
// by cascade are audited as display.* and need no case here.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';

// A DELETE or TRUNCATE of the table, with or without its schema, either name quoted or not.
const DELETES_ALERTS =
  /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?display_alert"?(?![a-z0-9_$])/i;
const THE_ALERT_CHECK = 'apps/api/src/alerts.ts';
const GUARD = 'packages/db/src/audit-debt-guard.ts';

/** The code files of the repository that are not tests, as git lists them. */
function sourceFiles(): string[] {
  const listed = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  );
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split('\0')
    .filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path))
    .filter((path) => !/(^|\/)tests?\/|\.test(-support)?\.tsx?$/.test(path))
    .filter((path) => existsSync(join(repoRoot, path)));
}

describe('the display_alert exemption of the audit-debt guard (AUD-3)', () => {
  it('AUD-3: only the alert check deletes from display_alert', () => {
    const deleting = sourceFiles().filter((path) =>
      DELETES_ALERTS.test(readFileSync(join(repoRoot, path), 'utf8')),
    );
    expect(
      deleting,
      `the audit-debt guard lets every DELETE on display_alert through for the alert check's silent close (EXEMPT_SHAPES in packages/db/src/audit-debt-guard.ts). A new delete of alert episodes returns its audit event from its change instead, and the exemption is narrowed to tell the two apart`,
    ).toEqual([THE_ALERT_CHECK]);
  });

  it("names this test in the exemption's reason", () => {
    // Read as text: scripts reach a package through its entries only, and none exports the list.
    const entry = /display_alert:\s*\{\s*shape: 'delete',\s*why:\s*'([^']*)'/.exec(
      readFileSync(join(repoRoot, GUARD), 'utf8'),
    );
    expect(entry?.[1]).toContain('scripts/lib/audit-exemptions.test.ts');
  });

  it('sees the forms a delete can take', () => {
    for (const text of [
      'DELETE FROM display_alert WHERE display_id = $1',
      'delete from public.display_alert',
      'DELETE FROM "public" . "display_alert" a',
      'TRUNCATE display_alert',
      'TRUNCATE TABLE ONLY display_alert',
    ]) {
      expect(DELETES_ALERTS.test(text), text).toBe(true);
    }
    for (const text of [
      'SELECT 1 FROM display_alert',
      'DELETE FROM display_alert_recipient',
      'INSERT INTO display_alert (display_id) VALUES ($1)',
    ]) {
      expect(DELETES_ALERTS.test(text), text).toBe(false);
    }
  });
});
