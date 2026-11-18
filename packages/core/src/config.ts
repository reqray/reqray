/**
 * Reqray options and their resolution into a fully populated form.
 *
 * Everything environment-dependent (`NODE_ENV`, `process.cwd()`) is read
 * exactly once, in {@link resolveOptions}. The hot path only ever sees
 * {@link ResolvedOptions}.
 */

import type { ReqrayMode, SamplingSettings, StackSettings } from '@reqray/protocol';
import {
  type DetectorKey,
  type DetectorOptions,
  detectorKeys,
  detectors,
} from './detectors/registry.js';
import { warnOnce } from './logger.js';
import type { RetentionPolicy } from './retention.js';
import type { PanelGate } from './types.js';

/** Operating mode. Affects stack capture and the share of retained requests. */
export type { ReqrayMode };

/**
 * Detector configuration.
 *
 * Each detector can be retuned by threshold or disabled entirely:
 * `reqray({ detect: { nPlusOne: { threshold: 10 } } })`.
 *
 * Derived from the registry rather than listed again: two lists of detectors
 * cannot be kept in agreement by anything but attention, and the one that
 * drifts is the one nothing runs.
 */
export type DetectOptions = {
  readonly [K in DetectorKey]?: Partial<DetectorOptions<K>> | false;
};

/** @see DetectOptions — `null` for a detector somebody turned off. */
export type ResolvedDetectOptions = {
  readonly [K in DetectorKey]: DetectorOptions<K> | null;
};

/** Masking of sensitive data. Runs before the buffer write. */
export interface RedactOptions {
  /**
   * Headers whose values are replaced.
   * Extends the default list rather than replacing it.
   */
  readonly headers?: readonly string[];
  /** Request and response body fields whose values are replaced. */
  readonly body?: readonly string[];
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

/** @see SamplingOptions — the protocol's shape, so the panel cannot drift. */
export type ResolvedSamplingOptions = SamplingSettings;

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

export interface ReqrayOptions {
  /** Defaults to `NODE_ENV !== 'production'`. */
  readonly enabled?: boolean;
  /** Defaults to being derived from `NODE_ENV`. */
  readonly mode?: ReqrayMode;
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
   * Sample the stack, so a stretch of unaccounted time can name the function
   * that burned it.
   *
   * Local development only by default, and gated for the same reason as
   * replay: sampling is cheap — a few microseconds a request — but a profile
   * names the application's own functions and files, which is a decision
   * somebody makes rather than a default somebody discovers.
   */
  readonly profile?: boolean;
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
   * Watch the event loop, and record how far behind it was on each request.
   *
   * On by default: it is one libuv histogram for the process, sampled on a
   * timer rather than per request, and it is the only way to tell a slow
   * route from a process that could not get scheduled. `false` turns it off
   * and every screen that shows loop delay simply has nothing to show.
   */
  readonly hostMetrics?: boolean;
  /**
   * Collect SQL parameter values into spans.
   *
   * `false` in every mode, including development: positional values carry no
   * field names, so name-based masking cannot protect them — collecting is a
   * deliberate, explicit decision. Values are stored as strings, truncated by
   * `redact.maxStringLength`, and are never substituted into EXPLAIN.
   */
  readonly collectSqlValues?: boolean;
  /**
   * How long anything kept is kept for.
   *
   * The same object the stores are given, so the number the panel shows is
   * the number they evict by. Without one, each store keeps to its own
   * limits and the panel reports them as fixed.
   */
  readonly retention?: RetentionPolicy;
  /**
   * The request log on disk, when there is one.
   *
   * Only so the panel can report what it holds — nothing reads the log back.
   */
  readonly requestLog?: RequestLogInfo;
}

/** What the panel can say about a log on disk without reading it. */
export interface RequestLogInfo {
  readonly dir: string;
  stats(): {
    readonly files: number;
    readonly bytes: number;
    readonly oldestAt: number | null;
    readonly written: number;
    readonly dropped: number;
    readonly writing: boolean;
  };
}

/**
 * The settings the recording path is allowed to see.
 *
 * A `RequestScope` carries these and nothing else: the panel's gate and the
 * retention policy's file handles have no business being reachable from inside
 * an instrumentation wrapper. A type boundary, not a copy — the same frozen
 * object is passed.
 */
export interface RecordingOptions {
  readonly enabled: boolean;
  readonly mode: ReqrayMode;
  readonly maxSpansPerRequest: number;
  readonly redact: ResolvedRedactOptions;
  readonly stack: ResolvedStackOptions;
  readonly detect: ResolvedDetectOptions;
  readonly sampling: ResolvedSamplingOptions;
  readonly logs: boolean;
  readonly hostMetrics: boolean;
  /**
   * Record SQL parameter values.
   *
   * Read by an instrumentation rather than by core, which is why it is here
   * and not among the panel's settings.
   */
  readonly collectSqlValues: boolean;
}

/** Options after resolution: nothing optional is left. */
export interface ResolvedOptions extends RecordingOptions {
  /**
   * The process runs locally: `NODE_ENV` is `development`, `test` or unset.
   * Staging is not included — which is exactly why it requires a gate.
   */
  readonly isLocalDevelopment: boolean;
  readonly bufferSize: number;
  /** `null` — panel disabled. */
  readonly panel: ResolvedPanelOptions | null;
  readonly replay: boolean;
  readonly profile: boolean;
  readonly explain: boolean;
  readonly blame: boolean;
  /** `null` — every store keeps to its own limits. */
  readonly retention: RetentionPolicy | null;
  /** `null` — nothing is being written to disk as a log. */
  readonly requestLog: RequestLogInfo | null;
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

/** @see StackCaptureOptions — the protocol's shape, for the same reason. */
export type ResolvedStackOptions = StackSettings;

/** Headers that are always masked. */
export const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
];

/**
 * Body fields and query parameters that are always masked.
 *
 * Matched as a part of the name, separators aside: `token` already covers `access_token` and
 * `refresh_token`, `secret` covers `client_secret`. `signature` is here for
 * presigned URLs, whose whole authority is one query parameter.
 */
export const DEFAULT_REDACTED_BODY_FIELDS: readonly string[] = [
  'password',
  'token',
  'secret',
  'cardNumber',
  'cvv',
  'apiKey',
  'signature',
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
 * could wipe a default and leave the detector without a threshold. A key the
 * detector does not have is refused with a warning rather than frozen into the
 * options: from JavaScript, `{ treshold: 10 }` type-checks nowhere, and
 * silently keeping it means somebody watches a threshold they think they
 * raised do nothing.
 */
function resolveDetector<T extends object>(
  id: string,
  defaults: T,
  override: Partial<T> | false | undefined,
): T | null {
  if (override === false) return null;
  const merged = { ...defaults } as Record<string, unknown>;
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      if (!(key in merged)) {
        warnOnce(
          `detect.${id}.${key}`,
          `reqray: ${id} has no option "${key}" — it was ignored. Known options: ${Object.keys(defaults).join(', ')}.`,
        );
        continue;
      }
      merged[key] = value;
    }
  }
  return Object.freeze(merged) as T;
}

