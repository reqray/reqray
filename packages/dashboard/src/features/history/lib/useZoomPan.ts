import { useCallback, useRef } from 'react';
import type { Window } from './metrics';

/**
 * Zoom under the cursor, from the wheel or a trackpad pinch.
 *
 * Returns the ref to put on the plot. Attaching the listener natively rather
 * than through React's `onWheel`: this one calls `preventDefault`, and the
 * event React delivers is passive — the browser would scroll the page *and*
 * zoom the chart, which is the seasick version of both.
 */
export function useZoomPan({
  zoom,
  win,
  minZoomMs,
  onZoom,
  onClosePeek,
}: {
  zoom: Window | null;
  win: Window | null;
  minZoomMs: number;
  /** `null` widens back to the whole period. */
  onZoom: (next: Window | null) => void;
  onClosePeek: () => void;
}): (node: HTMLButtonElement | null) => void {
  /**
   * What the wheel gesture needs to know, read at the moment it fires.
   *
   * The listener below is attached once, when the plot first exists, and a
   * listener attached once closes over the state of that render. Routing the
   * live values through a ref is what lets one listener serve every zoom
   * level without being torn down and re-attached forty times a spin.
   */
  const gesture = useRef<{ zoom: Window | null; win: Window | null }>({ zoom: null, win: null });
  gesture.current = { zoom, win };

  /**
   * Zoom under the cursor, from the wheel or a trackpad pinch.
   *
   * A native listener rather than React's `onWheel`: this one has to call
   * `preventDefault`, and the event React delivers is passive — the browser
   * would scroll the page *and* zoom the chart, which is the seasick version
   * of both. Anchored on the cursor, because zooming into the middle when the
   * eye is on a spike at the edge loses the spike.
   */

  // biome-ignore lint/correctness/useExhaustiveDependencies: onClosePeek is stable: usePeek returns useCallback([], …) functions
  return useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      const { zoom: held, win: base } = gesture.current;
      if (!base) return;
      const current = held ?? base;

      // Some mice report lines rather than pixels.
      const unit = event.deltaMode === 1 ? 16 : 1;
      const deltaY = event.deltaY * unit;
      const deltaX = event.deltaX * unit;
      const box = node.getBoundingClientRect();
      if (box.width <= 0) return;
      const width = current.to - current.from;

      // Two fingers sideways: pan the zoomed window along the period.
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (!held) return;
        event.preventDefault();
        onClosePeek();
        const shift = Math.min(
          base.to - current.to,
          Math.max(base.from - current.from, (deltaX / box.width) * width),
        );
        if (shift !== 0) onZoom({ from: current.from + shift, to: current.to + shift });
        return;
      }

      const zoomingIn = deltaY < 0;
      // Nothing to widen: let the page scroll instead of eating the gesture.
      if (!zoomingIn && !held) return;
      event.preventDefault();
      onClosePeek();

      // Exponential, so every notch changes the window by the same share of
      // itself; a pinch reports small deltas and gets a stronger exponent.
      const factor = Math.exp(deltaY * (event.ctrlKey ? 0.01 : 0.0022));
      const wanted = width * factor;
      if (wanted >= base.to - base.from) {
        onZoom(null);
        return;
      }
      const next = Math.max(minZoomMs, wanted);

      const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
      const anchor = current.from + fraction * width;
      let nextFrom = anchor - fraction * next;
      let nextTo = anchor + (1 - fraction) * next;
      if (nextFrom < base.from) {
        nextTo += base.from - nextFrom;
        nextFrom = base.from;
      }
      if (nextTo > base.to) {
        nextFrom -= nextTo - base.to;
        nextTo = base.to;
      }
      onZoom({ from: nextFrom, to: nextTo });
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
}
