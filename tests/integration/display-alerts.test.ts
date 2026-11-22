/**
 * E-mail alerts for screens (CMS-15, docs/portal-v2/stage-c-alerts.md section 7): the check
 * (runDisplayAlerts) against real heartbeats and a moved application clock, the alert address
 * routes and the public confirmation route. E-mail goes to the recording mailer of the test app.
 *
 * The check runs over every organisation in the shared test database, so each case reads only
 * its own screens' e-mails (by screen name) and its own organisation's audit rows.
 */
import { randomBytes } from 'node:crypto';
import { localWallClock, type AlertRecipientDto } from '@tinnox/contracts';
import { alertRecipientByTokenHash, poolAsTx, sha256 } from '@tinnox/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addAlertAddress,
  addMember,
  appClient,
  asMigratorIn,
  auditEvents,
  checkAlerts,
  confirmAlertAddress,
  createDisplay,
  createOrg,
  heartbeatBody,
  lastConfirmationToken,
  pairPlayer,
  PORTAL_ORIGIN,
  sendHeartbeat,
  signIn,
  startTestApp,
  statementHolds,
  type Operator,
  type PairedPlayer,
  type StatementHold,
  type TestApp,
  type TestOrg,
} from './support.ts';

const DELAY_MS = 31 * 60 * 1000;

