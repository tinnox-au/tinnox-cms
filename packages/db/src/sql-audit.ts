// The audit rows that a change's own SQL statement wrote (D25; adoption plan step 20). One
// statement does that: provisioning's `pending`, which expires the invites of every organisation
// and writes an invite.cancel row for each in the same statement (RAW_AUDIT_INSERTS in
// eslint.config.js). Its change can return neither the events (the wrapper would write them a
// second time) nor `unaudited(reason)` (rows were written), so it returns what this module
// makes: the answer the database gave for that statement.
//
// In a file of its own because everything ./change.ts exports is part of the runtime entry
// (./index.ts), and the maker must not be: `auditedInSql` of ./definer.ts, which the
// '@tinnox/db/migrate' entry exports and lint keeps out of the API (AG-1.10), is the only caller
// of `issueSqlAudit`, and it takes the result of a statement the definer handle really sent.
// ./change.ts reads the value and refuses it when the statement wrote no row. No entry of the
// package exports this module (./entries.test.ts).
import type { AuditAction } from '@tinnox/contracts';

/** What the database answered for the statement, kept when the statement was sent. */
export interface SqlAuditReceipt {
  /** The action of the rows the statement wrote. */
  readonly action: AuditAction;
  /** How many rows it inserted: the count of the server's own command tag (INSERT 0 n). */
  readonly rows: number;
  /** The transaction handle the statement was sent for, so the rows are that transaction's. */
  readonly on: object;
}

/** Marks what `issueSqlAudit` returns. Not exported, so nothing else makes one. */
const writtenInSql: unique symbol = Symbol('auditedInSql');

/** What a change returns in place of its audit events when its own statement wrote the rows. */
export interface AuditedInSql {
  readonly [writtenInSql]: SqlAuditReceipt;
}

/** For `auditedInSql` of ./definer.ts alone (./entries.test.ts holds that). */
export function issueSqlAudit(receipt: SqlAuditReceipt): AuditedInSql {
  return Object.freeze({ [writtenInSql]: Object.freeze({ ...receipt }) });
}

export const isAuditedInSql = (audit: object): audit is AuditedInSql => writtenInSql in audit;

export const receiptOf = (audit: AuditedInSql): SqlAuditReceipt => audit[writtenInSql];
