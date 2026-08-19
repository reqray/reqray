/**
 * Loupe options and their resolution into a fully populated form.
 *
 * Everything environment-dependent (`NODE_ENV`, `process.cwd()`) is read
 * exactly once, in {@link resolveOptions}. The hot path only ever sees
 * {@link ResolvedOptions}.
 */

import type { DuplicateCacheOptions, DuplicateHttpOptions } from './detectors/duplicates.js';
import { duplicateCache, duplicateHttp } from './detectors/duplicates.js';
import type { NPlusOneOptions } from './detectors/n-plus-one.js';
import { nPlusOne } from './detectors/n-plus-one.js';
import type { SequentialHttpOptions } from './detectors/sequential-http.js';
import { sequentialHttp } from './detectors/sequential-http.js';
import type { SlowBudgetOptions } from './detectors/slow-budget.js';
import { slowBudget } from './detectors/slow-budget.js';
import type { PanelGate } from './panel.js';

/** Operating mode. Affects stack capture and the share of retained requests. */
export type LoupeMode = 'development' | 'production';

/**
 * Detector configuration.
 *
 * Each detector can be retuned by threshold or disabled entirely:
 * `loupe({ detect: { nPlusOne: { threshold: 10 } } })`.
 */
export interface DetectOptions {
  /** `false` disables the N+1 detector completely. */
  readonly nPlusOne?: Partial<NPlusOneOptions> | false;
  /** `false` disables the sequential-HTTP detector completely. */
  readonly sequentialHttp?: Partial<SequentialHttpOptions> | false;
  /** Identical outbound reads in one request. */
  readonly duplicateHttp?: Partial<DuplicateHttpOptions> | false;
  /** The same cache key read more than once in one request. */
  readonly duplicateCache?: Partial<DuplicateCacheOptions> | false;
  /** Wall-time budget for a request; `false` turns the check off. */
  readonly slowBudget?: Partial<SlowBudgetOptions> | false;
}

/** @see DetectOptions */
export interface ResolvedDetectOptions {
  /** `null` — detector disabled. */
  readonly nPlusOne: NPlusOneOptions | null;
  /** `null` — detector disabled. */
  readonly sequentialHttp: SequentialHttpOptions | null;
  /** `null` — detector disabled. */
  readonly duplicateHttp: DuplicateHttpOptions | null;
  /** `null` — detector disabled. */
  readonly duplicateCache: DuplicateCacheOptions | null;
  /** `null` — detector disabled. */
  readonly slowBudget: SlowBudgetOptions | null;
}

/** Masking of sensitive data. Runs before the buffer write. */
export interface RedactOptions {
  /**
   * Headers whose values are replaced.
   * Extends the default list rather than replacing it.
   */
  readonly headers?: readonly string[];
  /** Request and response body fields whose values are replaced. */
  readonly body?: readonly string[];
  /** What to replace with. */
  readonly replaceWith?: string;
  /** Values are not walked deeper than this nesting level. */
  readonly maxDepth?: number;
  /** Longer strings are truncated — bodies must not blow up the buffer. */
  readonly maxStringLength?: number;
  /** Longer arrays are truncated. */
  readonly maxArrayLength?: number;
  /**
   * Cap on the serialized text of one stored body, in UTF-16 units.
   * Bodies are stored as text (see `RecordedBody`), and this bounds what a
   * single record can weigh in the buffer.
   */
  readonly maxBodyLength?: number;
}

/** Stack capture used to bind a span to a line of code. */
export interface StackCaptureOptions {
  /** How far `Error.stackTraceLimit` is raised for the duration of a capture. */
  readonly limit?: number;
  /**
   * How many times to capture a stack per fingerprint in `production` mode.
   * In `development` the stack is always captured.
   */
  readonly maxPerFingerprint?: number;
  /** Project root: frames outside it are not user code. */
  readonly projectRoot?: string;
  /** Extra path fragments that do not count as project code. */
  readonly exclude?: readonly string[];
}

/**
 * Sampling: which share of requests is retained in full.
 *
 * The decision is made after the request finishes, so anything interesting
 * (errors, slow requests, requests with findings) can be retained
 * unconditionally.
 */
export interface SamplingOptions {
  /** Base share of ordinary requests: 1 — all, 0.01 — every hundredth. */
  readonly rate?: number;
  /** Requests slower than this are always retained. `0` — disabled. */
  readonly slowMs?: number;
  /** Retain every request with an error or a 5xx status. */
  readonly alwaysOnError?: boolean;
  /** Retain every request the detectors found something in. */
  readonly alwaysOnFinding?: boolean;
}

/** @see SamplingOptions */
export interface ResolvedSamplingOptions {
  readonly rate: number;
  readonly slowMs: number;
  readonly alwaysOnError: boolean;
  readonly alwaysOnFinding: boolean;
}

