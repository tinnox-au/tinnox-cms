// The end-to-end stack reaches only services on this machine (EAX-09, adoption plan step 12b).
// tests/e2e/support/stack.ts builds the API's environment with allowListedEnv, and refuses to
// start while loopbackProblems finds a host or URL that is not loopback. The rules are pure so
// that the unit project tests them; the stack is only exercised by the browser suite.
import { isIP } from 'node:net';

/** A value the stack is about to use, and where it was set (for the refusal's instruction). */
export interface Target {
  readonly name: string;
  readonly value: string;
  /** Where to change it, for example "the root .env". */
  readonly source: string;
}

// A name that holds a host or a URL by this repository's naming, and a value that is a URL
// whatever its name: a new setting that points somewhere is checked even under another name.
const POINTER_NAME = /_(HOST|URL|URI|ORIGIN|ISSUER)$/;
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** True for a value that names somewhere to connect to, by its name or by its form. */
export function pointsSomewhere(name: string, value: string): boolean {
  return value !== '' && (POINTER_NAME.test(name) || URL_VALUE.test(value));
}

/**
 * True for a literal loopback address only: 127.0.0.0/8 or ::1, bare or in URL brackets. A name
 * is never loopback here, because what it resolves to is up to the machine (EAX-08).
 */
export function isLoopbackAddress(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family === 4) return bare.startsWith('127.');
  // The URL parser writes every spelling of an IPv6 address in one canonical form.
  if (family === 6) return new URL(`http://[${bare}]/`).hostname === '[::1]';
  return false;
}

/** A bare host, lower-cased; null when the value is not an address or a host name. */
function bareHost(value: string): string | null {
  if (isIP(value) !== 0 || isLoopbackAddress(value)) return value.toLowerCase();
  return HOST_NAME.test(value) ? value.toLowerCase() : null;
}

// pg-connection-string and libpq take the host from these query parameters over the URL's
// authority, each a comma-separated list, so postgres://u:p@127.0.0.1/db?host=db.example.com
// connects to db.example.com. Read on any URL: telling the schemes apart buys nothing here.
const HOST_PARAMETERS = ['host', 'hostaddr'];

/**
 * Every host a value points at, lower-cased: a URL's host and the hosts in its host and hostaddr
 * query parameters, or a bare host. Null when any of them cannot be read, so the caller refuses.
 */
export function hostsOf(value: string): string[] | null {
  if (!URL_VALUE.test(value)) {
    const host = bareHost(value);
    return host === null ? null : [host];
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === '') return null;
  const hosts = [host];
  for (const parameter of HOST_PARAMETERS) {
    for (const listed of url.searchParams.getAll(parameter)) {
      for (const entry of listed.split(',')) {
        const extra = bareHost(entry.trim());
        if (extra === null) return null;
        hosts.push(extra);
      }
    }
  }
  return hosts;
}

/**
 * A loopback address, or the one name `localhost`, which the stack also resolves before it starts
 * (localhostProblem). Not `*.localhost` and not a name that merely contains a loopback address.
 */
export function isLoopbackTarget(host: string): boolean {
  return host === 'localhost' || isLoopbackAddress(host);
}

const FIX =
  'The end-to-end stack may reach only services on this machine, so that a run never mails, signs in at or connects to anything a developer has configured (EAX-09)';

/**
 * One problem per target that points somewhere other than this machine. A problem names the
 * variable and the hosts, never the whole value: a URL can carry a password.
 */
export function loopbackProblems(targets: readonly Target[]): string[] {
  const problems: string[] = [];
  for (const { name, value, source } of targets) {
    if (!pointsSomewhere(name, value)) continue;
    const hosts = hostsOf(value);
    const outside = hosts?.filter((host) => !isLoopbackTarget(host)) ?? [];
    if (hosts === null) {
      problems.push(
        `${name} (${source}) is not a host name or a URL this check can read, so it cannot be shown to stay on this machine. ${FIX}: set it to localhost, 127.0.0.1 or ::1, or to a URL on one of them`,
      );
    } else if (outside.length > 0) {
      problems.push(
        `${name} (${source}) points at ${outside.join(', ')}, which ${outside.length === 1 ? 'is not a loopback address' : 'are not loopback addresses'}. ${FIX}: set it to localhost, 127.0.0.1 or ::1, or to a URL on one of them; a host or hostaddr query parameter in a URL must name one of them too`,
      );
    }
  }
  return problems;
}

/** The refusal when `localhost` resolves to anything but loopback addresses on this machine. */
export function localhostProblem(addresses: readonly string[]): string | null {
  const outside = addresses.filter((address) => !isLoopbackAddress(address));
  if (addresses.length > 0 && outside.length === 0) return null;
  return `localhost resolves to ${addresses.length === 0 ? 'nothing' : outside.join(', ')} on this machine, not only to loopback addresses. ${FIX}: map localhost to 127.0.0.1 and ::1 only (/etc/hosts)`;
}

/** The names a process reads, and where the stack takes each value from. */
export interface EnvAllowList {
  /** Every name the process reads. A name not listed below is passed empty, so nothing fills it in. */
  readonly names: readonly string[];
  /** Values the stack sets itself, whatever the developer's environment says. */
  readonly fixed: Readonly<Record<string, string>>;
  /** Names whose value is taken from the source as it is. */
  readonly fromSource: readonly string[];
}

/**
 * The environment for a process that reads `names`: the fixed values, the listed names from
 * `source`, and an empty value for every other name. The process takes nothing else, so a setting
 * that is not on the list cannot reach it from the shell or from a file it reads itself.
 */
export function allowListedEnv(
  list: EnvAllowList,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const known = new Set(list.names);
  const listed = [...Object.keys(list.fixed), ...list.fromSource];
  const unknown = listed.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not read by the process: remove ${unknown.length === 1 ? 'it' : 'them'} from the allow-list, or add the setting where the process reads its names`,
    );
  }
  const twice = list.fromSource.filter((name) => Object.hasOwn(list.fixed, name));
  if (twice.length > 0) {
    throw new Error(
      `${twice.join(', ')} ${twice.length === 1 ? 'is' : 'are'} both fixed and taken from the source: keep one`,
    );
  }
  const env: Record<string, string> = {};
  for (const name of list.names) {
    env[name] = Object.hasOwn(list.fixed, name)
      ? (list.fixed[name] ?? '')
      : list.fromSource.includes(name)
        ? (source[name] ?? '')
        : '';
  }
  return env;
}
