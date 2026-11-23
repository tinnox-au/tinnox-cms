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
 * `changeOrg` also takes a `WritePermit`. Only the role guard of the API issues one
 * (apps/api/src/auth/permissions.ts; lint keeps `issueWritePermit` out of every other file), and
 * the permit's re-check of the member's role is the first thing the transaction does, so a
 * change on `changeOrg` that skipped the role check does not type-check. The permit also carries
 * what the route says it audits (its row of ROUTE_PERMISSIONS), and the change is refused before
 * COMMIT when it recorded an action that row does not name.
 *
 * `changePreOrg` is not held that way: its `enterOrg` gives a handle that writes for any
 * `OrgId`, `operatorOf(request).orgId` included, with no permit. Lint holds it instead: only the
 * files of PRE_ORG_CHANGE_FILES in eslint.config.js, whose transactions start before the
 * organisation is known, may import it (or `withResolvedOrg`). An operator write inside one of
 * those files is left to review.
 *
 * What this cannot see: an `unaudited(reason)` that is not true, `read_only` above all, which any
 * route may return. The audit-debt guard of the integration test database holds that for the
 * audited tables (./audit-debt-guard.ts); in production a false `read_only` commits unseen. A
 * run-time check is possible but not free: the role re-check reads FOR SHARE, which assigns the
 * transaction an id, so `txid_current_if_assigned()` cannot tell a write from that lock, and the
 * per-transaction counters of pg_stat_xact_user_tables still hold rows of earlier transactions
 * of the connection that were not yet flushed, so they need a reading before `fn` as well as
 * after: one more statement on every change. Left to adoption plan step 20 and D3.
 */
import type { AuditAction, NoAuditReason } from '@tinnox/contracts';
import { auditRowsOn } from './audit-note.ts';
import type { Pool } from './pool.ts';
import { auditScoped, auditUnscoped, type AuditInput } from './sec.ts';
import { withOrg, withResolvedOrg, type OrgId, type OrgTx, type PreOrgTx } from './tx.ts';

/** Marks what `unaudited` returns. Not exported, so only `unaudited` makes one. */
const unauditedBecause: unique symbol = Symbol('unaudited');

/** What a change returns in place of its audit events when it writes no audit row. */
export interface Unaudited {
  readonly [unauditedBecause]: NoAuditReason;
}

/**
 * Says that a change writes no audit row, and why, with a reason of NO_AUDIT_REASONS
 * (packages/contracts/src/audit.ts, D3): `read_only` when this run of the change wrote nothing
 * (it found nothing to change), `telemetry` and `login_state` when what it stored is one of the
 * two things D3 leaves unaudited. A new reason is a decision, recorded in that list. Nothing
 * checks at run time that a `read_only` change wrote nothing (see the head of this file): a read
 * belongs in `readOrg`, whose transaction refuses a write.
 */
export function unaudited(reason: NoAuditReason): Unaudited {
  return Object.freeze({ [unauditedBecause]: reason });
}

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
 * refused when the change runs, because it gives no reason.
 */
export type Audit = AuditInput | readonly AuditInput[] | Unaudited | LegacyAudit;

/** What the callback of `changeOrg` and `changePreOrg` returns. */
export interface Change<T> {
  readonly value: T;
  readonly audit: Audit;
}

/**
 * What a route says its own work audits: the `audit` field of its row in ROUTE_PERMISSIONS
 * (apps/api/src/auth/permissions.ts, adoption plan step 17).
 */
export type StatedAudit =
  { readonly actions: readonly AuditAction[] } | { readonly none: NoAuditReason };

/** What a permit holds a change to. */
export interface PermitTerms<Granted> {
  /**
   * Runs first in the transaction of the change, on its handle: reads the member's role again
   * and throws when the change is no longer allowed. What it returns is handed to the change.
   */
  readonly recheck: (tx: OrgTx) => Promise<Granted>;
  /** What the route of the change says it audits. */
  readonly stated: StatedAudit;
  /** Where that is written, for the refusal: "the row of POST /api/apps in ROUTE_PERMISSIONS". */
  readonly statedIn: string;
}

/** Keys the terms of a permit. Not exported, so only `issueWritePermit` makes a permit. */
const terms: unique symbol = Symbol('writePermit');

/**
 * Permission to run one change for an organisation: `changeOrg` takes nothing else. `Granted`
 * is what the re-check read and hands to the change (the member's role).
 */
export interface WritePermit<Granted = unknown> {
  readonly [terms]: PermitTerms<Granted>;
}

/**
 * Makes a permit. For the role guard of the API alone: lint refuses this import in every other
 * file (WRITE_PERMIT_ISSUERS in eslint.config.js), and a cast to `WritePermit` everywhere.
 */
