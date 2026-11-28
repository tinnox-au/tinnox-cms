import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  errorFromResponse,
  isOutcomeUnknown,
  type ClientErrorCode,
} from '../api/client.ts';
import {
  DELETE_UNCONFIRMED,
  deleteScreen,
  deleteScreensFailureTitle,
  deleteScreensLabel,
  deleteScreensQuestion,
  isDeleteUnconfirmed,
  isScreenGone,
  pairedPlayersLose,
  SCREEN_DELETE_UNCONFIRMED_LINE,
  screenDeleteUnconfirmed,
  SCREENS_READ_AGAIN,
  screensDeletedNote,
  screensDeletedToast,
} from './screensDelete.ts';

const refusal = (status: number, code: ClientErrorCode) =>
  new ApiRequestError({ status, code, message: 'No.', fromApi: true });
// What reading the screen answers once a delete got a 404: gone, or still there.
const goneOnRead = () => Promise.reject(refusal(404, 'not_found'));
const thereOnRead = () => Promise.resolve({});

describe('deleteScreen', () => {
  it('resolves deleted when the server deleted it', async () => {
    await expect(deleteScreen(() => Promise.resolve(), thereOnRead)).resolves.toBe('deleted');
  });

  it('resolves gone on a 404 when reading the screen finds it gone too', async () => {
    await expect(
      deleteScreen(() => Promise.reject(refusal(404, 'not_found')), goneOnRead),
    ).resolves.toBe('gone');
  });

  it('#7: passes the 404 on when the screen is still there (an API without the route)', async () => {
    const missingRoute = refusal(404, 'not_found');
    await expect(deleteScreen(() => Promise.reject(missingRoute), thereOnRead)).rejects.toBe(
      missingRoute,
    );
    const offline = refusal(0, 'network_error');
    await expect(
      deleteScreen(
        () => Promise.reject(missingRoute),
        () => Promise.reject(offline),
      ),
    ).rejects.toBe(offline);
  });

  it('passes any other failure on', async () => {
    const forbidden = refusal(403, 'forbidden');
    await expect(deleteScreen(() => Promise.reject(forbidden), goneOnRead)).rejects.toBe(forbidden);
    const network = new Error('offline');
    await expect(deleteScreen(() => Promise.reject(network), goneOnRead)).rejects.toBe(network);
  });

  it("SDC-01: passes on a 404 that is not the API's own, an unknown outcome", async () => {
    // A proxy's page: no error envelope.
    const page = errorFromResponse(404, '<html>Not Found</html>', null);
    expect(page.fromApi).toBe(false);
    expect(page.code).toBe('invalid_response');
    expect(isOutcomeUnknown(page)).toBe(true);
    await expect(deleteScreen(() => Promise.reject(page), goneOnRead)).rejects.toBe(page);
  });
});

describe('isDeleteUnconfirmed', () => {
  it("R2-02: is an unknown outcome, except the API's own 429, which refused before the route ran", () => {
    expect(isDeleteUnconfirmed(refusal(429, 'rate_limited'))).toBe(false);
    expect(isDeleteUnconfirmed(refusal(500, 'commit_outcome_unknown'))).toBe(true);
    expect(isDeleteUnconfirmed(refusal(0, 'network_error'))).toBe(true);
    expect(isDeleteUnconfirmed(errorFromResponse(429, '<html>Slow down</html>', null))).toBe(true);
    expect(isDeleteUnconfirmed(refusal(403, 'forbidden'))).toBe(false);
  });
});

describe('isScreenGone', () => {
  it("SDC-01: is true only for the API's own not_found 404", () => {
    const envelope = JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } });
    expect(isScreenGone(errorFromResponse(404, envelope, null))).toBe(true);
    expect(isScreenGone(refusal(404, 'not_found'))).toBe(true);
    expect(isScreenGone(errorFromResponse(404, '<html>Not Found</html>', null))).toBe(false);
    expect(isScreenGone(errorFromResponse(404, '', null))).toBe(false);
    expect(
      isScreenGone(
        new ApiRequestError({ status: 404, code: 'not_found', message: 'No.', fromApi: false }),
      ),
    ).toBe(false);
    expect(isScreenGone(refusal(404, 'validation_failed'))).toBe(false);
    expect(isScreenGone(refusal(410, 'not_found'))).toBe(false);
    expect(isScreenGone(new Error('Not found'))).toBe(false);
  });
});

