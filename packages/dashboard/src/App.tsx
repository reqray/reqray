import { useCallback, useEffect, useState } from 'react';
import { fetchMeta, type PanelMeta } from './api';
import { KeyboardPanel } from './components/KeyboardPanel';
import { isTypingTarget } from './keyboard';
import { hashFor, parseHash, type Route, type Screen } from './routing';
import { CompareScreen } from './screens/CompareScreen';
import { DetailScreen } from './screens/DetailScreen';
import { ExceptionsScreen } from './screens/ExceptionsScreen';
import { RequestsScreen } from './screens/RequestsScreen';
import { RoutesScreen } from './screens/RoutesScreen';
import { EMPTY_FILTER, useRequests } from './useRequests';

type Theme = 'dark' | 'light';

export function App() {
  const initial = parseHash(window.location.hash);
  const [screen, setScreen] = useState<Screen>(initial.screen);
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [compare, setCompare] = useState<Route['compare']>(initial.compare);
  const [theme, setTheme] = useState<Theme>('dark');
  const [live, setLive] = useState(true);
  const [meta, setMeta] = useState<PanelMeta | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  /** Requests staged for comparison, oldest pick first; at most two. */
  const [picked, setPicked] = useState<string[]>([]);

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
      setScreen(next.screen);
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

  const togglePicked = useCallback((id: string) => {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      // Two at a time: a third pick pushes out the oldest.
      return current.length < 2 ? [...current, id] : [current[1] as string, id];
    });
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
            aria-current={screen !== 'exceptions' && screen !== 'routes'}
            onClick={() => setScreen('requests')}
          >
            Requests
          </button>
          <button
            type="button"
            aria-current={screen === 'routes'}
            onClick={() => setScreen('routes')}
          >
            Routes
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
        ) : screen === 'routes' ? (
          <RoutesScreen
            onPickRoute={(route) => {
              // Picking a route is a fresh question: the other filters, which
              // were asked about a different set of rows, are cleared.
              requests.setFilter({ ...EMPTY_FILTER, route });
              requests.setWindow(null);
              setScreen('requests');
            }}
          />
        ) : screen === 'compare' && compare ? (
          <CompareScreen
            a={compare.a}
            b={compare.b}
            onPick={(id) => setCompare((current) => (current ? { ...current, b: id } : current))}
            onSwap={() =>
              setCompare((current) => (current?.b ? { a: current.b, b: current.a } : current))
            }
            onClear={() => {
              setPicked([]);
              setScreen('requests');
            }}
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
            compare={picked}
            onOpen={openRequest}
            onSelect={setSelected}
            onToggleCompare={togglePicked}
            onClearCompare={() => setPicked([])}
            onOpenCompare={() => {
              const [a, b] = picked;
              if (!a || !b) return;
              setCompare({ a, b });
              setScreen('compare');
            }}
          />
        )}

        {keysOpen ? <KeyboardPanel onClose={() => setKeysOpen(false)} /> : null}
      </main>
    </div>
  );
}
