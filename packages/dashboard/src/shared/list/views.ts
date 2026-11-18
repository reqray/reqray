import type { FilterState } from './filter';

/**
 * Saved views: a filter worth coming back to, under a name.
 *
 * The whole question is serialized — the search text with its tokens, the
 * chips, the route — except the time range: a view is a *kind* of request
 * ("slow checkouts", "what the tests broke"), and a moment frozen into it
 * would quietly turn every later use into a search of last Tuesday.
 */

export interface SavedView {
  readonly name: string;
  readonly query: string;
  readonly methods: readonly string[];
  readonly statusClasses: readonly number[];
  readonly duration: FilterState['duration'];
  readonly route: { readonly method: string; readonly route: string } | null;
}

const STORAGE_KEY = 'reqray.views';

/** How many views the store keeps — a list, not a library. */
const VIEW_LIMIT = 20;

export function loadViews(storage: Pick<Storage, 'getItem'> | null): SavedView[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (view): view is SavedView =>
        typeof view === 'object' &&
        view !== null &&
        typeof (view as SavedView).name === 'string' &&
        typeof (view as SavedView).query === 'string',
    );
  } catch {
    // A corrupt or unavailable store is not worth a broken panel.
    return [];
  }
}

export function saveViews(
  storage: Pick<Storage, 'setItem'> | null,
  views: readonly SavedView[],
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(views.slice(0, VIEW_LIMIT)));
  } catch {
    // Nothing to do: the views still work for this session.
  }
}

/** The current filter as a view. The range is deliberately left behind. */
export function viewOf(name: string, filter: FilterState): SavedView {
  return {
    name: name.trim(),
    query: filter.query,
    methods: [...filter.methods],
    statusClasses: [...filter.statusClasses],
    duration: filter.duration,
    route: filter.route,
  };
}

/** The view as a filter again — everything but the range it never kept. */
export function filterOf(view: SavedView): FilterState {
  return {
    query: view.query,
    methods: [...view.methods],
    statusClasses: [...view.statusClasses],
    duration: view.duration,
    route: view.route,
    range: null,
  };
}

/** Adds or replaces by name — saving twice under one name is an update. */
export function withView(views: readonly SavedView[], view: SavedView): SavedView[] {
  return [view, ...views.filter((item) => item.name !== view.name)];
}
