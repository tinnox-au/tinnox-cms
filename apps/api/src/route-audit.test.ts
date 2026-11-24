/**
 * What every route audits (adoption plan section 2.1, step 17; D3): the start-up check, the two
 * tables against the routes the application really registers, and the list of actions as a
 * whole. No database: the application is built and never listens.
 */
import { AUDIT_ACTIONS, ROUTES, type AuditAction } from '@tinnox/contracts';
import { issueAuditStatement, termsOfStatement, type AuditStatement } from '@tinnox/db';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildApp } from './app.ts';
import { ROUTE_PERMISSIONS, type RouteRule } from './auth/permissions.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import {
  actionsOf,
  ATTEMPT_AUDITED_ACTIONS,
  audits,
  checkRouteAudit,
  createRouteAuditCheck,
  declaredRouteAudit,
  JOB_AUDIT,
  jobStatement,
  NO_AUDIT_REASONS,
  noAudit,
  OFF_ROUTE_AUDIT,
  OPERATOR_GUARD_AUDIT,
  OTHER_ROUTE_AUDIT,
  refusalStatement,
  routeStatement,
  type JobGrant,
  type OtherRouteAudit,
  type RouteGrant,
} from './route-audit.ts';

const OPERATOR: Record<string, RouteRule> = {
  'GET /api/media': { all: ['org.read'], audit: noAudit('read_only') },
  'POST /api/tags': {
    any: ['content.write', 'screen.setup'],
    refine: 'tagScopeFromBody',
    audit: audits('tag.create'),
  },
};
const OTHERS: Record<string, OtherRouteAudit> = {
  'POST /player/heartbeat': { audit: noAudit('telemetry'), guard: ['player.auth_rejected'] },
};
const REGISTERED = [
  'GET /api/media',
  'HEAD /api/media',
  'POST /api/tags',
  'POST /player/heartbeat',
];

describe('checkRouteAudit', () => {
  it('accepts routes that all say what they audit, with HEAD twins read as GET and preflights left out', () => {
    expect(
      checkRouteAudit(new Set([...REGISTERED, 'OPTIONS /player/*']), OPERATOR, OTHERS),
    ).toEqual([]);
  });

  it('reports a registered route that says nothing, with the two places to say it (D3)', () => {
    expect(
      checkRouteAudit(new Set([...REGISTERED, 'POST /player/screenshot']), OPERATOR, OTHERS),
    ).toEqual([
      'no audit statement for POST /player/screenshot: say what the route audits. An operator route gets a row in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts) built with write(rule, ...actions) or read(rule); any other route gets an entry in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts) with audits(...actions), or noAudit(reason) with a reason of NO_AUDIT_REASONS (D3). Then give each new action a case in tests/integration/audit-failure.test.ts',
    ]);
  });

  it('reports a statement for a route nobody registers, and a route stated in both tables', () => {
    expect(
      checkRouteAudit(new Set(['GET /api/media', 'POST /api/tags']), OPERATOR, OTHERS),
    ).toEqual([
      'audit statement POST /player/heartbeat in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts) matches no registered route: remove it, or correct its method and pattern',
    ]);
    const twice = { ...OTHERS, 'POST /api/tags': { audit: audits('tag.create'), guard: [] } };
    expect(checkRouteAudit(new Set(REGISTERED), OPERATOR, twice)).toEqual([
      'POST /api/tags states what it audits twice: keep its row in ROUTE_PERMISSIONS (apps/api/src/auth/permissions.ts) and remove the one in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts)',
    ]);
  });

  it('stops the start-up with every problem in one message', () => {
    const check = createRouteAuditCheck(OPERATOR);
    for (const route of ['GET /api/media', 'POST /api/tags', 'POST /api/unstated']) {
      const [method = '', url = ''] = route.split(' ');
      check.onRoute({ method, url } as RouteOptions);
    }
    expect(() => check.assertComplete()).toThrow(
      /^the audit statements of the routes are incomplete: no audit statement for POST \/api\/unstated: say what the route audits\./,
    );
  });
});

describe('declaredRouteAudit', () => {
  it("gives an operator write its own actions and the guards' refusals, and a read no guard row", () => {
    expect(declaredRouteAudit('POST /api/tags', OPERATOR, OTHERS)).toEqual({
      audit: { actions: ['tag.create'] },
      guard: OPERATOR_GUARD_AUDIT,
    });
    expect(declaredRouteAudit('HEAD /api/media', OPERATOR, OTHERS)).toEqual({
      audit: { none: 'read_only' },
      guard: [],
    });
    expect(declaredRouteAudit('POST /player/heartbeat', OPERATOR, OTHERS)).toEqual(
      OTHERS['POST /player/heartbeat'],
    );
    expect(declaredRouteAudit('POST /player/screenshot', OPERATOR, OTHERS)).toBeUndefined();
  });
});

