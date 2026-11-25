// The pairing protocol as a small model, and the fast-check generator of its commands (adoption
// plan section 4.7 and step 32). pairing-model.integration.test.ts runs each generated sequence
// against the real sec.* functions and against this model, and compares after every command.
//
// The model is written from the protocol's rules (docs/player-protocol-v1.md section 3, the
// headers of migrations 0002, 0010 and 0013), not from the code: it imports nothing of the
// package and calls no SQL, so a rule that the functions lose shows as a difference. It runs
// alone too, which is how its generator is checked: the self-check in the test file counts the
// answers the model gives over a sample, so a generator that stopped reaching a boundary (the
// third wrong code, a claim older than the cut-off) fails there and not silently.
//
// Time is the number of the command: every command of a run commits before the next begins, so
// a claim and a cut-off are never equal, and the order of two database times is the order of
// their commands.
import fc from 'fast-check';

/** How many wrong codes one member may enter before claims answer rate_limited (the test's own limit). */
export const MAX_CLAIM_FAILURES = 3;
/** How many wrong polling tokens lock a session (the test's own limit). */
export const MAX_WRONG_POLLS = 3;
export const DISPLAYS = 2;
export const MEMBERS = 2;

export type Command =
  | { readonly kind: 'Create' }
  | { readonly kind: 'Claim'; readonly s: number; readonly d: number; readonly m: number }
  | { readonly kind: 'WrongCode'; readonly d: number; readonly m: number }
  | { readonly kind: 'Poll'; readonly s: number }
  | { readonly kind: 'WrongPoll'; readonly s: number }
  | { readonly kind: 'Complete'; readonly s: number }
  | { readonly kind: 'Revoke'; readonly d: number }
  | { readonly kind: 'Reset'; readonly d: number }
  | { readonly kind: 'Expire'; readonly s: number }
  | { readonly kind: 'RemoveMember'; readonly m: number }
  | { readonly kind: 'Reinstate'; readonly m: number }
  | { readonly kind: 'EndSessions'; readonly m: number };

export type SessionStatus = 'pending' | 'claimed' | 'completed' | 'expired' | 'locked';
export type RevokedReason = 'replaced' | 'operator' | 'player_reset';

interface Session {
  status: SessionStatus;
  /** The stored expiry has passed; the status follows only when something looks (create, poll). */
  pastExpiry: boolean;
  wrongPolls: number;
  display: number | null;
  claimedBy: number | null;
  claimedAt: number | null;
}

interface Registration {
  /** The session whose collection made it. */
  readonly session: number;
  readonly display: number;
  revoked: RevokedReason | null;
}

interface Member {
  removed: boolean;
  /** The time of the last ending of this member's sessions, which a return does not clear. */
  cutOff: number | null;
  /** The time of the last removal, kept after a return: only for the self-check's tally. */
  removedAt: number | null;
  wrongCodes: number;
}

/** What both sides are compared on after every command, as lines a failure can print. */
export interface Observed {
  /** One line per session: status, wrong polls, display, whether a registration came of it. */
  readonly sessions: readonly string[];
  /** One line per registration, in order of creation: its session, display and state. */
  readonly registrations: readonly string[];
}

/**
 * The session a command names, once `count` sessions exist. A command is drawn before its run
 * is known, so it counts back from the newest session (0 is the newest) and wraps around: every
 * draw lands on a session there is, and a claim and its collection drawn together land on the
 * same one. Null while there is none, and for a command that names no session.
 */
export function sessionOf(c: Command, count: number): number | null {
  return 's' in c && count > 0 ? count - 1 - (c.s % count) : null;
}

const label = (ids: readonly number[]): string => `[${ids.map((i) => `s${String(i)}`).join(',')}]`;

/**
 * The command as one short line: what a shrunk failure prints. As drawn, a session reads `s~0`
 * (the newest at that moment), `s~1` (the one before) and so on; with `count`, the number of
 * sessions the run has when the command runs, it reads as the session it lands on (`s0` is the
 * first one made).
 */
