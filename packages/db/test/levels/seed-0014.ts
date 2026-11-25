// Level 0014, e-mail alerts: a confirmed and an unconfirmed alert address, a display with its own
// offline delay, and an open offline episode for the paired display of level 0004.
import { bytes32, id, inOrg, type Seeder, type SqlClient } from './sql.ts';
import { A as A4, LONG_AGO } from './seed-0004.ts';
import { BEFORE_ALERTS_A } from './seed-0013.ts';

const L = '0014';

export const RECIPIENTS = {
  confirmed: { id: id(L, 1), email: 'alerts@example.com' },
  unconfirmed: { id: id(L, 2), email: 'pending.alerts@example.com', tokenHash: bytes32('e1') },
} as const;

async function seed(client: SqlClient): Promise<void> {
  const q = (text: string, values: unknown[] = []) => client.query(text, values);
  await inOrg(client, BEFORE_ALERTS_A.org, async () => {
    await q(
      `INSERT INTO alert_recipient (id, org_id, email, created_by, confirmed_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        RECIPIENTS.confirmed.id,
        BEFORE_ALERTS_A.org,
        RECIPIENTS.confirmed.email,
        BEFORE_ALERTS_A.owner,
      ],
    );
    await q(
      `INSERT INTO alert_recipient (id, org_id, email, created_by, confirm_token_hash, confirm_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
      [
        RECIPIENTS.unconfirmed.id,
        BEFORE_ALERTS_A.org,
        RECIPIENTS.unconfirmed.email,
        BEFORE_ALERTS_A.owner,
        RECIPIENTS.unconfirmed.tokenHash,
      ],
    );
    await q('UPDATE display SET alert_offline_minutes = 60 WHERE id = $1', [
      BEFORE_ALERTS_A.display,
    ]);
  });
  await inOrg(client, A4.org, async () => {
    await q('INSERT INTO display_alert (display_id, org_id, offline_since) VALUES ($1, $2, $3)', [
      A4.published,
      A4.org,
      LONG_AGO,
    ]);
  });
}

export const seeder: Seeder = {
  level: L,
  plants:
    "a confirmed and an unconfirmed alert address and a 60-minute offline delay in 0013's first organisation; an open offline episode for 0004's paired display",
  seed,
};
