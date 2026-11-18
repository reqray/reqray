import { useCallback, useState } from 'react';
import { fetchMeta } from './api/index';
import { buildActions, CommandPalette } from './app/CommandPalette';
import { KeyboardPanel } from './app/KeyboardPanel';
import { PanelProvider } from './app/PanelContext';
import { type RoutePick, recentRoutes } from './app/palette';
import type { Screen } from './app/routing';
import { ScreenBoundary } from './app/ScreenBoundary';
import { Toast } from './app/Toast';
import { TopBar } from './app/TopBar';
import { useHashRoute } from './app/useHashRoute';
import { usePanelShortcuts } from './app/usePanelShortcuts';
import { useTheme } from './app/useTheme';
import { useUnreadDot } from './app/useUnreadDot';
import { CompareScreen } from './features/compare/CompareScreen';
import { DetailScreen } from './features/detail/DetailScreen';
import { ExceptionsScreen } from './features/exceptions/ExceptionsScreen';
import { FindingsScreen } from './features/findings/FindingsScreen';
import { HistoryScreen } from './features/history/HistoryScreen';
import { ProjectScreen } from './features/project/ProjectScreen';
import { RequestsScreen } from './features/requests/RequestsScreen';
import { RoutesScreen } from './features/routes/RoutesScreen';
import { EMPTY_FILTER } from './shared/list/filter';
import { useRequests } from './shared/list/useRequests';
import { filterOf, loadViews, type SavedView } from './shared/list/views';
import { useLiveQuery } from './shared/useLiveQuery';

