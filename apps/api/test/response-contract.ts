/**
 * The response-contract check of the integration harness (UTX-01, adoption plan step 23a).
 *
 * The portal and the player parse every answer with the shared schemas, and the API parses none
 * of its own: a field the server builds past a contract limit used to fail only in the browser,
 * as `invalid_response` (UTX-01: a sign-out address longer than LogoutResponseSchema allows).
 * startTestApp (support.ts) installs this check on every application it builds, so every
 * integration test that sends a request also checks the answer against ROUTE_RESPONSE_SCHEMAS
 * (packages/contracts/src/responses.ts).
 *
 * It lives in test code only: product code may not import a test file (rule (h) of
 * IMPORT_FACETS in eslint.config.js), and the entry points (src/main.ts, src/alerts-once.ts)
 * build the application with buildApp alone, so production never parses its own answers.
 */
import {
  PREFLIGHT_RESPONSE,
  responseContractGaps,
  responseContractProblem,
  ROUTE_RESPONSE_SCHEMAS,
  UNROUTED_RESPONSE,
  type ResponseContract,
} from '@tinnox/contracts/responses';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach } from 'vitest';

const mismatches: string[] = [];
const checked = new Set<string>();

/** The mismatches seen since the last call, which it clears. */
export function takeResponseContractMismatches(): string[] {
  return mismatches.splice(0);
}

/** The routes, as `${METHOD} ${pattern}`, whose answers the check has read in this file. */
export function routesCheckedForContract(): ReadonlySet<string> {
  return checked;
}

function bodyText(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  // A stream (stored bytes) or no body: nothing to parse.
  return undefined;
}

/**
 * Refuses an application whose registered `routes` and `table` (ROUTE_RESPONSE_SCHEMAS, unless a
 * test of this check gives its own) differ, then adds an onSend hook that checks every answer.
 * `routes` comes from registeredRoutes (support.ts): the route tables, which buildApp holds equal
 * to Fastify's onRoute list (createRouteAuditCheck) and refuses to start otherwise, so this reads
 * onRoute through them. Called after buildApp and before listen: a hook of the root instance runs
 * for the routes of every plugin, the operator and player groups included
 * (tests/integration/response-contract.test.ts shows it).
 */
export function installResponseContractCheck(
  app: FastifyInstance,
  routes: readonly string[],
  table: Readonly<Record<string, ResponseContract>> = ROUTE_RESPONSE_SCHEMAS,
): void {
  const gaps = responseContractGaps(routes, table);
  if (gaps.length > 0) {
    throw new Error(
      `the response contracts do not match the registered routes (UTX-01):\n${gaps.map((gap) => `  - ${gap}`).join('\n')}`,
    );
  }
  app.addHook('onSend', async (request, reply, payload) => {
    const pattern = request.routeOptions.url;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const route = pattern === undefined ? undefined : `${method} ${pattern}`;
    if (route !== undefined) checked.add(route);
    const rule =
      route === undefined
        ? UNROUTED_RESPONSE
        : method === 'OPTIONS'
          ? PREFLIGHT_RESPONSE
          : Object.hasOwn(table, route)
            ? table[route]
            : undefined;
    const header = reply.getHeader('content-type');
    const problem =
      rule === undefined
        ? 'has no row in ROUTE_RESPONSE_SCHEMAS (packages/contracts/src/responses.ts)'
        : responseContractProblem(rule, {
            status: reply.statusCode,
            contentType: typeof header === 'string' ? header : undefined,
            body: bodyText(payload),
          });
    if (problem !== null) mismatches.push(`${route ?? `${request.method} (no route)`} ${problem}`);
    return payload;
  });
}

function failOnMismatches(when: string): void {
  const seen = takeResponseContractMismatches();
  if (seen.length === 0) return;
  throw new Error(
    `${seen.length === 1 ? 'an answer' : `${String(seen.length)} answers`} ${when} broke the response contract the portal and the player parse it with (UTX-01):\n` +
      // One line per distinct mismatch: a loop over many requests repeats the same one.
      [...new Set(seen)]
        .map((mismatch) => {
          const times = seen.filter((other) => other === mismatch).length;
          return `  - ${mismatch}${times === 1 ? '' : ` (${String(times)} times)`}`;
        })
        .join('\n'),
  );
}

// Registered when a test file loads this module (through support.ts), so each test that sent a
// mismatching answer fails, and a hook of the file that did fails the file.
afterEach(() => {
  failOnMismatches('during this test');
});
afterAll(() => {
  failOnMismatches('in a hook of this file, outside its tests');
});
