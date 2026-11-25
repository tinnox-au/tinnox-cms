// fast-check generators for the end-session URL (adoption plan section 4.4, property 12).
//
// Choosing a generator: an ID token is a JWT (base64url and dots), but `endSessionUrl` takes
// whatever string the session row holds, so tokens are drawn of 0 to 8192 characters in four
// alphabets: JWT characters, printable ASCII, any Unicode code point, and UTF-16 units that
// include lone surrogates. The length is drawn first, so long tokens are as likely as short ones;
// oidc.property.test.ts checks the drawn lengths stay within the range.
import fc from 'fast-check';

export const MAX_TOKEN_LENGTH = 8192;

const JWT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.'.split('');

const units: readonly fc.Arbitrary<string>[] = [
  fc.constantFrom(...JWT_CHARS),
  fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
  fc
    .integer({ min: 0, max: 0x10ffff })
    .map((code) => (code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : String.fromCodePoint(code))),
  fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code)),
];

/** A token of 0 to 8192 UTF-16 units from one of the alphabets above. */
export const tokenArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 0, max: MAX_TOKEN_LENGTH }), fc.nat({ max: units.length - 1 }))
  .chain(([length, alphabet]) =>
    fc
      .array(units[alphabet] ?? fc.constant('x'), { minLength: length, maxLength: length })
      // An astral code point is two units: cut back to the drawn length.
      .map((chars) => chars.join('').slice(0, length)),
  );