/** The application without a database: it is built and never listens. */
async function builtApp(): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://tinnox_app:not-a-real-one@127.0.0.1:54329/tinnox_test',
    API_PUBLIC_ORIGIN: 'http://localhost:4000',
    PORTAL_ORIGIN: 'http://localhost:5173',
    PLAYER_ORIGIN: 'http://localhost:5174',
    SESSION_SECRET: 'not-a-real-session-secret-not-a-real-session-secret',
    MEDIA_URL_HMAC_SECRET: 'not-a-real-media-secret-not-a-real-media-secret',
    PAIRING_CLIENT_KEY_SECRET: 'not-a-real-pairing-secret-not-a-real-pairing-secret',
    OIDC_ISSUER: 'http://localhost:8080/realms/tinnox-dev',
    OIDC_CLIENT_ID: 'tinnox-portal-bff',
    OIDC_CLIENT_SECRET: 'not-a-real-client-secret-not-a-real-one',
    OIDC_REDIRECT_URI: 'http://localhost:5173/api/auth/callback',
    OIDC_POST_LOGOUT_REDIRECT_URI: 'http://localhost:5173/',
  });
  // Registering the routes reads the configuration only; nothing else here is ever called.
  const ctx = { config, pool: {}, now: () => new Date(0), rateLimitScale: 1 } as AppContext;
  return buildApp(ctx, { logger: false });
}

