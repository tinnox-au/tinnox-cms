/**
 * A change and its audit rows as one thing (adoption plan section 2.1 B, step 19; AG-3.1,
 * SCR-34).
 *
 * `changeOrg` and `changePreOrg` run a callback in one transaction, as `withOrg` and
 * `withResolvedOrg` do, but the callback does not write its audit rows: it returns them, as
 * `{ value, audit }`, and the wrapper writes them on that transaction and then sends COMMIT. So
 * the audit row of a change cannot land on another transaction, and a change that records
 * nothing has to say so with `unaudited(reason)`, which a reviewer can search for.
 *
 * `changeOrg` also takes a `WritePermit`, which only the thing that judged the caller issues
 * (lint keeps `issueWritePermit` to the files of WRITE_PERMIT_ISSUERS in eslint.config.js):
 *  - the role guard, for an operator's write (`changeAsOperator` in
 *    apps/api/src/auth/permissions.ts): the permit's re-check of the member's role is the first
 *    thing the transaction does, so a write that skipped the role check does not type-check;
 *  - the guards' refusal record, for a refusal that changed nothing and must leave its audit
 *    row (`recordRefusal` in apps/api/src/auth/refusal.ts; SCR-32, D2): no re-check, since the
 *    request was already refused, and the transaction is given the event and nothing else;
 *  - the device-credential check, for what a player does with its credential
 *    (`changeAsDevice` in apps/api/src/auth/device.ts);
 *  - the entry of the two jobs that run with no request (`changeAsJob` in
 *    apps/api/src/jobs.ts);
 *  - the migrator's connection, for an offline tool (`changeOrgAsMigrator` of
 *    '@tinnox/db/migrate').
 * Every permit carries what its route, job or tool says it audits, and the change is refused
 * before COMMIT when it recorded an action that statement does not name.
 *
 * One change writes its audit rows in its own SQL, in the statement that makes the change:
 * provisioning's `pending` (D25). It returns `auditedInSql(result, action)` of
 * '@tinnox/db/migrate', which the API cannot import, and the change is refused before COMMIT
 * when that statement wrote no row (./sql-audit.ts, ./definer.ts).
 *
 * `changePreOrg` takes no permit: its `enterOrg` gives a handle that writes for any `OrgId`,
 * `operatorOf(request).orgId` included. Lint holds it instead: only the files of
 * PRE_ORG_CHANGE_FILES in eslint.config.js, whose transactions start before the organisation is
 * known, may import it (or `withResolvedOrg`). An operator write inside one of those files is
 * left to review. It does take the statement of its route, and is held to it like `changeOrg`.
 *
 * What this cannot see: an `unaudited(reason)` that is not true, `nothing_changed` above all,
 * which any change may return. The audit-debt guard of the integration test database holds that
 * for the audited tables (./audit-debt-guard.ts); in production a false `nothing_changed`
 * commits unseen. A run-time check is possible but not free: the role re-check reads FOR SHARE,
 * which assigns the transaction an id, so `txid_current_if_assigned()` cannot tell a write from
 * that lock, and the per-transaction counters of pg_stat_xact_user_tables still hold rows of
 * earlier transactions of the connection that were not yet flushed, so they need a reading
 * before `fn` as well as after: one more statement on every change. Left to D3.
 */
import type {
  AuditAction,
  GrantedUnauditedReason,
  NoAuditReason,
  StatedUnauditedReason,
  UnauditedReason,
} from '@tinnox/contracts';
import { auditRowsOn } from './audit-note.ts';
import type { Pool } from './pool.ts';
import { auditScoped, auditUnscoped, type AuditInput } from './sec.ts';
import { isAuditedInSql, receiptOf, type AuditedInSql } from './sql-audit.ts';
import { withOrg, withResolvedOrg, type OrgId, type OrgTx, type PreOrgTx, type Tx } from './tx.ts';

/** Marks what `unaudited` returns. Not exported, so only `unaudited` makes one. */
const unauditedBecause: unique symbol = Symbol('unaudited');

/** What a change returns in place of its audit events when it writes no audit row. */
export interface Unaudited {
  readonly [unauditedBecause]: UnauditedReason;
}

