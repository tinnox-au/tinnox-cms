// Level 0008: no rows of its own.
import type { Seeder } from './sql.ts';

export const seeder: Seeder = {
  level: '0008',
  reason:
    '0008 only rewrites two CHECK constraints to be NULL-safe (publication_manifest_shape, media_ready_is_complete). It adds no table or column, so an installation at 0008 holds nothing the seeders of 0004 to 0007 cannot already plant; the chain proves their rows meet the rewritten checks when 0008 validates them.',
};