/** Resolves every detector in the registry, enabled or not. */
function resolveDetect(overrides: DetectOptions | undefined): ResolvedDetectOptions {
  const resolved: Record<string, unknown> = {};
  for (const key of detectorKeys) {
    resolved[key] = resolveDetector(
      detectors[key].id,
      detectors[key].defaultOptions,
      overrides?.[key],
    );
  }
  return Object.freeze(resolved) as ResolvedDetectOptions;
}

/**
 * What `NODE_ENV` says. Read once, so the answers cannot disagree.
 *
 * "Local" means an explicit `development`/`test` or nothing at all — the same
 * reading Express uses. `staging` and any custom value are not local: the
 * process may be reachable from outside.
 */
interface Environment {
  readonly mode: ReqrayMode;
  readonly isLocalDevelopment: boolean;
}

function readEnvironment(explicit: ReqrayMode | undefined): Environment {
  const env = process.env['NODE_ENV'];
  const production = env === 'production';
  return {
    mode: explicit ?? (production ? 'production' : 'development'),
    isLocalDevelopment: env === undefined || env === '' || env === 'development' || env === 'test',
  };
}

/**
 * Expands user options into their full form.
 *
 * Called once at initialization: the hot path reads nothing from
 * `process.env` and normalizes nothing.
 */
export function resolveOptions(options: ReqrayOptions = {}): ResolvedOptions {
  const { mode, isLocalDevelopment } = readEnvironment(options.mode);
  const redact = options.redact ?? {};
  const stack = options.stack ?? {};

  const sampling = options.sampling ?? {};
  const panel = options.panel;

  return Object.freeze({
    // From the mode, not from a fourth reading of the environment: an explicit
    // `mode: 'production'` must switch Reqray off, and it did not.
    enabled: options.enabled ?? mode !== 'production',
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
    detect: resolveDetect(options.detect),
    sampling: Object.freeze({
      // Locally everything is visible; in production the stream is cut back —
      // otherwise the buffer and the collector drown, and you only ever need
      // one specific request to dig into anyway.
      rate: sampling.rate ?? (mode === 'production' ? 0.01 : 1),
      slowMs: sampling.slowMs ?? (mode === 'production' ? 500 : 0),
      alwaysOnError: sampling.alwaysOnError ?? true,
      // A request with a finding is exactly what Reqray is installed for — and
      // locally everything is retained anyway. In production the finding can
      // only become a retention reason if the detectors run on every request,
      // so there the default is off: expensive N+1s reach the sample as slow
      // requests instead.
      alwaysOnFinding: sampling.alwaysOnFinding ?? mode !== 'production',
    }),
    replay: options.replay ?? isLocalDevelopment,
    profile: options.profile ?? isLocalDevelopment,
    explain: options.explain ?? isLocalDevelopment,
    blame: options.blame ?? isLocalDevelopment,
    logs: options.logs ?? true,
    hostMetrics: options.hostMetrics ?? true,
    collectSqlValues: options.collectSqlValues ?? false,
    retention: options.retention ?? null,
    requestLog: options.requestLog ?? null,
    panel:
      panel === false
        ? null
        : Object.freeze({
            path: panel?.path ?? '/_reqray',
            gate: panel?.gate ?? null,
          }),
  });
}
