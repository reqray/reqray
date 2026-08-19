import { useCallback, useEffect, useState } from 'react';
import { fetchMeta, type PanelMeta } from './api';
import { KeyboardPanel } from './components/KeyboardPanel';
import { isTypingTarget } from './keyboard';
import { hashFor, parseHash, type Route, type Screen } from './routing';
import { CompareScreen } from './screens/CompareScreen';
import { DetailScreen } from './screens/DetailScreen';
import { ExceptionsScreen } from './screens/ExceptionsScreen';
import { RequestsScreen } from './screens/RequestsScreen';
import { useRequests } from './useRequests';

type Theme = 'dark' | 'light';

/**
 * `#l/routes` is part of the hash contract already, but the screen it names
 * arrives with the Routes stage. Until then the link lands on the list rather
 * than on nothing, and the hash is rewritten to say so.
 */
function landable(screen: Screen): Screen {
  return screen === 'routes' ? 'requests' : screen;
}

export function App() {
  const initial = parseHash(window.location.hash);
  const [screen, setScreen] = useState<Screen>(landable(initial.screen));
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [compare, setCompare] = useState<Route['compare']>(initial.compare);
  const [theme, setTheme] = useState<Theme>('dark');
  const [live, setLive] = useState(true);
  const [meta, setMeta] = useState<PanelMeta | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);

  // The feed only runs on the list screen: nothing behind the detail screen
  // would show a new row anyway.
  const requests = useRequests(screen === 'requests', live);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    fetchMeta(controller.signal)
      .then(setMeta)
      .catch(() => setMeta(null));
    return () => controller.abort();
  }, []);

  // Back/forward buttons and pasted links drive the state.
  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash(window.location.hash);
      setScreen(landable(next.screen));
      setCompare(next.compare);
      // The list keeps its highlight when navigating back to it.
      if (next.selected !== null) setSelected(next.selected);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // The state drives the hash — that is what makes the link copyable. A real
  // navigation (rather than replaceState) is deliberate: back and forward are
  // how people leave a request they opened, and there are only a handful of
  // screen changes, so history stays readable.
  useEffect(() => {
    const wanted = hashFor({ screen, selected, compare });
    if (window.location.hash !== wanted) window.location.hash = wanted;
  }, [screen, selected, compare]);

  // Shortcuts that belong to the whole panel; the list owns j/k/↵ and `/`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        // Even here `esc` has a job: it hands focus back to the shortcuts.
        if (event.key === 'Escape') (event.target as HTMLElement).blur();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setKeysOpen((open) => !open);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        setLive((current) => !current);
        return;
      }
      if (event.key === 'Escape') {
        // Topmost overlay first, then out of the screen you are in.
        if (keysOpen) setKeysOpen(false);
        else if (screen !== 'requests') setScreen('requests');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysOpen, screen]);

  const openRequest = useCallback((id: string) => {
    setSelected(id);
    setScreen('detail');
  }, []);

  const openCompare = useCallback((a: string) => {
    setCompare({ a, b: null });
    setScreen('compare');
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-word">loupe</span>
          {meta ? <span className="brand-version">{meta.mode}</span> : null}
        </div>

        <nav className="nav">
          <button
            type="button"
            // `Requests` stays active for the detail screen too — it is the
            // same place, one level deeper.
            aria-current={screen !== 'exceptions'}
            onClick={() => setScreen('requests')}
          >
            Requests
          </button>
          <button
            type="button"
            aria-current={screen === 'exceptions'}
            onClick={() => setScreen('exceptions')}
          >
            Exceptions
          </button>
        </nav>

        <span className="spacer" />

        <span className="collector">
          <span className="pulse" />
          {meta ? `collector attached · pid ${meta.pid}` : 'connecting…'}
        </span>

        <button
          type="button"
          className="live-toggle"
          data-live={live}
          onClick={() => setLive((current) => !current)}
        >
          <span className="live-dot" />
          {live ? 'live' : 'paused'}
        </button>

        <div className="segmented">
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
            dark
          </button>
          <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
            light
          </button>
        </div>

        <button
          type="button"
          className="btn-secondary keys-open"
          title="keyboard shortcuts"
          onClick={() => setKeysOpen(true)}
        >
          ?
        </button>
      </header>

      <main className="screen">
        {screen === 'exceptions' ? (
          <ExceptionsScreen onOpenRequest={openRequest} />
        ) : screen === 'compare' && compare ? (
          <CompareScreen
            a={compare.a}
            b={compare.b}
            onPick={(id) => setCompare((current) => (current ? { ...current, b: id } : current))}
            onBack={() => setScreen('requests')}
          />
        ) : screen === 'detail' && selected ? (
          <DetailScreen
            id={selected}
            replayEnabled={meta?.replayEnabled ?? false}
            onBack={() => setScreen('requests')}
            onCompare={openCompare}
          />
        ) : (
          <RequestsScreen
            state={requests}
            selected={selected}
            onOpen={openRequest}
            onSelect={setSelected}
          />
        )}

        {keysOpen ? <KeyboardPanel onClose={() => setKeysOpen(false)} /> : null}
      </main>
    </div>
  );
}
