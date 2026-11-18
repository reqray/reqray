/**
 * Narrowing the live stream.
 *
 * The stream endpoint sends every request and takes no parameters, so this is
 * decided here — the same way the web panel narrows its own feed. It is also
 * the only sensible place for it: `--path` is a glob, and a glob is a
 * question about a string, not about a store.
 */

import type { RequestRow } from '@reqray/protocol';

/** What `watch` was asked to show. */
export interface StreamFilter {
  readonly slowerThanMs?: number | null;
  /** `404`, `4xx`, `5xx` — codes and classes together. */
  readonly statuses?: readonly string[];
  readonly methods?: readonly string[];
  /** A glob over the path: `*` is any run of characters, `?` is one. */
  readonly path?: string | null;
  readonly findingsOnly?: boolean;
}

/** Whether a row belongs on screen. */
export function matches(row: RequestRow, filter: StreamFilter): boolean {
  if (filter.slowerThanMs != null && row.durationMs < filter.slowerThanMs) return false;
  if (filter.findingsOnly && row.findingCount === 0) return false;

  const methods = filter.methods ?? [];
  if (methods.length > 0 && !methods.some((method) => method.toUpperCase() === row.method)) {
    return false;
  }

  const statuses = filter.statuses ?? [];
  if (statuses.length > 0 && !statuses.some((spec) => matchesStatus(row.status, spec))) {
    return false;
  }

  if (filter.path && !globOf(filter.path).test(row.path)) return false;
  return true;
}

/** `404` matches one code; `4xx` matches the class. */
export function matchesStatus(status: number, spec: string): boolean {
  const trimmed = spec.trim().toLowerCase();
  if (/^[1-5]xx$/.test(trimmed)) return Math.floor(status / 100) === Number(trimmed[0]);
  const exact = Number(trimmed);
  return Number.isFinite(exact) && exact === status;
}

const globCache = new Map<string, RegExp>();

/**
 * A path glob.
 *
 * `*` crosses slashes: `--path '/api/*'` means everything under `/api`, which
 * is what someone typing it means, whatever a shell would have done with it.
 */
export function globOf(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;

  const pattern = glob
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return /[a-zA-Z0-9/_-]/.test(char) ? char : `\\${char}`;
    })
    .join('');
  const expression = new RegExp(`^${pattern}$`);
  globCache.set(glob, expression);
  return expression;
}