/**
 * Says that this run of a change writes no audit row, and why, with a reason of
 * UNAUDITED_REASONS (packages/contracts/src/audit.ts, D3): `nothing_changed` when it found
 * nothing to change, `idempotent_replay` when an earlier request already did the work, and
 * `telemetry` or `counter_under_threshold` when what it stored is one of the things D3 leaves
 * unaudited, which only a route that states or grants the reason may give. The three writes the
 * step 20 ruling leaves as they are today (`alert_closed_silently`, `pairing_expired_by_time`,
 * `development_seed`) are granted the same way, each to the job, routes or tool that makes it.
 * A new reason is a decision, recorded in that list. `read_only` is not one: a read
 * belongs in `readOrg`, whose transaction refuses a write. Nothing checks at run time that a
 * `nothing_changed` run wrote nothing (see the head of this file).
 */
export function unaudited(reason: UnauditedReason): Unaudited {
  return Object.freeze({ [unauditedBecause]: reason });
}

/**
 * Who may give each reason. `stated`: it says what a route stores on every request, so the
 * route's statement must give the same reason (the ones UNAUDITED_REASONS shares with
 * NO_AUDIT_REASONS). `granted`: a write left unaudited on purpose, so the route's statement must
 * grant it (GRANTED_UNAUDITED_REASONS). `any`: what one run found, which passes under any
 * statement. Written out here because this package takes only types from the contracts (D19);
 * the mapped type holds the table to those lists.
 */
const GIVEN_BY = {
  nothing_changed: 'any',
  idempotent_replay: 'any',
  telemetry: 'stated',
  counter_under_threshold: 'granted',
  alert_closed_silently: 'granted',
  pairing_expired_by_time: 'granted',
  development_seed: 'granted',
} as const satisfies {
  readonly [R in UnauditedReason]: R extends StatedUnauditedReason
    ? 'stated'
    : R extends GrantedUnauditedReason
      ? 'granted'
      : 'any';
};

/** Marks what `legacyAudit` returns. Not exported. */
const writtenByCallback: unique symbol = Symbol('legacyAudit');

/** What `withOrgAllowed` returns for its callers, which still write their audit rows by hand. */
export interface LegacyAudit {
  readonly [writtenByCallback]: true;
}

const LEGACY = Object.freeze<LegacyAudit>({ [writtenByCallback]: true });

/**
 * Says that the callback wrote its audit rows itself, with `auditScoped(tx, event)`, or wrote
 * none: nothing here can tell which. Only `withOrgAllowed` of the role guard uses it, for the
 * route files that have not moved to `{ value, audit }` yet (the files of
 * LEGACY_TRANSACTION_FILES in eslint.config.js), and lint refuses the import everywhere else.
 * It goes when the last of those files has moved (adoption plan step 20).
 */
export function legacyAudit(): LegacyAudit {
  return LEGACY;
}

/**
 * The audit rows of a change: one event, several, or `unaudited(reason)`. An empty list is
 * refused when the change runs, because it gives no reason. An offline tool whose one statement
 * wrote the change and its audit rows together gives `auditedInSql(result, action)` of
 * '@tinnox/db/migrate' instead (D25): the wrapper then writes nothing and checks the count.
 */
export type Audit = AuditInput | readonly AuditInput[] | Unaudited | LegacyAudit | AuditedInSql;

/** What the callback of `changeOrg` and `changePreOrg` returns. */
export interface Change<T> {
  readonly value: T;
  readonly audit: Audit;
}

/**
 * What a route, a job or an offline tool says its own work audits: the `audit` field of a row
 * in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts) or OTHER_ROUTE_AUDIT, a row of
 * JOB_AUDIT (both apps/api/src/route-audit.ts), or the `audits` of a provisioning command
 * (adoption plan step 17).
 */
export type StatedAudit =
  { readonly actions: readonly AuditAction[] } | { readonly none: NoAuditReason };

/** What a change is held to, and where it is written. */
export interface StatementTerms {
  /** What the route, job or tool of the change says it audits. */
  readonly stated: StatedAudit;
  /** Where that is written, for the refusal: "the row of POST /api/apps in ROUTE_PERMISSIONS". */
  readonly statedIn: string;
  /**
   * The reasons of GRANTED_UNAUDITED_REASONS the route, job or tool lets one run give: the
   * `grants` of its entry in OTHER_ROUTE_AUDIT or its row of JOB_AUDIT
   * (apps/api/src/route-audit.ts), or what `changeOrgAsMigrator` adds for the seed. None when
   * absent.
   */
  readonly grants?: readonly GrantedUnauditedReason[];
}

