import { createContext, type ReactNode, useContext } from 'react';

/**
 * What the topbar decides and every screen obeys.
 *
 * Two contexts rather than one: `live` changes on a keystroke and re-renders
 * whoever reads it, while the toast function never changes at all — a screen
 * that only wants to say something must not repaint with the pause toggle.
 */

const LiveContext = createContext(true);

const ToastContext = createContext<(message: string) => void>(() => undefined);

interface PanelProviderProps {
  live: boolean;
  onToast: (message: string) => void;
  children: ReactNode;
}

export function PanelProvider({ live, onToast, children }: PanelProviderProps) {
  return (
    <ToastContext.Provider value={onToast}>
      <LiveContext.Provider value={live}>{children}</LiveContext.Provider>
    </ToastContext.Provider>
  );
}

/** The topbar's toggle: paused means nothing on the screen moves. */
export function useLive(): boolean {
  return useContext(LiveContext);
}

/** One line at the bottom of the screen, gone on its own. */
export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}
