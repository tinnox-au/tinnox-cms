import { useState } from 'react';
import { isApiRequestError } from '../../api/client.ts';
import { api } from '../../api/index.ts';
import { ConfirmDialog, ErrorNotice } from '../../ui/index.ts';
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
   * Where focus goes once the deleted row has left the list (EAX-14); `'opener'` where no
   * list shows it (the detail page, which leaves after a delete). Read when it opens.
   */
  readonly rowFocus: RowFocusSource | 'opener';
}

/**
 * Confirms deleting one screen. The server also revokes its player and cancels its pending
 * pairing codes; a refusal is shown in the dialog with its error code.
 */
export function DeleteScreenDialog({
  screen,
  onClose,
  onDeleted,
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
  const [busy, setBusy] = useState(false);
  if (screen !== previous) {
    setPrevious(screen);
    if (screen !== null) {
      setShown(screen);
      setError(null);
      setBusy(false);
    }
  }

  const confirm = () => {
    if (busy || shown === null) return;
    const target = shown;
    setBusy(true);
    setError(null);
    api.deleteDisplay(target.id).then(
      () => {
        setBusy(false);
        onClose();
        onDeleted(target, false);
      },
      (reason: unknown) => {
        setBusy(false);
        // Already deleted: what the operator asked for is true, so leave as after a delete.
        if (isApiRequestError(reason) && reason.status === 404) {
          onClose();
          onDeleted(target, true);
          return;
        }
        setError(reason);
      },
    );
  };

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
      {error !== null && <ErrorNotice error={error} title="The screen was not deleted" />}
    </ConfirmDialog>
  );
}