export function describeCommand(c: Command, count?: number): string {
  const landed = count === undefined ? null : sessionOf(c, count);
  const s = !('s' in c) ? '' : landed === null ? `s~${String(c.s)}` : `s${String(landed)}`;
  switch (c.kind) {
    case 'Create':
      return 'Create';
    case 'Claim':
      return `Claim ${s} d${String(c.d)} m${String(c.m)}`;
    case 'WrongCode':
      return `WrongCode d${String(c.d)} m${String(c.m)}`;
    case 'Poll':
    case 'WrongPoll':
    case 'Complete':
    case 'Expire':
      return `${c.kind} ${s}`;
    case 'Revoke':
    case 'Reset':
      return `${c.kind} d${String(c.d)}`;
    case 'RemoveMember':
    case 'Reinstate':
    case 'EndSessions':
      return `${c.kind} m${String(c.m)}`;
  }
}

/**
 * The model. `apply` answers what the command must answer and moves the state; `observed` is
 * what the database must then hold. A command that names a session while there is none answers
 * 'skipped' and changes nothing, on both sides.
 */
export class PairingModel {
  readonly #sessions: Session[] = [];
  readonly #registrations: Registration[] = [];
  readonly #members: Member[] = Array.from({ length: MEMBERS }, () => ({
    removed: false,
    cutOff: null,
    removedAt: null,
    wrongCodes: 0,
  }));
  #now = 0;
  #reached: string[] = [];

  /**
   * Why collections were refused or allowed since the last call. The answer alone does not say
   * (every refusal is `not_claimable`), so the generator's self-check tallies these to know
   * that each rule was really reached.
   */
  takeReached(): string[] {
    const reached = this.#reached;
    this.#reached = [];
    return reached;
  }

  get sessionCount(): number {
    return this.#sessions.length;
  }

  /** The registration a display's player holds, if it has one: its index in order of creation. */
  activeOn(display: number): number | null {
    const at = this.#registrations.findIndex((r) => r.display === display && r.revoked === null);
    return at === -1 ? null : at;
  }

  /** The newest registration of a display, active or not. */
  latestOn(display: number): number | null {
    const at = this.#registrations.findLastIndex((r) => r.display === display);
    return at === -1 ? null : at;
  }

  #member(m: number): Member {
    const member = this.#members[m];
    if (member === undefined) throw new Error(`the model has no member m${String(m)}`);
    return member;
  }

  #revokeActive(display: number, reason: RevokedReason): number | null {
    const at = this.activeOn(display);
    const registration = at === null ? undefined : this.#registrations[at];
    if (registration === undefined) return null;
    registration.revoked = reason;
    return registration.session;
  }

  /** Uncollected claims of a display stop being collectable; answers which. */
  #cancelClaims(display: number, except: number | null): number[] {
    const cancelled: number[] = [];
    this.#sessions.forEach((s, i) => {
      if (s.display === display && s.status === 'claimed' && i !== except) {
        s.status = 'expired';
        cancelled.push(i);
      }
    });
    return cancelled;
  }

  #wrongCode(member: Member): string {
    if (member.removed) return 'refused';
    if (member.wrongCodes >= MAX_CLAIM_FAILURES) return 'rate_limited';
    member.wrongCodes += 1;
    return 'invalid_code';
  }

  apply(command: Command): string {
    this.#now += 1;
    const landed = sessionOf(command, this.#sessions.length);
    if ('s' in command && landed === null) return 'skipped';
    const c = 's' in command && landed !== null ? { ...command, s: landed } : command;
    const session = 's' in c ? this.#sessions[c.s] : undefined;
    switch (c.kind) {
      case 'Create':
        // Asking for a code is also when codes nobody claimed in time are marked.
        for (const s of this.#sessions) {
          if (s.status === 'pending' && s.pastExpiry) s.status = 'expired';
        }
        this.#sessions.push({
          status: 'pending',
          pastExpiry: false,
          wrongPolls: 0,
          display: null,
          claimedBy: null,
          claimedAt: null,
        });
        return 'created';

      case 'WrongCode':
        return this.#wrongCode(this.#member(c.m));

      case 'Claim': {
        const s = session as Session;
        const member = this.#member(c.m);
        // Only a code that is still waiting and in time can be claimed; any other is a wrong code.
        if (member.removed || member.wrongCodes >= MAX_CLAIM_FAILURES)
          return this.#wrongCode(member);
        if (s.status !== 'pending' || s.pastExpiry) return this.#wrongCode(member);
        s.status = 'claimed';
        s.display = c.d;
        s.claimedBy = c.m;
        s.claimedAt = this.#now;
        // The newest claim is the only one that can complete, and it replaces the display's player.
        const cancelled = this.#cancelClaims(c.d, c.s);
        const replaced = this.#revokeActive(c.d, 'replaced');
        return `claimed replaced=${replaced === null ? 'none' : `s${String(replaced)}`} cancelled=${label(cancelled)}`;
      }

      case 'Poll': {
        const s = session as Session;
        if (s.status === 'locked') return 'locked';
        if ((s.status === 'pending' || s.status === 'claimed') && s.pastExpiry) {
          s.status = 'expired';
          return 'expired';
        }
        return s.status;
      }

      case 'WrongPoll': {
        const s = session as Session;
        if (s.status === 'locked') return 'locked';
        s.wrongPolls += 1;
        if (s.wrongPolls >= MAX_WRONG_POLLS && (s.status === 'pending' || s.status === 'claimed')) {
          s.status = 'locked';
          return 'wrong_token_locked';
        }
        return 'wrong_token';
      }

      case 'Complete': {
        const s = session as Session;
        if (s.status !== 'claimed') {
          this.#reached.push('collection refused: the claim was cancelled or never made');
          return 'not_claimable';
        }
        if (s.pastExpiry) {
          this.#reached.push('collection refused: past its expiry');
          return 'not_claimable';
        }
        if (s.display === null || s.claimedBy === null || s.claimedAt === null) {
          throw new Error('the model holds a claim with no display, member or time');
        }
        const claimer = this.#member(s.claimedBy);
        // The claim dies with the access of the member who made it, and stays dead (RCX-01).
        const claimerStillHasAccess =
          !claimer.removed && (claimer.cutOff === null || s.claimedAt > claimer.cutOff);
        // A display that has a player got it from a newer claim (SCX-01).
        if (!claimerStillHasAccess || this.activeOn(s.display) !== null) {
          this.#reached.push(
            claimer.removed
              ? 'collection refused: the claimer was removed'
              : !claimerStillHasAccess &&
                  claimer.removedAt !== null &&
                  s.claimedAt < claimer.removedAt
                ? 'collection refused: the claimer was removed and brought back'
                : !claimerStillHasAccess
                  ? 'collection refused: the claimer’s sessions were ended after the claim'
                  : 'collection refused: the display has a player of a newer claim',
          );
          s.status = 'expired';
          return 'not_claimable';
        }
        if (claimer.cutOff !== null) {
          this.#reached.push('collection allowed: claimed after the claimer’s cut-off');
        }
        s.status = 'completed';
        this.#registrations.push({ session: c.s, display: s.display, revoked: null });
        return 'completed';
      }

      case 'Revoke': {
        const cancelled = this.#cancelClaims(c.d, null);
        const revoked = this.#revokeActive(c.d, 'operator');
        return `revoked=${revoked === null ? 'none' : `s${String(revoked)}`} cancelled=${label(cancelled)}`;
      }

      case 'Reset':
        // The player gives up its own credential; claims of the display are left alone.
        return this.#revokeActive(c.d, 'player_reset') === null ? 'nothing' : 'reset';

      case 'Expire':
        (session as Session).pastExpiry = true;
        return 'expired_by_time';

      case 'RemoveMember': {
        const member = this.#member(c.m);
        if (member.removed) return 'skipped';
        member.removed = true;
        member.cutOff = this.#now;
        member.removedAt = this.#now;
        return 'removed';
      }

      case 'Reinstate': {
        const member = this.#member(c.m);
        if (!member.removed) return 'skipped';
        // The cut-off stays: what the member authorised before leaving does not come back.
        member.removed = false;
        return 'reinstated';
      }

      case 'EndSessions':
        this.#member(c.m).cutOff = this.#now;
        return 'sessions_ended';
    }
  }

  observed(): Observed {
    return {
      sessions: this.#sessions.map(
        (s, i) =>
          `s${String(i)} ${s.status} wrongPolls=${String(s.wrongPolls)} display=${s.display === null ? 'none' : `d${String(s.display)}`} registered=${String(this.#registrations.some((r) => r.session === i))}`,
      ),
      registrations: this.#registrations.map(
        (r) => `s${String(r.session)} d${String(r.display)} ${r.revoked ?? 'active'}`,
      ),
    };
  }
}

