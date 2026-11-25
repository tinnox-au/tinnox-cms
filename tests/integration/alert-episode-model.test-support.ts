// The alert episode of a screen and the organisation's alert addresses as a small model, and
// the fast-check generator of its commands (adoption plan section 4.7 and step 32, DEC-37, D22).
// alert-episode-model.test.ts runs each generated sequence against the real application (the
// heartbeat, display, member and alert-address routes, and the check itself, runDisplayAlerts,
// with the recording mailer) and against this model, and compares after every command.
//
// The model is written from the rules (docs/portal-v2/stage-c-alerts.md, DEC-37, D22), not from
// the code: it imports nothing of the application and calls nothing, so a rule the check or the
// routes lose shows as a difference. It runs alone too, which is how its generator is checked.
//
// Time. The application's clock is moved in whole steps of ten minutes, and the delay is thirty,
// so a report is either well short of its delay or on it: "on the delay" is due, since the real
// run is always a few milliseconds past the step. Two reports are told apart by their order,
// not their time: a check runs between any two that matter.
import fc from 'fast-check';

export const DISPLAYS = 2;
/** The Admins who add addresses; the Owner, who is never removed, makes every other change. */
export const MEMBERS = 2;
/** The offline delay of every screen whose alerts are on, in minutes: the shortest the product allows. */
export const DELAY_MINUTES = 30;
/** One step of the clock, in minutes. */
export const STEP_MINUTES = 10;
/** The most addresses an organisation's list holds (MAX_ALERT_RECIPIENTS of the contracts). */
export const MAX_ADDRESSES = 20;

export type Command =
  | { readonly kind: 'Heartbeat'; readonly d: number }
  | { readonly kind: 'Advance'; readonly steps: number }
  | { readonly kind: 'Tick' }
  | { readonly kind: 'TwoTicks' }
  | { readonly kind: 'Revoke'; readonly d: number }
  | { readonly kind: 'Repair'; readonly d: number }
  | { readonly kind: 'AlertsOff'; readonly d: number }
  | { readonly kind: 'AlertsOn'; readonly d: number }
  | { readonly kind: 'BackOnlineOff'; readonly d: number }
  | { readonly kind: 'BackOnlineOn'; readonly d: number }
  | { readonly kind: 'AddAddress'; readonly m: number }
  | { readonly kind: 'Confirm'; readonly a: number }
  | { readonly kind: 'RemoveAddress'; readonly a: number }
  | { readonly kind: 'RemoveMember'; readonly m: number }
  | { readonly kind: 'EndSessions'; readonly m: number };

interface Screen {
  /** The number of the registration its player holds; null when it has none. */
  player: number | null;
  /** The stored report: which registration sent it, when, and its place among all reports. */
  report: { readonly player: number; readonly at: number; readonly order: number } | null;
  alertsOn: boolean;
  backOnline: boolean;
  /** The open episode: the place of the report that went stale, and the player that sent it. */
  episode: { readonly order: number; readonly player: number } | null;
}

interface Address {
  readonly adder: number;
  /** When it was added, in commands. */
  readonly addedAt: number;
  state: 'pending' | 'confirmed' | 'removed';
}

interface Member {
  removed: boolean;
  /** When this member's sessions were last ended, in commands. */
  cutOff: number | null;
}

/** What both sides are compared on after every command, as lines a failure can print. */
export interface Observed {
  /** The screens with an open episode. */
  readonly episodes: readonly string[];
  /**
   * Every alert transition recorded so far, one line per screen, in order: `d0: offline online`.
   * (One check records its screens in the order of their ids, which no run chooses.)
   */
  readonly transitions: readonly string[];
  /** One line per address: what the list shows, and whether its link's lookup still knows it. */
  readonly addresses: readonly string[];
  /** The e-mails the last command sent, sorted: `offline d0 -> a1`. */
  readonly mail: readonly string[];
}

/**
 * The address a command names, once `count` addresses were added: counted back from the newest
 * (0 is the newest) and wrapped around, so every draw lands on one. Null while there is none.
 */
export function addressOf(c: Command, count: number): number | null {
  return 'a' in c && count > 0 ? count - 1 - (c.a % count) : null;
}

