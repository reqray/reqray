/**
 * `GET /api/exceptions` — what threw, grouped.
 *
 * The same error raised three hundred times is one row with a repeat count,
 * not three hundred rows. What the *grouping* costs — stack normalisation,
 * hashing, the frame parser — stays in `@reqray/core`; a client receives the
 * groups already formed.
 */

/** A stack frame as the panel shows it. */
export interface ExceptionFrame {
  /** The original stack line. */
  readonly raw: string;
  readonly file: string | null;
  readonly line: number | null;
  /** The frame belongs to project code — the panel highlights those. */
  readonly project: boolean;
}

/** A group of identical exceptions. */
export interface ExceptionGroup {
  /** Stable group identifier: hash of the normalised stack. */
  readonly id: string;
  /** Exception type: `TypeError`, `ZodError`. */
  readonly type: string;
  readonly message: string;
  /** First project frame: `services/pricing.js:61`. */
  readonly origin: string | null;
  /** Where it happened: `POST /api/orders`. */
  readonly where: string | null;
  readonly count: number;
  /** Time of the last occurrence, epoch ms. */
  readonly lastSeenAt: number;
  /** Ids of the requests it happened in — newest first. */
  readonly requestIds: readonly string[];
  readonly frames: readonly ExceptionFrame[];
  /** Histogram of occurrences over time, for the sparkline. */
  readonly buckets: readonly number[];
  /**
   * A test that reproduced this exception, when one of the requests carried a
   * test name. The most recent one wins — it is the one to run again.
   */
  readonly test: string | null;
}
