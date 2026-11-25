// Level 0012: no rows of its own.
import type { Seeder } from './sql.ts';

export const seeder: Seeder = {
  level: '0012',
  reason:
    "0012 changes no table: it cancels the claims from before 0010 that could still complete (level 0011's seeder planted them), audits each screen once, and replaces sec.pairing_cancel_claims.",
};
