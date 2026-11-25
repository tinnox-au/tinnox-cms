/**
 * The alert episode and the alert addresses, model-based (adoption plan section 4.7 and step 32;
 * DEC-37, D22): random sequences of commands run against the real application and against the
 * small model of alert-episode-model.test-support.ts, and after every command the answer, the
 * open episodes, the recorded transitions, the address list and the e-mails sent are compared.
 *
 * The application is the real one: heartbeats, pairing, revocation, the screen's settings, the
 * people routes and the alert-address routes go over HTTP, the check is runDisplayAlerts at the
 * application's clock, and e-mail lands in the recording mailer. Two things are arranged:
 *
 * - The check runs over the organisation of the current run only. sec.display_alert_orgs()
 *   names every organisation of the shared test database, whose screens would all fall silent
 *   as this file moves the clock; the pool hands the check its own row of that list and nothing
 *   else is changed, so every statement of the check is the product's.
 * - Each run has an organisation of its own, so its address list, its episodes and its audit
 *   rows are its alone.
 *
 * Held beside the model, whatever the model says: a reporting-again transition always follows
 * the not-reporting transition of the same screen, and an e-mail goes only to an address that
 * is confirmed.
 *
 * D11: every run draws a fresh seed, and a failure prints the seed, the shrunk commands as one
 * short line each, and the first command whose answer or state differed.
 */
import { randomUUID } from 'node:crypto';
import type { AlertRecipientDto } from '@tinnox/contracts';
import { alertRecipientByTokenHash, poolAsTx, sha256 } from '@tinnox/db';
import { testOrgId, withOrg, type Pool } from '@tinnox/db/testing';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AlertModel,
  addressOf,
  commandsArb,
  describeCommand,
  DELAY_MINUTES,
  DISPLAYS,
  MEMBERS,
  STEP_MINUTES,
  type Command,
  type Observed,
} from './alert-episode-model.test-support.ts';
import {
  addAlertAddress,
  asMigratorIn,
  checkAlerts,
  confirmAlertAddress,
  createDisplay,
  heartbeatBody,
  lastConfirmationToken,
  pairPlayer,
  sendHeartbeat,
  signIn,
  startTestApp,
  type Operator,
  type PairedPlayer,
  type TestApp,
  type TestOrg,
} from './support.ts';

const ALERT_ORGS = 'SELECT org_id FROM sec.display_alert_orgs()';

let t: TestApp;
/** The organisation the check runs over: the current run's. */
let checked = '';

/**
 * The application's pool, with one answer narrowed: of the organisations the check asks for, it
 * gets the current run's alone. Every other statement passes through untouched.
 */
function checkingOneOrganisation(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      if (key !== 'query') return method;
      return async (...args: unknown[]) => {
        const result = (await method(...args)) as { rows: { org_id?: string }[] };
        if (args[0] !== ALERT_ORGS) return result;
        const rows = result.rows.filter((row) => row.org_id === checked);
        if (rows.length !== 1) throw new Error('the run’s organisation is not in the check’s list');
        return { ...result, rows, rowCount: rows.length };
      };
    },
  });
}

beforeAll(async () => {
  t = await startTestApp({}, 1000, { wrapPool: checkingOneOrganisation });
});
afterAll(async () => {
  await t.close();
});

interface RealAddress {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

/** The real side of one run: an organisation of its own, and what the commands made in it. */
class RealAlerts {
  readonly addresses: RealAddress[] = [];
  readonly #org: TestOrg;
  readonly #owner: Operator;
  readonly #members: readonly TestOrg[];
  readonly #removed = new Set<number>();
  readonly #displays: readonly string[];
  readonly #players: (PairedPlayer | null)[];
  #seq = 0;
  #advancedMs = 0;
  #mailSeen = t.sentMail.length;

  private constructor(org: TestOrg, owner: Operator, members: TestOrg[], displays: string[]) {
    this.#org = org;
    this.#owner = owner;
    this.#members = members;
    this.#displays = displays;
    this.#players = displays.map(() => null);
  }

