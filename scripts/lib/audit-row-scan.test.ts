// The rules of the audit row scan (AG-3.4, adoption plan step 17), against rows as the product
// writes them and rows that hold what an audit row must not.
import { describe, expect, it } from 'vitest';
import {
  auditRowProblems,
  auditScanProblems,
  forbiddenShape,
  type ScannedAuditRow,
} from './audit-row-scan.ts';

const MEMBER = '0b7e1a2c-aaaa-4bbb-8ccc-dddddddddddd';
const DISPLAY = '3f9a12c4-1111-4222-8333-444455556666';
// Made up for the fixture: the shape of a session or device token, not a real one.
const TOKEN_SHAPED = `${'not-a-real-one_'.repeat(2)}0123456789abc`;

// Put together here, so the source holds nothing a secret scanner reads as a signed token.
const part = (json: string): string => Buffer.from(json).toString('base64url');
const JWT_SHAPED = `${part('{"alg":"none"}')}.${part('{"sub":"nobody"}')}.`;

const row = (fields: Partial<ScannedAuditRow>): ScannedAuditRow => ({
  id: '41',
  action: 'display.update',
  actorId: MEMBER,
  objectType: 'display',
  objectId: DISPLAY,
  detail: null,
  ...fields,
});

describe('forbiddenShape', () => {
  it.each([
    ['https://cdn.example/media/1', 'a URL'],
    ['postgres://tinnox_app@db/tinnox', 'a URL'],
    ['/player/media/1?exp=1700000000', 'a query string'],
    ['reg=1&sig=abc', 'a query string'],
    ['sig=abc', 'a query string'],
    [TOKEN_SHAPED, 'a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")'],
    // A SHA-256 digest in hex.
    ['a'.repeat(64), 'a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")'],
    [
      `Bearer ${TOKEN_SHAPED}`,
      'a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")',
    ],
    [JWT_SHAPED, 'a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")'],
    ['robin@example.com', 'an e-mail address'],
    ['Robin Example <robin@example.com>', 'an e-mail address'],
  ])('refuses %s as %s', (text, shape) => {
    expect(forbiddenShape(text)).toBe(shape);
  });

  it.each([
    MEMBER,
    // Two ids side by side are still ids.
    `${MEMBER}${DISPLAY}`,
    `${MEMBER.toUpperCase()}`,
    'POST /api/displays/:id/revoke-player',
    '/player/media/:assetId',
    'storage_quota_exceeded',
    'unknown_or_expired_state',
    'bytesRetainedForPublications',
    'image/png',
    'REQ-40',
    'sam.staff',
    // A keyed fingerprint of a client address: 16 characters, by design too short to be a token.
    'Zx81aQ_-3kLmN0pq',
    'urn:mace:incommon:iap:silver',
    'screen.setup',
    'Is this a question?',
    '',
  ])('lets %s through', (text) => {
    expect(forbiddenShape(text)).toBeNull();
  });
});

describe('auditRowProblems', () => {
  it('finds nothing in rows as the product writes them', () => {
    const rows = [
      row({ detail: { fields: ['assignedPlaylistId', 'name'], assignedPlaylistId: DISPLAY } }),
      row({
        action: 'security.permission_denied',
        objectType: 'route',
        objectId: 'POST /api/media',
        detail: {
          permission: ['content.write'],
          method: 'POST',
          route: '/api/media',
          reason: 'role',
          refusalsInWindow: 1,
          throttled: false,
        },
      }),
      row({
        action: 'player.auth_rejected',
        actorId: null,
        objectType: null,
        objectId: null,
        detail: {
          route: '/player/manifest',
          client: 'Zx81aQ_-3kLmN0pq',
          failuresInWindow: 1,
          throttled: false,
        },
      }),
      row({
        action: 'pairing.claim',
        detail: { pairingId: MEMBER, cancelledPairingIds: [DISPLAY, MEMBER] },
      }),
      row({
        action: 'membership.create',
        actorId: null,
        detail: {
          role: 'owner',
          inviteId: null,
          reactivated: false,
          requestRef: 'REQ-40',
          executedBy: 'sam.staff',
        },
      }),
    ];
    expect(auditScanProblems(rows)).toEqual([]);
  });

  it('names the row, where the value is and what to record instead', () => {
    expect(auditRowProblems(row({ detail: { previewUrl: 'https://cdn.example/a.png' } }))).toEqual([
      'audit_event 41 (display.update): detail.previewUrl holds a URL. An audit row never holds content, a secret, a token, a signed URL or a query string (AGENTS.md section 3): record an id, a count, a route pattern or a code from a closed list instead, and declare the field in AuditEventShapes (packages/contracts/src/audit.ts).',
    ]);
  });

  it('reads every text column, nested values, list items and keys', () => {
    const problems = auditScanProblems([
      row({ id: '1', actorId: 'robin@example.com' }),
      row({ id: '2', objectId: `/player/media/${DISPLAY}?reg=${MEMBER}` }),
      row({ id: '3', objectType: TOKEN_SHAPED }),
      row({ id: '4', detail: { outer: { inner: [0, 'fine', TOKEN_SHAPED] } } }),
      row({ id: '5', detail: { 'https://key.example': 1 } }),
      row({ id: '6', detail: [{ token: `x ${TOKEN_SHAPED}` }] }),
      // Not strings: a number, a flag and null hold nothing to judge.
      row({ id: '7', detail: { bytes: 1234567890123456, throttled: true, colour: null } }),
    ]);
    expect(problems.map((problem) => problem.slice(0, problem.indexOf('. An audit row')))).toEqual([
      'audit_event 1 (display.update): actor_id holds an e-mail address',
      'audit_event 2 (display.update): object_id holds a query string',
      'audit_event 3 (display.update): object_type holds a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")',
      'audit_event 4 (display.update): detail.outer.inner[2] holds a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")',
      'audit_event 5 (display.update): detail (the key "https://key.example") holds a URL',
      'audit_event 6 (display.update): detail[0].token holds a token-shaped string (32 or more characters of A-Z, a-z, 0-9, "-" and "_")',
    ]);
  });
});
