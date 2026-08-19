import { useEffect } from 'react';

/** How long a message stays before it gets out of the way. */
const DISMISS_MS = 2600;

/** A single line of feedback for an action that has no visible result. */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <output className="toast" aria-live="polite">
      {message}
    </output>
  );
}
