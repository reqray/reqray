/**
 * Loupe state shared across the whole process.
 *
 * `@loupe/core` is built as both ESM and CJS. Both builds can end up loaded in
 * one application at once: the adapter came in through `import`, while a
 * loader hook or a third-party package came in through `require`. That gives
 * two sets of module-level variables, and this is not cosmetic: two separate
 * `AsyncLocalStorage` instances mean instrumentation never sees the scope the
 * adapter created, and no spans are recorded at all.
 *
 * So everything that must be single per process lives on `globalThis` under a
 * symbol from the global registry — the same one for both copies.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DiagnosticEntry } from './diagnostics.js';
import type { LoupeLogSink } from './logger.js';
import type { RequestScope } from './scope.js';
import type { SqlOperation } from './sql.js';
import type { Callsite, RecordedRequest } from './types.js';

/** Version in the key: an incompatible change of shape must not break silently. */
const STATE_KEY = Symbol.for('loupe.state.v1');

/** Everything that has to be single per process. */
export interface LoupeGlobalState {
  /** Current request context. */
  readonly storage: AsyncLocalStorage<RequestScope>;
  /** Instrumentation report to print at startup. */
  readonly diagnostics: DiagnosticEntry[];
  /** Keys of warnings already issued. */
  readonly warned: Set<string>;
  /** Detectors that disabled themselves after an error. */
  readonly disabledDetectors: Set<string>;
  /** SQL fingerprint cache keyed by the source string. */
  readonly fingerprints: Map<string, string>;
  /** Statement type cache. */
  readonly operations: Map<string, SqlOperation>;
  /**
   * Pending replays: a request with such a marker stays out of the main list,
   * its record goes to whoever started the replay.
   */
  readonly replayWaiters: Map<string, (request: RecordedRequest) => void>;
  /**
   * Callsite handed from a pool wrapper down to the driver wrapper.
   *
   * Absent outside a pooled query — that is what tells the driver wrapper to
   * capture a stack of its own.
   */
  readonly pendingCallsite: AsyncLocalStorage<{
    readonly callsite: Callsite | null;
    readonly clientId?: number;
  }>;
  /**
   * What has been learned about each SQL fingerprint's origin.
   *
   * Process-wide, not per request: capturing a stack is the single most
   * expensive thing Loupe does, and in production it is paid only while the
   * origin of a fingerprint is still unknown.
   */
  readonly callsites: Map<string, CallsiteRecord>;
  /** The startup report has already been printed. */
  printed: boolean;
  /** Where Loupe writes its own messages. `null` — the default sink. */
  sink: LoupeLogSink | null;
  /**
   * A framework adapter has been initialized.
   *
   * The standalone mode in `@loupe/register` checks this to stand down: an
   * adapter records the same requests with full fidelity.
   */
  adapterActive: boolean;
  /**
   * Live database pools and clients, able to run EXPLAIN — weakly referenced,
   * so the registry never keeps a closed pool alive. See `explain-targets.ts`.
   */
  readonly explainTargets: Map<number, WeakRef<object>>;
  /** Id source for {@link explainTargets}. */
  explainTargetSeq: number;
}

/** What is known about where a fingerprint is issued from. */
export interface CallsiteRecord {
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

type StateHolder = typeof globalThis & { [STATE_KEY]?: LoupeGlobalState };

function create(): LoupeGlobalState {
  return {
    storage: new AsyncLocalStorage<RequestScope>(),
    diagnostics: [],
    warned: new Set<string>(),
    disabledDetectors: new Set<string>(),
    fingerprints: new Map<string, string>(),
    operations: new Map<string, SqlOperation>(),
    replayWaiters: new Map<string, (request: RecordedRequest) => void>(),
    pendingCallsite: new AsyncLocalStorage<{
      readonly callsite: Callsite | null;
      readonly clientId?: number;
    }>(),
    callsites: new Map<string, CallsiteRecord>(),
    printed: false,
    sink: null,
    adapterActive: false,
    explainTargets: new Map<number, WeakRef<object>>(),
    explainTargetSeq: 0,
  };
}

/** Shared process state. Created on first access. */
export function loupeState(): LoupeGlobalState {
  const holder = globalThis as StateHolder;
  const existing = holder[STATE_KEY];
  if (existing) return existing;

  const fresh = create();
  holder[STATE_KEY] = fresh;
  return fresh;
}
