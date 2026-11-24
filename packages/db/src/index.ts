// The runtime entry, '@tinnox/db': what the API, the alert job and the offline tools use on a
// connection. The other two entries of package.json are not re-exported here, and lint keeps them
// out of the API (the db entries of eslint.config.js): '@tinnox/db/migrate' (./migrate.ts) holds
// what only an offline tool that connects as tinnox_migrator may use, and '@tinnox/db/testing'
// (./testing.ts) what only tests may use. ./entries.test.ts fails when one of their modules can
// be reached from here.
//
// ./tx.ts and ./sec.ts are listed name by name, because each holds what the change API of
// ./change.ts is built on and this entry does not hand out (adoption plan step 20, SCR-34): the
// openers withOrg, withoutOrg and withResolvedOrg, which run anything with no permit and no
// audit row, and the audit writers auditScoped and auditUnscoped, which write a row on whatever
// transaction they are given. A change runs on changeOrg or changePreOrg and returns its audit
// rows; a read runs on readOrg. Tests reach the five through '@tinnox/db/testing'.
// ./entries.test.ts fails when a new export of either module is missing here.
//
// ./pool.ts and ./database.ts are listed name by name too (adoption plan step 21): the API and
// the alert job hold the database as the handle createDatabase returns (AppContext.db in the
// API), which has no query and no connect, so createPool and the Pool and PoolClient types stay
// out of this entry, and so do the functions that make a handle for a pool or read the pool
// behind one. Tests reach a pool through '@tinnox/db/testing'.
export {
  assertConnectionRole,
  readRuntimeRole,
  RuntimeRoleError,
  runtimeRoleProblems,
  startupSettingsProblem,
  type CreatePoolOptions,
  type QueryResult,
  type QueryResultRow,
  type RuntimeRoleFacts,
} from './pool.ts';
export { assertRuntimeRole, createDatabase, ping, type Database } from './database.ts';
export {
  CommitOutcomeUnknownError,
  poolAsTx,
  readOrg,
  type Autocommit,
  type OrgId,
  type OrgReadTx,
  type OrgTx,
  type PreOrgTx,
  type Queryable,
  type StandaloneCaller,
  type Tx,
} from './tx.ts';
export {
  alertRecipientByTokenHash,
  auditStandalone,
  deviceByRegistrationId,
  deviceByTokenHash,
  displayAlertOrgs,
  heartbeatLogPurge,
  loginStatePut,
  loginStateTake,
  MEDIA_PROCESSING_JOBS_CAP,
  mediaProcessingJobs,
  membershipByOidcSub,
  PAIRING_POLL_OUTCOMES,
  pairingCancelClaims,
  pairingClaim,
  pairingComplete,
  pairingCreate,
  pairingPoll,
  pairingPurge,
  sessionByIdHash,
  sessionCreate,
  sessionPurgeExpired,
  sessionRevoke,
  sessionRevokeMembership,
  sessionRevokeUnaudited,
  sha256,
  type AlertRecipientLookup,
  type AnyScope,
  type AuditInput,
  type DeviceLookup,
  type LoginState,
  type MediaProcessingJob,
  type MembershipLookup,
  type PairingClaimResult,
  type PairingCompleteResult,
  type PairingCreateResult,
  type PairingPollOutcome,
  type SessionCreateResult,
  type SessionLookup,
  type StandaloneAuditEvent,
} from './sec.ts';
export * from './change.ts';
export * from './listing.ts';
export * from './sql.ts';
export * from './members.ts';
export * from './counted-limit.ts';
export * from './session-lock.ts';
export * from './constraints.ts';
export * from './error-field.ts';