  /** An organisation with an Owner, two Admins, and two screens with no player, alerts on. */
  static async arrange(): Promise<RealAlerts> {
    const org: TestOrg = {
      orgId: testOrgId(randomUUID()),
      siteId: randomUUID(),
      membershipId: randomUUID(),
      oidcSub: `alert-model-${randomUUID()}`,
    };
    const members = Array.from({ length: MEMBERS }, () => ({
      ...org,
      membershipId: randomUUID(),
      oidcSub: `alert-model-${randomUUID()}`,
    }));
    await asMigratorIn(org.orgId, async (client) => {
      await client.query("INSERT INTO organization (id, name) VALUES ($1, 'Alert model')", [
        org.orgId,
      ]);
      await client.query(
        "INSERT INTO site (id, org_id, name, timezone) VALUES ($1, $2, 'Model site', 'Australia/Melbourne')",
        [org.siteId, org.orgId],
      );
      await client.query(
        `INSERT INTO membership (id, org_id, oidc_sub, role)
         SELECT m.id, $1, m.sub, m.role FROM unnest($2::uuid[], $3::text[], $4::text[]) AS m (id, sub, role)`,
        [
          org.orgId,
          [org.membershipId, ...members.map((m) => m.membershipId)],
          [org.oidcSub, ...members.map((m) => m.oidcSub)],
          ['owner', ...members.map(() => 'admin')],
        ],
      );
    });
    checked = org.orgId;
    const owner = await signIn(t, org);
    const displays: string[] = [];
    for (let d = 0; d < DISPLAYS; d += 1) {
      const display = await createDisplay(owner, org, `Model screen ${String(d)}`);
      displays.push(display.id);
    }
    return new RealAlerts(org, owner, members, displays);
  }

  /** Puts the application's clock back where the run found it. */
  restoreClock(): void {
    t.advanceClock(-this.#advancedMs);
    this.#advancedMs = 0;
  }

  #display(d: number): string {
    const id = this.#displays[d];
    if (id === undefined) throw new Error(`no screen d${String(d)}`);
    return id;
  }
  #member(m: number): TestOrg {
    const member = this.#members[m];
    if (member === undefined) throw new Error(`no member m${String(m)}`);
    return member;
  }