export function App() {
  const { screen, selected, compare, setScreen, setSelected, setCompare } = useHashRoute();
  const [theme, setTheme] = useTheme();
  const [live, setLive] = useState(true);
  const [keysOpen, setKeysOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** Requests staged for comparison, oldest pick first; at most two. */
  const [picked, setPicked] = useState<string[]>([]);
  /** A stretch of the list's window the status bar sent the reader here with. */
  const [findingsRange, setFindingsRange] = useState<readonly [number, number] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const { data: meta } = useLiveQuery(fetchMeta);
  const [newPatterns, setNewPatterns] = useUnreadDot(live);

  // The feed only runs on the list screen: nothing behind the detail screen
  // would show a new row anyway.
  const requests = useRequests(screen === 'requests', live, meta?.bufferSize);

  const toggleLive = () => setLive((current) => !current);

  usePanelShortcuts({
    togglePalette: () => setPaletteOpen((open) => !open),
    toggleKeys: () => setKeysOpen((open) => !open),
    toggleLive,
    escape: () => {
      // Topmost overlay first, then out of the screen you are in.
      if (paletteOpen) setPaletteOpen(false);
      else if (keysOpen) setKeysOpen(false);
      else if (screen !== 'requests') setScreen('requests');
    },
  });

  const openRequest = useCallback(
    (id: string) => {
      setSelected(id);
      setScreen('detail');
    },
    [setSelected, setScreen],
  );

  const openCompare = useCallback(
    (a: string) => {
      setCompare({ a, b: null });
      setScreen('compare');
    },
    [setCompare, setScreen],
  );

  const togglePicked = useCallback((id: string) => {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      // Two at a time: a third pick pushes out the oldest.
      return current.length < 2 ? [...current, id] : [current[1] as string, id];
    });
  }, []);

  /** A move by name, from the nav or the palette. Findings asked for this way is asked about everything. */
  const goTo = (next: Screen) => {
    if (next === 'findings') setFindingsRange(null);
    setScreen(next);
  };

  const showList = () => setScreen('requests');

  /**
   * Picking a route is a fresh question: the other filters, which were asked
   * about a different set of rows, are cleared.
   */
  const pickRoute = (route: RoutePick) => {
    requests.setFilter({ ...EMPTY_FILTER, route });
    setScreen('requests');
  };

  const clearFilter = () => requests.setFilter(EMPTY_FILTER);

  /**
   * Opens the list on the stretch a chart column stands for.
   *
   * The filter the chart was drawn with is kept: opening a point has to land
   * on the very requests that made it, or the chart is a gauge after all.
   */
  const openRange = (from: number, to: number) => {
    requests.setFilter({ ...requests.filter, range: [from, to] });
    setScreen('requests');
  };

  /** The findings of one stretch of time, sent from a chart. */
  const openFindingsRange = (from: number, to: number) => {
    setFindingsRange([from, to]);
    setScreen('findings');
  };

  /**
   * The findings behind the number in the list's status bar — scoped to the
   * window the list is looking at, since that is what the number was counted
   * over.
   */
  const openFindingsHere = () => {
    setFindingsRange(requests.filter.range);
    setScreen('findings');
  };

  /** The second half of the pair, chosen on the compare screen itself. */
  const pickCompared = (id: string) =>
    setCompare((current) => (current ? { ...current, b: id } : current));

  const swapCompared = () =>
    setCompare((current) => (current?.b ? { a: current.b, b: current.a } : current));

  /** Leaves the comparison, and drops the staged pair with it. */
  const leaveCompare = () => {
    setPicked([]);
    setScreen('requests');
  };

  /** Opens the two staged requests side by side. */
  const openPicked = () => {
    const [a, b] = picked;
    if (!a || !b) return;
    setCompare({ a, b });
    setScreen('compare');
  };

  const applyView = (view: SavedView) => {
    requests.setFilter(filterOf(view));
    setScreen('requests');
  };

  /** Appends a search token to the query the list already carries. */
  const insertToken = (token: string) => {
    const query = requests.filter.query;
    requests.setFilter({ ...requests.filter, query: query ? `${query} ${token}` : token });
    setScreen('requests');
  };

  const paletteActions = () =>
    buildActions({
      views: loadViews(typeof localStorage === 'undefined' ? null : localStorage),
      routes: recentRoutes(requests.rows),
      go: goTo,
      applyView,
      insertToken,
      pickRoute,
    });

  /**
   * The screen in view.
   *
   * A comparison and a detail need their subject: a link to a request the
   * buffer has since dropped opens the list, not an empty frame.
   */
  const currentScreen = () => {
    const list = (
      <RequestsScreen
        state={requests}
        selected={selected}
        compare={picked}
        onOpen={openRequest}
        onOpenFindings={openFindingsHere}
        onSelect={setSelected}
        onToggleCompare={togglePicked}
        onClearCompare={() => setPicked([])}
        onOpenCompare={openPicked}
      />
    );

    switch (screen) {
      case 'project':
        return <ProjectScreen />;
      case 'exceptions':
        return (
          <ExceptionsScreen
            blameEnabled={meta?.blameEnabled ?? false}
            onOpenRequest={openRequest}
          />
        );
      case 'routes':
        return <RoutesScreen onOpenRequest={openRequest} onPickRoute={pickRoute} />;
      case 'findings':
        return (
          <FindingsScreen
            range={findingsRange}
            detectors={meta?.detectors ?? []}
            onClearRange={() => setFindingsRange(null)}
            onOpenRequest={openRequest}
            onNewCount={setNewPatterns}
          />
        );
      case 'history':
        return (
          <HistoryScreen
            filter={requests.filter}
            processStartedAt={meta?.startedAt ?? null}
            onOpenRequest={openRequest}
            onOpenFindings={openFindingsRange}
            onClearFilter={clearFilter}
            onOpenRange={openRange}
          />
        );
      case 'compare':
        return compare ? (
          <CompareScreen
            a={compare.a}
            b={compare.b}
            onPick={pickCompared}
            onSwap={swapCompared}
            onClear={leaveCompare}
            onBack={showList}
          />
        ) : (
          list
        );
      case 'detail':
        return selected ? (
          <DetailScreen
            id={selected}
            replayEnabled={meta?.replayEnabled ?? false}
            onOpen={openRequest}
            onBack={showList}
            onCompare={openCompare}
          />
        ) : (
          list
        );
      default:
        return list;
    }
  };

  return (
    <PanelProvider live={live} onToast={setToast}>
      <div className="shell">
        <TopBar
          meta={meta}
          screen={screen}
          live={live}
          theme={theme}
          selected={selected}
          newPatterns={newPatterns}
          onGo={goTo}
          onToggleLive={toggleLive}
          onTheme={setTheme}
          onOpenKeys={() => setKeysOpen(true)}
        />

        <main className="screen">
          <ScreenBoundary key={screen}>{currentScreen()}</ScreenBoundary>

          {keysOpen ? <KeyboardPanel onClose={() => setKeysOpen(false)} /> : null}
          {paletteOpen ? (
            <CommandPalette actions={paletteActions()} onClose={() => setPaletteOpen(false)} />
          ) : null}

          {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
        </main>
      </div>
    </PanelProvider>
  );
}
