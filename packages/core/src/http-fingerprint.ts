/**
 * Fingerprint of an outgoing HTTP call.
 *
 * The counterpart of `fingerprintSql` for the sequential-HTTP detector: calls
 * to `/users/1/orders` and `/users/2/orders` must collapse into one shape,
 * otherwise a loop over ids is invisible. Variable path segments — numbers,
 * uuids, long hex — become `:id`; the query string is dropped entirely
 * (its values are almost always the varying part).
 */

import { globalSlot, TwoGenerationCache } from './state.js';

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{8,}$/i;

function normalizeSegment(segment: string): string {
  if (NUMERIC.test(segment) || UUID.test(segment) || HEX.test(segment)) return ':id';
  return segment;
}

const CACHE_LIMIT = 5_000;

/**
 * Process-wide cache: the same URL string is fingerprinted once.
 *
 * In the shared registry rather than in a module variable, for the same reason
 * everything else is: this is read on every outgoing call, and a dual ESM/CJS
 * load would otherwise give two caches with the same ceiling and half the hits
 * each.
 */
const cache = globalSlot(
  'http.fingerprints',
  () => new TwoGenerationCache<string, string>(CACHE_LIMIT),
);

/**
 * Reduces an outgoing call to its shape: `GET api.example.com/users/:id/orders`.
 *
 * Never throws; an unparseable URL is used as-is.
 */
export function fingerprintHttp(method: string, url: string): string {
  const key = `${method} ${url}`;
  const fingerprints = cache();
  const cached = fingerprints.get(key);
  if (cached) return cached;

  let fingerprint: string;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split('/').map(normalizeSegment).join('/');
    fingerprint = `${method.toUpperCase()} ${parsed.host}${path}`;
  } catch {
    fingerprint = `${method.toUpperCase()} ${url}`;
  }

  fingerprints.set(key, fingerprint);
  return fingerprint;
}

/** Clears the fingerprint cache. Needed by tests. */
export function clearHttpFingerprints(): void {
  cache().clear();
}
