// fast-check generators for the twins differential test (adoption plan section 4.4, step 31).
//
// Each generator draws inputs on both sides of its contract and lands on the edges where a
// contract and its CHECK could part: exact lengths (253, 254 and 255 characters),
// characters that one side counts as whitespace and the other does not (probed against
// PostgreSQL 17 on Alpine on 2026-11-25), control, text-direction, combining and non-ASCII
// letters, characters outside the BMP, upper and lower case, a trailing newline and NUL, the
// first and last year, the same minute on both ends of a window, and the bounds of every number.
// twins.test.ts self-checks that each lands there.
import fc from 'fast-check';

const pick = <T>(values: readonly T[]) => fc.constantFrom(...values);

/** In both JavaScript's \s and PostgreSQL's [:space:]. */
export const SHARED_SPACE = [' ', '\t', '\n', '\r', '\v', '\f', '\u2000', '\u2028', '\u3000'];
/** In JavaScript's \s only. */
export const JS_ONLY_SPACE = ['\u00a0', '\u1680', '\u2007', '\u202f', '\ufeff'];
/**
 * U+0085, a C1 control character the contract refuses. This server's [:space:] (musl) counts it
 * as space and refuses it; other C libraries may store it. Either way the contract refuses it.
 */
export const PG_ONLY_SPACE = ['\u0085'];
export const CONTROL = ['\u0000', '\u0001', '\u001f', '\u007f', '\u009f'];
export const DIRECTION = ['\u200e', '\u202e', '\u2066', '\u061c'];
/** Neither side calls these whitespace. */
export const INVISIBLE = ['\u180e', '\u200b'];
/** Letters whose case JavaScript and PostgreSQL could map differently ('İ' lowers to two code points). */
export const NON_ASCII = ['é', 'Ü', 'ß', 'ẞ', 'İ', 'Σ', 'ς', 'ǅ', 'Ж', '中', 'ﬀ', 'é'];
export const ASTRAL = ['😀', '𝒜'];
/** RFC 5322 punctuation the alert shape refuses, and the shape's own two. */
export const PUNCTUATION = ['<', '>', '(', ')', '[', ']', '\\', ',', ';', ':', '"', '.', '@'];

const asciiChar = pick([...'abcxyzABCXYZ0189-_+']);
const addressChar: fc.Arbitrary<string> = fc.oneof(
  { weight: 12, arbitrary: asciiChar },
  { weight: 2, arbitrary: pick(NON_ASCII) },
  { weight: 1, arbitrary: pick(ASTRAL) },
  { weight: 1, arbitrary: pick(SHARED_SPACE) },
  { weight: 1, arbitrary: pick(JS_ONLY_SPACE) },
  { weight: 1, arbitrary: pick(PG_ONLY_SPACE) },
  { weight: 1, arbitrary: pick(CONTROL) },
  { weight: 1, arbitrary: pick(DIRECTION) },
  { weight: 1, arbitrary: pick(INVISIBLE) },
  { weight: 1, arbitrary: pick(PUNCTUATION) },
);
const part = (minLength: number) =>
  fc.array(addressChar, { minLength, maxLength: 6 }).map((chars) => chars.join(''));
const space = pick(['', '', '', ' ', '\t', '\n', '\u00a0', '\ufeff']);

/** local@label.tld, with an extra or missing "@" or dot now and then, and padding around it. */
const shapedAddress = fc
  .record({
    local: part(0),
    label: part(0),
    tld: part(0),
    at: pick(['@', '@', '@', '', '@@', '@x@']),
    dot: pick(['.', '.', '.', '', '..']),
    before: space,
    after: space,
  })
  .map((a) => `${a.before}${a.local}${a.at}${a.label}${a.dot}${a.tld}${a.after}`);

/**
 * A plain address padded to 253, 254 or 255 characters (code points, which zod's max and
 * char_length both count), with the padding of ASCII, astral or uppercase letters ('İ' lowers
 * to two code points, so a lower-cased address grows).
 */
const longAddress = fc
  .record({
    length: pick([253, 254, 255]),
    pad: pick(['a', 'A', '😀', 'İ']),
    tail: pick(['@example.com', '@exämple.de', '@b.c']),
  })
  .map(({ length, pad, tail }) => {
    const local = Array.from({ length: length - [...tail].length }, () => pad).join('');
    return `${local}${tail}`;
  });

/** Any of the characters above, in no particular shape. */
const looseAddress = fc.array(addressChar, { maxLength: 12 }).map((chars) => chars.join(''));

/** Raw request strings for an address field: trimmed, case-folded and refused by the contract. */
export const addressArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: shapedAddress },
  { weight: 2, arbitrary: longAddress },
  { weight: 1, arbitrary: looseAddress },
);

/** The parts of a wall-clock time 'YYYY-MM-DDTHH:mm', each on and past its bounds. */
export interface Stamp {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}
const edgeOr = (edges: readonly number[], min: number, max: number) =>
  fc.oneof(pick(edges), fc.integer({ min, max }));
/**
 * Hour 24 is not drawn: PostgreSQL reads '24:00' as midnight of the next day, a spelling of a
 * value the contract also takes, not a value outside it (twins.test.ts pins it).
 */
export const stampArb: fc.Arbitrary<Stamp> = fc.record({
  year: edgeOr([0, 999, 1000, 1001, 9998, 9999, 10_000, 99_999], 1000, 9999),
  month: edgeOr([0, 1, 2, 12, 13], 1, 12),
  day: edgeOr([0, 1, 28, 29, 30, 31, 32], 1, 28),
  hour: edgeOr([0, 23], 0, 23),
  minute: edgeOr([0, 59, 60], 0, 59),
});
const two = (n: number) => String(n).padStart(2, '0');
export const stampText = (s: Stamp): string =>
  `${String(s.year).padStart(4, '0')}-${two(s.month)}-${two(s.day)}T${two(s.hour)}:${two(s.minute)}`;

