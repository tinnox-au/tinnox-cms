import { useState } from 'react';
import { isOutcomeUnknown } from '../../../api/client.ts';
import { api } from '../../../api/index.ts';
import {
  countOf,
  mergeBulkOutcomes,
  runInSequence,
  type BulkOutcome,
} from '../../../lib/bulkOutcome.ts';
import {
  deleteScreen,
  deleteScreensFailureTitle,
  deleteScreensLabel,
  deleteScreensQuestion,
  pairedPlayersLose,
  SCREEN_DELETE_UNCONFIRMED_LINE,
  SCREENS_READ_AGAIN,
  screensDeletedNote,
  screensDeletedToast,
  type ScreenDeleteResult,
} from '../../../lib/screensDelete.ts';
import { failureText } from '../../../lib/playlistsListActions.ts';
import { Banner, Button, Dialog, useToast } from '../../../ui/index.ts';
import { useRowFocusReturn, type RowFocusSource } from '../../shared/index.ts';
import type { ScreenToDelete } from '../DeleteScreenDialog.tsx';
import './screensList.css';

type DeleteOutcome = BulkOutcome<ScreenToDelete, ScreenDeleteResult>;

export interface DeleteScreensDialogProps {
  /** The screens to delete, one or many; null keeps the dialog closed. Read when it opens. */
  readonly targets: readonly ScreenToDelete[] | null;
  /** Cancel, Escape, the close button, and after a delete that fully succeeded. */
  readonly onClose: () => void;
  /**
   * Called after each attempt that deleted at least one screen, with their ids, or that may
   * have (an unknown outcome, with no id); the list reads the screens again.
   */
  readonly onDeleted: (ids: readonly string[]) => void;
  /** Where focus goes once the deleted rows have left the list (EAX-14). Read when it opens. */
  readonly rowFocus: RowFocusSource;
}

interface Progress {
  readonly finished: number;
  readonly total: number;
}

/**
 * Confirms deleting the selected screens (CMS-41), as the Playlists list does: one request
 * per screen, one after another, and every failure listed with the server's reason and error
 * code. A screen already gone (404) counts as deleted. A failure whose answer was lost says the
 * server may have deleted it (SDC-02). "Try again" repeats only the failures and keeps focus.
 */
export function DeleteScreensDialog({
  targets,
  onClose,
  onDeleted,
  rowFocus,
}: DeleteScreensDialogProps) {
  const toast = useToast();
  const open = targets !== null;
  const returnFocus = useRowFocusReturn(
    open,
    (targets ?? []).map((screen) => screen.id),
    rowFocus,
  );
  // The screens as they were when the dialog opened; they also stay while it fades out.
  const [items, setItems] = useState<readonly ScreenToDelete[]>(targets ?? []);
  const [outcome, setOutcome] = useState<DeleteOutcome | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (targets !== null) {
      setItems(targets);
      setOutcome(null);
      setProgress(null);
    }
  }

  const busy = progress !== null;
  const total = items.length;
  const single = total === 1 ? items[0] : undefined;
  const paired = items.filter((screen) => screen.paired).length;
  const failed = outcome?.failed ?? [];
  const pending = outcome === null ? items : failed.map((failure) => failure.item);
  // Any failure that may have deleted its screen: the words never say "not deleted" then.
  const unconfirmed = failed.some((failure) => isOutcomeUnknown(failure.error));

  const run = async () => {
    if (busy || pending.length === 0) return;
    setProgress({ finished: 0, total: pending.length });
    const attempt = await runInSequence(
      pending,
      (screen) => deleteScreen(() => api.deleteDisplay(screen.id)),
      (finished, of) => {
        setProgress({ finished, total: of });
      },
    );
    const merged = outcome === null ? attempt : mergeBulkOutcomes(outcome, attempt);
    setProgress(null);
    // A failure whose outcome is unknown may have deleted the screen: read the list again then too.
    const unsure = attempt.failed.some((failure) => isOutcomeUnknown(failure.error));
    if (attempt.done.length > 0 || unsure) onDeleted(attempt.done.map((entry) => entry.item.id));
    if (merged.failed.length === 0) {
      onClose();
      const { tone, message } = screensDeletedToast(
        merged.done.map((entry) => ({ name: entry.item.name, result: entry.result })),
      );
      if (tone === 'info') toast.info(message);
      else toast.success(message);
      return;
    }
    setOutcome(merged);
  };

  const attempted = outcome !== null;
  const note = attempted ? screensDeletedNote(outcome.done.length) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        attempted
          ? deleteScreensFailureTitle(failed.length, total, unconfirmed)
          : deleteScreensQuestion(total)
      }
      busy={busy}
      returnFocus={returnFocus}
      footerStart={
        busy && progress.total > 1 ? (
          <span role="status" data-testid="screens-bulk-delete-progress">
            Deleting {Math.min(progress.finished + 1, progress.total)} of {progress.total}
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button
            onClick={onClose}
            aria-disabled={busy || undefined}
            data-autofocus
            data-testid="screens-bulk-delete-cancel"
          >
            {attempted ? 'Close' : 'Cancel'}
          </Button>
          {pending.length > 0 && (
            <Button
              variant={attempted ? 'secondary' : 'danger-solid'}
              busy={busy}
              onClick={() => {
                void run();
              }}
              data-testid={attempted ? 'screens-bulk-delete-retry' : 'screens-bulk-delete-confirm'}
            >
              {attempted ? 'Try again' : deleteScreensLabel(total)}
            </Button>
          )}
        </>
      }
    >
      <div className="tx-stack" data-testid="screens-bulk-delete-dialog">
        {!attempted && single !== undefined && (
          <p className="tx-break">
            <strong>{single.name}</strong> is removed for good. Its history stays in the activity
            log.
          </p>
        )}
        {!attempted && single === undefined && (
          <>
            <p>
              These {countOf(total, 'screen')} are removed for good. Their history stays in the
              activity log.
            </p>
            <ul className="tx-screens-delete__names" aria-label="Screens to delete">
              {items.map((screen) => (
                <li key={screen.id}>
                  <span className="tx-strong tx-break">{screen.name}</span>
                  {screen.paired && <span className="tx-screens-delete__note">Player paired</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {!attempted && paired > 0 && (
          <p>
            {pairedPlayersLose(paired, total)} access immediately. When{' '}
            {paired === 1 ? 'it' : 'each'} next reports it shows “This player was unregistered”, and
            it must be reset there before it can be paired again. A player that is not reporting
            keeps showing what it has cached until then.
          </p>
        )}
        {!attempted && paired < total && (
          <p>
            Any pairing code accepted for {total === 1 ? 'it' : 'them'} that no player has collected
            yet stops working.
          </p>
        )}
        {attempted && (
          <Banner tone="danger" live="assertive">
            {note !== null && <p>{note}</p>}
            <ul className="tx-screens-delete__failures" data-testid="screens-bulk-delete-failures">
              {failed.map(({ item, error }) => {
                const text = failureText(error);
                const message = isOutcomeUnknown(error)
                  ? SCREEN_DELETE_UNCONFIRMED_LINE
                  : text.message;
                return (
                  <li key={item.id}>
                    <span className="tx-strong tx-break">{item.name}</span>:{' '}
                    <span className="tx-break">{message}</span>{' '}
                    {text.code !== null && <span className="tx-code">{text.code}</span>}
                  </li>
                );
              })}
            </ul>
            {unconfirmed && <p>{SCREENS_READ_AGAIN}</p>}
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
