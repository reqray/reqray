import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A confirmation that fades on its own — `copied ✓` on a button.
 *
 * The naive `setTimeout(() => setOn(false))` leaks past unmount and, clicked
 * twice, turns the second confirmation off on the first one's clock. This one
 * restarts the clock per flash and clears it with the component.
 */
export function useFlash(ms = 1_500): [on: boolean, flash: () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return [on, flash];
}
