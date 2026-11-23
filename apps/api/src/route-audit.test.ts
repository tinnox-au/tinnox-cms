/**
 * What every route audits (adoption plan section 2.1, step 17; D3): the start-up check, the two
 * tables against the routes the application really registers, and the list of actions as a
 * whole. No database: the application is built and never listens.
 */
import { AUDIT_ACTIONS, type AuditAction } from '@tinnox/contracts';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { ROUTE_PERMISSIONS, type RouteRule } from './auth/permissions.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import {
  actionsOf,
  audits,
  checkRouteAudit,
  createRouteAuditCheck,
  declaredRouteAudit,
  NO_AUDIT_REASONS,
  noAudit,
  OFF_ROUTE_AUDIT,
  OPERATOR_GUARD_AUDIT,
  OTHER_ROUTE_AUDIT,
  type OtherRouteAudit,
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