/**
 * The command as one short line: what a shrunk failure prints. As drawn, an address reads `a~0`
 * (the newest at that moment); with `count`, the number of addresses added when the command
 * runs, it reads as the address it lands on (`a0` is the first one added).
 */
export function describeCommand(c: Command, count?: number): string {
  switch (c.kind) {
    case 'Tick':
    case 'TwoTicks':
      return c.kind;
    case 'Advance':
      return `Advance ${String(c.steps * STEP_MINUTES)}min`;
    case 'Heartbeat':
    case 'Revoke':
    case 'Repair':
    case 'AlertsOff':
    case 'AlertsOn':
    case 'BackOnlineOff':
    case 'BackOnlineOn':
      return `${c.kind} d${String(c.d)}`;
    case 'AddAddress':
    case 'RemoveMember':
    case 'EndSessions':
      return `${c.kind} m${String(c.m)}`;
    case 'Confirm':
    case 'RemoveAddress': {
      const landed = count === undefined ? null : addressOf(c, count);
      return `${c.kind} ${landed === null ? `a~${String(c.a)}` : `a${String(landed)}`}`;
    }
  }
}

/**
 * The model. `apply` answers what the command must answer and moves the state; `observed` is
 * what the application must then hold. Every screen starts with no player, alerts on at the
 * delay, and the reporting-again e-mail on.
 */
