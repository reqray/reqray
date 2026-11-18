import type React from 'react';
import { useCallback, useRef, useState } from 'react';

/**
 * Below this many pixels of travel, a drag was a click.
 *
 * Fingers and trackpads move a little between press and release, and a chart
 * that only pins on a perfectly still click ignores half of them. In pixels
 * rather than as a share of the width, because the same share is a different
 * gesture on a chart that spans the screen and on one of three side by side.
 */
const CLICK_PX = 5;

/** What the pointer did, and where. */
export interface PlotGesture {
  /** Fraction of the plot's width, 0 at the left edge. */
  readonly hovered: number | null;
  readonly dragFrom: number | null;
  readonly dragTo: number | null;
}

/**
 * The plot's pointer state machine: hover, click, and drag to zoom.
 *
 * It reports *what happened* — a column was picked, a stretch was dragged —
 * and knows nothing about what either means. That is the caller's, because a
 * pick is a pinned rail on one chart and a filtered list on another.
 */
export function usePlotPointer({
  columns,
  onPick,
  onDrag,
  onHover,
  onLeave,
  onDragStart,
}: {
  columns: number;
  /** A column was clicked. `alsoThis` is a shift-click: hold both. */
  onPick: (column: number, alsoThis: boolean) => void;
  /** A stretch was dragged across, as fractions of the width, in order. */
  onDrag: (from: number, to: number) => void;
  /** The pointer moved to a column, and no drag is in progress. */
  onHover: (column: number) => void;
  onLeave: () => void;
  /** A drag began, and whatever floats over the plot should get out of the way. */
  onDragStart: () => void;
}): {
  gesture: PlotGesture;
  /**
   * Whether a drag is in progress, read through the ref rather than state.
   *
   * For callers inside an interval or a listener attached once: those close
   * over the render they were created in, and a boolean from state would be
   * the answer from before the drag began.
   */
  dragging: () => boolean;
  handlers: Pick<
    React.DOMAttributes<HTMLButtonElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onPointerLeave'
  >;
} {
  const [hovered, setHovered] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  /**
   * Where the pointer went down, kept where the pointer-up handler can read it.
   *
   * State would be the obvious place and is the wrong one: a click sends
   * `pointerdown` and `pointerup` in the same task, React has not re-rendered
   * in between, and the handler on the way up would close over the value from
   * before the way down — `null`, so the click does nothing at all. It happens
   * under load and never on a quiet machine.
   */
  const origin = useRef<number | null>(null);

  // Stable, so a caller may list it as a dependency without rebuilding the
  // timer or listener it guards on every render.
  const dragging = useCallback(() => origin.current !== null, []);

  const fractionAt = (event: React.PointerEvent<HTMLButtonElement>): number => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) : 0;
  };

  const columnAt = (fraction: number): number =>
    Math.max(0, Math.min(columns - 1, Math.floor(fraction * columns)));

  const stop = (): void => {
    origin.current = null;
    setDragFrom(null);
    setDragTo(null);
  };

  return {
    gesture: { hovered, dragFrom, dragTo },
    dragging,
    handlers: {
      onPointerDown(event) {
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = fractionAt(event);
        origin.current = at;
        setDragFrom(at);
        setDragTo(at);
        onDragStart();
      },

      onPointerMove(event) {
        const at = fractionAt(event);
        setHovered(columnAt(at));
        if (origin.current !== null) {
          setDragTo(at);
          return;
        }
        onHover(columnAt(at));
      },

      onPointerUp(event) {
        const at = fractionAt(event);
        const start = origin.current;
        const width = event.currentTarget.getBoundingClientRect().width;
        stop();
        if (start === null) return;

        if (Math.abs(at - start) * width < CLICK_PX) {
          onPick(columnAt(at), event.shiftKey);
          return;
        }
        onDrag(Math.min(start, at), Math.max(start, at));
      },

      onPointerCancel: stop,

      onPointerLeave() {
        setHovered(null);
        onLeave();
      },
    },
  };
}