export function issueWritePermit<Granted>(held: PermitTerms<Granted>): WritePermit<Granted> {
  return Object.freeze({ [terms]: held });
}

function termsOf<Granted>(permit: WritePermit<Granted>): PermitTerms<Granted> {
  // A value that was cast to the type has no terms: say so, not "cannot read properties".
  const candidate: unknown = permit;
  if (typeof candidate !== 'object' || candidate === null || !Object.hasOwn(candidate, terms)) {
    throw new Error(
      'changeOrg requires a WritePermit that the role guard issued: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues the permit and checks the role again first',
    );
  }
  return permit[terms];
}

const isUnaudited = (audit: Audit): audit is Unaudited => unauditedBecause in audit;
const isLegacy = (audit: Audit): audit is LegacyAudit => writtenByCallback in audit;

const describeStated = (stated: StatedAudit): string =>
  'actions' in stated ? stated.actions.join(', ') : `no audit row (${stated.none})`;

/**
 * Writes the audit rows a change returned and checks what its transaction recorded, before
 * COMMIT. Throws to roll the change back. `rows` gives every action written on the
 * transaction: the ones `write` just wrote, and any the callback wrote by hand.
 */
async function record<T>(
  opener: string,
  change: Change<T>,
  write: (event: AuditInput) => Promise<void>,
  rows: () => readonly AuditAction[],
  held?: { readonly stated: StatedAudit; readonly statedIn: string },
): Promise<T> {
  const { audit } = change;
  const reason = isUnaudited(audit) ? audit[unauditedBecause] : undefined;
  if (!isUnaudited(audit) && !isLegacy(audit)) {
    const events = 'action' in audit ? [audit] : audit;
    if (events.length === 0) {
      throw new Error(
        `${opener}: the change returned an empty list of audit events, so nothing says why it records nothing. Return the event of what it changed, or { value, audit: unaudited(reason) } with a reason of NO_AUDIT_REASONS (packages/contracts/src/audit.ts) when it really writes no audit row. Nothing was committed.`,
      );
    }
    for (const event of events) await write(event);
  }

  const written = rows();
  if (reason !== undefined && written.length > 0) {
    throw new Error(
      `${opener}: the change returned unaudited('${reason}'), yet its callback wrote audit rows itself (${written.join(', ')}). Return those events as { value, audit } and let ${opener} write them, or return no unaudited(...). Nothing was committed.`,
    );
  }
  if (held === undefined) return change.value;

  const { stated, statedIn } = held;
  const allowed: readonly AuditAction[] = 'actions' in stated ? stated.actions : [];
  const unstated = [...new Set(written.filter((action) => !allowed.includes(action)))];
  if (unstated.length > 0) {
    throw new Error(
      `${opener}: the change recorded ${unstated.join(', ')}, which ${statedIn} does not state: it states ${describeStated(stated)}. Name every action the route writes in that statement, and give a new one its case in tests/integration/audit-failure.test.ts; or correct the event. Nothing was committed.`,
    );
  }
  // read_only says this run wrote nothing, which any route may find. The other reasons say
  // what was stored needs no audit row, and that is the route's statement to make.
  if (
    reason !== undefined &&
    reason !== 'read_only' &&
    !('none' in stated && stated.none === reason)
  ) {
    throw new Error(
      `${opener}: the change returned unaudited('${reason}'), but ${statedIn} states ${describeStated(stated)}. Return the audit event of what changed, or unaudited('read_only') when this run changed nothing. Nothing was committed.`,
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
      return record(
        'changeOrg',
        change,
        (event) => auditScoped(tx, event),
        () => auditRowsOn(tx),
        held,
      );
    },
    'changeOrg',
  );
}

/**
 * The same before the organisation is known (sign-in and sign-out, pairing, a confirmation
 * link): one transaction that starts with no organisation, where `fn` resolves a credential
 * with the sec.* wrappers and may then call `enterOrg`, as in `withResolvedOrg`. No permit:
 * there is no member yet whose role could be checked. The audit events `fn` returns are written
 * for the organisation it entered, or with no organisation when it entered none (a refusal
 * that names nobody's organisation). Since nothing checks a role here, lint keeps it to the
 * files of PRE_ORG_CHANGE_FILES in eslint.config.js.
 */
export async function changePreOrg<T>(
  pool: Pool,
  fn: (tx: PreOrgTx, enterOrg: (orgId: OrgId) => Promise<OrgTx>) => Promise<Change<T>>,
): Promise<T> {
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
        () => [pre, ...entered].flatMap((tx) => auditRowsOn(tx)),
      );
    },
    'changePreOrg',
  );
}