export class AlertModel {
  readonly #screens: Screen[] = Array.from({ length: DISPLAYS }, () => ({
    player: null,
    report: null,
    alertsOn: true,
    backOnline: true,
    episode: null,
  }));
  readonly #members: Member[] = Array.from({ length: MEMBERS }, () => ({
    removed: false,
    cutOff: null,
  }));
  readonly #addresses: Address[] = [];
  readonly #transitions: string[][] = Array.from({ length: DISPLAYS }, () => []);
  #mail: string[] = [];
  #minutes = 0;
  #commands = 0;
  #reports = 0;
  #players = 0;
  #reached: string[] = [];

  get addressCount(): number {
    return this.#addresses.length;
  }

  /** What happened since the last call that the answers do not say: for the generator's self-check. */
  takeReached(): string[] {
    const reached = this.#reached;
    this.#reached = [];
    return reached;
  }

  #screen(d: number): Screen {
    const screen = this.#screens[d];
    if (screen === undefined) throw new Error(`the model has no screen d${String(d)}`);
    return screen;
  }
  #member(m: number): Member {
    const member = this.#members[m];
    if (member === undefined) throw new Error(`the model has no member m${String(m)}`);
    return member;
  }

  /** D22: a pending address lives while the member who added it still has the access they had then. */
  #adderStillHasAccess(address: Address): boolean {
    const adder = this.#member(address.adder);
    return !adder.removed && (adder.cutOff === null || address.addedAt > adder.cutOff);
  }

  /** One run of the check over every screen. */
  #check(): { offline: number; online: number; closed: number } {
    const counts = { offline: 0, online: 0, closed: 0 };
    const to = this.#addresses.flatMap((a, i) => (a.state === 'confirmed' ? [i] : []));
    this.#screens.forEach((screen, d) => {
      // Only the report of the player the screen has now counts.
      const report =
        screen.report !== null && screen.report.player === screen.player ? screen.report : null;
      if (screen.episode === null) {
        if (!screen.alertsOn || report === null) return;
        if (this.#minutes - report.at < DELAY_MINUTES) return;
        screen.episode = { order: report.order, player: report.player };
        counts.offline += 1;
        this.#transitions[d]?.push('offline');
        for (const a of to) this.#mail.push(`offline d${String(d)} -> a${String(a)}`);
        this.#reached.push(to.length === 0 ? 'offline, nobody to tell' : 'offline e-mail');
        return;
      }
      const watched = screen.alertsOn && report !== null;
      const back = watched && report.order > screen.episode.order;
      // Still silent: the episode stays open and nothing more is sent for it.
      if (watched && !back) {
        this.#reached.push('episode still open: nothing sent again');
        return;
      }
      const opened = screen.episode;
      screen.episode = null;
      if (back && screen.backOnline) {
        counts.online += 1;
        this.#transitions[d]?.push('online');
        for (const a of to) this.#mail.push(`online d${String(d)} -> a${String(a)}`);
        this.#reached.push(
          opened.player === screen.player
            ? 'reporting-again e-mail'
            : 'reporting-again e-mail: a new player reported',
        );
      } else {
        counts.closed += 1;
        this.#reached.push(
          !screen.alertsOn
            ? 'closed silently: alerts off'
            : screen.player === null
              ? 'closed silently: no player'
              : report === null
                ? 'closed silently: paired again, no report yet'
                : 'closed silently: reporting-again e-mail off',
        );
      }
    });
    return counts;
  }

  /**
   * @param ran for TwoTicks, how many of the two runs did the work (the other found the lock
   *   held and skipped): the one thing the model is told, since both are right.
   */
  apply(c: Command, ran = 1): string {
    this.#commands += 1;
    this.#mail = [];
    const landed = addressOf(c, this.#addresses.length);
    if ('a' in c && landed === null) return 'skipped';
    switch (c.kind) {
      case 'Heartbeat': {
        const screen = this.#screen(c.d);
        if (screen.player === null) return 'no_player';
        this.#reports += 1;
        screen.report = { player: screen.player, at: this.#minutes, order: this.#reports };
        return 'reported';
      }
      case 'Advance':
        this.#minutes += c.steps * STEP_MINUTES;
        return 'advanced';
      case 'Tick':
      case 'TwoTicks': {
        const total = { offline: 0, online: 0, closed: 0 };
        const runs = c.kind === 'Tick' ? 1 : ran;
        for (let i = 0; i < runs; i += 1) {
          const counts = this.#check();
          total.offline += counts.offline;
          total.online += counts.online;
          total.closed += counts.closed;
        }
        if (runs === 2) this.#reached.push('two runs, one after the other');
        return `ran=${String(runs)} offline=${String(total.offline)} online=${String(total.online)} closed=${String(total.closed)}`;
      }
      case 'Revoke': {
        const screen = this.#screen(c.d);
        if (screen.player === null) return 'no_player';
        screen.player = null;
        return 'revoked';
      }
      case 'Repair':
        // A new player, also in place of one the screen has: its report is still to come.
        this.#players += 1;
        this.#screen(c.d).player = this.#players;
        return 'paired';
      case 'AlertsOff':
      case 'AlertsOn':
        this.#screen(c.d).alertsOn = c.kind === 'AlertsOn';
        return 'saved';
      case 'BackOnlineOff':
      case 'BackOnlineOn':
        this.#screen(c.d).backOnline = c.kind === 'BackOnlineOn';
        return 'saved';
      case 'AddAddress':
        if (this.#member(c.m).removed) return 'no_access';
        if (this.#addresses.filter((a) => a.state !== 'removed').length >= MAX_ADDRESSES) {
          return 'full';
        }
        this.#addresses.push({ adder: c.m, addedAt: this.#commands, state: 'pending' });
        return 'added';
      case 'Confirm': {
        const address = this.#addresses[landed ?? -1];
        if (address === undefined) throw new Error('the model lost an address');
        if (address.state !== 'pending') {
          this.#reached.push(
            address.state === 'confirmed' ? 'link used twice' : 'link of a removed address',
          );
          return 'not_found';
        }
        if (!this.#adderStillHasAccess(address)) {
          this.#reached.push(
            this.#member(address.adder).removed
              ? 'link refused: the adder was removed'
              : 'link refused: the adder’s sessions were ended',
          );
          return 'not_found';
        }
        if (this.#member(address.adder).cutOff !== null) {
          this.#reached.push('link accepted: added after the adder’s cut-off');
        }
        address.state = 'confirmed';
        return 'confirmed';
      }
      case 'RemoveAddress': {
        const address = this.#addresses[landed ?? -1];
        if (address === undefined) throw new Error('the model lost an address');
        if (address.state === 'removed') return 'not_found';
        address.state = 'removed';
        return 'removed';
      }
      case 'RemoveMember': {
        const member = this.#member(c.m);
        if (member.removed) return 'skipped';
        member.removed = true;
        member.cutOff = this.#commands;
        return 'removed';
      }
      case 'EndSessions': {
        const member = this.#member(c.m);
        if (member.removed) return 'skipped';
        member.cutOff = this.#commands;
        return 'sessions_ended';
      }
    }
  }

  observed(): Observed {
    return {
      episodes: this.#screens.flatMap((s, d) => (s.episode === null ? [] : [`d${String(d)}`])),
      transitions: this.#transitions.map((own, d) => `d${String(d)}: ${own.join(' ')}`),
      addresses: this.#addresses.map((a, i) => {
        const shown =
          a.state === 'removed'
            ? 'gone'
            : a.state === 'confirmed'
              ? 'confirmed'
              : this.#adderStillHasAccess(a)
                ? 'waiting'
                : 'expired';
        // Today the lookup of a link knows every address that is not confirmed yet, a dead one
        // too; the route then refuses it (D22, left open: tightening it is a new migration).
        return `a${String(i)} ${shown} link=${a.state === 'pending' ? 'known' : 'unknown'}`;
      }),
      mail: [...this.#mail].sort(),
    };
  }
}

