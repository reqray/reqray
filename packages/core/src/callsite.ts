/**
 * Stack capture and locating the user's line of code.
 *
 * The most expensive operation in the whole collection path, so it may only be
 * called through `scope.shouldCaptureStack()`: always in development, only for
 * the first occurrences of each fingerprint in production.
 */

import { isAbsolute, relative as pathRelative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedStackOptions } from './config.js';
import { pendingCallsite } from './context.js';
import { globalSlot, TwoGenerationCache } from './state.js';

/** What is known about where a fingerprint is issued from. */
interface CallsiteRecord {
  callsite: Callsite | null;
  /** How many stacks have been captured for this fingerprint. */
  samples: number;
  /**
   * The same SQL has been seen coming from more than one place.
   *
   * Attributing it to either one would be a lie, so nothing is attributed —
   * and the N+1 detector, which needs a single origin, stays silent.
   */
  ambiguous: boolean;
}

/**
 * What has been learned about each fingerprint's origin.
 *
 * Process-wide, not per request: capturing a stack is the single most
 * expensive thing Reqray does, and in production it is paid only while the
 * origin of a fingerprint is still unknown.
 *
 * Bounded, which it was not. Every sibling cache has had a ceiling from the
 * start with a comment about applications that build SQL dynamically; this one
 * has the same key space and had no ceiling at all, so such an application
 * leaked a record per distinct statement, for the life of the process, inside
 * somebody else's production.
 */
const CACHE_LIMIT = 5_000;

const learnedCallsites = globalSlot(
  'callsite.learned',
  () => new TwoGenerationCache<string, CallsiteRecord>(CACHE_LIMIT),
);

import type { Callsite } from './types.js';

/** `at fn (/path/file.ts:12:34)` — frame with a function name. */
const FRAME_WITH_NAME = /^\s*at\s+.*?\s+\((.+):(\d+):(\d+)\)\s*$/;
/** `at /path/file.ts:12:34` — frame without a function name. */
const FRAME_BARE = /^\s*at\s+(.+):(\d+):(\d+)\s*$/;

const NODE_MODULES = /[\\/]node_modules[\\/]/;

/** A position in a file, parsed out of one stack line. */
export interface StackFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Parses one line of a V8 stack.
 *
 * Returns `null` for lines that are not frames (the error header) and for
 * frames without a file (`at <anonymous>`, `eval`).
 */
export function parseStackFrame(line: string): StackFrame | null {
  const match = FRAME_WITH_NAME.exec(line) ?? FRAME_BARE.exec(line);
  if (!match) return null;

  const rawFile = match[1];
  const lineNo = Number(match[2]);
  const columnNo = Number(match[3]);
  if (!rawFile || !Number.isFinite(lineNo) || !Number.isFinite(columnNo)) return null;

  // ESM frames arrive as file:// URLs.
  let file = rawFile;
  if (file.startsWith('file://')) {
    try {
      file = fileURLToPath(file);
    } catch {
      return null;
    }
  }

  return { file, line: lineNo, column: columnNo };
}

/**
 * Checks that a frame points at project code: inside `projectRoot`, not in
 * `node_modules`, not in Node internals and not in the exclusion list.
 */