describe('SDC-02: an unconfirmed delete', () => {
  it('never says the screen was not deleted', () => {
    expect(DELETE_UNCONFIRMED).toBe('The delete could not be confirmed');
    expect(screenDeleteUnconfirmed('Lobby', 'list')).toBe(
      'The server may or may not have deleted Lobby. The list is being read again; check it before you try again.',
    );
    expect(screenDeleteUnconfirmed('Lobby', 'page')).toBe(
      'The server may or may not have deleted Lobby. The page is being read again; check it before you try again.',
    );
    expect(deleteScreensFailureTitle(1, 1, true)).toBe('The delete could not be confirmed');
    expect(deleteScreensFailureTitle(1, 3, true)).toBe('Not every delete could be confirmed');
    expect(deleteScreensFailureTitle(3, 3, true)).toBe('Not every delete could be confirmed');
    expect(SCREEN_DELETE_UNCONFIRMED_LINE).toBe('The server may or may not have deleted it.');
    expect(SCREENS_READ_AGAIN).toBe('The list is being read again; check it before you try again.');
  });
});

describe('bulk screen delete words', () => {
  it('asks, confirms and reports by count', () => {
    expect(deleteScreensQuestion(1)).toBe('Delete this screen?');
    expect(deleteScreensQuestion(3)).toBe('Delete 3 screens?');
    expect(deleteScreensLabel(1)).toBe('Delete screen');
    expect(deleteScreensLabel(3)).toBe('Delete 3 screens');
    expect(deleteScreensFailureTitle(1, 1)).toBe('The screen was not deleted');
    expect(deleteScreensFailureTitle(1, 3)).toBe('1 of 3 screens was not deleted');
    expect(deleteScreensFailureTitle(3, 3)).toBe('None of the 3 screens were deleted');
    expect(screensDeletedNote(0)).toBeNull();
    expect(screensDeletedNote(1)).toBe('1 screen was deleted.');
    expect(screensDeletedNote(2)).toBe('2 screens were deleted.');
  });

  it('says whose players lose access', () => {
    expect(pairedPlayersLose(1, 1)).toBe('The player paired with it loses');
    expect(pairedPlayersLose(3, 3)).toBe('The players paired with them lose');
    expect(pairedPlayersLose(1, 3)).toBe('The player paired with 1 of them loses');
    expect(pairedPlayersLose(2, 3)).toBe('The players paired with 2 of them lose');
  });

  it('toasts what happened, already deleted screens included', () => {
    const deleted = (name: string) => ({ name, result: 'deleted' as const });
    const gone = (name: string) => ({ name, result: 'gone' as const });
    expect(screensDeletedToast([deleted('Lobby')])).toEqual({
      tone: 'success',
      message: 'Lobby deleted',
    });
    expect(screensDeletedToast([gone('Lobby')])).toEqual({
      tone: 'info',
      message: 'Lobby was already deleted',
    });
    expect(screensDeletedToast([deleted('A'), deleted('B')])).toEqual({
      tone: 'success',
      message: '2 screens deleted',
    });
    expect(screensDeletedToast([gone('A'), gone('B')])).toEqual({
      tone: 'info',
      message: '2 screens were already deleted',
    });
    expect(screensDeletedToast([deleted('A'), gone('B'), deleted('C')])).toEqual({
      tone: 'success',
      message: '3 screens deleted; 1 of them already was',
    });
  });

  it('never calls a screen a display', () => {
    const words = [
      deleteScreensQuestion(2),
      deleteScreensLabel(2),
      deleteScreensFailureTitle(1, 2),
      deleteScreensFailureTitle(1, 2, true),
      screenDeleteUnconfirmed('A', 'list'),
      SCREEN_DELETE_UNCONFIRMED_LINE,
      SCREENS_READ_AGAIN,
      pairedPlayersLose(1, 2),
      screensDeletedToast([{ name: 'A', result: 'gone' }]).message,
    ];
    for (const text of words) expect(text).not.toMatch(/display|online|offline/i);
  });
});
