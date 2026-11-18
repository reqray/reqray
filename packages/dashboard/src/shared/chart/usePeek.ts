import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The pointer must rest this long before a peek opens.
 *
 * Long enough that reading the shape of the line never summons it, short
 * enough that stopping on a point one is curious about does.
 */
const REST_MS = 450;

/** How long a peek survives the pointer travelling from plot to popup. */
const GRACE_MS = 250;

/** Stops a pending timer, if one is pending. */
function stop(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/**
 * The open/close state machine for a hover peek.
 *
 * Shared by every chart that offers one, so the feel is identical: resting
 * opens, moving follows, leaving closes after a grace long enough to reach
 * the popup, and a drag or a wheel closes at once.
 */
export function usePeek(options: { restMs?: number; graceMs?: number } = {}) {
  // The timings are the caller's: a floating popup must wait for the hand to
  // rest — a card chasing every pass over the chart is noise — while a docked
  // rail covers nothing and can follow the pointer at once, with a longer
  // grace so the hand can travel to it.
  const restMs = options.restMs ?? REST_MS;
  const graceMs = options.graceMs ?? GRACE_MS;
  const [column, setColumn] = useState<number | null>(null);
  const open = useRef(false);
  open.current = column !== null;
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The pointer is over this column. */
  const move = useCallback(
    (next: number) => {
      stop(grace);
      // Once open the peek follows the pointer; before that, it waits for the
      // hand to rest — a popup that chases every pass over the chart is noise.
      if (open.current) {
        setColumn(next);
        return;
      }
      if (restMs === 0) {
        setColumn(next);
        return;
      }
      stop(rest);
      rest.current = setTimeout(() => setColumn(next), restMs);
      // A primitive the caller fixes once, so the callback stays stable.
    },
    [restMs],
  );

  /** The pointer left the plot — perhaps on its way into the popup. */
  const leave = useCallback(() => {
    stop(rest);
    stop(grace);
    grace.current = setTimeout(() => setColumn(null), graceMs);
    // A primitive the caller fixes once, so the callback stays stable.
  }, [graceMs]);

  /** The pointer arrived in the popup: it stays. */
  const hold = useCallback(() => stop(grace), []);

  /** A drag or a wheel began: the peek is in the way of the gesture. */
  const close = useCallback(() => {
    stop(rest);
    stop(grace);
    setColumn(null);
  }, []);

  useEffect(
    () => () => {
      stop(rest);
      stop(grace);
    },
    [],
  );

  return { column, move, leave, hold, close };
}
