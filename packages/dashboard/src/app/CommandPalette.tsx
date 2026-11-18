import { useEffect, useMemo, useRef, useState } from 'react';
import { TOKEN_HINTS } from '../shared/list/tokens';
import type { SavedView } from '../shared/list/views';
import { useFocusTrap } from '../shared/ui/useFocusTrap';
import type { Screen } from './routing';
import { NAV_SCREENS } from './screens';

/**
 * ⌘K: everything the panel can do, behind one box.
 *
 * Four kinds of entries, and nothing generated: the tabs, the saved views,
 * the search tokens, and the routes of the requests in hand. Typing narrows
 * by substring; Enter runs the highlighted one. It is a launcher, not a
 * second query language — the query language is the search field the token
 * entries lead into.
 */

export interface PaletteAction {
  readonly kind: 'screen' | 'view' | 'token' | 'route';
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

export function buildActions(input: {
  views: readonly SavedView[];
  routes: ReadonlyArray<{ method: string; route: string }>;
  go: (screen: Screen) => void;
  applyView: (view: SavedView) => void;
  insertToken: (token: string) => void;
  pickRoute: (route: { method: string; route: string }) => void;
}): PaletteAction[] {
  return [
    ...NAV_SCREENS.map(
      (entry): PaletteAction => ({
        kind: 'screen',
        label: entry.label.toLowerCase(),
        hint: 'go to',
        run: () => input.go(entry.screen),
      }),
    ),
    ...input.views.map(
      (view): PaletteAction => ({
        kind: 'view',
        label: view.name,
        hint: 'saved view',
        run: () => input.applyView(view),
      }),
    ),
    ...TOKEN_HINTS.map(
      (entry): PaletteAction => ({
        kind: 'token',
        label: entry.token,
        hint: entry.hint,
        run: () => input.insertToken(entry.token),
      }),
    ),
    ...input.routes.map(
      (route): PaletteAction => ({
        kind: 'route',
        label: `${route.method} ${route.route}`,
        hint: 'filter the list to this route',
        run: () => input.pickRoute(route),
      }),
    ),
  ];
}

/** Substring match over the label and the hint, case-insensitive. */
export function matchActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...actions];
  return actions.filter(
    (action) =>
      action.label.toLowerCase().includes(needle) || action.hint.toLowerCase().includes(needle),
  );
}

interface CommandPaletteProps {
  actions: readonly PaletteAction[];
  onClose: () => void;
}

export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  const shown = useMemo(() => matchActions(actions, query).slice(0, 12), [actions, query]);
  const cursor = Math.min(index, Math.max(0, shown.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (action: PaletteAction): void => {
    action.run();
    onClose();
  };

  /**
   * Arrow keys walk the list, Enter runs, Escape closes.
   *
   * `Ctrl-N`/`Ctrl-P` alongside the arrows: the palette is reached from the
   * keyboard, and the hands that reach for it rarely leave the home row.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Stopped here, or the panel's own Escape handler would also fire and
      // clear the filter behind the palette that is closing.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, shown.length - 1));
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key !== 'Enter') return;

    event.preventDefault();
    const action = shown[cursor];
    if (action) run(action);
  };

  /** The backdrop closes; a click that started inside the box does not. */
  const onBackdropClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  /** Typing narrows the list, and puts the cursor back on its first row. */
  const onQuery = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
    setIndex(0);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on click, like every overlay here
    <div className="palette-overlay" onClick={onBackdropClick} onKeyDown={onKeyDown}>
      <div
        ref={trapRef}
        className="palette mono"
        role="dialog"
        aria-modal="true"
        aria-label="command palette"
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="screens, saved views, tokens, routes…"
          onChange={onQuery}
        />

        {shown.length === 0 ? (
          <div className="palette-empty s-dim">nothing matches</div>
        ) : (
          shown.map((action, at) => (
            <button
              key={`${action.kind}:${action.label}`}
              type="button"
              className="palette-row"
              data-active={at === cursor}
              onMouseEnter={() => setIndex(at)}
              onClick={() => run(action)}
            >
              <span className="palette-kind s-dim">{action.kind}</span>
              <span className="ellipsis">{action.label}</span>
              <span className="palette-hint s-dim ellipsis">{action.hint}</span>
            </button>
          ))
        )}

        <div className="palette-foot s-dim">↑↓ move · enter runs · esc closes</div>
      </div>
    </div>
  );
}
