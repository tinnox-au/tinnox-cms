import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ClientErrorCode } from '../api/client.ts';
import {
  deleteScreen,
  deleteScreensFailureTitle,
  deleteScreensLabel,
  deleteScreensQuestion,
  pairedPlayersLose,
  screensDeletedNote,
  screensDeletedToast,
} from './screensDelete.ts';

const refusal = (status: number, code: ClientErrorCode) =>
  new ApiRequestError({ status, code, message: 'No.', fromApi: true });

describe('deleteScreen', () => {
  it('resolves deleted when the server deleted it', async () => {
    await expect(deleteScreen(() => Promise.resolve())).resolves.toBe('deleted');
  });

  it('resolves gone on a 404: the screen was already deleted', async () => {
    await expect(deleteScreen(() => Promise.reject(refusal(404, 'not_found')))).resolves.toBe(
      'gone',
    );
  });

  it('passes any other failure on', async () => {
    const forbidden = refusal(403, 'forbidden');
    await expect(deleteScreen(() => Promise.reject(forbidden))).rejects.toBe(forbidden);
    const network = new Error('offline');
    await expect(deleteScreen(() => Promise.reject(network))).rejects.toBe(network);
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
      pairedPlayersLose(1, 2),
      screensDeletedToast([{ name: 'A', result: 'gone' }]).message,
    ];
    for (const text of words) expect(text).not.toMatch(/display|online|offline/i);
  });
});
