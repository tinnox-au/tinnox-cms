import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardReturnedFocus } from './focusReturn.ts';

const stops: (() => void)[] = [];
const guard = (fallback: () => HTMLElement | null) => {
  stops.push(guardReturnedFocus(fallback));
};

function button(label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  document.body.append(element);
  return element;
}

const focusIs = (element: Element | null) =>
  vi.waitFor(() => {
    expect(document.activeElement).toBe(element);
  });

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.replaceChildren();
});

describe('guardReturnedFocus', () => {
  it('puts lost focus on the fallback at once', async () => {
    const target = button('Add screen');
    (document.activeElement as HTMLElement | null)?.blur();
    guard(() => target);
    await focusIs(target);
  });

  it('puts focus back again when the control it chose goes too (the list read again)', async () => {
    let target: HTMLElement = button('Select all');
    guard(() => (target.isConnected ? target : null) ?? document.body.querySelector('button'));
    await focusIs(target);

    // The read lands: the table and its box are replaced by the empty state.
    target.remove();
    target = button('Add screen');
    await focusIs(target);
  });

  it('puts focus back when the opener, still there at close, goes later', async () => {
    const opener = button('Delete');
    opener.focus();
    const target = button('Add screen');
    guard(() => target);
    expect(document.activeElement).toBe(opener);
    opener.remove();
    await focusIs(target);
  });

  it('keeps guarding when focus comes back to the opener (React moving its row, the window regaining focus)', async () => {
    const opener = button('Actions for Lobby');
    opener.focus();
    const target = button('Actions for Hall');
    guard(() => target);
    opener.blur();
    opener.focus();
    opener.remove();
    await focusIs(target);
  });

  it('never takes focus from where the person put it', async () => {
    const target = button('Add screen');
    const chosen = button('Search');
    guard(() => target);
    chosen.focus();
    button('Late row');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(chosen);
  });

  it('stops once focus moves where it did not put it, so a later dialog decides alone', async () => {
    const target = button('Add screen');
    guard(() => target);
    await focusIs(target);
    // Tab, or another dialog opening: then that control goes, and this guard stays out of it.
    const elsewhere = button('Other dialog opener');
    elsewhere.focus();
    elsewhere.remove();
    button('Another');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(document.body);
  });

  it('stops at the first pointer press', async () => {
    const target = button('Add screen');
    guard(() => target);
    await focusIs(target);
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    target.remove();
    button('Another');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(document.body);
  });
});