// ------------------------------------------------------------------------ generator

const display = fc.nat({ max: DISPLAYS - 1 });
const member = fc.nat({ max: MEMBERS - 1 });
// Counted back from the newest session (sessionOf); mostly the newest two.
const session = fc.oneof({ weight: 3, arbitrary: fc.nat({ max: 1 }) }, fc.nat({ max: 4 }));

const printable = (c: Command): Command =>
  Object.defineProperty({ ...c }, fc.toStringMethod, {
    value: () => describeCommand(c),
    enumerable: false,
  });

type Weighted = { weight: number; arbitrary: fc.Arbitrary<Command[]> };
const one = (weight: number, arbitrary: fc.Arbitrary<Command>): Weighted => ({
  weight,
  arbitrary: arbitrary.map((c) => [c]),
});
const repeated = (c: Command, times: number): Command[] => Array.from({ length: times }, () => c);

/** Any one command, or a short run of them that reaches a limit or undoes itself. */
const anything: fc.Arbitrary<Command[]> = fc.oneof<Weighted[]>(
  one(3, fc.constant({ kind: 'Create' })),
  one(4, fc.record({ kind: fc.constant('Claim'), s: session, d: display, m: member })),
  one(4, fc.record({ kind: fc.constant('Complete'), s: session })),
  one(2, fc.record({ kind: fc.constant('Poll'), s: session })),
  one(1, fc.record({ kind: fc.constant('Expire'), s: session })),
  one(1, fc.record({ kind: fc.constant('Revoke'), d: display })),
  one(1, fc.record({ kind: fc.constant('Reset'), d: display })),
  one(2, fc.record({ kind: fc.constant('EndSessions'), m: member })),
  one(2, fc.record({ kind: fc.constant('RemoveMember'), m: member })),
  one(2, fc.record({ kind: fc.constant('Reinstate'), m: member })),
  // A member who leaves and is brought back: the cut-off of the removal stays (RCX-01).
  {
    weight: 2,
    arbitrary: member.map((m) => [
      { kind: 'RemoveMember', m },
      { kind: 'Reinstate', m },
    ]),
  },
  // A new code claimed for a display, which may have a claim or a player already (SCX-01).
  {
    weight: 3,
    arbitrary: fc
      .tuple(display, member)
      .map(([d, m]) => [{ kind: 'Create' }, { kind: 'Claim', s: 0, d, m }]),
  },
  // Wrong polling tokens up to and onto the limit that locks a session, and one past it.
  {
    weight: 2,
    arbitrary: fc
      .tuple(session, fc.integer({ min: 1, max: MAX_WRONG_POLLS + 1 }))
      .map(([s, times]) => repeated({ kind: 'WrongPoll', s }, times)),
  },
  // Wrong codes up to and onto the limit that blocks a member's claims, and one past it.
  {
    weight: 2,
    arbitrary: fc
      .tuple(display, member, fc.integer({ min: 1, max: MAX_CLAIM_FAILURES + 1 }))
      .map(([d, m, times]) => repeated({ kind: 'WrongCode', d, m }, times)),
  },
);

