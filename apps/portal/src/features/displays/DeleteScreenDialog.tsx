import { useState } from 'react';
import { isApiRequestError, isOutcomeUnknown } from '../../api/client.ts';
import { api } from '../../api/index.ts';
import {
  DELETE_UNCONFIRMED,
  deleteScreen,
  screenDeleteUnconfirmed,
} from '../../lib/screensDelete.ts';
import { Banner, ConfirmDialog, ErrorNotice } from '../../ui/index.ts';
import { useRowFocusReturn, type RowFocusSource } from '../shared/index.ts';

/** What the delete dialogs need of a screen. */
export interface ScreenToDelete {
  readonly id: string;
  readonly name: string;
  /**
   * A player holds a credential for it, as last known: on the list, the screen or its latest
   * status says so (`ScreenRow.paired`), since the list itself is not read again on a pairing.
   */
  readonly paired: boolean;
}

export interface DeleteScreenDialogProps {
  /** The screen to delete; null keeps the dialog closed. */
  readonly screen: ScreenToDelete | null;
  readonly onClose: () => void;
  /**
   * After the server deleted it, or answered 404 because it was already gone (another tab,
   * another person); the dialog has closed. `alreadyGone` tells the two apart for the message.
   */
  readonly onDeleted: (screen: ScreenToDelete, alreadyGone: boolean) => void;
  /**
   * When the answer was lost and the server may have deleted it (SDC-02); the dialog stays
   * open, and the caller reads the screen again.
   */
  readonly onUnsure?: () => void;
  /**
   * Where focus goes once the deleted row has left the list (EAX-14); `'opener'` where no
   * list shows it (the detail page, which leaves after a delete). Read when it opens.
   */
  readonly rowFocus: RowFocusSource | 'opener';
}

/**
 * Confirms deleting one screen. The server also revokes its player and cancels its pending
 * pairing codes; a refusal is shown in the dialog with its error code. When the answer is
 * lost, the dialog says the delete could not be confirmed and stays open: deleting again
 * settles it, since a screen already gone answers 404.
 */
export function DeleteScreenDialog({
  screen,
  onClose,
  onDeleted,
  onUnsure,
  rowFocus,
}: DeleteScreenDialogProps) {
  const returnFocus = useRowFocusReturn(
    screen !== null,
    screen === null ? [] : [screen.id],
    rowFocus,
  );
  // The screen as it was when the dialog opened; it also stays while the dialog fades out.
  const [shown, setShown] = useState<ScreenToDelete | null>(screen);
  // The prop as last seen, null included, so reopening for the same screen starts afresh.
  const [previous, setPrevious] = useState<ScreenToDelete | null>(screen);
  const [error, setError] = useState<unknown>(null);
  // The answer was lost (SDC-02), with its error code when there is one.
  const [unsure, setUnsure] = useState<{ readonly code: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  if (screen !== previous) {
    setPrevious(screen);
    if (screen !== null) {
      setShown(screen);
      setError(null);
      setUnsure(null);
      setBusy(false);
    }
  }

  const confirm = () => {
    if (busy || shown === null) return;
    const target = shown;
    setBusy(true);
    setError(null);
    setUnsure(null);
    // Already deleted (the API's 404) resolves as gone: what the operator asked for is true.
    deleteScreen(() => api.deleteDisplay(target.id)).then(
      (result) => {
        setBusy(false);
        onClose();
        onDeleted(target, result === 'gone');
      },
      (reason: unknown) => {
        setBusy(false);
        // The server may have deleted it: never say it was not.
        if (isOutcomeUnknown(reason)) {
          setUnsure({ code: isApiRequestError(reason) ? reason.code : null });
          onUnsure?.();
          return;
        }
        setError(reason);
      },
    );
  };
  // What `onUnsure` reads again: the list, or the screen's page where no list shows it.
  const readAgain = rowFocus === 'opener' ? 'page' : 'list';

  return (
    <ConfirmDialog
      open={screen !== null}
      title={`Delete ${shown?.name ?? 'this screen'}?`}
      confirmLabel="Delete screen"
      tone="danger"
      busy={busy}
      onConfirm={confirm}
      onCancel={onClose}
      testId="screens-delete-dialog"
      returnFocus={returnFocus}
    >
      <p>
        <strong>{shown?.name ?? 'This screen'}</strong> is removed for good. Its history stays in
        the activity log.
      </p>
      {shown?.paired === true ? (
        <p>
          The player paired with it loses access immediately. When it next reports it shows “This
          player was unregistered”, and it must be reset there before it can be paired again. A
          player that is not reporting keeps showing what it has cached until then.
        </p>
      ) : (
        <p>Any pairing code accepted for it that no player has collected yet stops working.</p>
      )}
      {unsure !== null && (
        <Banner tone="danger" live="assertive" title={DELETE_UNCONFIRMED}>
          <p>
            {screenDeleteUnconfirmed(shown?.name ?? 'this screen', readAgain)}{' '}
            {unsure.code !== null && <span className="tx-code">{unsure.code}</span>}
          </p>
        </Banner>
      )}
      {error !== null && <ErrorNotice error={error} title="The screen was not deleted" />}
    </ConfirmDialog>
  );
}