  async #patch(d: number, json: Record<string, unknown>): Promise<string> {
    const saved = await this.#owner.fetch(`/api/displays/${this.#display(d)}`, {
      method: 'PATCH',
      json,
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    return 'saved';
  }

  /** How many of two runs at once did the work; set by TwoTicks for the model. */
  ran = 1;

  async run(c: Command): Promise<string> {
    const landed = addressOf(c, this.addresses.length);
    if ('a' in c && landed === null) return 'skipped';
    const address = this.addresses[landed ?? -1];
    switch (c.kind) {
      case 'Heartbeat': {
        const player = this.#players[c.d];
        if (player === null || player === undefined) return 'no_player';
        this.#seq += 1;
        const sent = await sendHeartbeat(t, player, heartbeatBody(this.#display(c.d), this.#seq));
        expect(sent.status, await sent.clone().text()).toBe(200);
        const body = (await sent.json()) as { accepted: boolean };
        return body.accepted ? 'reported' : 'ignored';
      }
      case 'Advance':
        t.advanceClock(c.steps * STEP_MINUTES * 60_000);
        this.#advancedMs += c.steps * STEP_MINUTES * 60_000;
        return 'advanced';
      case 'Tick':
      case 'TwoTicks': {
        const results = await Promise.all(
          Array.from({ length: c.kind === 'Tick' ? 1 : 2 }, () => checkAlerts(t)),
        );
        const done = results.filter((r) => !r.skipped);
        this.ran = done.length;
        const sum = (of: (r: (typeof done)[number]) => number): string =>
          String(done.reduce((total, r) => total + of(r), 0));
        // Nothing may fail, and a run that skipped did nothing.
        expect(results.map((r) => r.failed)).toEqual(results.map(() => 0));
        for (const r of results) {
          if (r.skipped) expect(r).toMatchObject({ offline: 0, online: 0, closed: 0 });
        }
        return `ran=${String(done.length)} offline=${sum((r) => r.offline)} online=${sum((r) => r.online)} closed=${sum((r) => r.closed)}`;
      }
      case 'Revoke': {
        const revoked = await this.#owner.fetch(
          `/api/displays/${this.#display(c.d)}/revoke-player`,
          { method: 'POST' },
        );
        expect(revoked.status).toBe(200);
        const body = (await revoked.json()) as { revokedRegistrationId: string | null };
        this.#players[c.d] = null;
        return body.revokedRegistrationId === null ? 'no_player' : 'revoked';
      }
      case 'Repair':
        this.#players[c.d] = await pairPlayer(t, this.#owner, this.#display(c.d));
        return 'paired';
      case 'AlertsOff':
      case 'AlertsOn':
        return this.#patch(c.d, {
          alertOfflineMinutes: c.kind === 'AlertsOn' ? DELAY_MINUTES : null,
        });
      case 'BackOnlineOff':
      case 'BackOnlineOn':
        return this.#patch(c.d, { alertBackOnline: c.kind === 'BackOnlineOn' });
      case 'AddAddress': {
        // The member signs in again for it: a removed one cannot.
        let operator: Operator;
        try {
          operator = await signIn(t, this.#member(c.m));
        } catch {
          return 'no_access';
        }
        const email = `a${String(this.addresses.length)}-${randomUUID()}@example.com`;
        const added = await addAlertAddress(operator, email);
        if (added.status === 409) return 'full';
        expect(added.status, await added.clone().text()).toBe(201);
        const dto = (await added.json()) as AlertRecipientDto;
        expect(dto.status).toBe('waiting');
        this.addresses.push({ id: dto.id, email, token: lastConfirmationToken(t) });
        return 'added';
      }
      case 'Confirm': {
        if (address === undefined) throw new Error('the run lost an address');
        const answered = await confirmAlertAddress(t, address.token);
        if (answered.status === 204) return 'confirmed';
        expect(answered.status, await answered.clone().text()).toBe(404);
        return 'not_found';
      }
      case 'RemoveAddress': {
        if (address === undefined) throw new Error('the run lost an address');
        const removed = await this.#owner.fetch(`/api/alert-recipients/${address.id}`, {
          method: 'DELETE',
        });
        if (removed.status === 204) return 'removed';
        expect(removed.status, await removed.clone().text()).toBe(404);
        return 'not_found';
      }
      case 'RemoveMember':
      case 'EndSessions': {
        // The people routes answer a removed member like an unknown one; the run does not ask.
        if (this.#removed.has(c.m)) return 'skipped';
        const id = this.#member(c.m).membershipId;
        const path = c.kind === 'RemoveMember' ? 'remove' : 'sign-out';
        const done = await this.#owner.fetch(`/api/members/${id}/${path}`, { method: 'POST' });
        expect(done.status, await done.clone().text()).toBe(200);
        if (c.kind === 'EndSessions') return 'sessions_ended';
        this.#removed.add(c.m);
        return 'removed';
      }
    }
  }

  async observed(): Promise<Observed> {
    const reading = t.testSql('reads the open episodes and the alert audit rows of a model run');
    // The three reads change nothing, so they go out together.
    const [stored, list, known] = await Promise.all([
      withOrg(reading, this.#org.orgId, async (tx) => ({
        episodes: (
          await tx.query<{ display_id: string }>(
            'SELECT display_id FROM display_alert WHERE org_id = app_org_id()',
          )
        ).rows,
        transitions: (
          await tx.query<{ action: string; object_id: string }>(
            `SELECT action, object_id FROM audit_event
             WHERE org_id = app_org_id()
               AND action IN ('display.offline_alert', 'display.online_alert')
             ORDER BY id`,
          )
        ).rows,
      })),
      this.#owner
        .fetch('/api/alert-recipients')
        .then((response) => response.json() as Promise<{ items: AlertRecipientDto[] }>),
      Promise.all(
        this.addresses.map((address) =>
          alertRecipientByTokenHash(poolAsTx(t.ctx.db), sha256(address.token)),
        ),
      ),
    ]);
    const screen = (id: string): string => {
      const d = this.#displays.indexOf(id);
      if (d === -1) throw new Error('an alert names a screen that is not of this run');
      return `d${String(d)}`;
    };
    const transitions = this.#displays.map((id, d) => {
      const own = stored.transitions
        .filter((row) => row.object_id === id)
        .map((row) => (row.action === 'display.offline_alert' ? 'offline' : 'online'));
      // Held whatever the model says: reporting again always follows not reporting.
      own.forEach((kind, i) => {
        if (kind === 'online') expect(own[i - 1], own.join(' ')).toBe('offline');
      });
      return `d${String(d)}: ${own.join(' ')}`;
    });
    expect(stored.transitions.every((row) => this.#displays.includes(row.object_id))).toBe(true);

    const addresses = this.addresses.map((address, i) => {
      const shown = list.items.find((item) => item.id === address.id)?.status ?? 'gone';
      const lookup = known[i] ?? null;
      if (lookup !== null) {
        expect(lookup).toEqual({ orgId: this.#org.orgId, recipientId: address.id });
      }
      return `a${String(i)} ${shown} link=${lookup === null ? 'unknown' : 'known'}`;
    });

    const mail: string[] = [];
    for (const message of t.sentMail.slice(this.#mailSeen)) {
      if (message.subject.startsWith('Confirm ')) continue;
      const kind = message.subject.startsWith('Screen not reporting: ')
        ? 'offline'
        : message.subject.startsWith('Screen reporting again: ')
          ? 'online'
          : null;
      const d = this.#displays.findIndex((id) => message.text.includes(`/screens/${id}`));
      const a = this.addresses.findIndex((address) => address.email === message.to);
      if (kind === null || d === -1 || a === -1) {
        throw new Error(`an e-mail of this run is not understood: ${message.subject}`);
      }
      // Held whatever the model says: only an address the list shows as confirmed is written to.
      expect(addresses[a], message.subject).toMatch(/ confirmed /);
      mail.push(`${kind} d${String(d)} -> a${String(a)}`);
    }
    this.#mailSeen = t.sentMail.length;

    return {
      episodes: stored.episodes.map((row) => screen(row.display_id)).sort(),
      transitions,
      addresses,
      mail: mail.sort(),
    };
  }
}

/** Runs the commands against the application and the model, and fails at the first difference. */
async function runAgainstModel(commands: readonly Command[]): Promise<void> {
  const real = await RealAlerts.arrange();
  const model = new AlertModel();
  const trace: string[] = [];
  try {
    for (const [i, command] of commands.entries()) {
      const line = `${String(i + 1).padStart(2)}. ${describeCommand(command, model.addressCount)}`;
      const answered = await real.run(command);
      const expected = model.apply(command, real.ran);
      if (answered !== expected) {
        throw new Error(
          [...trace, `${line} -> answered "${answered}", the model says "${expected}"`].join('\n'),
        );
      }
      trace.push(`${line} -> ${answered}`);
      const wanted = model.observed();
      const stored = await real.observed();
      try {
        expect(stored).toEqual(wanted);
      } catch (error) {
        throw new Error(
          `${trace.join('\n')}\n    after it, the application (received) differs from the model (expected):\n${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  } finally {
    real.restoreClock();
  }
}

const tick: Command = { kind: 'Tick' };
const wait = (minutes: number): Command => ({ kind: 'Advance', steps: minutes / STEP_MINUTES });
const beat = (d = 0): Command => ({ kind: 'Heartbeat', d });
const pair = (d = 0): Command => ({ kind: 'Repair', d });
const add = (m = 0): Command => ({ kind: 'AddAddress', m });
const confirm = (a = 0): Command => ({ kind: 'Confirm', a });

describe('alert model: generator self-checks', () => {
  it('reaches every answer and every rule of the episode and the addresses within a sample, on the model alone', () => {
    const reached = new Map<string, number>();
    const count = (key: string): void => {
      reached.set(key, (reached.get(key) ?? 0) + 1);
    };
    for (const commands of fc.sample(commandsArb, 3000)) {
      const model = new AlertModel();
      for (const command of commands) {
        const ran = command.kind === 'TwoTicks' ? 1 + (commands.length % 2) : 1;
        const answer = model.apply(command, ran).replace(/=[1-9]\d*/g, '=n');
        count(`${command.kind}: ${answer}`);
        for (const tag of model.takeReached()) count(tag);
        const state = model.observed();
        if (state.mail.length > 1) count('several e-mails from one command');
        for (const line of state.addresses) count(`address ${line.replace(/^a\d+ /, '')}`);
      }
    }
    for (const wanted of [
      'Heartbeat: reported',
      'Heartbeat: no_player',
      'Tick: ran=n offline=0 online=0 closed=0',
      'Tick: ran=n offline=n online=0 closed=0',
      'Tick: ran=n offline=0 online=n closed=0',
      'Tick: ran=n offline=0 online=0 closed=n',
      'TwoTicks: ran=n offline=n online=0 closed=0',
      'Revoke: revoked',
      'Revoke: no_player',
      'Repair: paired',
      'AddAddress: added',
      'AddAddress: no_access',
      'Confirm: confirmed',
      'Confirm: not_found',
      'RemoveAddress: removed',
      'RemoveAddress: not_found',
      'RemoveMember: removed',
      'EndSessions: sessions_ended',
      // How an episode opens and ends, each a rule of its own.
      'offline e-mail',
      'offline, nobody to tell',
      'episode still open: nothing sent again',
      'reporting-again e-mail',
      'reporting-again e-mail: a new player reported',
      'closed silently: alerts off',
      'closed silently: no player',
      'closed silently: paired again, no report yet',
      'closed silently: reporting-again e-mail off',
      'two runs, one after the other',
      'several e-mails from one command',
      // What a link is answered, and why (D22).
      'link refused: the adder was removed',
      'link refused: the adder’s sessions were ended',
      'link accepted: added after the adder’s cut-off',
      'link used twice',
      'link of a removed address',
      // What the list shows; a dead pending address is still known to the link's lookup.
      'address waiting link=known',
      'address expired link=known',
      'address confirmed link=unknown',
      'address gone link=unknown',
    ]) {
      expect(reached.get(wanted) ?? 0, wanted).toBeGreaterThan(0);
    }
  });
});

describe('alerts: the application against the model', () => {
  it(
    'answers, records and e-mails what the model says, command by command, for any sequence of commands',
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(commandsArb, async (commands) => {
          await runAgainstModel(commands);
        }),
      );
    },
  );

  it('an episode sends one not-reporting e-mail per confirmed address, once, and one reporting-again e-mail after it', async () => {
    await runAgainstModel([
      add(0),
      confirm(),
      add(1),
      confirm(),
      // A third address that nobody confirmed gets nothing.
      add(0),
      pair(),
      beat(),
      wait(20),
      tick,
      wait(10),
      tick,
      tick,
      { kind: 'TwoTicks' },
      beat(),
      tick,
      tick,
    ]);
  });

  it('a new player’s first report ends the old player’s episode with the reporting-again e-mail; until then it ends silently', async () => {
    await runAgainstModel([
      add(),
      confirm(),
      pair(),
      beat(),
      wait(30),
      tick,
      pair(),
      beat(),
      tick,
      wait(30),
      tick,
      pair(),
      tick,
      wait(30),
      tick,
    ]);
  });

  it('alerts off, no player and the reporting-again choice off each end an episode without an e-mail', async () => {
    await runAgainstModel([
      add(),
      confirm(),
      pair(0),
      pair(1),
      beat(0),
      beat(1),
      wait(30),
      tick,
      { kind: 'AlertsOff', d: 0 },
      { kind: 'Revoke', d: 1 },
      tick,
      // On again with the same stale report: a new episode, and its e-mail.
      { kind: 'AlertsOn', d: 0 },
      tick,
      { kind: 'BackOnlineOff', d: 0 },
      beat(0),
      tick,
    ]);
  });

  it('D22: a pending address dies when the member who added it is removed or signed out everywhere, its link’s lookup still knows it, and one added after the cut-off confirms', async () => {
    await runAgainstModel([
      add(0),
      add(1),
      { kind: 'EndSessions', m: 0 },
      { kind: 'RemoveMember', m: 1 },
      confirm(1),
      confirm(0),
      add(0),
      confirm(),
      add(1),
      // A confirmed address outlives its adder.
      { kind: 'RemoveMember', m: 0 },
      pair(),
      beat(),
      wait(30),
      tick,
    ]);
  });

  it('an address removed between two checks gets the first e-mail and not the second; a link works once', async () => {
    await runAgainstModel([
      add(),
      confirm(),
      confirm(),
      pair(),
      beat(),
      wait(30),
      tick,
      { kind: 'RemoveAddress', a: 0 },
      { kind: 'RemoveAddress', a: 0 },
      confirm(),
      beat(),
      tick,
    ]);
  });
});
