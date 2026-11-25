/**
 * The revocation window, as decided (adoption plan section 4.7 and step 32, D8). A player's
 * credential is looked up before its transaction begins, so a request already past the lookup
 * finishes its one transaction after a revocation has committed. Nothing closes that window; it
 * is stated, and these tests hold both halves of the statement with two real transactions:
 *
 * - Case A, an operator revoke: the request held inside its transaction finishes, and the next
 *   request, and a signed URL issued in the window, answer 401 `device_revoked`.
 * - Case B, a display paired again: the old player's late heartbeat never replaces the new
 *   player's report, in either order of the two, because the heartbeat's write takes effect
 *   only while its registration is still the active one.
 *
 * Beside them, a heartbeat that waits for another report's row lock past lock_timeout answers
 * 503 as an operator change does, and stores nothing.
 *
 * The held side is a real request of the application, stopped before one of its statements
 * (`statementHolds`); the other side is a real request too, and where it has to wait for the
 * held one, the wait is read from the server (`waitForLockWaiters`), not guessed.
 */
import { waitForLockWaiters, withOrg } from '@tinnox/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  createDisplay,
  createOrg,
  expectError,
  pairPlayer,
  publishImages,
  readyImage,
  signIn,
  startTestApp,
  statementHolds,
  type Operator,
  type PairedPlayer,
  type TestApp,
  type TestOrg,
} from './support.ts';

// The statements of the player routes that a request is stopped before (apps/api/src/routes/player.ts).
/** The heartbeat's read of the delivery row, which takes the row lock: nothing is locked yet. */
const HEARTBEAT_ROW_LOCK =
  /FROM display_delivery\s+WHERE display_id = \$1 AND org_id = app_org_id\(\) FOR UPDATE/;
/** The heartbeat's write: the row lock is held. */
const HEARTBEAT_WRITE = /^UPDATE display_delivery\s+SET reporting_registration_id/;
/** The first statement of the media-urls read. */
const MEDIA_URLS_READ =
  /FROM display_delivery\s+WHERE display_id = \$1 AND org_id = app_org_id\(\) AND desired_publication_id/;
/** The audit row of a claim, written after sec.pairing_claim has revoked the display's player. */
const AUDIT_ROW = /INSERT INTO audit_event/;

interface Stored {
  readonly reporting_registration_id: string | null;
  readonly last_seq: string | null;
  readonly player_state: string | null;
}

