import { Component, type ReactNode } from 'react';

interface ScreenBoundaryProps {
  children: ReactNode;
}

interface ScreenBoundaryState {
  error: Error | null;
}

/**
 * The fence around one screen.
 *
 * Without it a throw during render unmounts the entire panel — a blank page,
 * from the tool whose job is explaining other software's failures. The fence
 * keeps the crash to the screen it happened on: the tabs above stay alive,
 * and the boundary is keyed by screen, so navigating away and back mounts a
 * fresh one and retries.
 *
 * A class, deliberately: catching a render error is the one thing hooks
 * cannot do.
 */
export class ScreenBoundary extends Component<ScreenBoundaryProps, ScreenBoundaryState> {
  override state: ScreenBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ScreenBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // The panel must never take the host application down with it, so the
    // error goes to the console it would have reached anyway — legible now.
    console.error('reqray: this screen crashed —', error);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;

    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-body">
            <h1 className="empty-title">This screen crashed</h1>
            <p className="empty-text">
              {this.state.error.message || String(this.state.error)} — the details are in the
              browser console. The rest of the panel is fine: the tabs above still work, and coming
              back to this screen retries.
            </p>
          </div>
        </div>
      </div>
    );
  }
}
