/**
 * What a request moved.
 *
 * The honest answer to "where is the memory going". Node has no per-request
 * memory to report: `process.memoryUsage()` around a request, under
 * concurrency and a garbage collector that runs when it likes, is noise and
 * occasionally negative. What *is* knowable is what the request pulled out of
 * the database and pushed back to the client — which is what the spike was
 * made of, and which points at a line of code rather than at a graph.
 */

import type { RecordedBody, RequestWeight, Span } from './types.js';

/**
 * The size of a body, as the two sources know it.
 *
 * `content-length` is what the client was told and is preferred; the recorded
 * body's own size answers when the header is missing — a chunked response, a
 * framework that streams. Neither is a guess: when both are absent the answer
 * is `null`, and every screen shows nothing rather than a zero.
 */
function bytesOf(
  headers: Readonly<Record<string, string>>,
  body: RecordedBody | null,
): number | null {
  const declared = Number(headers['content-length']);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  // A body recorded before sizes were kept has no answer to give, and saying
  // zero would put a route that returns megabytes at the bottom of the list.
  return body && Number.isFinite(body.bytes) ? body.bytes : null;
}

/** Rows across every query that reported a count, and the largest of them. */
function rowsOf(spans: readonly Span[]): { rows: number; biggestRows: number } {
  let rows = 0;
  let biggestRows = 0;
  for (const span of spans) {
    if (span.kind !== 'db' || span.rowCount === null) continue;
    rows += span.rowCount;
    if (span.rowCount > biggestRows) biggestRows = span.rowCount;
  }
  return { rows, biggestRows };
}

/** What the request moved, in the numbers the panel and the detector read. */
export function weightOf(input: {
  readonly spans: readonly Span[];
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly requestBody: RecordedBody | null;
  readonly responseBody: RecordedBody | null;
}): RequestWeight {
  return {
    bytesIn: bytesOf(input.requestHeaders, input.requestBody),
    bytesOut: bytesOf(input.responseHeaders, input.responseBody),
    ...rowsOf(input.spans),
  };
}

/**
 * The query a large response most likely came out of.
 *
 * The one that returned the most rows, when the driver says how many. When
 * none of them does — plenty of drivers do not — the answer is the query
 * itself if there was only one, and nothing at all if there were several:
 * picking the slowest and calling it the source would be a guess wearing
 * evidence's clothes.
 */
export function biggestQuery(spans: readonly Span[]): Extract<Span, { kind: 'db' }> | null {
  const queries = spans.filter((span): span is Extract<Span, { kind: 'db' }> => span.kind === 'db');
  const counted = queries.filter((span) => span.rowCount !== null);
  if (counted.length === 0) return queries.length === 1 ? (queries[0] ?? null) : null;

  let found = counted[0] ?? null;
  for (const span of counted) {
    if (found && (span.rowCount ?? 0) > (found.rowCount ?? 0)) found = span;
  }
  return found;
}