describe('the audit statements of the application', { timeout: 30_000 }, () => {
  it('starts: every route it registers says what it audits, and every statement has its route', async () => {
    // buildApp runs the start-up check itself and throws on a route that says nothing, or on
    // an entry of OTHER_ROUTE_AUDIT without a route.
    const app = await builtApp();
    try {
      const stated = [...Object.keys(ROUTE_PERMISSIONS), ...Object.keys(OTHER_ROUTE_AUDIT)];
      expect(stated).toHaveLength(62 + 14);
      for (const route of stated) {
        const [method = '', url = ''] = route.split(' ');
        expect(app.hasRoute({ method, url }), route).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  // D3: which routes write no audit row, and why. A change here is a decision.
  it('pins the routes outside the operator table that audit nothing, each with its reason', () => {
    const none = Object.entries(OTHER_ROUTE_AUDIT).flatMap(([route, { audit }]) =>
      'none' in audit ? [[route, audit.none]] : [],
    );
    expect(Object.fromEntries(none)).toEqual({
      'GET /healthz': 'read_only',
      'GET /readyz': 'read_only',
      'GET /api/auth/login': 'login_state',
      'GET /api/session': 'read_only',
      'GET /player/manifest': 'read_only',
      'POST /player/media-urls': 'read_only',
      'GET /player/media/:assetId': 'read_only',
      'POST /player/heartbeat': 'telemetry',
    });
    expect(Object.keys(NO_AUDIT_REASONS).sort()).toEqual(['login_state', 'read_only', 'telemetry']);
  });

  it('gives every audit action a writer, so an action nothing writes cannot stay in the list (D3)', () => {
    const byRoutes = new Set<AuditAction>();
    for (const rule of Object.values(ROUTE_PERMISSIONS)) {
      for (const action of actionsOf(rule.audit)) byRoutes.add(action);
    }
    for (const action of OPERATOR_GUARD_AUDIT) byRoutes.add(action);
    for (const { audit, guard } of Object.values(OTHER_ROUTE_AUDIT)) {
      for (const action of [...actionsOf(audit), ...guard]) byRoutes.add(action);
    }
    const offRoute = Object.keys(OFF_ROUTE_AUDIT);
    for (const action of offRoute) {
      expect(
        byRoutes.has(action as AuditAction),
        `${action} is written by a route: remove it from OFF_ROUTE_AUDIT`,
      ).toBe(false);
    }
    const unwritten = AUDIT_ACTIONS.filter(
      (action) => !byRoutes.has(action) && !offRoute.includes(action),
    );
    expect(
      unwritten,
      'an audit action needs a writer: name it in the row of the route that writes it (ROUTE_PERMISSIONS or OTHER_ROUTE_AUDIT), or in OFF_ROUTE_AUDIT with what writes it (apps/api/src/route-audit.ts). An action nothing writes is deleted from AUDIT_ACTIONS (D3)',
    ).toEqual([]);
    expect([...byRoutes, ...offRoute].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});

// Adoption plan step 20: a change with no operator behind it is held to a statement too. These
// are the statements it is given; who gives them is in auth/device.test.ts,
// auth/refusal.test.ts and jobs.test.ts, and changeOrg's side in packages/db/src/change.test.ts.
describe('the statements of the changes with no operator behind them (D3)', () => {
  const at = (method: string, url: string) => ({ method, routeOptions: { url } });
  const terms = (statement: AuditStatement) => termsOfStatement('a test', statement);

  it('a route outside the operator table states its entry in OTHER_ROUTE_AUDIT', () => {
    for (const [key, { audit, grants }] of Object.entries(OTHER_ROUTE_AUDIT)) {
      const [method = '', url = ''] = key.split(' ');
      // Made by issueAuditStatement, as changePreOrg requires (step 20 review).
      expect(routeStatement(at(method, url)), key).toEqual(
        issueAuditStatement({
          stated: audit,
          statedIn: `the entry of ${key} in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts)`,
          ...(grants === undefined ? {} : { grants }),
        }),
      );
    }
    // Fastify answers a HEAD with the route of its GET.
    expect(terms(routeStatement(at('HEAD', '/api/session'))).stated).toEqual({ none: 'read_only' });
  });

  it('only the pairing poll grants an unaudited counter: its wrong token under the limit (D3, step 20 review)', () => {
    const counting = Object.entries(OTHER_ROUTE_AUDIT)
      .filter(([, entry]) => entry.grants?.includes('counter_under_threshold') === true)
      .map(([key]) => key);
    expect(counting).toEqual([`GET ${ROUTES.playerPairingPollPattern}`]);
    expect(terms(routeStatement(at('POST', '/player/pairing'))).grants).not.toContain(
      'counter_under_threshold',
    );
  });

  it('grants each write the step 20 ruling leaves unaudited to what makes it, and to nothing else (DEC-38, CMS-36)', () => {
    // Who may say unaudited(reason) for a write that changed something: the pairing routes for
    // the expiry mark of sec.pairing_create and sec.pairing_poll, the alert check for its silent
    // close. The seed's reason is granted by no table: only by the offline permit
    // (changeOrgAsMigrator of @tinnox/db/migrate), which the API cannot import.
    const granting = Object.entries(OTHER_ROUTE_AUDIT)
      .filter(([, entry]) => entry.grants !== undefined)
      .map(([key, entry]) => [key, entry.grants]);
    expect(granting).toEqual([
      [`POST ${ROUTES.playerPairing}`, ['pairing_expired_by_time']],
      [
        `GET ${ROUTES.playerPairingPollPattern}`,
        ['counter_under_threshold', 'pairing_expired_by_time'],
      ],
    ]);
    const jobGrants = Object.entries(JOB_AUDIT).map(([name, row]) => [
      name,
      'grants' in row ? row.grants : undefined,
    ]);
    expect(jobGrants).toEqual([
      ['display_alerts', ['alert_closed_silently']],
      ['media_pipeline', undefined],
    ]);
    expect(terms(routeStatement(at('GET', ROUTES.playerPairingPollPattern))).grants).toEqual([
      'counter_under_threshold',
      'pairing_expired_by_time',
    ]);
    expect(terms(jobStatement('display_alerts')).grants).toEqual(['alert_closed_silently']);
    expect(terms(jobStatement('media_pipeline')).grants).toBeUndefined();
    // A route's grants and a job's are typed apart, and neither can name the seed.
    expectTypeOf<RouteGrant>().toEqualTypeOf<
      'counter_under_threshold' | 'pairing_expired_by_time'
    >();
    expectTypeOf<JobGrant>().toEqualTypeOf<'alert_closed_silently'>();
  });

  it('refuses an operator route and an unknown one: their changes go through the role guard', () => {
    for (const [method, url] of [
      ['POST', '/api/tags'],
      ['POST', '/player/screenshot'],
      ['GET', ''],
    ] as const) {
      expect(() => routeStatement(at(method, url))).toThrow(
        `a change ran on ${method} ${url}, which has no entry in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts), so nothing says what it audits. A route outside the operator table gets its entry there, with audits(...actions) or noAudit(reason). The change of an operator route goes through changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which holds it to its row of ROUTE_PERMISSIONS`,
      );
    }
  });

  it("a refusal states the guards of its route, and the route's own actions once the role guard let it through (SCR-32)", () => {
    const upload = ROUTE_PERMISSIONS['POST /api/media']?.audit ?? null;
    expect(upload).toEqual({ actions: ['media.upload'] });
    // Before the role guard: what requireOperator and permissionGuard record, and no more.
    expect(terms(refusalStatement(at('POST', '/api/media'), null)).stated).toEqual({
      actions: OPERATOR_GUARD_AUDIT,
    });
    expect(terms(refusalStatement(at('POST', '/api/media'), upload)).stated).toEqual({
      actions: [...OPERATOR_GUARD_AUDIT, 'media.upload'],
    });
    // A read is refused without a row, and a route that audits nothing adds nothing.
    expect(terms(refusalStatement(at('GET', '/api/media'), noAudit('read_only'))).stated).toEqual({
      actions: [],
    });
    // A route outside the operator table: its own guard, whatever is passed for the route.
    expect(refusalStatement(at('POST', '/api/auth/logout'), upload)).toEqual(
      issueAuditStatement({
        stated: { actions: ['security.csrf_rejected'] },
        statedIn:
          'the guard of POST /api/auth/logout in OTHER_ROUTE_AUDIT (apps/api/src/route-audit.ts)',
      }),
    );
    expect(terms(refusalStatement(at('POST', '/player/heartbeat'), null)).stated).toEqual({
      actions: ['player.auth_rejected'],
    });
    // The guards declaredRouteAudit gives for every operator write, and of the route's own
    // actions only the ones D2 lets a refusal record on its own (step 20 review).
    for (const [key, rule] of Object.entries(ROUTE_PERMISSIONS)) {
      const [method = '', url = ''] = key.split(' ');
      const declared = declaredRouteAudit(key, ROUTE_PERMISSIONS);
      expect(terms(refusalStatement(at(method, url), rule.audit)).stated, key).toEqual({
        actions: [
          ...(declared?.guard ?? []),
          ...actionsOf(rule.audit).filter((action) => ATTEMPT_AUDITED_ACTIONS.includes(action)),
        ],
      });
    }
    // A refused folder.create is a business-rule refusal: D3 writes no row for it.
    const folders = ROUTE_PERMISSIONS[`POST ${ROUTES.folders}`]?.audit ?? null;
    expect(folders).toEqual({ actions: ['folder.create'] });
    expect(terms(refusalStatement(at('POST', ROUTES.folders), folders)).stated).toEqual({
      actions: OPERATOR_GUARD_AUDIT,
    });
    // D2 names the upload refusals alone beside the guards'. Pairing, revocation and publishing
    // record a refused or failed attempt on the transaction of their own change, so a refusal
    // on its own never states them (step 20 review).
    expect(ATTEMPT_AUDITED_ACTIONS).toEqual(['media.upload']);
    for (const action of ['pairing.claim', 'player.revoke', 'publication.create'] as const) {
      const routes = Object.entries(ROUTE_PERMISSIONS).filter(([, rule]) =>
        actionsOf(rule.audit).includes(action),
      );
      expect(routes, action).not.toEqual([]);
      for (const [key, rule] of routes) {
        const [method = '', url = ''] = key.split(' ');
        expect(terms(refusalStatement(at(method, url), rule.audit)).stated, key).toEqual({
          actions: OPERATOR_GUARD_AUDIT,
        });
      }
    }
    // Every attempt-audited action is one an operator route states.
    const stated = Object.values(ROUTE_PERMISSIONS).flatMap((rule) => actionsOf(rule.audit));
    for (const action of ATTEMPT_AUDITED_ACTIONS) expect(stated, action).toContain(action);
  });

  it('a job states the actions OFF_ROUTE_AUDIT gives to its file, all of them and no other', () => {
    for (const [name, { file, audit }] of Object.entries(JOB_AUDIT)) {
      const written = Object.entries(OFF_ROUTE_AUDIT)
        .filter(([, by]) => by.includes(`(${file})`))
        .map(([action]) => action);
      expect(written, `${name} writes no action OFF_ROUTE_AUDIT gives to ${file}`).not.toEqual([]);
      expect(
        [...actionsOf(audit)].sort(),
        `the row of ${name} in JOB_AUDIT states what OFF_ROUTE_AUDIT says ${file} writes`,
      ).toEqual(written.sort());
    }
    // And no off-route action of the API is written by a job that has no row.
    const jobFiles = Object.values(JOB_AUDIT).map(({ file }) => `(${file})`);
    const byTheApi = Object.entries(OFF_ROUTE_AUDIT).filter(([, by]) => by.includes('(apps/api/'));
    for (const [action, by] of byTheApi) {
      expect(
        jobFiles.some((file) => by.includes(file)),
        `${action} is written off a route by the API: give its job a row in JOB_AUDIT`,
      ).toBe(true);
    }
  });
});
