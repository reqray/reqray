/**
 * Hash routing.
 *
 * The panel's screen lives in the URL hash so a trace has a permanent link.
 * Two schemes are read and only one is written:
 *
 * - `#l/…` — the current scheme (`l/` namespaces the panel's own hashes, so a
 *   host page using the hash for its own purposes is not hijacked);
 * - `#/…` — the scheme permalinks were first shipped with. Links to it are
 *   already out in chat threads and issue trackers, so it stays readable
 *   forever. It is never written.
 */

export type Screen =
  | 'requests'
  | 'detail'
  | 'exceptions'
  | 'compare'
  | 'routes'
  | 'findings'
  | 'history'
  | 'project';

export interface Route {
  readonly screen: Screen;
  readonly selected: string | null;
  /** The pair on the compare screen; `b` is `null` while it is being picked. */
  readonly compare: { a: string; b: string | null } | null;
}

export const LIST_ROUTE: Route = { screen: 'requests', selected: null, compare: null };

function detail(id: string): Route {
  return { screen: 'detail', selected: decodeURIComponent(id), compare: null };
}

function compare(a: string | undefined, b: string | undefined): Route | null {
  if (!a) return null;
  const first = decodeURIComponent(a);
  return {
    screen: 'compare',
    selected: first,
    compare: { a: first, b: b ? decodeURIComponent(b) : null },
  };
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');

  if (path.startsWith('l/')) {
    const rest = path.slice('l/'.length);
    if (rest === 'exc') return { ...LIST_ROUTE, screen: 'exceptions' };
    if (rest === 'routes') return { ...LIST_ROUTE, screen: 'routes' };
    if (rest === 'findings') return { ...LIST_ROUTE, screen: 'findings' };
    if (rest === 'history') return { ...LIST_ROUTE, screen: 'history' };
    if (rest === 'project') return { ...LIST_ROUTE, screen: 'project' };
    if (rest.startsWith('req/')) return detail(rest.slice('req/'.length));
    if (rest.startsWith('cmp/')) {
      const [a, b] = rest.slice('cmp/'.length).split(',');
      return compare(a, b) ?? LIST_ROUTE;
    }
    return LIST_ROUTE;
  }

  // The original scheme: read-only, kept so old permalinks still open.
  const legacy = path.replace(/^\/?/, '');
  if (legacy === 'exceptions') return { ...LIST_ROUTE, screen: 'exceptions' };
  if (legacy.startsWith('req/')) return detail(legacy.slice('req/'.length));
  if (legacy.startsWith('compare/')) {
    const [a, b] = legacy.slice('compare/'.length).split('/');
    return compare(a, b) ?? LIST_ROUTE;
  }
  return LIST_ROUTE;
}

export function hashFor(route: Route): string {
  switch (route.screen) {
    case 'exceptions':
      return '#l/exc';
    case 'project':
      return '#l/project';
    case 'routes':
      return '#l/routes';
    case 'findings':
      return '#l/findings';
    case 'history':
      return '#l/history';
    case 'detail':
      return route.selected ? `#l/req/${encodeURIComponent(route.selected)}` : '#l/requests';
    case 'compare': {
      if (!route.compare) return '#l/requests';
      const tail = route.compare.b ? `,${encodeURIComponent(route.compare.b)}` : '';
      return `#l/cmp/${encodeURIComponent(route.compare.a)}${tail}`;
    }
    default:
      return '#l/requests';
  }
}
