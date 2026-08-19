/**
 * Keyboard-layer helpers.
 *
 * The panel is meant to be driven without the mouse, which makes exactly one
 * rule non-negotiable: a shortcut must never fire while the user is typing.
 * Everything here is pure so that rule is pinned by tests rather than by
 * clicking around.
 */

/**
 * True while focus sits in a field, where letters mean letters.
 *
 * Structural rather than `instanceof HTMLElement` so the rule can be tested
 * without a DOM; the shape it reads is the same one the browser provides.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
  );
}

/**
 * Selection step for `j`/`k`.
 *
 * Clamps at both ends instead of wrapping: in a log that grows at the top,
 * wrapping from the last row to the first is disorienting — the eye loses the
 * place it was scanning.
 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  // Nothing selected yet: `j` starts at the top, `k` at the bottom.
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}

/**
 * Where the rows container must scroll so row `index` is visible, or `null`
 * when it already is.
 *
 * Deliberately not `scrollIntoView`: that centers the row and yanks the whole
 * table under the eye on every keypress. Moving by exactly the amount needed
 * keeps the surrounding rows in place.
 */
export function scrollTopFor(view: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  index: number;
}): number | null {
  if (view.index < 0 || view.rowHeight <= 0) return null;
  const top = view.index * view.rowHeight;
  const bottom = top + view.rowHeight;
  if (top < view.scrollTop) return top;
  if (bottom > view.scrollTop + view.viewportHeight) return bottom - view.viewportHeight;
  return null;
}
