// Level 0015: no rows of its own.
import type { Seeder } from './sql.ts';

export const seeder: Seeder = {
  level: '0015',
  reason:
    '0015 only replaces sec.session_revoke_membership (it locks the member row before it stamps the cut-off); no table, column or constraint changes.',
};
