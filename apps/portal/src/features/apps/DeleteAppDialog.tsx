import type { AppDto } from '@tinnox/contracts';
import { useState } from 'react';
import { isApiRequestError } from '../../api/client.ts';
import { api } from '../../api/index.ts';
import { inUsePlaylistNames } from '../../lib/apps.ts';
import { Banner, ConfirmDialog, ErrorNotice } from '../../ui/index.ts';
import { InUseList, useRowFocusReturn, type RowFocusSource } from '../shared/index.ts';

export interface DeleteAppDialogProps {
  /** The app to delete; null keeps the dialog closed. */
  readonly app: AppDto | null;
  readonly onClose: () => void;
  /** After the server deleted it; the dialog has closed. */
  readonly onDeleted: (app: AppDto) => void;
  /**
   * Where focus goes once the deleted row has left the list (EAX-14); `'opener'` where no
   * list shows it (the editor, which leaves the page after a delete). Read when it opens.
   */
  readonly rowFocus: RowFocusSource | 'opener';
}

/**
 * Confirms deleting one app. A playlist that holds it makes the server refuse
 * (`app_in_use`); the dialog then names those playlists, so the operator knows where to
 * remove it first. Any other refusal is shown with its error code.
 */
export function DeleteAppDialog({ app, onClose, onDeleted, rowFocus }: DeleteAppDialogProps) {
  const returnFocus = useRowFocusReturn(app !== null, app === null ? [] : [app.id], rowFocus);
  // The app as it was when the dialog opened; it also stays while the dialog fades out.
  const [shown, setShown] = useState<AppDto | null>(app);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (app !== null && app !== shown) {
    setShown(app);
    setError(null);
    setBusy(false);
  }

  const refusal = isApiRequestError(error) && error.code === 'app_in_use' ? error : null;
  const playlists = refusal === null ? [] : inUsePlaylistNames(refusal.details);

  const confirm = () => {
    if (busy || shown === null) return;
    const target = shown;
    setBusy(true);
    setError(null);
    api.deleteApp(target.id).then(
      () => {
        setBusy(false);
        onClose();
        onDeleted(target);
      },
      (reason: unknown) => {
        setBusy(false);
        setError(reason);
      },
    );
  };

  return (
    <ConfirmDialog
      open={app !== null}
      title={`Delete ${shown?.name ?? 'this app'}?`}
      confirmLabel="Delete app"
      tone="danger"
      busy={busy}
      onConfirm={confirm}
      onCancel={onClose}
      testId="apps-delete-dialog"
      returnFocus={returnFocus}
    >
      <p>
        The app is removed for good. Screens that already show it keep it until their next push.
      </p>
      {refusal !== null ? (
        <Banner tone="danger" live="assertive" title="This app is used in a playlist">
          <p>
            {refusal.message} <span className="tx-code">{refusal.code}</span>
          </p>
          <InUseList names={playlists} testId="apps-delete-playlists" />
        </Banner>
      ) : (
        error !== null && <ErrorNotice error={error} title="The app was not deleted" />
      )}
    </ConfirmDialog>
  );
}