/**
 * A pairing from the code to its collection, with up to three of the above between the claim
 * and the collection: where a newer claim, a revocation or a change to the claimer decides
 * whether the collection may still happen.
 */
const interruptedPairing: fc.Arbitrary<Command[]> = fc
  .tuple(display, member, fc.array(anything, { maxLength: 3 }))
  .map(([d, m, between]) => {
    const made = between.flat();
    // The collection names the session this pairing made, however many came after it.
    const since = made.filter((c) => c.kind === 'Create').length;
    return [
      { kind: 'Create' },
      { kind: 'Claim', s: 0, d, m },
      ...made,
      { kind: 'Complete', s: since },
    ];
  });

/**
 * Command sequences: pairings interrupted between claim and collection, mixed with single
 * commands and short runs onto a limit. Sessions, displays and members are few, so the
 * commands meet each other; the self-check in pairing-model.integration.test.ts counts how
 * often each rule of the protocol is reached.
 */
export const commandsArb: fc.Arbitrary<Command[]> = fc
  .array(
    fc.oneof({ weight: 2, arbitrary: interruptedPairing }, { weight: 3, arbitrary: anything }),
    {
      minLength: 1,
      maxLength: 10,
      // Without it fast-check keeps the arrays of a default run to a few steps.
      size: 'max',
    },
  )
  .map((steps) => steps.flat().map(printable));
