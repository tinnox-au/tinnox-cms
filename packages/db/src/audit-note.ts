// Which audit actions were written on each transaction handle. The two audit writers of
// ./sec.ts note every row here, and changeOrg and changePreOrg (./change.ts) read the notes
// before COMMIT, to compare what a change recorded with what its route says it audits (adoption
// plan step 19). So a row a callback still writes by hand with auditScoped counts like one the
// wrapper wrote from what the callback returned. In a file of its own because everything
// ./sec.ts exports is part of the runtime entry (./index.ts), and this is not: no entry of the
// package exports this module.
import type { AuditAction } from '@tinnox/contracts';

// Keyed by the handle, so the notes go when the handle does, with its transaction.
const written = new WeakMap<object, AuditAction[]>();

/** Called by auditScoped and auditUnscoped, once the row is in. */
export function noteAuditRow(tx: object, action: AuditAction): void {
  const actions = written.get(tx);
  if (actions === undefined) written.set(tx, [action]);
  else actions.push(action);
}

/** The actions of the audit rows written on `tx` so far, in the order they were written. */
export function auditRowsOn(tx: object): readonly AuditAction[] {
  return written.get(tx) ?? [];
}
