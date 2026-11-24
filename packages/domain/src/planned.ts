import type { PublicationDraft } from './types.ts';

// DEC-23. This module is not re-exported by src/index.ts, and package.json exports only the
// root entry, so code outside this package cannot import markPlanned: only the planners of
// manifest.ts, schedule.ts and layout.ts (and the package's own tests) mint the brand. A cast to
// PlannedPublication is refused by lint everywhere but here (NO_PLANNED_PUBLICATION_CAST in
// eslint.config.js).

declare const plannedBy: unique symbol;

/**
 * A draft the publishing rule accepted (DEC-23). The brand exists only in the type, so a
 * publication cannot be created from a hand-built draft that skipped the route's capability check.
 */
export type PlannedPublication = PublicationDraft & { readonly [plannedBy]: true };

/** Marks a draft a planner accepted. */
export function markPlanned(draft: PublicationDraft): PlannedPublication {
  return draft as PlannedPublication;
}