describe('e-mail alerts for screens', () => {
  let t: TestApp;
  let org: TestOrg;
  let owner: Operator;
  let seq = 1;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg('Alerts');
    owner = await signIn(t, org);
    await addConfirmed(t, owner, 'ops@example.com');
    // Waiting for confirmation: receives nothing.
    expect((await addAlertAddress(owner, 'waiting@example.com')).status).toBe(201);
  });
  afterAll(async () => {
    await t.close();
  });

  /** A paired screen that has just reported. */
  async function reportingScreen(
    name: string,
    operator = owner,
  ): Promise<{ id: string; player: PairedPlayer }> {
    const display = await createDisplay(operator, org, name);
    const player = await pairPlayer(t, operator, display.id);
    await report(display.id, player);
    return { id: display.id, player };
  }
  async function report(displayId: string, player: PairedPlayer): Promise<void> {
    seq += 1;
    expect((await sendHeartbeat(t, player, heartbeatBody(displayId, seq))).status).toBe(200);
  }
  const mailFor = (name: string) => t.sentMail.filter((m) => m.subject.endsWith(`: ${name}`));
  async function later<T>(work: () => Promise<T>): Promise<T> {
    t.advanceClock(DELAY_MS);
    try {
      return await work();
    } finally {
      t.advanceClock(-DELAY_MS);
    }
  }
  async function check(): Promise<void> {
    expect((await checkAlerts(t)).failed).toBe(0);
  }
  const openEpisodes = async (displayId: string) => {
    const client = await appClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      const { rowCount } = await client.query('SELECT 1 FROM display_alert WHERE display_id = $1', [
        displayId,
      ]);
      await client.query('COMMIT');
      return rowCount;
    } finally {
      await client.end();
    }
  };

  it('sends one offline e-mail per confirmed address after the delay, once, then one when it reports again', async () => {
    const screen = await reportingScreen('Alert foyer');
    await check();
    expect(mailFor('Alert foyer')).toEqual([]);

    await later(async () => {
      await check();
      expect(mailFor('Alert foyer')).toEqual([
        expect.objectContaining({
          to: 'ops@example.com',
          subject: 'Screen not reporting: Alert foyer',
        }),
      ]);
      expect(mailFor('Alert foyer')[0]?.text).toContain(`${PORTAL_ORIGIN}/screens/${screen.id}`);
      // A second run finds the episode claimed and sends nothing.
      await check();
      expect(mailFor('Alert foyer')).toHaveLength(1);

      await report(screen.id, screen.player);
      await check();
      expect(mailFor('Alert foyer').map((m) => [m.to, m.subject])).toEqual([
        ['ops@example.com', 'Screen not reporting: Alert foyer'],
        ['ops@example.com', 'Screen reporting again: Alert foyer'],
      ]);
    });
    expect(await openEpisodes(screen.id)).toBe(0);
    const audit = (await auditEvents(owner, '&category=display')).filter(
      (e) => e.objectId === screen.id && e.action !== 'display.create',
    );
    expect(audit.map((e) => [e.action, e.actorId, e.detail])).toEqual([
      ['display.online_alert', null, { recipients: 1 }],
      ['display.offline_alert', null, { recipients: 1 }],
    ]);
  });

  it('does not alert outside working hours', async () => {
    const screen = await reportingScreen('Alert closed');
    // Open only on a day three days from now (site zone): closed for the whole check.
    const today = localWallClock(t.ctx.now().getTime(), 'Australia/Melbourne')?.day ?? 0;
    const hours = Array.from({ length: 7 }, (_, day) =>
      day === (today + 3) % 7 ? { start: '00:00', end: '24:00' } : null,
    );
    const saved = await owner.fetch(`/api/displays/${screen.id}`, {
      method: 'PATCH',
      json: { workingHours: hours },
    });
    expect(saved.status).toBe(200);
    await later(check);
    expect(mailFor('Alert closed')).toEqual([]);
    expect(await openEpisodes(screen.id)).toBe(0);
  });

  it('closes the episode of a re-paired screen without an e-mail, and does not alert on its old report', async () => {
    const screen = await reportingScreen('Alert repaired');
    await later(async () => {
      await check();
      expect(mailFor('Alert repaired')).toHaveLength(1);
      await pairPlayer(t, owner, screen.id);
      await check();
    });
    expect(mailFor('Alert repaired')).toHaveLength(1);
    expect(await openEpisodes(screen.id)).toBe(0);
    // The new player has not reported yet: still nothing, however long it stays silent.
    t.advanceClock(2 * DELAY_MS);
    try {
      await check();
    } finally {
      t.advanceClock(-2 * DELAY_MS);
    }
    expect(mailFor('Alert repaired')).toHaveLength(1);
  });

  it('sends the reporting-again e-mail once a re-paired screen’s new player has reported', async () => {
    const screen = await reportingScreen('Alert swapped');
    await later(async () => {
      await check();
      // A technician swaps the player: the new one reports before the next check.
      const replacement = await pairPlayer(t, owner, screen.id);
      await report(screen.id, replacement);
      await check();
    });
    expect(mailFor('Alert swapped').map((m) => m.subject)).toEqual([
      'Screen not reporting: Alert swapped',
      'Screen reporting again: Alert swapped',
    ]);
    expect(await openEpisodes(screen.id)).toBe(0);
    const audit = (await auditEvents(owner, '&category=display')).filter(
      (e) => e.objectId === screen.id && e.action.endsWith('_alert'),
    );
    expect(audit.map((e) => e.action)).toEqual(['display.online_alert', 'display.offline_alert']);
  });

  it('sends no reporting-again e-mail when that choice is off', async () => {
    const screen = await reportingScreen('Alert no recovery');
    const saved = await owner.fetch(`/api/displays/${screen.id}`, {
      method: 'PATCH',
      json: { alertBackOnline: false },
    });
    expect(saved.status).toBe(200);
    await later(async () => {
      await check();
      await report(screen.id, screen.player);
      await check();
    });
    expect(mailFor('Alert no recovery').map((m) => m.subject)).toEqual([
      'Screen not reporting: Alert no recovery',
    ]);
    expect(await openEpisodes(screen.id)).toBe(0);
    const audit = (await auditEvents(owner, '&category=display')).filter(
      (e) => e.objectId === screen.id && e.action.endsWith('_alert'),
    );
    expect(audit.map((e) => e.action)).toEqual(['display.offline_alert']);
  });

  it('lets an Editor turn alerts off, which sends nothing and closes an open episode silently', async () => {
    const editor = await signIn(t, await addMember(org, 'editor'));
    const screen = await reportingScreen('Alert off', editor);
    await later(async () => {
      await check();
      expect(mailFor('Alert off')).toHaveLength(1);
      const off = await editor.fetch(`/api/displays/${screen.id}`, {
        method: 'PATCH',
        json: { alertOfflineMinutes: null, alertBackOnline: false },
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ alertOfflineMinutes: null, alertBackOnline: false });
      await check();
      await report(screen.id, screen.player);
      await check();
    });
    expect(mailFor('Alert off')).toHaveLength(1);
    expect(await openEpisodes(screen.id)).toBe(0);
    const update = (await auditEvents(owner, '&category=display')).find(
      (e) => e.objectId === screen.id && e.action === 'display.update',
    );
    expect(update?.detail).toEqual({ fields: ['alertBackOnline', 'alertOfflineMinutes'] });
  });

  it('refuses an offline delay outside 30 minutes to 48 hours in half hours', async () => {
    const display = await createDisplay(owner, org, 'Alert bounds');
    for (const minutes of [0, 15, 45, 2910]) {
      const response = await owner.fetch(`/api/displays/${display.id}`, {
        method: 'PATCH',
        json: { alertOfflineMinutes: minutes },
      });
      expect(response.status, String(minutes)).toBe(400);
    }
    const saved = await owner.fetch(`/api/displays/${display.id}`, {
      method: 'PATCH',
      json: { alertOfflineMinutes: 120 },
    });
    expect(await saved.json()).toMatchObject({ alertOfflineMinutes: 120, alertBackOnline: true });
  });

  it('records the transition with no confirmed address, and a later confirmation does not send it', async () => {
    const quiet = await createOrg('Alerts without addresses');
    const quietOwner = await signIn(t, quiet);
    const display = await createDisplay(quietOwner, quiet, 'Quiet screen');
    const player = await pairPlayer(t, quietOwner, display.id);
    seq += 1;
    expect((await sendHeartbeat(t, player, heartbeatBody(display.id, seq))).status).toBe(200);
    await later(async () => {
      await check();
      await addConfirmed(t, quietOwner, 'late@example.com');
      await check();
    });
    expect(mailFor('Quiet screen')).toEqual([]);
    const audit = (await auditEvents(quietOwner, '&category=display')).filter(
      (e) => e.action === 'display.offline_alert',
    );
    expect(audit.map((e) => [e.objectId, e.detail])).toEqual([[display.id, { recipients: 0 }]]);
  });

  it('claims and closes a report time with microseconds, compared at millisecond precision', async () => {
    const screen = await reportingScreen('Alert micro');
    // Any writer other than the heartbeat route (SQL now(), say) can store microseconds.
    await asMigratorIn(org.orgId, (client) =>
      client.query(
        "UPDATE display_delivery SET last_heartbeat_at = last_heartbeat_at + interval '123 microseconds' WHERE display_id = $1",
        [screen.id],
      ),
    );
    await later(async () => {
      await check();
      expect(mailFor('Alert micro').map((m) => m.subject)).toEqual([
        'Screen not reporting: Alert micro',
      ]);
      await report(screen.id, screen.player);
      await check();
    });
    expect(mailFor('Alert micro').map((m) => m.subject)).toEqual([
      'Screen not reporting: Alert micro',
      'Screen reporting again: Alert micro',
    ]);
    expect(await openEpisodes(screen.id)).toBe(0);
  });

  it('records a refused send as failed and does not resend it; a stopping run claims nothing', async () => {
    const screen = await reportingScreen('Alert bounce');
    const refusing = {
      send: () => Promise.reject(Object.assign(new Error('421'), { code: 'ECONNECTION' })),
    };
    await later(async () => {
      // Shutting down: stops before the first organisation, so nothing is claimed.
      expect(await checkAlerts(t, { shouldStop: () => true })).toMatchObject({
        skipped: false,
        offline: 0,
        failed: 0,
      });
      expect(await openEpisodes(screen.id)).toBe(0);

      const refused = await checkAlerts(t, { mail: refusing });
      expect(refused.offline).toBeGreaterThanOrEqual(1);
      expect(refused.failed).toBeGreaterThanOrEqual(1);
      expect(await openEpisodes(screen.id)).toBe(1);
      // At most once: the claimed transition is not mailed again by a later run.
      await check();
    });
    expect(mailFor('Alert bounce')).toEqual([]);
    const audit = (await auditEvents(owner, '&category=display')).filter(
      (e) => e.objectId === screen.id && e.action === 'display.offline_alert',
    );
    expect(audit.map((e) => e.detail)).toEqual([{ recipients: 1 }]);
  });

  it('skips while another runner holds the lock, and two runs at once send once', async () => {
    const screen = await reportingScreen('Alert race');
    const holder = await appClient();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('tinnox.display_alerts', 0))");
      expect(await later(() => checkAlerts(t))).toMatchObject({ skipped: true, offline: 0 });
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('tinnox.display_alerts', 0))");
    } finally {
      await holder.end();
    }
    expect(mailFor('Alert race')).toEqual([]);
    const results = await later(() => Promise.all([checkAlerts(t), checkAlerts(t)]));
    expect(results.map((r) => r.failed)).toEqual([0, 0]);
    expect(mailFor('Alert race')).toHaveLength(1);
    expect(await openEpisodes(screen.id)).toBe(1);
  });

  it('mails every confirmed address, and not one removed during the run', async () => {
    const pair = await createOrg('Alerts two addresses');
    const pairOwner = await signIn(t, pair);
    // Sent in address order: a-first before b-second.
    await addConfirmed(t, pairOwner, 'a-first@example.com');
    const second = await addConfirmed(t, pairOwner, 'b-second@example.com');
    const display = await createDisplay(pairOwner, pair, 'Alert pair');
    const player = await pairPlayer(t, pairOwner, display.id);
    await report(display.id, player);
    let removed = 0;
    // Removes b-second while a-first's reporting-again e-mail is being sent.
    const removing = {
      send: async (message: (typeof t.sentMail)[number]) => {
        if (
          message.to === 'a-first@example.com' &&
          message.subject.startsWith('Screen reporting')
        ) {
          const response = await pairOwner.fetch(`/api/alert-recipients/${second}`, {
            method: 'DELETE',
          });
          removed = response.status;
        }
        t.sentMail.push(message);
      },
    };
    await later(async () => {
      await check();
      await report(display.id, player);
      expect((await checkAlerts(t, { mail: removing })).failed).toBe(0);
    });
    expect(removed).toBe(204);
    expect(mailFor('Alert pair').map((m) => [m.to, m.subject])).toEqual([
      ['a-first@example.com', 'Screen not reporting: Alert pair'],
      ['b-second@example.com', 'Screen not reporting: Alert pair'],
      ['a-first@example.com', 'Screen reporting again: Alert pair'],
    ]);
  });

  it('stops claiming when the lock connection is lost, and still sends what it claimed', async () => {
    // Two organisations, each with a due screen; `first` is checked first (ids in order).
    const made: { org: TestOrg; name: string; displayId: string }[] = [];
    for (const i of [1, 2]) {
      // One at a time: addConfirmed reads the newest confirmation e-mail.
      const o = await createOrg(`Alerts lock ${i}`);
      const op = await signIn(t, o);
      await addConfirmed(t, op, `lock${i}@example.com`);
      const display = await createDisplay(op, o, `Alert lock ${i}`);
      const player = await pairPlayer(t, op, display.id);
      await report(display.id, player);
      made.push({ org: o, name: `Alert lock ${i}`, displayId: display.id });
    }
    const [first, second] = [...made].sort((x, y) => (x.org.orgId < y.org.orgId ? -1 : 1));
    if (first === undefined || second === undefined) throw new Error('two organisations');
    let terminated = false;
    // On the first e-mail of either screen, ends the run's lock connection.
    const cutting = {
      send: async (message: (typeof t.sentMail)[number]) => {
        if (!terminated && made.some((m) => message.subject.endsWith(`: ${m.name}`))) {
          terminated = true;
          const killer = await appClient();
          try {
            const { rows } = await killer.query<{ pid: number }>(
              `SELECT l.pid FROM pg_locks l,
                 LATERAL (SELECT hashtextextended('tinnox.display_alerts', 0) AS k) h
               WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
                 AND l.classid = ((h.k >> 32) & 4294967295)::oid
                 AND l.objid = (h.k & 4294967295)::oid`,
            );
            const pid = rows[0]?.pid;
            expect(pid).toBeDefined();
            await killer.query('SELECT pg_terminate_backend($1)', [pid]);
            // Gives the client time to see the connection end.
            for (let i = 0; i < 50; i += 1) {
              const left = await killer.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
                pid,
              ]);
              if (left.rowCount === 0) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          } finally {
            await killer.end();
          }
        }
        t.sentMail.push(message);
      },
    };
    const countEpisodes = async (orgId: string, displayId: string) => {
      const client = await appClient();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        const { rowCount } = await client.query(
          'SELECT 1 FROM display_alert WHERE display_id = $1',
          [displayId],
        );
        await client.query('COMMIT');
        return rowCount;
      } finally {
        await client.end();
      }
    };
    await later(async () => {
      const stopped = await checkAlerts(t, { mail: cutting });
      expect(terminated).toBe(true);
      expect(stopped.failed).toBeGreaterThanOrEqual(1);
      expect(mailFor(first.name).map((m) => m.subject)).toEqual([
        `Screen not reporting: ${first.name}`,
      ]);
      expect(mailFor(second.name)).toEqual([]);
      expect(await countEpisodes(second.org.orgId, second.displayId)).toBe(0);
      // The next run takes the lock again and claims the rest.
      await check();
    });
    expect(mailFor(second.name).map((m) => m.subject)).toEqual([
      `Screen not reporting: ${second.name}`,
    ]);
  });
});