/** A window: either end absent, apart, equal, or a minute either way. */
export const windowArb: fc.Arbitrary<{ from: string | null; until: string | null }> = fc
  .record({ from: stampArb, other: stampArb, how: pick(['apart', 'same', 'next', 'previous']) })
  .chain(({ from, other, how }) => {
    const until =
      how === 'apart'
        ? other
        : // Never below 00: a minus sign is outside 'YYYY-MM-DDTHH:mm', and PostgreSQL reads it as a zone.
          {
            ...from,
            minute: Math.max(0, from.minute + (how === 'next' ? 1 : how === 'previous' ? -1 : 0)),
          };
    return fc.record({
      from: fc.option(fc.constant(stampText(from)), { freq: 6 }),
      until: fc.option(fc.constant(stampText(until)), { freq: 6 }),
    });
  });

/** HH:mm on and past its bounds, and the spellings a looser pattern would take. */
export const timeArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .record({ h: edgeOr([0, 23, 24, 25], 0, 23), m: edgeOr([0, 59, 60], 0, 59) })
      .map(({ h, m }) => `${two(h)}:${two(m)}`),
  },
  {
    weight: 1,
    arbitrary: pick([
      '00:00',
      '24:00',
      '24:01',
      '7:00',
      '07:0',
      '٠٧:٠٠',
      '07:00\n',
      ' 07:00',
      '07:00 ',
      '07.00',
      '',
    ]),
  },
);

export type Day = boolean | null;
const days7 = fc.array(fc.boolean(), { minLength: 7, maxLength: 7 });
/** Seven days with at least one, none, a NULL entry, or six or eight entries. */
export const daysArb: fc.Arbitrary<Day[]> = fc.oneof(
  { weight: 6, arbitrary: days7 },
  { weight: 1, arbitrary: fc.constant<Day[]>([false, false, false, false, false, false, false]) },
  {
    weight: 1,
    arbitrary: days7.chain((d) => fc.nat(6).map((n) => d.map((v, i): Day => (i === n ? null : v)))),
  },
  { weight: 1, arbitrary: fc.array(fc.boolean(), { minLength: 0, maxLength: 9 }) },
);

export interface Rule {
  readonly days: Day[];
  readonly start: string;
  readonly end: string;
}
export const ruleArb: fc.Arbitrary<Rule> = fc
  .record({ days: daysArb, start: timeArb, end: timeArb, same: fc.boolean() })
  .map(({ days, start, end, same }) => ({ days, start, end: same && start !== '' ? start : end }));

const VALID_RULE: Rule = {
  days: [true, true, true, true, true, false, false],
  start: '09:00',
  end: '17:00',
};
/**
 * Zero to three rules, 49, 50 or 51 copies of a valid one (the 50-event limit), or a valid rule
 * that ends at 24:00. Random rules reach that last one about once in 600 draws, so the self-check
 * missed it in about 3% of runs; the direct arm makes it a tenth of all draws.
 */
export const eventsArb: fc.Arbitrary<Rule[]> = fc.oneof(
  { weight: 8, arbitrary: fc.array(ruleArb, { maxLength: 3 }) },
  {
    weight: 1,
    arbitrary: pick([49, 50, 51]).map((n) => Array.from({ length: n }, () => VALID_RULE)),
  },
  { weight: 1, arbitrary: fc.constant<Rule[]>([{ ...VALID_RULE, start: '00:00', end: '24:00' }]) },
);

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const coordinate = fc.oneof(
  { weight: 2, arbitrary: pick([-1, 0, 1, 5000, 9999, 10_000, 10_001]) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
  { weight: 1, arbitrary: pick([0.5, 2 ** 31]) },
);
const looseBox: fc.Arbitrary<Box> = fc.record({
  x: coordinate,
  y: coordinate,
  width: coordinate,
  height: coordinate,
});
/** Two zones that share an edge at `at`, one on each side, filling the square. */
const splitPair = edgeOr([1, 5000, 9999], 1, 9999).map((at): Box[] => [
  { x: 0, y: 0, width: at, height: 10_000 },
  { x: at, y: 0, width: 10_000 - at, height: 10_000 },
]);
/**
 * Zone sets of zero to five boxes, in or out of the square, touching, apart or overlapping. Loose
 * boxes overlap inside the square about once in 300 draws, so the self-check missed it in about
 * one run in 650; a split pair whose left zone is one unit too wide overlaps by construction.
 */
export const zonesArb: fc.Arbitrary<Box[]> = fc.oneof(
  { weight: 3, arbitrary: fc.array(looseBox, { maxLength: 5 }) },
  { weight: 2, arbitrary: splitPair },
  {
    weight: 1,
    arbitrary: edgeOr([1, 5000, 9999], 1, 9999).map((at): Box[] => [
      { x: 0, y: 0, width: at + 1, height: 10_000 },
      { x: at, y: 0, width: 10_000 - at, height: 10_000 },
    ]),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(splitPair, fc.array(looseBox, { maxLength: 3 }))
      .map(([pair, more]) => [...pair, ...more]),
  },
);

/** The offline delay on and past its bounds, off, a part of a minute, and past integer. */
export const offlineMinutesArb: fc.Arbitrary<number | null> = fc.oneof(
  {
    weight: 2,
    arbitrary: pick([null, 0, 29, 30, 31, 60, 2850, 2880, 2881, 2910, -30, 30.5, 2 ** 31]),
  },
  { weight: 3, arbitrary: fc.integer({ min: -100, max: 3000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 96 }).map((n) => n * 30) },
);
