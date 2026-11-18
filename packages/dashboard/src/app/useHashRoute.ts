import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { hashFor, parseHash, type Route, type Screen } from './routing';

export interface HashRoute {
  screen: Screen;
  selected: string | null;
  compare: Route['compare'];
  setScreen: Dispatch<SetStateAction<Screen>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setCompare: Dispatch<SetStateAction<Route['compare']>>;
}

/**
 * The screen in the URL hash, in both directions.
 *
 * State drives the hash — that is what makes every view a copyable link — and
 * the hash drives the state, so back, forward and pasted links all land. A
 * real navigation rather than `replaceState` on purpose: back and forward are
 * how people leave a request they opened, and there are only a handful of
 * screen changes, so history stays readable.
 */
export function useHashRoute(): HashRoute {
  // Parsed once: the hash matters again only when it changes, and that has a
  // listener of its own below.
  const [initial] = useState(() => parseHash(window.location.hash));
  const [screen, setScreen] = useState<Screen>(initial.screen);
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [compare, setCompare] = useState<Route['compare']>(initial.compare);

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

  useEffect(() => {
    const wanted = hashFor({ screen, selected, compare });
    if (window.location.hash !== wanted) window.location.hash = wanted;
  }, [screen, selected, compare]);

  return { screen, selected, compare, setScreen, setSelected, setCompare };
}