/** Panel. `false` in the options disables mounting it entirely. */
export interface PanelOptions {
  /** Mount path inside the application. */
  readonly path?: string;
  /**
   * Who is allowed into the panel. Required everywhere except local
   * development — otherwise the application fails at startup.
   */
  readonly gate?: PanelGate;
}

/** @see PanelOptions */
export interface ResolvedPanelOptions {
  readonly path: string;
  readonly gate: PanelGate | null;
}

/** Public Loupe options. */
export interface LoupeOptions {
  /** Defaults to `NODE_ENV !== 'production'`. */
  readonly enabled?: boolean;
  /** Defaults to being derived from `NODE_ENV`. */
  readonly mode?: LoupeMode;
  /** Size of the request ring buffer. */
  readonly bufferSize?: number;
  /** Hard cap on spans per request: protection against pathological requests. */
  readonly maxSpansPerRequest?: number;
  readonly redact?: RedactOptions;
  readonly stack?: StackCaptureOptions;
  readonly detect?: DetectOptions;
  readonly sampling?: SamplingOptions;
  readonly panel?: PanelOptions | false;
  /**
   * Allow replaying requests from the panel.
   *
   * Local development only by default. Replaying a request in production
   * means charging a card twice and sending an email twice, so outside
   * development it is opt-in and logs a warning.
   */
  readonly replay?: boolean;
  /**
   * Allow running EXPLAIN on recorded queries from the panel.
   *
   * Local development only by default. Plain EXPLAIN executes nothing, but it
   * is still a query against the live database — outside development it is
   * opt-in.
   */
  readonly explain?: boolean;
  /**
   * Allow `git blame` on the frames of an exception, from the panel.
   *
   * Local development only by default: it runs `git` on the machine the panel
   * runs on, and outside development that machine is a server.
   */
  readonly blame?: boolean;
  /**
   * Capture `console.*` lines written during request handling into the
   * request's record. Terminal output is never altered; `false` turns the
   * capture off entirely. pino and winston write past `console` and are not
   * captured.
   */
  readonly logs?: boolean;
  /**
   * Collect SQL parameter values into spans.
   *
   * `false` in every mode, including development: positional values carry no
   * field names, so name-based masking cannot protect them — collecting is a
   * deliberate, explicit decision. Values are stored as strings, truncated by
   * `redact.maxStringLength`, and are never substituted into EXPLAIN.
   */
  readonly collectSqlValues?: boolean;
}

/** Options after resolution: nothing optional is left. */
export interface ResolvedOptions {
  readonly enabled: boolean;
  readonly mode: LoupeMode;
  /**
   * The process runs locally: `NODE_ENV` is `development`, `test` or unset.
   * Staging is not included — which is exactly why it requires a gate.
   */
  readonly isLocalDevelopment: boolean;
  readonly bufferSize: number;
  readonly maxSpansPerRequest: number;
  readonly redact: ResolvedRedactOptions;
  readonly stack: ResolvedStackOptions;
  readonly detect: ResolvedDetectOptions;
  readonly sampling: ResolvedSamplingOptions;
  /** `null` — panel disabled. */
  readonly panel: ResolvedPanelOptions | null;
  readonly replay: boolean;
  readonly explain: boolean;
  readonly blame: boolean;
  readonly logs: boolean;
  readonly collectSqlValues: boolean;
}

/** @see RedactOptions */
export interface ResolvedRedactOptions {
  /** Normalized patterns: lower case, no `-` or `_`. */
  readonly headers: readonly string[];
  /** Normalized patterns: lower case, no `-` or `_`. */
  readonly body: readonly string[];
  readonly replaceWith: string;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxBodyLength: number;
}

/** @see StackCaptureOptions */
export interface ResolvedStackOptions {
  readonly limit: number;
  readonly maxPerFingerprint: number;
  readonly projectRoot: string;
  readonly exclude: readonly string[];
}

/** Headers that are always masked. */
export const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
];

/** Body fields that are always masked. */
export const DEFAULT_REDACTED_BODY_FIELDS: readonly string[] = [
  'password',
  'token',
  'secret',
  'cardNumber',
];

/**
 * Reduces a field name to the form masking patterns are compared against:
 * lower case, no separators. `X-Api-Token` and `api_token` both give `apitoken`.
 */
export function normalizeFieldName(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    // '-' | '_' | ' ' | '.'
    if (ch === 45 || ch === 95 || ch === 32 || ch === 46) continue;
    out += name[i]?.toLowerCase() ?? '';
  }
  return out;
}

function normalizePatterns(defaults: readonly string[], extra: readonly string[] | undefined) {
  const seen = new Set<string>();
  for (const p of defaults) seen.add(normalizeFieldName(p));
  if (extra) for (const p of extra) seen.add(normalizeFieldName(p));
  return Object.freeze([...seen]);
}

