/** How long after a dialog closes a lost focus is still put back. */
const GUARD_MS = 5000;

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/** The page's `main` landmark: the skip link's target, focusable through `tabIndex={-1}`. */
export function mainLandmark(): HTMLElement | null {
  return document.getElementById('main');
}

/**
 * After a dialog has handed focus back, keeps it from falling to the document.
 *
 * The control that opened a dialog is often gone once the dialog has done its work: the row
 * whose "Actions" menu asked for a delete, the selection bar that empties after a bulk
 * delete. Sometimes it is gone at once, sometimes only when the list has been read again a
 * moment later. In both cases a keyboard or screen-reader user would be left on `<body>`
 * with no reading position (WCAG 2.4.3). This moves focus to `fallback()` (else the `main`
 * landmark) as soon as it is lost, and keeps watching for a few seconds for the late case,
 * also after it has put focus back: the control it chose may itself go when the list is read
 * again (the last rows deleted, so the empty state replaces the table and its controls).
 *
 * It never takes focus from somewhere the person put it: it acts only while nothing has
 * focus, and stops at the first pointer press and as soon as focus moves anywhere it did not
 * put it (Tab, or another dialog opening, whose own guard then decides). It returns a
 * function that stops it sooner.
 */
export function guardReturnedFocus(fallback?: () => HTMLElement | null): () => void {
  // The element this guard last focused, at first the one focus is on as it starts (the opener,
  // when the browser put focus back there): focus arriving anywhere else ends the guard, but
  // focus coming back to it does not (React re-focusing a row it moved, the window regaining
  // focus).
  let ours: Element | null = focusIsLost() ? null : document.activeElement;
  const restore = (): boolean => {
    if (!focusIsLost()) return false;
    const target = fallback?.() ?? mainLandmark();
    if (target === null || !target.isConnected) return false;
    ours = target;
    // The landmark is the whole page: keep the scroll position rather than jump to its top.
    target.focus(target === mainLandmark() ? { preventScroll: true } : undefined);
    return document.activeElement === target;
  };
  restore();

  let done = false;
  const observer = new MutationObserver(() => {
    restore();
  });
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== ours) stop();
  };
  const timer = window.setTimeout(stop, GUARD_MS);
  function stop(): void {
    if (done) return;
    done = true;
    observer.disconnect();
    window.clearTimeout(timer);
    document.removeEventListener('pointerdown', stop, true);
    document.removeEventListener('focusin', onFocusIn, true);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('focusin', onFocusIn, true);
  return stop;
}
