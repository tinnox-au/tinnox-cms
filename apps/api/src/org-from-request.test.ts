/**
 * AG-2.3, LINT-6 (adoption plan step 18): the organisation a query runs for is an `OrgId`, which
 * only the lookups of @tinnox/db return, so nothing read from a request can be handed to
 * `withOrg`. The lint of step 10 (NO_ORG_FROM_REQUEST in eslint.config.js) reads names, and so
 * misses a value copied out of the request, a cast, a destructured handler parameter and an
 * API-local schema built with `.extend` or `.merge`. Each of those forms is here, and none
 * compiles: `npm run typecheck` reads this file, and an unused @ts-expect-error is an error.
 */
import { withOrg, type DeviceLookup, type OrgId, type OrgTx, type Pool } from '@tinnox/db';
import type { FastifyRequest } from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { OperatorSession } from './auth/session.ts';
import { accept, withOrgDecision, type Decision } from './db-helpers.ts';

type OrgRequest = FastifyRequest<{
  Params: { orgId: string };
  Querystring: { org_id: string };
  Body: { orgId: string; organisationId: string };
  Headers: { 'x-org-id': string };
}>;

const read = async (tx: OrgTx): Promise<number> => (await tx.query('SELECT 1')).rows.length;
const decide = async (tx: OrgTx): Promise<Decision<number>> => accept(await read(tx));

describe('the organisation never comes from the request (AG-2.3, LINT-6)', () => {
  it('the verified session and the device credential name it as an OrgId', () => {
    expectTypeOf<OperatorSession['orgId']>().toEqualTypeOf<OrgId>();
    expectTypeOf<DeviceLookup['orgId']>().toEqualTypeOf<OrgId>();
    expectTypeOf(withOrg).parameter(1).toEqualTypeOf<OrgId>();
    expectTypeOf(withOrgDecision).parameter(1).toEqualTypeOf<OrgId>();
  });

  it('a path parameter, a query, a body field and a header are strings, and withOrg refuses them', () => {
    // Never called: these lines are for the type checker.
    const cases = async (pool: Pool, request: OrgRequest, session: OperatorSession) => {
      await withOrg(pool, session.orgId, read);
      // @ts-expect-error a path parameter is a string, not an OrgId
      await withOrg(pool, request.params.orgId, read);
      // @ts-expect-error so is a query parameter
      await withOrg(pool, request.query.org_id, read);
      // @ts-expect-error and a body field
      await withOrg(pool, request.body.orgId, read);
      // @ts-expect-error and a header
      await withOrg(pool, request.headers['x-org-id'], read);
      // @ts-expect-error the API's own wrapper around withOrg takes an OrgId too
      await withOrgDecision(pool, request.body.orgId, decide);
    };
    expect(cases).toBeTypeOf('function');
  });

  it('nor does a value copied out of the request first (LINT-6)', () => {
    const cases = async (pool: Pool, request: OrgRequest) => {
      const input = request.body;
      // @ts-expect-error the copy is still a string
      await withOrg(pool, input.orgId, read);
      const { orgId } = request.params;
      // @ts-expect-error and so is a destructured field, under any name
      await withOrg(pool, orgId, read);
      const { organisationId: tenant } = input;
      // @ts-expect-error or taken from the copy and renamed
      await withOrg(pool, tenant, read);
    };
    expect(cases).toBeTypeOf('function');
  });

  it('nor a cast of the request to a type with an organisation field (LINT-6)', () => {
    const cases = async (pool: Pool, request: FastifyRequest) => {
      interface WithOrg {
        orgId: string;
      }
      // @ts-expect-error the cast names a string field; only a cast to OrgId itself would pass, and lint refuses that one
      await withOrg(pool, (request.body as { orgId: string }).orgId, read);
      // @ts-expect-error the same through a named type
      await withOrg(pool, (request.params as WithOrg).orgId, read);
    };
    expect(cases).toBeTypeOf('function');
  });

  it('nor a destructured handler parameter (LINT-6)', () => {
    const handler =
      (pool: Pool) =>
      async ({ params, body, headers }: OrgRequest): Promise<void> => {
        // @ts-expect-error the handler took the request apart; the parts are still strings
        await withOrg(pool, params.orgId, read);
        // @ts-expect-error a body field
        await withOrg(pool, body.organisationId, read);
        // @ts-expect-error a header
        await withOrg(pool, headers['x-org-id'], read);
      };
    expect(handler).toBeTypeOf('function');
  });

  it('nor the output of an API-local schema built with .extend or .merge (LINT-6)', () => {
    const cases = async (pool: Pool, request: FastifyRequest) => {
      const Base = z.object({ name: z.string() });
      const Extended = Base.extend({ orgId: z.uuid() });
      const Merged = Base.merge(z.object({ organisationId: z.string() }));
      // @ts-expect-error a parsed uuid is a string: zod cannot make an OrgId
      await withOrg(pool, Extended.parse(request.body).orgId, read);
      // @ts-expect-error nor can a merged schema
      await withOrg(pool, Merged.parse(request.body).organisationId, read);
    };
    expect(cases).toBeTypeOf('function');
  });
});