// ------------------------------------------------------------------------ generator

const display = fc.nat({ max: DISPLAYS - 1 });
const member = fc.nat({ max: MEMBERS - 1 });
// Counted back from the newest address (addressOf); mostly the newest two.
const address = fc.oneof({ weight: 3, arbitrary: fc.nat({ max: 1 }) }, fc.nat({ max: 4 }));

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
const on = <K extends Command['kind']>(kind: K) =>
  fc.record({ kind: fc.constant(kind), d: display });
/** One, two or three steps: short of the delay, short of it again, and onto it. */
const advance: fc.Arbitrary<Command> = fc
  .integer({ min: 1, max: DELAY_MINUTES / STEP_MINUTES })
  .map((steps) => ({ kind: 'Advance', steps }));

/** Any one command, or a short run of them. */
const anything: fc.Arbitrary<Command[]> = fc.oneof<Weighted[]>(
  one(4, on('Heartbeat')),
  one(3, advance),
  one(5, fc.constant({ kind: 'Tick' })),
  one(1, fc.constant({ kind: 'TwoTicks' })),
  one(1, on('Revoke')),
  one(2, on('Repair')),
  one(1, on('AlertsOff')),
  one(1, on('AlertsOn')),
  one(1, on('BackOnlineOff')),
  one(1, on('BackOnlineOn')),
  one(1, fc.record({ kind: fc.constant('AddAddress'), m: member })),
  one(2, fc.record({ kind: fc.constant('Confirm'), a: address })),
  one(1, fc.record({ kind: fc.constant('RemoveMember'), m: member })),
  one(1, fc.record({ kind: fc.constant('EndSessions'), m: member })),
  // An address taken off the list, and then asked for again: its link, and a second removal.
  {
    weight: 2,
    arbitrary: fc
      .tuple(address, fc.boolean(), fc.boolean())
      .map(([a, linkAfter, again]) => [
        { kind: 'RemoveAddress', a },
        ...(linkAfter ? [{ kind: 'Confirm', a } as const] : []),
        ...(again ? [{ kind: 'RemoveAddress', a } as const] : []),
      ]),
  },
  // A member whose sessions were ended, or who was removed, and who then adds an address: after
  // the cut-off the first one's link works, and the second one cannot add at all (D22).
  {
    weight: 2,
    arbitrary: fc.tuple(member, fc.boolean()).map(([m, removed]) => [
      { kind: removed ? 'RemoveMember' : 'EndSessions', m },
      { kind: 'AddAddress', m },
      { kind: 'Confirm', a: 0 },
    ]),
  },
  // An address from its addition to its link, with up to two commands between: where a change
  // to the member who added it decides whether the link still works (D22).
  {
    weight: 4,
    arbitrary: member.chain((m) =>
      fc
        .array(
          fc.oneof<fc.Arbitrary<Command>[]>(
            // The member who added it, more often than the other one.
            fc.constantFrom<Command[]>({ kind: 'RemoveMember', m }, { kind: 'EndSessions', m }),
            fc.record({ kind: fc.constant('RemoveMember'), m: member }),
            fc.record({ kind: fc.constant('EndSessions'), m: member }),
            fc.record({ kind: fc.constant('AddAddress'), m: member }),
            fc.record({ kind: fc.constant('Confirm'), a: address }),
            fc.constant({ kind: 'Tick' }),
          ),
          { maxLength: 2 },
        )
        .map((between) => [
          { kind: 'AddAddress', m },
          ...between,
          // The address this run added, however many came after it.
          { kind: 'Confirm', a: between.filter((c) => c.kind === 'AddAddress').length },
        ]),
    ),
  },
);

