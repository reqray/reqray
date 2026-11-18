import type { Screen } from './routing';
import { NAV_SCREENS } from './screens';

/**
 * The screens the `Requests` tab stands for: the list, a request opened from
 * it, and two of them compared — one place, at three depths.
 *
 * Named rather than written as a list of exclusions: a screen added to the
 * union would otherwise light this tab up by default.
 */
const LIST_SCREENS: ReadonlySet<Screen> = new Set<Screen>(['requests', 'detail', 'compare']);

function isCurrent(tab: Screen, screen: Screen): boolean {
  return tab === 'requests' ? LIST_SCREENS.has(screen) : tab === screen;
}

interface NavTabsProps {
  screen: Screen;
  /** Patterns nobody has looked at — what the dot on Findings counts. */
  newPatterns: number;
  onGo: (screen: Screen) => void;
}

/** The tabs, one per destination, with the current one marked. */
export function NavTabs({ screen, newPatterns, onGo }: NavTabsProps) {
  return (
    <nav className="nav">
      {NAV_SCREENS.map((tab) => (
        <button
          key={tab.screen}
          type="button"
          aria-current={isCurrent(tab.screen, screen)}
          onClick={() => onGo(tab.screen)}
        >
          {tab.label}
          {tab.screen === 'findings' && newPatterns > 0 ? <span className="nav-dot" /> : null}
        </button>
      ))}
    </nav>
  );
}
