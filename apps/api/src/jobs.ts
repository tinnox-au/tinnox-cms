/**
 * What the two jobs that run with no request may change (adoption plan step 20; SCR-34): the
 * alert check (alerts.ts) and the media pipeline (media/pipeline.ts).
 *
 * A job has no operator and no credential. It enters every organisation in turn, each named by
 * its own lookup across all of them (`displayAlertOrgs`, `mediaProcessingJobs` of @tinnox/db).
 * `changeOrg` still runs no change without a permit, and this module issues the job's, which
 * carries the job's row of JOB_AUDIT (route-audit.ts): a change of the alert check that
 * recorded anything but an alert is refused before COMMIT, as a route's is.
 *
 * Nothing proves that a caller is a job, so lint does what a type cannot: only the job files
 * may import this module (JOB_CHANGE_FILES in eslint.config.js). An operator route that
 * reached for it would skip the role guard, and does not lint.
 */
import {
  changeOrg,
  issueWritePermit,
  termsOfStatement,
  type Change,
  type OrgId,
  type OrgTx,
  type Pool,
} from '@tinnox/db';
import { jobStatement, type JobName } from './route-audit.ts';

/**
 * A change by the job `job` for one organisation, on `changeOrg`:
 *
 *   BEGIN; set the organisation; ...fn...; the audit rows `fn` returned; COMMIT
 *
 * `orgId` is one the job's own lookup named. `fn` returns `{ value, audit }` and writes no
 * audit row itself; a run that found nothing to do returns `unaudited('nothing_changed')`.
 */
export async function changeAsJob<T>(
  pool: Pool,
  job: JobName,
  orgId: OrgId,
  fn: (tx: OrgTx) => Promise<Change<T>>,
): Promise<T> {
  const statement = jobStatement(job);
  const permit = issueWritePermit({
    // The whole statement, grants included.
    ...termsOfStatement('changeAsJob', statement),
    // Nothing to read again: no member, and no credential, stands behind a job.
    recheck: () => Promise.resolve(),
  });
  return changeOrg(pool, orgId, permit, (tx) => fn(tx));
}
