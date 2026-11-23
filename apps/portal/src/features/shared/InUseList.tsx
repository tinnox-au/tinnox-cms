export interface InUseListProps {
  /** The names the refusal lists, in its order; a name may appear more than once. */
  readonly names: readonly string[];
  readonly testId: string;
}

/**
 * What still uses the thing being deleted: the screens a `layout_in_use` or `schedule_in_use`
 * refusal names, or the playlists of an `app_in_use` one. Nothing when the refusal names none.
 * Names are not unique (two screens may both be "Lobby") and the refusal carries no ids, so each
 * row is keyed by its position in the answer: a name key would give React two equal keys, and
 * it can then show a row twice or drop one (LYX-04).
 */
export function InUseList({ names, testId }: InUseListProps) {
  if (names.length === 0) return null;
  return (
    <ul data-testid={testId}>
      {names.map((name, index) => (
        <li key={index}>{name}</li>
      ))}
    </ul>
  );
}
