// AG-3.4 (adoption plan section 1.4, step 17): an audit row never holds content, a secret, a
// token, a signed URL or a query string. The types close the shape of each action's detail
// (AuditEventShapes in packages/contracts/src/audit.ts), but cannot see what a string holds, so
// the integration set-up reads every row its test file wrote and judges it with the rules here
// (scripts/vitest-integration-file-setup.ts). The rules are pure; audit-row-scan.test.ts holds
// them.
//
// What a rule can see is the shape of a value, not its meaning: an address, the two marks of a
// URL or a query string, and a long run of token characters. A short secret (a pairing code) and
// plain content (a name an operator typed) look like any other word here; the tests of the
// routes that take them check those by value, and judging a new detail field stays with the
// reviewer.

/** An audit row as the scan reads it (StoredAuditRow of @tinnox/db/testing). */
export interface ScannedAuditRow {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly detail: unknown;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// The tokens of this system are 32 random bytes in base64url (43 characters), and a digest in
// hex is 64: both are runs of these characters. An id is a UUID, taken out first.
const TOKEN_RUN = /[A-Za-z0-9_-]{32,}/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const QUERY = /[?&][A-Za-z0-9_.~%-]+=|\bsig=/;
const ADDRESS = /[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/;

/** What `text` looks like that an audit row must not hold, or null. */
export function forbiddenShape(text: string): string | null {
  if (text.includes('://')) return 'a URL';
  if (QUERY.test(text)) return 'a query string';
  if (JWT.test(text) || TOKEN_RUN.test(text.replace(UUID, ' '))) {
    return 'a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")';
  }
  if (ADDRESS.test(text)) return 'an e-mail address';
  return null;
}

/** Every string in a JSON value, each with the path to it; a key is a string too. */
function stringsIn(value: unknown, path: string): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringsIn(item, `${path}[${String(index)}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      { path: `${path} (the key ${JSON.stringify(key)})`, text: key },
      ...stringsIn(item, `${path}.${key}`),
    ]);
  }
  return [];
}

/** The problems of one audit row, one sentence each, saying what to do instead. */
export function auditRowProblems(row: ScannedAuditRow): string[] {
  const texts = [
    ...(row.actorId === null ? [] : [{ path: 'actor_id', text: row.actorId }]),
    ...(row.objectType === null ? [] : [{ path: 'object_type', text: row.objectType }]),
    ...(row.objectId === null ? [] : [{ path: 'object_id', text: row.objectId }]),
    ...stringsIn(row.detail, 'detail'),
  ];
  return texts.flatMap(({ path, text }) => {
    const shape = forbiddenShape(text);
    return shape === null
      ? []
      : [
          `audit_event ${row.id} (${row.action}): ${path} holds ${shape}. An audit row never holds content, a secret, a token, a signed URL or a query string (AGENTS.md section 3): record an id, a count, a route pattern or a code from a closed list instead, and declare the field in AuditEventShapes (packages/contracts/src/audit.ts).`,
        ];
  });
}

/** The problems of every row, in the order of the rows. */
export function auditScanProblems(rows: readonly ScannedAuditRow[]): string[] {
  return rows.flatMap(auditRowProblems);
}
