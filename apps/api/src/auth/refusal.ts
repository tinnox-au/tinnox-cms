/**
 * The audit row of a refusal that changed nothing, in a transaction of its own (SCR-32, D2;
 * adoption plan step 20): a request the guards turned away (`security.csrf_rejected`,
 * `security.permission_denied`), or an attempt at an upload that was refused or failed before
 * any row was written (D3 audits every attempt at an upload, whatever its result).
 *
 * It cannot use the permit of an operator's write (./permissions.ts): that one reads the role
 * again first, and would refuse the request a second time instead of recording that it was
 * refused. So this module issues a permit of its own. It reads nothing again, and what it
 * allows is one thing: the transaction is given the event and no callback, so nothing but the
 * audit row can be written in it, and the event is typed and checked to be a refusal, never a
 * success. The permit carries what the route's guards, and the route itself, may record
 * (`refusalStatement` in ../route-audit.ts), and `changeOrg` holds the row to that.
 */
import { changeOrg, issueWritePermit, termsOfStatement, type AuditInput } from '@tinnox/db';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { refusalStatement } from '../route-audit.ts';
import type { OperatorSession } from './session.ts';

/** What a refusal records: an event whose result is `denied` or `failure`, never `success`. */
export type RefusalEvent = AuditInput & { readonly result: 'denied' | 'failure' };

/**
 * Writes `event`, the refusal of this request, for the organisation of `session`:
 *
 *   BEGIN; set the organisation; the audit row; COMMIT
 *
 * Nothing else: the refused request changed nothing, and this adds only its trace. The caller
 * decides what a failure to write it means (the guards log it and keep the refusal).
 */
export async function recordRefusal(
  ctx: AppContext,
  request: FastifyRequest,
  session: OperatorSession,
  event: RefusalEvent,
): Promise<void> {
  // A success would be the audit row of a change that this transaction does not hold.
  const result: string = event.result;
  if (result !== 'denied' && result !== 'failure') {
    throw new Error(
      `recordRefusal writes the audit row of a refusal, and was given an event whose result is ${result}. A change and its audit row commit together: return the event from the change, as { value, audit } in changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts)`,
    );
  }
  // The row of the route is known once the role guard has let the request through.
  const statement = refusalStatement(request, request.permission?.audit ?? null);
  const permit = issueWritePermit({
    ...termsOfStatement('recordRefusal', statement),
    // Nothing to read again: the request is already refused, whatever the role is now.
    recheck: () => Promise.resolve(),
  });
  await changeOrg(ctx.pool, session.orgId, permit, () =>
    Promise.resolve({ value: undefined, audit: event }),
  );
}
