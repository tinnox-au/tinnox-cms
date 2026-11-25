// Level 0010: no rows of its own.
import type { Seeder } from './sql.ts';

export const seeder: Seeder = {
  level: '0010',
  reason:
    "0010 only replaces sec.* pairing functions (claim, complete, poll, cancel_claims); no table or column changes. The rows it missed, claims accepted before 0010 that could still complete, are planted by level 0011's seeder, where migration-0012.integration.test.ts has always started.",
};