export function isProjectFrame(file: string, options: ResolvedStackOptions): boolean {
  // Node internals arrive either as `node:internal/...` or as a relative
  // `internal/process/...` — the absolute-path check rejects both.
  if (!isAbsolute(file)) return false;
  if (NODE_MODULES.test(file)) return false;
  for (const fragment of options.exclude) {
    if (file.includes(fragment)) return false;
  }

  const rel = pathRelative(options.projectRoot, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Finds the first frame in the stack that belongs to project code.
 *
 * Kept as a separate pure function so it can be tested against recorded
 * stacks without depending on a real call tree.
 */
export function findProjectFrame(stack: string, options: ResolvedStackOptions): Callsite | null {
  for (const line of stack.split('\n')) {
    const frame = parseStackFrame(line);
    if (!frame || !isProjectFrame(frame.file, options)) continue;

    return {
      file: frame.file,
      relative: pathRelative(options.projectRoot, frame.file).replaceAll('\\', '/'),
      line: frame.line,
      column: frame.column,
    };
  }
  return null;
}

/**
 * Captures a stack and returns the first line inside the project.
 *
 * `Error.stackTraceLimit` is raised for the duration of the capture and
 * restored even on exception. Never throws: a failed capture is `null`, not a
 * broken request.
 *
 * @param boundary the instrumentation's wrapper function. Every frame up to
 * and including it is dropped, so the top frame is user code rather than Reqray
 * itself. The `node_modules` filter cannot be relied on here: when developing
 * against a linked copy of Reqray its sources sit inside the project root, and
 * the first "project code" line would be the interceptor itself.
 */
export function captureCallsite(
  options: ResolvedStackOptions,
  boundary?: (...args: never[]) => unknown,
): Callsite | null {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = options.limit;
  try {
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, boundary ?? captureCallsite);
    return holder.stack ? findProjectFrame(holder.stack, options) : null;
  } catch {
    return null;
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}

/** A callsite handed down from a pool wrapper to the driver wrapper. */
export interface HandedCallsite {
  readonly callsite: Callsite | null;
  /** Registry id of the pool the query went through — for EXPLAIN. */
  readonly clientId?: number;
}

/**
 * Carries a callsite across an asynchronous connection acquire.
 *
 * `pool.query()` resolves a connection asynchronously, so by the time the
 * query reaches the driver the caller's frame has left the stack and there is
 * nothing left to capture. The pool wrapper captures it while the frame is
 * still there and hands it down through this context.
 */
export function withHandedCallsite<T>(handed: HandedCallsite, fn: () => T): T {
  return pendingCallsite().run(handed, fn);
}

/**
 * The callsite handed down by a pool wrapper.
 *
 * `undefined` means the query did not come through a pool, and the driver
 * wrapper should capture a stack of its own.
 */
export function handedCallsite(): HandedCallsite | undefined {
  return pendingCallsite().getStore();
}

/**
 * The callsite for a span, capturing a stack only when it is still needed.
 *
 * This is the single place the capture policy lives, so every instrumentation
 * gets the same behaviour:
 *
 * 1. a callsite handed down by a pool wrapper wins — it is the only one taken
 *    while the caller's frame was still on the stack;
 * 2. in development a stack is captured every time, which keeps full fidelity;
 * 3. in production it is captured only until the origin of that fingerprint is
 *    known, and later spans reuse what was learned. Capturing a stack costs
 *    roughly a third of the application's throughput, so paying it per query
 *    is not an option;
 * 4. if the same SQL turns out to come from more than one place, nothing is
 *    attributed at all: a wrong line of code is worse than none, and the N+1
 *    detector needs a single origin anyway.
 *
 * Never throws — a failed capture is `null`, not a broken request.
 */
export function resolveCallsite(
  scope: {
    shouldCaptureStack(fingerprint?: string): boolean;
    options: { stack: ResolvedStackOptions };
  },
  fingerprint: string,
  boundary?: (...args: never[]) => unknown,
): Callsite | null {
  try {
    const handed = handedCallsite();
    if (handed) return handed.callsite;

    // In development every stack is captured, so each span carries its own
    // true origin and the detector compares them per request. Learning would
    // only add a way to be wrong: one unlucky pair of call sites anywhere in
    // the process would permanently mute a whole query shape.
    // Without an explicit boundary this function is the boundary, otherwise
    // the top frame would be Reqray's own code.
    const from = boundary ?? resolveCallsite;

    if (scope.options.stack.maxPerFingerprint === Number.POSITIVE_INFINITY) {
      return captureCallsite(scope.options.stack, from);
    }

    const learned = learnedCallsites();
    const known = learned.get(fingerprint);
    if (known?.ambiguous) return null;

    if (!scope.shouldCaptureStack(fingerprint)) return known?.callsite ?? null;

    const captured = captureCallsite(scope.options.stack, from);
    remember(learned, fingerprint, known, captured);
    return learned.get(fingerprint)?.ambiguous ? null : captured;
  } catch {
    return null;
  }
}

function remember(
  learned: TwoGenerationCache<string, CallsiteRecord>,
  fingerprint: string,
  known: CallsiteRecord | undefined,
  captured: Callsite | null,
): void {
  if (!known) {
    learned.set(fingerprint, { callsite: captured, samples: 1, ambiguous: false });
    return;
  }

  known.samples++;
  if (!captured) return;
  if (!known.callsite) {
    known.callsite = captured;
    return;
  }
  if (known.callsite.file !== captured.file || known.callsite.line !== captured.line) {
    known.callsite = null;
    known.ambiguous = true;
  }
}

/**
 * How many stacks have been captured for a fingerprint so far.
 *
 * Asked by `RequestScope.shouldCaptureStack`, which decides whether to pay for
 * another. The count lives here because the map does.
 */
export function samplesFor(fingerprint: string): number {
  return learnedCallsites().get(fingerprint)?.samples ?? 0;
}

/** Forgets what was learned about fingerprint origins. Needed by tests. */
export function resetLearnedCallsites(): void {
  learnedCallsites().clear();
}
