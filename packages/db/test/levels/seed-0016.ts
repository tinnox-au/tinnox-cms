// Level 0016: no rows of its own.
import type { Seeder } from './sql.ts';

export const seeder: Seeder = {
  level: '0016',
  reason:
    '0016 only tightens CHECK constraints (the two address shapes, the media window years) and adds no table or column, so a 0016 installation holds nothing an earlier level could not. What it refuses is what earlier seeders must not plant: the chain applies it to their addresses and window, and its refusing case stays in migration-0016.integration.test.ts.',
};