describe('alert addresses', () => {
  let t: TestApp;
  let org: TestOrg;
  let owner: Operator;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg('Alert addresses');
    owner = await signIn(t, org);
  });
  afterAll(async () => {
    await t.close();
  });

  it('adds an address in lower case, sends the confirmation link, lists and removes it, never auditing the address', async () => {
    const added = await addAlertAddress(owner, ' New.Person@Example.com ');
    expect(added.status).toBe(201);
    const dto = (await added.json()) as AlertRecipientDto;
    expect(dto).toMatchObject({ email: 'new.person@example.com', status: 'waiting' });
    const mail = t.sentMail.at(-1);
    expect(mail?.to).toBe('new.person@example.com');
    expect(mail?.subject).toBe('Confirm alert e-mails from TINNOX CMS');
    expect(mail?.text).toMatch(/http:\/\/localhost:5173\/alerts\/confirm#[A-Za-z0-9_-]{43}\n/);
    expect(mail?.text).toContain('Alert addresses asked to send screen alerts to this address.');

    const duplicate = await addAlertAddress(owner, 'NEW.PERSON@example.com');
    expect(duplicate.status).toBe(409);
    const list = (await (await owner.fetch('/api/alert-recipients')).json()) as {
      items: AlertRecipientDto[];
    };
    expect(list.items).toEqual([dto]);

    expect(
      (await owner.fetch(`/api/alert-recipients/${dto.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect(
      (await owner.fetch(`/api/alert-recipients/${dto.id}`, { method: 'DELETE' })).status,
    ).toBe(404);
    const audit = (await auditEvents(owner, '&category=alert_recipient')).map((e) => [
      e.action,
      e.objectId,
      e.detail,
    ]);
    expect(audit).toEqual([
      ['alert_recipient.remove', dto.id, null],
      ['alert_recipient.add', dto.id, null],
    ]);
    expect(JSON.stringify(await auditEvents(owner))).not.toContain('new.person');
  });

  it('refuses an address that is not one, and unknown fields', async () => {
    expect((await addAlertAddress(owner, 'not an address')).status).toBe(400);
    const planted = await owner.fetch('/api/alert-recipients', {
      method: 'POST',
      json: { email: 'a@example.com', orgId: org.orgId },
    });
    expect(planted.status).toBe(400);
  });

  it('keeps at most 20 addresses', async () => {
    const full = await createOrg('Full alert list');
    const fullOwner = await signIn(t, full);
    for (let i = 0; i < 20; i += 1) {
      expect((await addAlertAddress(fullOwner, `person${i}@example.com`)).status).toBe(201);
    }
    const refused = await addAlertAddress(fullOwner, 'one-more@example.com');
    expect(refused.status).toBe(409);
  });

  it('confirms once: used, unknown and expired links all answer the same 404', async () => {
    const id = await addConfirmed(t, owner, 'confirmed@example.com');
    const used = lastConfirmationToken(t);
    const listed = (await (await owner.fetch('/api/alert-recipients')).json()) as {
      items: AlertRecipientDto[];
    };
    expect(listed.items.find((r) => r.id === id)?.status).toBe('confirmed');

    const expiredId = (
      (await (await addAlertAddress(owner, 'late@example.com')).json()) as { id: string }
    ).id;
    const expired = lastConfirmationToken(t);
    await asMigratorIn(org.orgId, (client) =>
      client.query(
        "UPDATE alert_recipient SET confirm_expires_at = now() - interval '1 second' WHERE id = $1",
        [expiredId],
      ),
    );
    const answers = [];
    for (const token of [used, expired, randomBytes(32).toString('base64url')]) {
      const response = await confirmAlertAddress(t, token);
      expect(response.status).toBe(404);
      answers.push(((await response.json()) as { error: { code: string; message: string } }).error);
    }
    expect(new Set(answers.map((a) => `${a.code} ${a.message}`))).toEqual(
      new Set(['not_found This link is not valid any more.']),
    );
    const after = (await (await owner.fetch('/api/alert-recipients')).json()) as {
      items: AlertRecipientDto[];
    };
    expect(after.items.find((r) => r.id === expiredId)?.status).toBe('expired');
    const audit = (await auditEvents(owner, '&category=alert_recipient')).filter(
      (e) => e.action === 'alert_recipient.confirm',
    );
    expect(audit.map((e) => [e.objectId, e.actorId])).toEqual([[id, null]]);
  });

  it('confirms only the organisation the link was made for, and hides one organisation’s addresses from another', async () => {
    const other = await createOrg('Other alert addresses');
    const otherOwner = await signIn(t, other);
    const theirs = (
      (await (await addAlertAddress(otherOwner, 'theirs@example.com')).json()) as {
        id: string;
      }
    ).id;
    expect((await confirmAlertAddress(t, lastConfirmationToken(t))).status).toBe(204);
    const mine = await (await owner.fetch('/api/alert-recipients')).text();
    expect(mine).not.toContain('theirs@example.com');
    expect(mine).not.toContain(theirs);
    // Another organisation's id answers like an unknown one.
    const foreign = await owner.fetch(`/api/alert-recipients/${theirs}`, { method: 'DELETE' });
    expect(foreign.status).toBe(404);
    const theirList = (await (await otherOwner.fetch('/api/alert-recipients')).json()) as {
      items: AlertRecipientDto[];
    };
    expect(theirList.items).toEqual([expect.objectContaining({ id: theirs, status: 'confirmed' })]);
  });

  it('adds nothing when e-mail is not set up, and keeps a waiting address when the confirmation e-mail fails', async () => {
    const noMail = await startTestApp({}, 1000, { mail: null });
    const failing = await startTestApp({}, 1000, {
      mail: { send: () => Promise.reject(new Error('550 mailbox unavailable')) },
    });
    try {
      const a = await signIn(noMail, await createOrg('No mail'));
      expect((await addAlertAddress(a, 'nobody@example.com')).status).toBe(503);
      expect(await (await a.fetch('/api/alert-recipients')).json()).toEqual({ items: [] });

      const b = await signIn(failing, await createOrg('Failing mail'));
      expect((await addAlertAddress(b, 'bounced@example.com')).status).toBe(503);
      expect(await (await b.fetch('/api/alert-recipients')).json()).toMatchObject({
        items: [{ email: 'bounced@example.com', status: 'waiting' }],
      });
    } finally {
      await noMail.close();
      await failing.close();
    }
  });
});

/**
 * D22: a pending address dies with the access of the member who added it. One predicate in
 * apps/api/src/routes/alert-recipients.ts decides both what the link is answered and what the
 * list shows. The reactivation case needs provision-member and is in provision-member.test.ts.
 */
describe('alert addresses and the member who added them (D22)', () => {
  const holds = statementHolds();
  let t: TestApp;
  let org: TestOrg;
  let owner: Operator;

  beforeAll(async () => {
    t = await startTestApp({}, 1000, { wrapPool: holds.wrapPool });
    org = await createOrg('Alert address adders');
    owner = await signIn(t, org);
  });
  afterAll(async () => {
    await t.close();
  });

  interface Pending {
    readonly member: TestOrg;
    readonly id: string;
    readonly token: string;
  }

  /** A new Admin and one address they added, waiting, with the token of its link. */
  async function pendingFrom(email: string): Promise<Pending> {
    const member = await addMember(org, 'admin');
    const added = await addAlertAddress(await signIn(t, member), email);
    expect(added.status).toBe(201);
    const dto = (await added.json()) as AlertRecipientDto;
    expect(dto.status).toBe('waiting');
    return { member, id: dto.id, token: lastConfirmationToken(t) };
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const list = (await (await owner.fetch('/api/alert-recipients')).json()) as {
      items: AlertRecipientDto[];
    };
    return list.items.find((r) => r.id === id)?.status;
  }

  /**
   * The status and body a link is answered with (a confirmation has no body), less the request
   * id, which differs for every answer.
   */
  async function answerTo(token: string): Promise<{ status: number; body: unknown }> {
    const response = await confirmAlertAddress(t, token);
    const text = await response.text();
    if (text === '') return { status: response.status, body: null };
    const body = JSON.parse(text) as { error: Record<string, unknown> };
    return { status: response.status, body: { error: { ...body.error, requestId: null } } };
  }

  /** The link is answered exactly as a token nobody was sent, and the list shows Expired. */
  async function expectDead(pending: Pending): Promise<void> {
    const unknown = await answerTo(randomBytes(32).toString('base64url'));
    expect(unknown.status).toBe(404);
    expect(await answerTo(pending.token)).toEqual(unknown);
    expect(await statusOf(pending.id)).toBe('expired');
  }

  const post = (path: string) => owner.fetch(path, { method: 'POST' });
  const signOutEverywhere = (member: TestOrg) =>
    post(`/api/members/${member.membershipId}/sign-out`);

  /** True when the promise is still pending after a short wait. */
  async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    const mark = (): void => {
      settled = true;
    };
    promise.then(mark, mark);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return !settled;
  }

  it('D22: after the adder is removed, the link answers 404 like an unknown one and the list shows Expired', async () => {
    const pending = await pendingFrom('adder-removed@example.com');
    expect(await statusOf(pending.id)).toBe('waiting');
    expect((await post(`/api/members/${pending.member.membershipId}/remove`)).status).toBe(200);
    await expectDead(pending);
    // Refused, so nothing was confirmed or audited.
    const confirmations = (await auditEvents(owner, '&category=alert_recipient')).filter(
      (e) => e.action === 'alert_recipient.confirm' && e.objectId === pending.id,
    );
    expect(confirmations).toEqual([]);
  });

  it('D22: an adder who is no longer a member ends the address even when no cut-off was set', async () => {
    const pending = await pendingFrom('adder-gone-no-cut-off@example.com');
    // Every removal in the product also sets the cut-off, so only a direct write leaves the
    // "still a member" half of the rule to refuse the link by itself.
    let cutOff: Date | null | undefined;
    await asMigratorIn(org.orgId, async (client) => {
      const removed = await client.query<{ sessions_valid_after: Date | null }>(
        'UPDATE membership SET removed_at = now() WHERE id = $1 RETURNING sessions_valid_after',
        [pending.member.membershipId],
      );
      cutOff = removed.rows[0]?.sessions_valid_after;
    });
    expect(cutOff).toBeNull();
    await expectDead(pending);
  });

  it('D22: a demotion ends the adder’s pending address; a promotion, which ends no session, does not', async () => {
    const demoted = await pendingFrom('adder-demoted@example.com');
    const down = await owner.fetch(`/api/members/${demoted.member.membershipId}`, {
      method: 'PATCH',
      json: { role: 'editor' },
    });
    expect(down.status).toBe(200);
    await expectDead(demoted);

    const promoted = await pendingFrom('adder-promoted@example.com');
    const up = await owner.fetch(`/api/members/${promoted.member.membershipId}`, {
      method: 'PATCH',
      json: { role: 'owner' },
    });
    expect(up.status).toBe(200);
    expect(await statusOf(promoted.id)).toBe('waiting');
    expect((await confirmAlertAddress(t, promoted.token)).status).toBe(204);
    expect(await statusOf(promoted.id)).toBe('confirmed');
  });

  it('D22: after a sign out everywhere the old address is dead, and one added after the cut-off confirms', async () => {
    const pending = await pendingFrom('adder-signed-out@example.com');
    expect((await signOutEverywhere(pending.member)).status).toBe(200);
    await expectDead(pending);

    // The same Admin signs in again and adds another address.
    const added = await addAlertAddress(
      await signIn(t, pending.member),
      'after-cut-off@example.com',
    );
    expect(added.status).toBe(201);
    const dto = (await added.json()) as AlertRecipientDto;
    expect(dto.status).toBe('waiting');
    expect((await confirmAlertAddress(t, lastConfirmationToken(t))).status).toBe(204);
    expect(await statusOf(dto.id)).toBe('confirmed');
    expect(await statusOf(pending.id)).toBe('expired');
  });

  it('D22: an address with no recorded adder is dead', async () => {
    const token = randomBytes(32).toString('base64url');
    let id = '';
    await asMigratorIn(org.orgId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO alert_recipient (org_id, email, confirm_token_hash, confirm_expires_at)
         VALUES ($1, 'no-adder@example.com', $2, now() + interval '7 days') RETURNING id`,
        [org.orgId, sha256(token)],
      );
      id = inserted.rows[0]?.id ?? '';
    });
    // The link is known and in date: it is the missing adder that refuses it.
    expect(await alertRecipientByTokenHash(poolAsTx(t.pool), sha256(token))).toEqual({
      orgId: org.orgId,
      recipientId: id,
    });
    await expectDead({ member: org, id, token });
  });

  it('D22: a confirmed address stays confirmed when the adder is removed', async () => {
    const pending = await pendingFrom('confirmed-first@example.com');
    expect((await confirmAlertAddress(t, pending.token)).status).toBe(204);
    expect((await post(`/api/members/${pending.member.membershipId}/remove`)).status).toBe(200);
    expect(await statusOf(pending.id)).toBe('confirmed');
  });

  // The three cases below are the lock order of the confirmation under READ COMMITTED: the
  // recipient row, then the adder's member row FOR SHARE, then the conditional UPDATE.
  const isAdderLock = (text: string): boolean =>
    text.includes('FROM membership') && text.includes('id = $1 FOR SHARE');
  const isConfirmUpdate = (text: string): boolean =>
    text.includes('UPDATE alert_recipient') && text.includes('SET confirmed_at');

  /** Waits for the held statement; fails at once when the request ends without sending it. */
  async function reached(held: StatementHold, request: Promise<unknown>, statement: string) {
    const settled = () => false;
    const arrived = await Promise.race([
      held.reached.then(() => true),
      request.then(settled, settled),
    ]);
    if (arrived) return;
    held.release();
    throw new Error(`the confirmation ended without ${statement}`);
  }

  // Each case lets its requests finish before it asserts: a request still running when the
  // app closes keeps its connection open, and the close then waits for it.
  it('D22: refuses when a sign out everywhere commits between the recipient lock and the member lock', async () => {
    const pending = await pendingFrom('cut-off-between@example.com');
    const held = holds.hold(isAdderLock);
    const confirming = answerTo(pending.token);
    await reached(held, confirming, 'locking the adder’s member row FOR SHARE');
    const signedOut = await signOutEverywhere(pending.member).finally(held.release);
    const answer = await confirming;
    expect(signedOut.status).toBe(200);
    expect(answer.status).toBe(404);
    await expectDead(pending);
  });

  it('D22: waits for a cut-off that is committing, then refuses', async () => {
    const pending = await pendingFrom('cut-off-committing@example.com');
    // What the people routes and the incident script do, left open: the member row is locked
    // and its cut-off set, and neither is committed yet.
    const ending = await appClient();
    try {
      await ending.query('BEGIN');
      await ending.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await ending.query('SELECT sec.session_revoke_membership($1)', [pending.member.membershipId]);
      const confirming = answerTo(pending.token);
      // Without the lock the UPDATE would read the member row as it was and confirm at once.
      const waited = await stillWaiting(confirming);
      await ending.query('COMMIT');
      const answer = await confirming;
      expect(waited).toBe(true);
      expect(answer.status).toBe(404);
    } finally {
      await ending.query('ROLLBACK').catch(() => undefined);
      await ending.end();
    }
    await expectDead(pending);
  });

  it('D22: a member change that holds the adder’s row past lock_timeout answers 503 with retry-after, and the link works after it (SEC-3, BEH-3)', async () => {
    const pending = await pendingFrom('adder-row-held@example.com');
    // A sign out everywhere left open past tinnox_app's 5 s lock_timeout, then rolled back.
    const ending = await appClient();
    let held: Response;
    let waitedMs: number;
    try {
      await ending.query('BEGIN');
      await ending.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
      await ending.query('SELECT sec.session_revoke_membership($1)', [pending.member.membershipId]);
      const started = Date.now();
      held = await confirmAlertAddress(t, pending.token);
      waitedMs = Date.now() - started;
    } finally {
      await ending.query('ROLLBACK');
      await ending.end();
    }
    expect(waitedMs).toBeGreaterThanOrEqual(4_500);
    expect(held.status).toBe(503);
    expect(held.headers.get('retry-after')).toBe('2');
    // The body withOrgAllowed gives a write that waited too long for a lock.
    const body = (await held.json()) as { error: Record<string, unknown> };
    expect({ ...body.error, requestId: null }).toEqual({
      code: 'service_unavailable',
      message: 'Another change is being saved. Try again in a moment.',
      requestId: null,
    });
    // Nothing was confirmed or audited, and the link still confirms once the row is free.
    expect(await statusOf(pending.id)).toBe('waiting');
    expect(
      (await auditEvents(owner, '&category=alert_recipient')).filter(
        (e) => e.action === 'alert_recipient.confirm' && e.objectId === pending.id,
      ),
    ).toEqual([]);
    expect((await confirmAlertAddress(t, pending.token)).status).toBe(204);
    expect(await statusOf(pending.id)).toBe('confirmed');
  }, 20_000);

  it('D22: a sign out everywhere that starts during a confirmation waits for it, and the address stays confirmed', async () => {
    const pending = await pendingFrom('confirmed-just-before@example.com');
    const held = holds.hold(isConfirmUpdate);
    const confirming = confirmAlertAddress(t, pending.token);
    await reached(held, confirming, 'its conditional UPDATE');
    const signingOut = signOutEverywhere(pending.member);
    const waited = await stillWaiting(signingOut).finally(held.release);
    const [confirmed, signedOut] = await Promise.all([confirming, signingOut]);
    expect(waited).toBe(true);
    expect(confirmed.status).toBe(204);
    expect(signedOut.status).toBe(200);
    expect(await statusOf(pending.id)).toBe('confirmed');
  });
});

/** Adds an address and confirms it from its e-mail, as its owner would; returns its id. */
async function addConfirmed(t: TestApp, operator: Operator, email: string): Promise<string> {
  const added = await addAlertAddress(operator, email);
  if (added.status !== 201) throw new Error(`adding an alert address failed: ${added.status}`);
  const confirmed = await confirmAlertAddress(t, lastConfirmationToken(t));
  if (confirmed.status !== 204) throw new Error(`confirming failed: ${confirmed.status}`);
  return ((await added.json()) as { id: string }).id;
}