/**
 * Keys the terms of a statement. Not exported, so only `issueAuditStatement` makes a statement,
 * and the terms sit under it rather than beside it: a spread of a statement copies it whole, and
 * a key written next to the spread (`{ ...routeStatement(request), stated }`) is not read.
 */
const fromTheTable: unique symbol = Symbol('auditStatement');

/**
 * The statement of a route, a job or a command, read from the table that holds it: what
 * `changePreOrg` and `changeOrgAsMigrator` take where `changeOrg` takes a permit. Only
 * `issueAuditStatement` makes one, and lint keeps that to the files whose helpers read the
 * tables (STATEMENT_ISSUERS in eslint.config.js: `routeStatement`, `jobStatement` and
 * `refusalStatement` of apps/api/src/route-audit.ts, `provisionStatement` of
 * scripts/lib/provision.ts), so a change cannot be held to a statement its caller wrote itself.
 * `termsOfStatement` reads it.
 */
export interface AuditStatement {
  readonly [fromTheTable]: StatementTerms;
}

/**
 * Makes a statement. For the helpers that read it from a table alone: lint refuses this import
 * in every other file (STATEMENT_ISSUERS in eslint.config.js), and a cast to `AuditStatement`
 * everywhere.
 */
export function issueAuditStatement(held: StatementTerms): AuditStatement {
  return Object.freeze({ [fromTheTable]: Object.freeze({ ...held }) });
}

/**
 * What `statement` holds a change to. Throws unless it came from `issueAuditStatement`: a value
 * the type checker did not read, or one that was cast, would hold the change to whatever its
 * caller wrote. changePreOrg and changeOrgAsMigrator call it before they send anything, and the
 * issuers of a permit read the statement of their route or job with it.
 */
export function termsOfStatement(opener: string, statement: AuditStatement): StatementTerms {
  const candidate: unknown = statement;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !Object.hasOwn(candidate, fromTheTable)
  ) {
    throw new Error(
      `${opener} requires the audit statement of its route or command, as the table that holds it gives it: a route outside the operator table passes routeStatement(request) (apps/api/src/route-audit.ts), its entry in OTHER_ROUTE_AUDIT; a provisioning command passes provisionStatement(command) (scripts/lib/provision.ts), the audits of its row in PROVISION_COMMANDS. A statement written in place is not one`,
    );
  }
  return statement[fromTheTable];
}

/** What a permit holds a change to. */
export interface PermitTerms<Granted> extends StatementTerms {
  /**
   * Runs first in the transaction of the change, on its handle. The role guard's reads the
   * member's role again and throws when the change is no longer allowed. A permit whose issuer
   * has nothing to read again (a refusal, a device, a job, an offline tool) sends no statement
   * here. What it returns is handed to the change.
   */
  readonly recheck: (tx: OrgTx) => Promise<Granted>;
}

/** Keys the terms of a permit. Not exported, so only `issueWritePermit` makes a permit. */
const terms: unique symbol = Symbol('writePermit');

/**
 * Permission to run one change for an organisation: `changeOrg` takes nothing else. `Granted`
 * is what the re-check hands to the change (for an operator, the role it read).
 */
export interface WritePermit<Granted = unknown> {
  readonly [terms]: PermitTerms<Granted>;
}

/**
 * Makes a permit. For the issuers named at the head of this file alone: lint refuses this
 * import in every other file (WRITE_PERMIT_ISSUERS in eslint.config.js), and a cast to
 * `WritePermit` everywhere.
 */
export function issueWritePermit<Granted>(held: PermitTerms<Granted>): WritePermit<Granted> {
  return Object.freeze({ [terms]: held });
}

function termsOf<Granted>(permit: WritePermit<Granted>): PermitTerms<Granted> {
  // A value that was cast to the type has no terms: say so, not "cannot read properties".
  const candidate: unknown = permit;
  if (typeof candidate !== 'object' || candidate === null || !Object.hasOwn(candidate, terms)) {
    throw new Error(
      'changeOrg requires a WritePermit that the role guard issued: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues the permit and checks the role again first. A change with no operator behind it gets its permit the same way, from what judged it: changeAsDevice (apps/api/src/auth/device.ts), changeAsJob (apps/api/src/jobs.ts), or changeOrgAsMigrator of @tinnox/db/migrate for an offline tool',
    );
  }
  return permit[terms];
}