/**
 * Layers user thresholds over the defaults.
 *
 * `undefined` in an override is ignored — otherwise a call from untyped JS
 * could wipe a default and leave the detector without a threshold.
 */
function resolveDetector<T extends object>(
  defaults: T,
  override: Partial<T> | false | undefined,
): T | null {
  if (override === false) return null;
  const merged = { ...defaults } as Record<string, unknown>;
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return Object.freeze(merged) as T;
}

function detectMode(explicit: LoupeMode | undefined): LoupeMode {
  if (explicit) return explicit;
  return process.env['NODE_ENV'] === 'production' ? 'production' : 'development';
}

/**
 * Local development means an explicit `development`/`test` or an unset
 * `NODE_ENV` (the same reading Express uses). `staging` and any custom value
 * are not local: the process may be reachable from outside.
 */
function detectLocalDevelopment(): boolean {
  const env = process.env['NODE_ENV'];
  return env === undefined || env === '' || env === 'development' || env === 'test';
}

/**
 * Expands user options into their full form.
 *
 * Called once at initialization: the hot path reads nothing from
 * `process.env` and normalizes nothing.
 */
export function resolveOptions(options: LoupeOptions = {}): ResolvedOptions {
  const mode = detectMode(options.mode);
  const redact = options.redact ?? {};
  const stack = options.stack ?? {};

  const sampling = options.sampling ?? {};
  const panel = options.panel;
  const isLocalDevelopment = detectLocalDevelopment();

  return Object.freeze({
    enabled: options.enabled ?? process.env['NODE_ENV'] !== 'production',
    mode,
    isLocalDevelopment,
    bufferSize: options.bufferSize ?? 500,
    maxSpansPerRequest: options.maxSpansPerRequest ?? 2000,
    redact: Object.freeze({
      headers: normalizePatterns(DEFAULT_REDACTED_HEADERS, redact.headers),
      body: normalizePatterns(DEFAULT_REDACTED_BODY_FIELDS, redact.body),
      replaceWith: redact.replaceWith ?? '[redacted]',
      maxDepth: redact.maxDepth ?? 8,
      maxStringLength: redact.maxStringLength ?? 4096,
      maxArrayLength: redact.maxArrayLength ?? 100,
      maxBodyLength: redact.maxBodyLength ?? 65536,
    }),
    stack: Object.freeze({
      limit: stack.limit ?? 12,
      // In development the stack is always captured; in production only for
      // the first occurrences of each fingerprint.
      maxPerFingerprint:
        stack.maxPerFingerprint ?? (mode === 'production' ? 3 : Number.POSITIVE_INFINITY),
      projectRoot: stack.projectRoot ?? process.cwd(),
      exclude: Object.freeze(stack.exclude ? [...stack.exclude] : []),
    }),
    detect: Object.freeze({
      nPlusOne: resolveDetector(nPlusOne.defaultOptions, options.detect?.nPlusOne),
      sequentialHttp: resolveDetector(
        sequentialHttp.defaultOptions,
        options.detect?.sequentialHttp,
      ),
      duplicateHttp: resolveDetector(duplicateHttp.defaultOptions, options.detect?.duplicateHttp),
      duplicateCache: resolveDetector(
        duplicateCache.defaultOptions,
        options.detect?.duplicateCache,
      ),
      slowBudget: resolveDetector(slowBudget.defaultOptions, options.detect?.slowBudget),
    }),
    sampling: Object.freeze({
      // Locally everything is visible; in production the stream is cut back —
      // otherwise the buffer and the collector drown, and you only ever need
      // one specific request to dig into anyway.
      rate: sampling.rate ?? (mode === 'production' ? 0.01 : 1),
      slowMs: sampling.slowMs ?? (mode === 'production' ? 500 : 0),
      alwaysOnError: sampling.alwaysOnError ?? true,
      // A request with a finding is exactly what Loupe is installed for — and
      // locally everything is retained anyway. In production the finding can
      // only become a retention reason if the detectors run on every request,
      // so there the default is off: expensive N+1s reach the sample as slow
      // requests instead.
      alwaysOnFinding: sampling.alwaysOnFinding ?? mode !== 'production',
    }),
    replay: options.replay ?? isLocalDevelopment,
    explain: options.explain ?? isLocalDevelopment,
    blame: options.blame ?? isLocalDevelopment,
    logs: options.logs ?? true,
    collectSqlValues: options.collectSqlValues ?? false,
    panel:
      panel === false
        ? null
        : Object.freeze({
            path: panel?.path ?? '/_loupe',
            gate: panel?.gate ?? null,
          }),
  });
}
