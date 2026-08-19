/**
 * Grouping of exceptions by normalised stack.
 *
 * The same error raised three hundred times is one row in the panel with a
 * repeat count, not three hundred rows. Normalisation drops everything that
 * varies between calls and keeps the shape of the stack.
 */

import { createHash } from 'node:crypto';
import { isProjectFrame, parseStackFrame } from '../callsite.js';
import type { ResolvedStackOptions } from '../config.js';
import type { RecordedRequest, SpanError } from '../types.js';

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

/** Buckets in the sparkline — as many as there are bars in the mockup. */
const BUCKET_COUNT = 12;

/** Frames taken into the fingerprint: deeper than this stacks stop differing. */
const SIGNIFICANT_FRAMES = 8;

function framesOf(error: SpanError, options: ResolvedStackOptions): ExceptionFrame[] {
  if (!error.stack) return [];

  const frames: ExceptionFrame[] = [];
  for (const line of error.stack.split('\n')) {
    if (!line.trim().startsWith('at ')) continue;
    const parsed = parseStackFrame(line);
    frames.push({
      raw: line.trim(),
      file: parsed?.file ?? null,
      line: parsed?.line ?? null,
      project: parsed ? isProjectFrame(parsed.file, options) : false,
    });
  }
  return frames;
}

/**
 * Stack fingerprint.
 *
 * It takes the exception type and the positions of the first frames — without
 * columns and without the message: the message usually carries varying values
 * (`id 8812`), which would split identical errors into separate groups.
 */
function fingerprintStack(error: SpanError, frames: readonly ExceptionFrame[]): string {
  const parts = [error.name];
  for (const frame of frames.slice(0, SIGNIFICANT_FRAMES)) {
    parts.push(frame.file ? `${frame.file}:${frame.line ?? 0}` : frame.raw);
  }
  // There may be no stack at all — then the message is the only thing that
  // tells errors apart.
  if (frames.length === 0) parts.push(error.message);

  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

interface Accumulator {
  readonly id: string;
  readonly type: string;
  message: string;
  readonly frames: ExceptionFrame[];
  readonly origin: string | null;
  where: string | null;
  count: number;
  lastSeenAt: number;
  readonly requestIds: string[];
  readonly times: number[];
  test: string | null;
}

function originOf(frames: readonly ExceptionFrame[], options: ResolvedStackOptions): string | null {
  const projectFrame = frames.find((frame) => frame.project && frame.file);
  if (!projectFrame?.file) return null;
  const relative = projectFrame.file.startsWith(options.projectRoot)
    ? projectFrame.file.slice(options.projectRoot.length + 1)
    : projectFrame.file;
  return `${relative}:${projectFrame.line ?? 0}`;
}

function bucketize(times: readonly number[], now: number, windowMs: number): number[] {
  const buckets = new Array<number>(BUCKET_COUNT).fill(0);
  if (windowMs <= 0) return buckets;

  const from = now - windowMs;
  for (const time of times) {
    const position = Math.floor(((time - from) / windowMs) * BUCKET_COUNT);
    const index = Math.min(BUCKET_COUNT - 1, Math.max(0, position));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

/**
 * Builds exception groups from recorded requests.
 *
 * Requests are expected newest first, the order the store returns them in.
 * Groups come back by descending occurrence count.
 */
export function groupExceptions(
  requests: readonly RecordedRequest[],
  options: ResolvedStackOptions,
  now = Date.now(),
): ExceptionGroup[] {
  const groups = new Map<string, Accumulator>();
  let oldest = now;

  for (const request of requests) {
    if (request.startedAt < oldest) oldest = request.startedAt;

    const error = request.error;
    if (!error) continue;

    const frames = framesOf(error, options);
    const id = fingerprintStack(error, frames);

    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        type: error.name,
        message: error.message,
        frames,
        origin: originOf(frames, options),
        where: `${request.method} ${request.path}`,
        count: 0,
        lastSeenAt: request.startedAt,
        requestIds: [],
        times: [],
        test: null,
      };
      groups.set(id, group);
    }

    group.count++;
    group.times.push(request.startedAt);
    if (request.startedAt > group.lastSeenAt) {
      group.lastSeenAt = request.startedAt;
      group.message = error.message;
      group.where = `${request.method} ${request.path}`;
    }
    // Records arrive newest first, so the first test name seen is the latest.
    if (group.test === null && request.test !== null) group.test = request.test;
    // The request list is capped: the panel needs the latest ones, not all.
    if (group.requestIds.length < 50) group.requestIds.push(request.id);
  }

  const windowMs = Math.max(1, now - oldest);

  return [...groups.values()]
    .map(
      (group): ExceptionGroup => ({
        id: group.id,
        type: group.type,
        message: group.message,
        origin: group.origin,
        where: group.where,
        count: group.count,
        lastSeenAt: group.lastSeenAt,
        requestIds: group.requestIds,
        frames: group.frames,
        buckets: bucketize(group.times, now, windowMs),
        test: group.test,
      }),
    )
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt);
}
