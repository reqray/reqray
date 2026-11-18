import type { PanelMeta } from '../api/index';
import { ExportMenu } from './ExportMenu';
import { NavTabs } from './NavTabs';
import type { Screen } from './routing';
import type { Theme } from './useTheme';

interface TopBarProps {
  /** `null` while the first answer is still on its way. */
  meta: PanelMeta | null;
  screen: Screen;
  live: boolean;
  theme: Theme;
  /** The request the trace export applies to, if one is open or highlighted. */
  selected: string | null;
  /** Patterns nobody has looked at — the dot on the Findings tab. */
  newPatterns: number;
  onGo: (screen: Screen) => void;
  onToggleLive: () => void;
  onTheme: (theme: Theme) => void;
  onOpenKeys: () => void;
}

/** The bar over everything: who this process is, and the panel-wide switches. */
export function TopBar({
  meta,
  screen,
  live,
  theme,
  selected,
  newPatterns,
  onGo,
  onToggleLive,
  onTheme,
  onOpenKeys,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        <span className="brand-word">reqray</span>
        {meta ? <span className="brand-version">{meta.mode}</span> : null}
      </div>

      <NavTabs screen={screen} newPatterns={newPatterns} onGo={onGo} />

      <span className="spacer" />

      <span className="collector">
        <span className="pulse" />
        {meta ? `collector attached · pid ${meta.pid}` : 'connecting…'}
      </span>

      <button type="button" className="live-toggle" data-live={live} onClick={onToggleLive}>
        <span className="live-dot" />
        {live ? 'live' : 'paused'}
      </button>

      <ExportMenu selected={selected} />

      <div className="segmented">
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => onTheme('dark')}>
          dark
        </button>
        <button type="button" aria-pressed={theme === 'light'} onClick={() => onTheme('light')}>
          light
        </button>
      </div>

      <button
        type="button"
        className="btn-secondary keys-open"
        title="keyboard shortcuts"
        onClick={onOpenKeys}
      >
        ?
      </button>
    </header>
  );
}
