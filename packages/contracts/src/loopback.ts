// The one rule for "this host is this machine" (EAX-08). The API uses it to relax TLS for a mail
// relay and to allow an http issuer outside production; the end-to-end stack uses it to refuse a
// host that is not local (EAX-09, scripts/lib/loopback-targets.ts). It lives here because both
// may import @tinnox/contracts under IMPORT_LAYERS and the portal bundles this package, so it
// takes no node: module and parses the one address it knows.

/**
 * True for a literal loopback address only: 127.0.0.1, or ::1 in any spelling, bare or in URL
 * brackets. A name is never loopback here, not even `localhost`, because what it resolves to is up
 * to the machine, and not another 127.x address either: the API never needed one, so the one
 * rule takes the narrower answer of the two copies it replaced.
 */
export function isLoopbackAddress(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '127.0.0.1') return true;
  return isIpv6Loopback(bare);
}

/** ::1 in any spelling of the groups: ::1, 0:0::1, 0000:0000:0000:0000:0000:0000:0000:0001. */
function isIpv6Loopback(address: string): boolean {
  // Hex digits and colons only: no dotted tail, no zone id (::1%lo0), no host name.
  if (!/^[0-9a-f:]+$/i.test(address)) return false;
  const gap = address.indexOf('::');
  if (gap !== address.lastIndexOf('::')) return false;
  const groupsOf = (text: string): string[] => (text === '' ? [] : text.split(':'));
  const groups =
    gap === -1
      ? groupsOf(address)
      : [...groupsOf(address.slice(0, gap)), '', ...groupsOf(address.slice(gap + 2))];
  const written = groups.filter((group) => group !== '');
  if (!written.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  // Without "::" all eight groups are written; with it, at least one is left out.
  if (gap === -1 ? written.length !== 8 : written.length > 7) return false;
  const last = groups[groups.length - 1];
  // "::" must not be the end of the address, or the 1 would not be the last group.
  if (last === undefined || last === '') return false;
  return (
    Number.parseInt(last, 16) === 1 && written.slice(0, -1).every((group) => /^0+$/.test(group))
  );
}
