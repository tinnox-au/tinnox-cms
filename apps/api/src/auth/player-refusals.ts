/**
 * The player protocol's three 403s (docs/player-protocol-v1.md section 10), named here because a
 * route file builds no 403 of its own (adoption plan step 28; NO_ROUTE_403 in eslint.config.js).
 * Each is decided without looking up the requested id, so it is the same for an own, unknown or
 * another organisation's id (D1): the signed media URL checks read only the URL, and the
 * heartbeat compares the report's display id with the credential's.
 */
import { HttpError } from '../errors.ts';

/** A media address whose parts or signature do not check out. The player requests new URLs. */
export const mediaUrlInvalid = (): HttpError =>
  new HttpError('url_signature_invalid', 'This media address is not valid.');

/** A validly signed media address past its expiry. The player requests new URLs. */
export const mediaUrlExpired = (): HttpError =>
  new HttpError('url_expired', 'This media address has expired. Request a new one.');

/**
 * A heartbeat whose report names a display other than the credential's. It stays 403, not 404:
 * the protocol tells the player to reset its local state on it, and a 404 there would merge two
 * states (D1).
 */
export const reportForOtherDisplay = (): HttpError =>
  new HttpError('forbidden', 'This credential cannot report for that display.');
