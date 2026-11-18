import { useCallback, useEffect, useRef, useState } from 'react';

/** The one cadence panel screens re-read at while the topbar says live. */
export const LIVE_REFRESH_MS = 5_000;

export interface LiveQueryOptions {
  /** Re-read on a cadence; off, the question is asked once per fetcher. */
  live?: boolean;
  refreshMs?: number;
  /**
   * A failed re-read keeps the answer already on screen.
   *
   * For the polling screens: a blip in a ten-second poll must not replace a
   * page of numbers with an apology. The first read has nothing to keep, so
   * its failure still shows as the error.
   */
  keepLastGood?: boolean;
  /**
   * A new question keeps the previous answer up while its own is read.
   *
   * Off by default: a baseline drawn for the previous request must not stand
   * beside the next one. On for screens where the questions are windows over
   * one list, and a blank frame between two of them would read as flicker.
   */
  keepStale?: boolean;
}

export interface LiveQuery<T> {
  /** `null` until the first answer for the current fetcher lands. */
  data: T | null;
  error: string | null;
  /** Asks again now — after a mutation whose result the screen shows. */
  reload: () => void;
}

/**
 * The server-state shape every panel screen was hand-rolling: ask, abort on
 * unmount, re-ask on a cadence while live, and decide what a failure leaves
 * on screen.
 *
 * The fetcher's identity is the question. Wrap it in `useCallback` with the
 * inputs that define it — a range, an id — and a new fetcher resets the
 * answer, while the same fetcher re-asked (the cadence, `reload`) swaps the
 * fresh answer in without blanking the screen.
 */
export function useLiveQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: LiveQueryOptions = {},
): LiveQuery<T> {
  const {
    live = false,
    refreshMs = LIVE_REFRESH_MS,
    keepLastGood = false,
    keepStale = false,
  } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  // A new question drops the old answer at once: a baseline drawn for the
  // previous request must not stand beside the next one while it loads.
  const asked = useRef(fetcher);
  const answered = useRef(false);
  if (asked.current !== fetcher) {
    asked.current = fetcher;
    answered.current = false;
    if (!keepStale) {
      setData(null);
      setError(null);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `token` is the trigger — `reload` bumps it to ask the same question again
  useEffect(() => {
    const controller = new AbortController();
    const ask = () => {
      fetcher(controller.signal)
        .then((answer) => {
          if (controller.signal.aborted) return;
          answered.current = true;
          setData(answer);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (keepLastGood && answered.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    ask();
    if (!live) return () => controller.abort();
    const timer = setInterval(ask, refreshMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [fetcher, live, refreshMs, keepLastGood, token]);

  const reload = useCallback(() => setToken((current) => current + 1), []);

  return { data, error, reload };
}