/** One check, or two at once. */
const check: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Command>({ kind: 'Tick' }) },
  { weight: 1, arbitrary: fc.constant<Command>({ kind: 'TwoTicks' }) },
);

/** What can happen to a screen while its episode is open, each of which ends it its own way. */
const meanwhile = (d: number): fc.Arbitrary<Command[]> =>
  fc.oneof<Weighted[]>(
    { weight: 6, arbitrary: anything },
    one(2, fc.constant({ kind: 'Heartbeat', d })),
    one(2, fc.constant({ kind: 'Repair', d })),
    one(2, fc.constant({ kind: 'Revoke', d })),
    one(2, fc.constant({ kind: 'AlertsOff', d })),
    one(2, fc.constant({ kind: 'BackOnlineOff', d })),
    one(1, fc.constant({ kind: 'AlertsOn', d })),
    one(1, fc.constant({ kind: 'BackOnlineOn', d })),
  );

/**
 * A screen that reports, falls silent (mostly onto its delay, sometimes short of it) and is
 * checked, with up to two things happening before it is checked again: where a new report, a
 * new player, a revocation or a setting decides how the episode ends.
 */
const outage: fc.Arbitrary<Command[]> = display.chain((d) =>
  fc
    .tuple(
      fc.boolean(),
      fc.oneof(
        { weight: 3, arbitrary: fc.constant(DELAY_MINUTES / STEP_MINUTES) },
        fc.nat({ max: 2 }),
      ),
      check,
      fc.array(meanwhile(d), { maxLength: 2 }),
      check,
    )
    .map(([pairFirst, steps, first, between, second]) => [
      ...(pairFirst ? [{ kind: 'Repair', d } as const] : []),
      { kind: 'Heartbeat', d },
      ...(steps === 0 ? [] : [{ kind: 'Advance', steps } as const]),
      first,
      ...between.flat(),
      second,
    ]),
);

/**
 * How most runs begin: an address someone confirmed, and players on the screens. Each part is
 * left out for a small number, so a failure shrinks to a run without the parts it does not need.
 */
const opening: fc.Arbitrary<Command[]> = fc
  .tuple(fc.nat({ max: 9 }), member, fc.nat({ max: 9 }), fc.nat({ max: 9 }))
  .map(([withAddress, m, first, second]) => [
    ...(withAddress >= 2
      ? [{ kind: 'AddAddress', m } as const, { kind: 'Confirm', a: 0 } as const]
      : []),
    ...(first >= 2 ? [{ kind: 'Repair', d: 0 } as const] : []),
    ...(second >= 4 ? [{ kind: 'Repair', d: 1 } as const] : []),
  ]);

/**
 * Command sequences: an opening, then outages and address confirmations with something between
 * their two ends, mixed with single commands. Screens and members are few, so the commands
 * meet each other; the self-check in alert-episode-model.test.ts counts how often each rule is
 * reached.
 */
export const commandsArb: fc.Arbitrary<Command[]> = fc
  .tuple(
    opening,
    fc.array(fc.oneof({ weight: 3, arbitrary: outage }, { weight: 2, arbitrary: anything }), {
      minLength: 1,
      maxLength: 6,
      // Without it fast-check keeps the arrays of a default run to a few steps.
      size: 'max',
    }),
  )
  .map(([first, steps]) => [...first, ...steps.flat()].map(printable));