const isUnaudited = (audit: Audit): audit is Unaudited => unauditedBecause in audit;
const isLegacy = (audit: Audit): audit is LegacyAudit => writtenByCallback in audit;

const describeStated = (stated: StatedAudit): string => {
  if (!('actions' in stated)) return `no audit row (${stated.none})`;
  // A refusal statement of a read: its guards record no refusal, and it has no action of its own.
  return stated.actions.length === 0 ? 'no action at all' : stated.actions.join(', ');
};

/**
 * Writes the audit rows a change returned and checks what its transaction recorded, before
 * COMMIT. Throws to roll the change back. `handles` are the handles of the transaction: the
 * audit writers note on them every action written, the ones `write` just wrote and any the
 * callback wrote by hand.
 */
async function record<T>(
  opener: string,
  change: Change<T>,
  write: (event: AuditInput) => Promise<void>,
  handles: readonly Tx[],
  held: StatementTerms,
): Promise<T> {
  const { audit } = change;
  const reason = isUnaudited(audit) ? audit[unauditedBecause] : undefined;
  // D25: the change's own statement wrote its audit rows. Nothing is written for it here, and
  // it is taken only for what the database counted: at least one row, on this transaction.
  const inSql = isAuditedInSql(audit) ? receiptOf(audit) : undefined;
  if (inSql !== undefined) {
    if (!handles.some((handle) => handle === inSql.on)) {
      throw new Error(
        `${opener}: the change returned auditedInSql(result, '${inSql.action}') for a statement that ran on another transaction, so its audit rows are not this change's. Send the statement inside this change, on the handle of asDefiner(pool, tx, work) (@tinnox/db/migrate) given the tx of this callback, and pass its result. Nothing was committed.`,
      );
    }
    if (inSql.rows < 1) {
      throw new Error(
        `${opener}: the change returned auditedInSql(result, '${inSql.action}'), but that statement wrote no audit row: the database counted ${String(inSql.rows)} inserted. A run that found nothing to change returns { value, audit: unaudited('nothing_changed') }; a change whose statement does not write its own audit rows returns its events as { value, audit }. Nothing was committed.`,
      );
    }
  }
  if (!isUnaudited(audit) && !isLegacy(audit) && !isAuditedInSql(audit)) {
    const events = 'action' in audit ? [audit] : audit;
    if (events.length === 0) {
      throw new Error(
        `${opener}: the change returned an empty list of audit events, so nothing says why it records nothing. Return the event of what it changed, or { value, audit: unaudited(reason) } with a reason of UNAUDITED_REASONS (packages/contracts/src/audit.ts) when it really writes no audit row. Nothing was committed.`,
      );
    }
    for (const event of events) await write(event);
  }

  const written = [
    ...handles.flatMap((handle) => auditRowsOn(handle)),
    // Held to the statement like a row the wrapper wrote: a command that does not name the
    // action cannot give it this way either.
    ...(inSql === undefined ? [] : [inSql.action]),
  ];
  if (reason !== undefined && written.length > 0) {
    throw new Error(
      `${opener}: the change returned unaudited('${reason}'), yet its callback wrote audit rows itself (${written.join(', ')}). Return those events as { value, audit } and let ${opener} write them, or return no unaudited(...). Nothing was committed.`,
    );
  }

  const { stated, statedIn } = held;
  const allowed: readonly AuditAction[] = 'actions' in stated ? stated.actions : [];
  const unstated = [...new Set(written.filter((action) => !allowed.includes(action)))];
  if (unstated.length > 0) {
    throw new Error(
      `${opener}: the change recorded ${unstated.join(', ')}, which ${statedIn} does not state: it states ${describeStated(stated)}. Name every action the route writes in that statement, and give a new one its case in tests/integration/audit-failure.test.ts; or correct the event. Nothing was committed.`,
    );
  }
  // Most reasons say what this run found, which any change may find. The others say that what
  // was stored needs no audit row, and that is the route's decision to make (GIVEN_BY).
  const givenBy = reason === undefined ? 'any' : GIVEN_BY[reason];
  if (givenBy === 'stated' && !('none' in stated && stated.none === reason)) {
    throw new Error(
      `${opener}: the change returned unaudited('${String(reason)}'), but ${statedIn} states ${describeStated(stated)}. '${String(reason)}' says what the route stores on every request, so its statement has to give the same reason. Return the audit event of what changed, or unaudited('nothing_changed') when this run changed nothing. Nothing was committed.`,
    );
  }
  if (givenBy === 'granted' && !(held.grants ?? []).some((granted) => granted === reason)) {
    throw new Error(
      `${opener}: the change returned unaudited('${String(reason)}'), but ${statedIn} does not grant it. '${String(reason)}' leaves a write unaudited on purpose, which only the route, job or tool that makes that write may do: its entry in OTHER_ROUTE_AUDIT or its row of JOB_AUDIT (apps/api/src/route-audit.ts) grants the reason (D3; UNAUDITED_REASONS in packages/contracts/src/audit.ts says who makes each). Return the audit event of what changed, or unaudited('nothing_changed') when this run changed nothing. Nothing was committed.`,
    );
  }
  return change.value;
}