describe('the revocation window (D8)', () => {
  const holds = statementHolds();
  let t: TestApp;
  let org: TestOrg;
  let operator: Operator;

  beforeAll(async () => {
    t = await startTestApp({}, 1000, { wrapPool: holds.wrapPool });
    org = await createOrg('Revocation window');
    operator = await signIn(t, org);
  });
  afterAll(async () => {
    await t.close();
  });

  const report = (displayId: string, seq: number, playerState: 'idle' | 'error'): string =>
    JSON.stringify({
      schemaVersion: 1,
      seq,
      sentAt: new Date().toISOString(),
      displayId,
      downloadedPublicationId: null,
      activePublicationId: null,
      activeItemIndex: null,
      playerState,
      staging: null,
      errors: [],
      player: { version: 'test', storagePersisted: null, online: true },
    });
  const heartbeat = (player: PairedPlayer, body: string): Promise<Response> =>
    fetch(`${t.url}/player/heartbeat`, {
      method: 'POST',
      headers: { ...player.headers, 'content-type': 'application/json' },
      body,
    });
  const mediaUrls = (player: PairedPlayer, publicationId: string, assetIds: string[]) =>
    fetch(`${t.url}/player/media-urls`, {
      method: 'POST',
      headers: { ...player.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, assetIds }),
    });
  const revoke = (displayId: string): Promise<Response> =>
    operator.fetch(`/api/displays/${displayId}/revoke-player`, { method: 'POST' });

  const reading = () => t.testSql('reads what the heartbeats of a screen stored');
  /** The stored report of a screen, or undefined when no heartbeat ever reached the row. */
  const stored = (displayId: string): Promise<Stored | undefined> =>
    withOrg(reading(), org.orgId, async (tx) => {
      const { rows } = await tx.query<Stored>(
        `SELECT reporting_registration_id, last_seq, player_state FROM display_delivery
         WHERE display_id = $1 AND org_id = app_org_id()`,
        [displayId],
      );
      return rows[0];
    });
  /** The registrations whose reports were kept as history, oldest first. */
  const logged = (displayId: string): Promise<string[]> =>
    withOrg(reading(), org.orgId, async (tx) => {
      const { rows } = await tx.query<{ registration_id: string }>(
        `SELECT registration_id FROM heartbeat_log
         WHERE display_id = $1 AND org_id = app_org_id() ORDER BY received_at, id`,
        [displayId],
      );
      return rows.map((r) => r.registration_id);
    });
  const lastHeartbeatAt = async (displayId: string): Promise<string | null> =>
    (
      (await (await operator.fetch(`/api/displays/${displayId}/status`)).json()) as {
        lastHeartbeatAt: string | null;
      }
    ).lastHeartbeatAt;
  /** The audit rows that name the registration, by action. */
  const auditOf = async (registrationId: string): Promise<string[]> =>
    (await auditEvents(operator))
      .filter((e) => e.objectId === registrationId || e.actorId === registrationId)
      .map((e) => e.action)
      .sort();

  /**
   * A screen whose player has reported once (seq 1, idle), so the screen's delivery row exists
   * and a later heartbeat only locks that row. The clock then moves past the history's sampling
   * interval, so the next stored report would be kept as history too.
   */
  async function reportingScreen(
    name: string,
  ): Promise<{ display: { id: string }; player: PairedPlayer }> {
    const display = await createDisplay(operator, org, name);
    const player = await pairPlayer(t, operator, display.id);
    const first = await heartbeat(player, report(display.id, 1, 'idle'));
    expect(await first.json()).toMatchObject({ accepted: true, ignoredReason: null });
    t.advanceClock(11_000);
    return { display, player };
  }

  /** What a late heartbeat is answered: what the sequence rule says, as before the write was made conditional. */
  const ANSWERED_AS_BEFORE = { accepted: true, ignoredReason: null };

  it('case A: a media-urls request held inside its transaction finishes after an operator revoke, and the next request and the URL it issued answer 401 device_revoked', async () => {
    const display = await createDisplay(operator, org, 'Window A urls');
    const image = await readyImage(t, operator);
    const { publicationId } = await publishImages(operator, display.id, [image.id]);
    const player = await pairPlayer(t, operator, display.id);

    const held = holds.hold((text) => MEDIA_URLS_READ.test(text));
    const asking = mediaUrls(player, publicationId, [image.id]);
    await held.reached;
    let revoked: Response;
    try {
      revoked = await revoke(display.id);
    } finally {
      held.release();
    }
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ revokedRegistrationId: player.registrationId });

    // Past its lookup, so it finishes.
    const answered = await asking;
    expect(answered.status).toBe(200);
    const { urls } = (await answered.json()) as { urls: { url: string }[] };
    expect(urls).toHaveLength(1);

    // The URL was issued after the revocation committed, and is worth nothing.
    const issued = new URL(urls[0]?.url ?? '');
    await expectError(await fetch(`${t.url}${issued.pathname}${issued.search}`), 'device_revoked');
    await expectError(await mediaUrls(player, publicationId, [image.id]), 'device_revoked');
    await expectError(
      await fetch(`${t.url}/player/manifest`, { headers: player.headers }),
      'device_revoked',
    );
  });

  it('case A: a heartbeat held inside its transaction finishes after an operator revoke and stores nothing; the next one answers 401 device_revoked', async () => {
    const { display, player } = await reportingScreen('Window A heartbeat');

    const held = holds.hold((text) => HEARTBEAT_ROW_LOCK.test(text));
    const late = heartbeat(player, report(display.id, 2, 'error'));
    await held.reached;
    try {
      expect((await revoke(display.id)).status).toBe(200);
    } finally {
      held.release();
    }

    const answered = await late;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject(ANSWERED_AS_BEFORE);
    // The report from before the revocation stays; the late one changed nothing and was not
    // kept as history.
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: player.registrationId,
      last_seq: '1',
      player_state: 'idle',
    });
    expect(await logged(display.id)).toEqual([player.registrationId]);
    // Telemetry (D3): the late heartbeat wrote no audit row of its own.
    expect(await auditOf(player.registrationId)).toEqual(['pairing.complete', 'player.revoke']);

    await expectError(await heartbeat(player, report(display.id, 3, 'error')), 'device_revoked');
  });

  it('case B: the old player’s heartbeat, released after the new player has reported, does not replace that report', async () => {
    const { display, player: old } = await reportingScreen('Window B replaced first');

    // Past its credential lookup, before it has locked anything.
    const held = holds.hold((text) => HEARTBEAT_ROW_LOCK.test(text));
    const late = heartbeat(old, report(display.id, 50, 'error'));
    await held.reached;
    let replacement: PairedPlayer;
    try {
      replacement = await pairPlayer(t, operator, display.id);
      const first = await heartbeat(replacement, report(display.id, 1, 'idle'));
      expect(await first.json()).toMatchObject({ accepted: true });
    } finally {
      held.release();
    }
    const shown = await lastHeartbeatAt(display.id);
    expect(shown).not.toBeNull();

    const answered = await late;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject(ANSWERED_AS_BEFORE);
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: replacement.registrationId,
      last_seq: '1',
      player_state: 'idle',
    });
    expect(await lastHeartbeatAt(display.id)).toBe(shown);
    expect(await logged(display.id)).toEqual([old.registrationId, replacement.registrationId]);
    expect(await auditOf(old.registrationId)).toEqual(['pairing.complete', 'player.revoke']);
    await expectError(await heartbeat(old, report(display.id, 51, 'error')), 'device_revoked');
  });

  it('case B: the old player’s heartbeat that holds the row lock while the display is paired again writes nothing, and the new player’s report, which waited for it, is the one stored', async () => {
    const { display, player: old } = await reportingScreen('Window B lock held');

    // Stopped before its write: the delivery row is locked and the sequence rule has accepted.
    const held = holds.hold((text) => HEARTBEAT_WRITE.test(text));
    const late = heartbeat(old, report(display.id, 50, 'error'));
    const holder = await held.reached;
    let first: Promise<Response>;
    let replacement: PairedPlayer;
    try {
      // The claim and the collection take no lock the heartbeat holds.
      replacement = await pairPlayer(t, operator, display.id);
      first = heartbeat(replacement, report(display.id, 1, 'idle'));
      await waitForLockWaiters(
        reading(),
        holder,
        1,
        'the new player’s heartbeat never waited for the old one’s row lock',
      );
    } finally {
      held.release();
    }

    const answered = await late;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject(ANSWERED_AS_BEFORE);
    expect(await (await first).json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: replacement.registrationId,
      last_seq: '1',
      player_state: 'idle',
    });
    // The final row would be the new player's either way, since it wrote last. The history
    // shows that the old one wrote nothing: it keeps one report per screen per ten seconds,
    // so a stored late report would have taken the new report's place in it.
    expect(await logged(display.id)).toEqual([old.registrationId, replacement.registrationId]);
  });

  it('case B, the other order: a heartbeat that writes while the claim that replaces its player has not committed is stored, and the new player’s report replaces it', async () => {
    const { display, player: old } = await reportingScreen('Window B heartbeat first');

    const created = await fetch(`${t.url}/player/pairing`, { method: 'POST' });
    const pairing = (await created.json()) as {
      pairingId: string;
      code: string;
      pollingToken: string;
    };
    // The claim has revoked the old registration in its transaction and not committed.
    const held = holds.hold((text) => AUDIT_ROW.test(text));
    const claiming = operator.fetch(`/api/displays/${display.id}/claim`, {
      method: 'POST',
      json: { code: pairing.code },
    });
    await held.reached;
    try {
      // Still the active registration for every other transaction: a legitimate report, and
      // the condition takes no lock, so it does not wait for the claim either.
      const before = await heartbeat(old, report(display.id, 7, 'error'));
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({ accepted: true, ignoredReason: null });
    } finally {
      held.release();
    }
    expect((await claiming).status).toBe(200);
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: old.registrationId,
      last_seq: '7',
      player_state: 'error',
    });
    // The screen has no player now, so the stored report is not shown as current.
    expect(await lastHeartbeatAt(display.id)).toBeNull();

    const poll = await fetch(`${t.url}/player/pairing/${pairing.pairingId}`, {
      headers: { authorization: `Bearer ${pairing.pollingToken}` },
    });
    const collected = (await poll.json()) as { deviceToken: string; registrationId: string };
    const replacement: PairedPlayer = {
      deviceToken: collected.deviceToken,
      registrationId: collected.registrationId,
      headers: { authorization: `Bearer ${collected.deviceToken}` },
    };
    expect(await lastHeartbeatAt(display.id)).toBeNull();
    // A new registration starts a new sequence, below the old one's.
    expect(
      await (await heartbeat(replacement, report(display.id, 1, 'idle'))).json(),
    ).toMatchObject({ accepted: true, ignoredReason: null });
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: replacement.registrationId,
      last_seq: '1',
      player_state: 'idle',
    });
    expect(await lastHeartbeatAt(display.id)).not.toBeNull();
    await expectError(await heartbeat(old, report(display.id, 8, 'error')), 'device_revoked');
  });

  // Michael, 25 Nov: a lock timeout on the device path answers as the operator routes do
  // (changeAsDevice maps it as changeAsOperator does), not 500.
  it('a heartbeat that waits for the delivery row past lock_timeout answers 503 service_unavailable with retry-after 2, as an operator change does, and stores nothing', async () => {
    const { display, player } = await reportingScreen('Lock timeout heartbeat');

    // Another report of the screen, stopped before its write: it holds the delivery row.
    const held = holds.hold((text) => HEARTBEAT_WRITE.test(text));
    const first = heartbeat(player, report(display.id, 2, 'idle'));
    const holder = await held.reached;
    let timedOut: Response;
    let waitedMs: number;
    try {
      const started = Date.now();
      const waiting = heartbeat(player, report(display.id, 3, 'error'));
      await waitForLockWaiters(
        reading(),
        holder,
        1,
        'the second heartbeat never waited for the first one’s row lock',
      );
      timedOut = await waiting;
      waitedMs = Date.now() - started;
    } finally {
      held.release();
    }
    // tinnox_app's 5 s lock_timeout ran out.
    expect(waitedMs).toBeGreaterThanOrEqual(4_500);
    expect(timedOut.status).toBe(503);
    expect(timedOut.headers.get('retry-after')).toBe('2');
    // The body changeAsOperator gives a write that waited too long for a lock.
    const body = (await timedOut.json()) as { error: Record<string, unknown> };
    expect({ ...body.error, requestId: null }).toEqual({
      code: 'service_unavailable',
      message: 'Another change is being saved. Try again in a moment.',
      requestId: null,
    });

    // The holder finishes; the timed-out report rolled back and left nothing.
    expect(await (await first).json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: player.registrationId,
      last_seq: '2',
      player_state: 'idle',
    });
    expect(await logged(display.id)).toEqual([player.registrationId, player.registrationId]);
    // A heartbeat is telemetry (D3): neither wrote an audit row.
    expect(await auditOf(player.registrationId)).toEqual(['pairing.complete']);
  });

  // Found by this file, and kept as it is: no decision asks for a change. A screen's first
  // heartbeat inserts its delivery row, whose foreign key holds the screen's row against the
  // revoke's lock until the heartbeat commits. So here the revoke does not overtake the request
  // in the window: it waits for it (for five seconds at most, then 503), and the report is
  // stored first, by a registration that is still active.
  it('pins: an operator revoke waits for a screen’s first heartbeat, which is stored before the revocation', async () => {
    const display = await createDisplay(operator, org, 'Window first heartbeat');
    const player = await pairPlayer(t, operator, display.id);

    const held = holds.hold((text) => HEARTBEAT_ROW_LOCK.test(text));
    const first = heartbeat(player, report(display.id, 1, 'idle'));
    const holder = await held.reached;
    let revoking: Promise<Response>;
    try {
      revoking = revoke(display.id);
      await waitForLockWaiters(reading(), holder, 1, 'the revoke never waited for the heartbeat');
    } finally {
      held.release();
    }
    expect(await (await first).json()).toMatchObject({ accepted: true, ignoredReason: null });
    expect((await revoking).status).toBe(200);
    expect(await stored(display.id)).toEqual({
      reporting_registration_id: player.registrationId,
      last_seq: '1',
      player_state: 'idle',
    });
    await expectError(await heartbeat(player, report(display.id, 2, 'idle')), 'device_revoked');
  });
});
