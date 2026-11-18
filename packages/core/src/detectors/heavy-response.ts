/**
 * Heavy-response detector: this endpoint returned far more than it should.
 *
 * The mistake it names is a missing limit — a list route that grew with the
 * table behind it, an export that was never paginated, a serializer that
 * includes every relation because once it was convenient. It is the ordinary
 * cause of a memory graph that climbs under load, and it is invisible in a
 * waterfall: every query is fast, and the megabytes are in the tail.
 *
 * Two things it deliberately does not do.
 *
 * It does not report a cost in milliseconds. What a large response costs is
 * bytes: memory in this process, bandwidth, and time on somebody's phone that
 * this process never measured. Putting a made-up figure in `costMs` so that
 * the finding sorts higher would be inventing the one number the panel treats
 * as measured.
 *
 * And it does not fire on files. A twelve-megabyte PDF is a document; a
 * twelve-megabyte JSON document is a forgotten `LIMIT`. The content type is
 * the only thing that tells them apart, and guessing wrong here means telling
 * somebody their download is a bug.
 */

import type { Finding } from '../types.js';
import { biggestQuery } from '../weight.js';
import type { Detector, FinishedRequest } from './types.js';

export interface HeavyResponseOptions {
  /** Response size above which the endpoint is doing something wrong. */
  readonly maxBytes: number;
}

/**
 * Content types that are documents rather than answers.
 *
 * Matched on what a response *is*, not on what it is not: an unknown type is
 * left alone. A detector that fires on everything it does not recognise is a
 * detector that gets switched off.
 */
const STRUCTURED = /^(application\/(json|.*\+json|xml|.*\+xml|javascript)|text\/)/i;

/** What the panel says to do about it, in the order worth trying. */
const HINT =
  'Paginate it, or return only the fields the caller uses. A response this size is memory in this process, bandwidth, and a wait on the device at the other end.';

/** `12 MB`, `840 KB` — the size as the finding's title says it. */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export const heavyResponse: Detector<HeavyResponseOptions> = {
  id: 'heavy_response',

  defaultOptions: {
    // A megabyte of structured text is somewhere upwards of a thousand
    // objects. Under it, a response is within what a client absorbs without
    // anybody noticing; over it, somebody forgot a limit — and the threshold
    // has to be high enough that a normal page of results never reaches it,
    // because the first false positive is the one that gets the detector
    // turned off.
    maxBytes: 1024 * 1024,
  },

  run(scope, options, request: FinishedRequest): Finding[] {
    const bytes = request.bytesOut;
    if (bytes === null || bytes <= options.maxBytes) return [];

    const contentType = request.contentType;
    // Unknown type: no finding. A stream of bytes nobody labelled might be an
    // export somebody meant to write.
    if (!contentType || !STRUCTURED.test(contentType)) return [];

    const spans = scope.spans;
    const biggest = biggestQuery(spans);
    let rows = 0;
    for (const span of spans) {
      if (span.kind === 'db' && span.rowCount !== null) rows += span.rowCount;
    }

    const from = rows > 0 ? ` from ${rows.toLocaleString('en-US')} rows` : '';
    return [
      {
        detector: 'heavy_response',
        severity: 'warn',
        title: `${size(bytes)} response${from}`,
        // Bytes, not milliseconds — see the note at the top of this file.
        costMs: 0,
        callsite: biggest?.callsite ?? null,
        evidence: {
          kind: 'heavy_response',
          bytes,
          rows,
          sample: biggest ? biggest.sql.replace(/\s+/g, ' ').trim() : null,
          contentType,
          spanIds: biggest ? [biggest.id] : [],
        },
        hint: HINT,
      },
    ];
  },
};
