/**
 * The question the list is asked: chips, tokens and a time range.
 *
 * `matches` is the client half of a filter the server also applies — the panel
 * re-filters what arrives on the live feed, and the parity test holds the two
 * together.
 */

import type { RequestFilterQuery, RequestRow } from '../../api/index';
import { inWindow, type TimeWindow } from './timeline';
import { apiQueryOf, type ParsedQuery, parseQuery } from './tokens';

/**
 * The chips in the last filter group are radio-like: exactly one is active.
 * `tests` is not about duration, but it belongs to the same single-choice
 * group — "show me only this kind of request".
 */
export type DurationFilter = 'any' | 'slow100' | 'slow500' | 'nplus' | 'tests';

export interface FilterState {
  query: string;
  methods: string[];
  statusClasses: number[];
  duration: DurationFilter;
  /** Set by picking a row on the Routes screen; cleared from the status bar. */
  route: { method: string; route: string } | null;
  /**
   * The selected stretch of time — dragged on the strip or typed into the
   * time pill. One range, whichever way it was chosen, and the store applies
   * it: narrowing to yesterday must search yesterday, not the page in hand.
   */
  range: TimeWindow | null;
}

export const EMPTY_FILTER: FilterState = {
  query: '',
  methods: [],
  statusClasses: [],
  duration: 'any',
  route: null,
  range: null,
};

/**
 * Free text, matched the way the server matches it.
 *
 * Within one field, never across the join of several: a needle spanning two of
 * them must not select rows here that a page would never return.
 */
function matchesText(row: RequestRow, needle: string): boolean {
  if (row.method.toLowerCase().includes(needle)) return true;
  if (row.path.toLowerCase().includes(needle)) return true;
  if (String(row.status).includes(needle)) return true;
  return row.query ? row.query.toLowerCase().includes(needle) : false;
}

export function matches(row: RequestRow, filter: FilterState, parsed: ParsedQuery): boolean {
  if (
    filter.route &&
    (row.method.toUpperCase() !== filter.route.method.toUpperCase() ||
      row.route !== filter.route.route)
  ) {
    return false;
  }
  const needle = parsed.text.trim().toLowerCase();
  if (needle && !matchesText(row, needle)) return false;
  if (!inWindow(row.startedAt, filter.range)) return false;
  // Chips and tokens compose: either can narrow, both must be satisfied.
  if (filter.methods.length && !filter.methods.includes(row.method.toUpperCase())) return false;
  if (parsed.methods.length && !parsed.methods.includes(row.method.toUpperCase())) return false;
  if (filter.statusClasses.length && !filter.statusClasses.includes(Math.floor(row.status / 100))) {
    return false;
  }
  if (parsed.statusClasses.length && !parsed.statusClasses.includes(Math.floor(row.status / 100))) {
    return false;
  }
  if (parsed.status !== null && row.status !== parsed.status) return false;
  if (parsed.path !== null && !row.path.toLowerCase().includes(parsed.path.toLowerCase())) {
    return false;
  }
  if (parsed.minDurationMs !== null && row.durationMs < parsed.minDurationMs) return false;
  if (parsed.minSql !== null && row.sqlCount < parsed.minSql) return false;
  if (parsed.flagged.length && (row.flag === null || !parsed.flagged.includes(row.flag))) {
    return false;
  }
  if (parsed.nPlusOne && !row.nPlusOne) return false;
  if (parsed.onlyFindings && row.findingCount === 0) return false;
  if (parsed.onlyErrors && !row.hasError) return false;
  if (parsed.test !== null) {
    if (row.test === null) return false;
    if (parsed.test && !row.test.toLowerCase().includes(parsed.test.toLowerCase())) return false;
  }
  switch (filter.duration) {
    case 'slow100':
      return row.durationMs >= 100;
    case 'slow500':
      return row.durationMs >= 500;
    case 'nplus':
      return row.nPlusOne;
    case 'tests':
      return row.test !== null;
    default:
      return true;
  }
}

/**
 * The panel's filter, as the API takes it.
 *
 * Everything the reader can narrow by goes to the server, so a filter means
 * the same thing whether the store behind it is a ring of five hundred or a
 * history of half a million. The client applies the same filter again to what
 * comes back — that is what keeps rows arriving on the live feed, which never
 * pass through the server, from showing up where they do not belong.
 */
export function asQuery(filter: FilterState): RequestFilterQuery {
  const parsed = parseQuery(filter.query);
  const tokens = apiQueryOf(parsed);
  const chipMin =
    filter.duration === 'slow100' ? 100 : filter.duration === 'slow500' ? 500 : undefined;
  return {
    ...tokens,
    from: filter.range?.[0],
    to: filter.range?.[1],
    // Chips and tokens compose: the stricter of the two thresholds, the
    // union of nothing — a method chip AND a method token both apply, and
    // the server receives whichever set is present (both go through
    // `matches` again client-side, so the intersection still holds).
    methods: [...new Set([...filter.methods, ...(tokens.methods ?? [])])],
    statusClasses: [...new Set([...filter.statusClasses, ...(tokens.statusClasses ?? [])])],
    minDurationMs: Math.max(chipMin ?? 0, tokens.minDurationMs ?? 0) || undefined,
    onlyNPlusOne: filter.duration === 'nplus' || tokens.onlyNPlusOne,
    onlyTests: filter.duration === 'tests' || tokens.onlyTests,
    route: filter.route,
  };
}

/**
 * Whether the reader has narrowed anything at all.
 *
 * The difference between "nothing recorded yet" and "nothing matches what you
 * asked for" — two very different things to say, and the second one must
 * never replace the screen the filters live on.
 */
export function isFiltering(filter: FilterState): boolean {
  return (
    filter.query.trim() !== '' ||
    filter.methods.length > 0 ||
    filter.statusClasses.length > 0 ||
    filter.duration !== 'any' ||
    filter.route !== null ||
    filter.range !== null
  );
}

/**
 * What the filter is asking, in the fewest words that name it.
 *
 * Used wherever a screen has to say what it is showing — the history
 * screen's pill, and the list's own "nothing matches", which must name the
 * question rather than the answer: a bare "no results" leaves the reader to
 * guess which of six narrowings emptied the screen.
 */
export function describeFilter(filter: FilterState): string[] {
  const parts: string[] = [];
  if (filter.route) parts.push(`${filter.route.method} ${filter.route.route}`);
  // Word by word: the box speaks tokens now, and `status:5xx` and the free
  // text beside it are two separate narrowings to take back.
  for (const word of filter.query.trim().split(/\s+/)) if (word) parts.push(word);
  if (filter.methods.length > 0) parts.push(filter.methods.join('/'));
  if (filter.statusClasses.length > 0) {
    parts.push(filter.statusClasses.map((cls) => `${cls}xx`).join('/'));
  }
  if (filter.duration !== 'any') parts.push(filter.duration);
  if (filter.range) parts.push('a stretch of time');
  return parts;
}

/** What identifies a filter, for deciding whether to ask the server again. */
export function queryKey(filter: FilterState): string {
  return JSON.stringify(asQuery(filter));
}
