/**
 * Words of the bulk screen delete (CMS-41): the Screens list's selection bar. Pure. A screen
 * the server no longer finds (404) was deleted meanwhile, by another tab or person; it counts
 * as deleted, and the message says so.
 */

import { isApiRequestError } from '../api/client.ts';
import { bulkFailureTitle, countOf } from './bulkOutcome.ts';

/** How one delete ended: deleted now, or already gone (404). */
export type ScreenDeleteResult = 'deleted' | 'gone';

/** Runs one delete; a 404 is the end the operator asked for, so it resolves as `gone`. */
export async function deleteScreen(remove: () => Promise<void>): Promise<ScreenDeleteResult> {
  try {
    await remove();
    return 'deleted';
  } catch (error) {
    if (isApiRequestError(error) && error.status === 404) return 'gone';
    throw error;
  }
}

/**
 * Who loses access, for `paired` screens with a player out of `total`: "The player paired
 * with it loses", "The players paired with them lose", "The player paired with 1 of them loses".
 */
export function pairedPlayersLose(paired: number, total: number): string {
  const players = paired === 1 ? 'player' : 'players';
  const verb = paired === 1 ? 'loses' : 'lose';
  if (paired >= total) return `The ${players} paired with ${total === 1 ? 'it' : 'them'} ${verb}`;
  return `The ${players} paired with ${paired} of them ${verb}`;
}

/** "Delete this screen?", "Delete 3 screens?". */
export function deleteScreensQuestion(count: number): string {
  return count === 1 ? 'Delete this screen?' : `Delete ${count} screens?`;
}

/** The confirming button: "Delete screen", "Delete 3 screens". */
export function deleteScreensLabel(count: number): string {
  return count === 1 ? 'Delete screen' : `Delete ${count} screens`;
}

/** "The screen was not deleted", "2 of 5 screens were not deleted". */
export function deleteScreensFailureTitle(failedCount: number, total: number): string {
  return bulkFailureTitle(failedCount, total, 'screen', 'deleted');
}

/** What did happen in an attempt that also had failures, or null when nothing was deleted. */
export function screensDeletedNote(deletedCount: number): string | null {
  if (deletedCount <= 0) return null;
  return `${countOf(deletedCount, 'screen')} ${deletedCount === 1 ? 'was' : 'were'} deleted.`;
}

/**
 * The toast after every screen was deleted: "Lobby deleted", "3 screens deleted", and what
 * was already gone when some were.
 */
export function screensDeletedToast(
  results: readonly { readonly name: string; readonly result: ScreenDeleteResult }[],
): { readonly tone: 'success' | 'info'; readonly message: string } {
  const total = results.length;
  const gone = results.filter((entry) => entry.result === 'gone').length;
  const [only] = results;
  if (total === 1 && only !== undefined) {
    return gone === 1
      ? { tone: 'info', message: `${only.name} was already deleted` }
      : { tone: 'success', message: `${only.name} deleted` };
  }
  if (gone === 0) return { tone: 'success', message: `${countOf(total, 'screen')} deleted` };
  if (gone === total) {
    return { tone: 'info', message: `${countOf(total, 'screen')} were already deleted` };
  }
  return {
    tone: 'success',
    message: `${countOf(total, 'screen')} deleted; ${gone} of them already ${gone === 1 ? 'was' : 'were'}`,
  };
}