/**
 * Runs a change for an organisation in one transaction, with its audit rows:
 *
 *   BEGIN; set the organisation; permit's re-check; ...fn...; the audit rows; COMMIT
 *
 * `fn` returns `{ value, audit }`: the events of what it changed, or `unaudited(reason)`.
 * `changeOrg` writes the events on the same transaction and returns `value`. It rolls back when
 * the re-check or `fn` throws, when an audit row cannot be written, and when the change
 * recorded an action its route does not state (see the head of this file). A refusal that must
 * leave a trace does not throw inside `fn`: it returns the refusal as its value, with the event.
 *
 * Request code does not call this itself: the issuer of the permit does, in a function that
 * takes what it judged (`changeAsOperator`, `recordRefusal`, `changeAsDevice`, `changeAsJob`,
 * `changeOrgAsMigrator`).
 */
export async function changeOrg<T, Granted>(
  pool: Pool,
  orgId: OrgId,
  permit: WritePermit<Granted>,
  fn: (tx: OrgTx, granted: Granted) => Promise<Change<T>>,
): Promise<T> {
  const held = termsOf(permit);
  return withOrg(
    pool,
    orgId,
    async (tx) => {
      const granted = await held.recheck(tx);
      const change = await fn(tx, granted);
      return record('changeOrg', change, (event) => auditScoped(tx, event), [tx], held);
    },
    'changeOrg',
  );
}

/**
 * The same before the organisation is known (sign-in and sign-out, pairing, a confirmation
 * link, a provisioning command): one transaction that starts with no organisation, where `fn`
 * resolves a credential with the sec.* wrappers and may then call `enterOrg`, as in
 * `withResolvedOrg`. No permit: there is no member yet whose role could be checked. The audit
 * events `fn` returns are written for the organisation it entered, or with no organisation when
 * it entered none (a refusal that names nobody's organisation). Since nothing checks a role
 * here, lint keeps it to the files of PRE_ORG_CHANGE_FILES in eslint.config.js.
 *
 * `statement` is what the route or the command says it audits, and the change is held to it as
 * a change on `changeOrg` is held to its permit's: a route gives `routeStatement(request)` of
 * apps/api/src/route-audit.ts, its entry in OTHER_ROUTE_AUDIT, and a provisioning command
 * `provisionStatement(command)` of scripts/lib/provision.ts. Only those make one (`AuditStatement`).
 */
export async function changePreOrg<T>(
  pool: Pool,
  statement: AuditStatement,
  fn: (tx: PreOrgTx, enterOrg: (orgId: OrgId) => Promise<OrgTx>) => Promise<Change<T>>,
): Promise<T> {
  // A caller the type checker did not read (or one written for the form without a statement)
  // would otherwise run with no statement to be held to, or one it wrote itself.
  const held = termsOfStatement('changePreOrg', statement);
  return withResolvedOrg(
    pool,
    async (pre, enterOrg) => {
      const entered: OrgTx[] = [];
      const change = await fn(pre, async (orgId) => {
        const tx = await enterOrg(orgId);
        entered.push(tx);
        return tx;
      });
      const org = entered.at(-1);
      return record(
        'changePreOrg',
        change,
        (event) => (org === undefined ? auditUnscoped(pre, event) : auditScoped(org, event)),
        [pre, ...entered],
        held,
      );
    },
    'changePreOrg',
  );
}
