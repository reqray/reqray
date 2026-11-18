import { useEffect, useRef } from 'react';
import { isTypingTarget } from './keyboard';

export interface PanelShortcuts {
  /** `⌘K` / `ctrl-K` — works even while typing. */
  togglePalette: () => void;
  /** `?` — the shortcuts panel. */
  toggleKeys: () => void;
  /** Space — pause or resume the live feed. */
  toggleLive: () => void;
  /** Escape — the topmost overlay first, then out of the screen. */
  escape: () => void;
}

/** Shortcuts that belong to the whole panel; the list owns j/k/↵ and `/`. */
export function usePanelShortcuts(shortcuts: PanelShortcuts): void {
  // The latest handlers behind one subscription: shortcuts close over state
  // that changes, and re-binding a window listener per keystroke is noise.
  const current = useRef(shortcuts);
  current.current = shortcuts;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        current.current.togglePalette();
        return;
      }
      if (isTypingTarget(event.target)) {
        // Even here `esc` has a job: it hands focus back to the shortcuts.
        if (event.key === 'Escape') (event.target as HTMLElement).blur();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        current.current.toggleKeys();
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        current.current.toggleLive();
        return;
      }
      if (event.key === 'Escape') current.current.escape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
