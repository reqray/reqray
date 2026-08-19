import { useCallback, useEffect, useState } from 'react';
import { fetchMeta, type PanelMeta } from './api';
import { CompareScreen } from './screens/CompareScreen';
import { DetailScreen } from './screens/DetailScreen';
import { ExceptionsScreen } from './screens/ExceptionsScreen';
import { RequestsScreen } from './screens/RequestsScreen';
import { useRequests } from './useRequests';

type Screen = 'requests' | 'detail' | 'exceptions' | 'compare';
type Theme = 'dark' | 'light';

interface Route {
  readonly screen: Screen;
  readonly selected: string | null;
  /** The pair on the compare screen; `b` is `null` while it is being picked. */
  readonly compare: { a: string; b: string | null } | null;
}

/**
 * The screen lives in the URL hash, so a trace has a permanent link:
 * `#/req/<id>` opens the same detail for whoever it is sent to (while the
 * record is still in the ring buffer — an evicted one gets an honest screen),
 * and `#/compare/<a>/<b>` shares a whole comparison.
 */
function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'exceptions') return { screen: 'exceptions', selected: null, compare: null };
  if (path.startsWith('req/')) {
    return {
      screen: 'detail',
      selected: decodeURIComponent(path.slice('req/'.length)),
      compare: null,
    };
  }
  if (path.startsWith('compare/')) {
    const [a, b] = path.slice('compare/'.length).split('/').map(decodeURIComponent);
    if (a) return { screen: 'compare', selected: a, compare: { a, b: b || null } };
  }
  return { screen: 'requests', selected: null, compare: null };
}

function hashFor(route: Route): string {
  if (route.screen === 'exceptions') return '#/exceptions';
  if (route.screen === 'detail' && route.selected) {
    return `#/req/${encodeURIComponent(route.selected)}`;
  }
  if (route.screen === 'compare' && route.compare) {
    const tail = route.compare.b ? `/${encodeURIComponent(route.compare.b)}` : '';
    return `#/compare/${encodeURIComponent(route.compare.a)}${tail}`;
  }
  return '#/';
}

export function App() {
  const initial = parseHash(window.location.hash);
  const [screen, setScreen] = useState<Screen>(initial.screen);
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [compare, setCompare] = useState<Route['compare']>(initial.compare);
  const [theme, setTheme] = useState<Theme>('dark');
  const [live, setLive] = useState(true);
  const [meta, setMeta] = useState<PanelMeta | null>(null);

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

  // The state drives the hash — that is what makes the link copyable.
  useEffect(() => {
    const wanted = hashFor({ screen, selected, compare });
    if ((window.location.hash || '#/') !== wanted) window.location.hash = wanted;
  }, [screen, selected, compare]);

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
          <RequestsScreen state={requests} selected={selected} onOpen={openRequest} />
        )}
      </main>
    </div>
  );
}
