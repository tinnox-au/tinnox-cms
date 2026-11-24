/**
 * The readiness route (`GET /readyz`): its database check is `ping(ctx.db)` from @tinnox/db, the
 * one statement the API sends on the pool itself (adoption plan step 15, AG-2.1). The route
 * reports each dependency as true or false and nothing else: no error text, no configuration.
 */
import { ROUTES } from '@tinnox/contracts';
import type { Pool } from '@tinnox/db/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support.ts';

const PROBE = 'SELECT 1';

/** A pool that records what is sent on it directly and can stop answering the liveness probe. */
function watched(pool: Pool, probe: { fails: boolean; sent: string[] }): Pool {
  return new Proxy(pool, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const call = value as (...args: unknown[]) => unknown;
      if (key !== 'query') return call.bind(target);
      return (text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string') probe.sent.push(text);
        return text === PROBE && probe.fails
          ? Promise.reject(new Error('Connection terminated unexpectedly'))
          : Reflect.apply(call, target, [text, ...rest]);
      };
    },
  });
}

describe('GET /readyz', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('answers 200 while the database, the storage and the job folders answer', async () => {
    const probe = { fails: false, sent: [] as string[] };
    t = await startTestApp({}, 1000, { wrapPool: (pool) => watched(pool, probe) });
    const response = await fetch(`${t.url}${ROUTES.readyz}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The test app has no identity provider and no media worker: both are reported, and
    // neither makes the API unready.
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: {
        database: true,
        storage: true,
        mediaJobs: true,
        identityProvider: false,
        mediaWorker: false,
      },
    });
    // The probe is one statement on the pool, with no transaction around it.
    expect(probe.sent.filter((text) => text === PROBE)).toHaveLength(1);
  });

  it('answers 503 with database false when the probe fails, and says nothing more', async () => {
    const probe = { fails: true, sent: [] as string[] };
    t = await startTestApp({}, 1000, { wrapPool: (pool) => watched(pool, probe) });
    const response = await fetch(`${t.url}${ROUTES.readyz}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      status: 'not_ready',
      checks: {
        database: false,
        storage: true,
        mediaJobs: true,
        identityProvider: false,
        mediaWorker: false,
      },
    });
    expect(body).not.toContain('Connection terminated');
  });

  it('answers /healthz without touching the database', async () => {
    const probe = { fails: true, sent: [] as string[] };
    t = await startTestApp({}, 1000, { wrapPool: (pool) => watched(pool, probe) });
    const before = probe.sent.length;
    const response = await fetch(`${t.url}${ROUTES.healthz}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(probe.sent.slice(before)).not.toContain(PROBE);
  });
});
