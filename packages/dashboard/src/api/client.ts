/*
 * The base every call goes through: where the API is, and how to reach it.
 *
 * The panel mounts on an arbitrary path inside the host application, so the
 * base is derived from the current location rather than baked into the bundle.
 */

import type { RequestSort } from '@reqray/protocol';

export interface RequestFilterQuery {
  /** Not before this moment, epoch ms. */
  from?: number | undefined;
  /** Not after this moment, epoch ms. */
  to?: number | undefined;
  q?: string | undefined;
  methods?: string[] | undefined;
  statusClasses?: number[] | undefined;
  minDurationMs?: number | undefined;
  onlyFindings?: boolean | undefined;
  onlyNPlusOne?: boolean | undefined;
  onlyTests?: boolean | undefined;
  onlyErrors?: boolean | undefined;
  /** Substring of the path alone — narrower than `q`, which matches four fields. */
  path?: string | undefined;
  /** Exactly this status code. */
  status?: number | undefined;
  /** At least this many SQL queries. */
  minSql?: number | undefined;
  /** Rows the list flags with one of these detectors. */
  flagged?: string[] | undefined;
  /** Issued by a test whose name contains this. */
  test?: string | undefined;
  route?: { method: string; route: string } | null | undefined;
  /** `slowest` puts the worst first — what a "top requests" peek is made of. */
  sort?: RequestSort | undefined;
  /** One page's worth; the server caps it. */
  limit?: number | undefined;
}

/**
 * Mount path of the panel, derived from the current location.
 *
 * The panel mounts on an arbitrary path inside the host application, so no
 * absolute API base can be baked into the bundle.
 */
export function apiBase(): string {
  const path = window.location.pathname.replace(/\/+$/, '');
  return `${path}/api`;
}

/** An absolute URL for a panel API path — for links the browser must follow. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal: signal ?? null,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * A request that changes something, and answers for whether it worked.
 *
 * Every mutation goes through here: a change nobody can see fail is worse than
 * one that fails loudly.
 */
export async function sendJson<T = void>(
  path: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    signal: signal ?? null,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // A proxy answering HTML must not surface as `Unexpected token <`.
    const failed = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failed?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json().catch(() => undefined)) as T;
}

/**
 * The filter, as the query string the panel API parses.
 *
 * Exported so the parity test can drive the whole chain rather than a copy of
 * half of it.
 */
export function toSearchParams(filter: RequestFilterQuery): string {
  const params = new URLSearchParams();
  // An open end is left off entirely rather than sent as an infinity the
  // server would have to know to ignore.
  if (filter.from !== undefined && Number.isFinite(filter.from)) {
    params.set('from', String(Math.round(filter.from)));
  }
  if (filter.to !== undefined && Number.isFinite(filter.to)) {
    params.set('to', String(Math.round(filter.to)));
  }
  if (filter.q) params.set('q', filter.q);
  if (filter.methods?.length) params.set('method', filter.methods.join(','));
  if (filter.statusClasses?.length) params.set('status', filter.statusClasses.join(','));
  if (filter.minDurationMs) params.set('minDurationMs', String(filter.minDurationMs));
  if (filter.onlyFindings) params.set('findings', '1');
  if (filter.onlyNPlusOne) params.set('nplus', '1');
  if (filter.onlyTests) params.set('tests', '1');
  if (filter.onlyErrors) params.set('errors', '1');
  if (filter.path) params.set('path', filter.path);
  if (filter.status) params.set('statusExact', String(filter.status));
  if (filter.minSql) params.set('minSql', String(filter.minSql));
  if (filter.flagged?.length) params.set('flagged', filter.flagged.join(','));
  if (filter.test !== undefined) params.set('test', filter.test);
  if (filter.route) {
    params.set('route', filter.route.route);
    params.set('routeMethod', filter.route.method);
  }
  if (filter.sort) params.set('sort', filter.sort);
  if (filter.limit) params.set('limit', String(filter.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}
