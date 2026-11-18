/**
 * `@reqray/core` — the Reqray core.
 *
 * Request context, buffer, masking, stack capture, detectors.
 * No third-party runtime dependencies: Node built-ins only. The one
 * dependency, `@reqray/protocol`, is types — it emits no runtime code, so
 * nothing of it is loaded and nothing of it can fail at the host's expense.
 */

export { recordBody } from './body.js';
export { RingBuffer } from './buffer.js';
export {
  captureCallsite,
  findProjectFrame,
  type HandedCallsite,
  handedCallsite,
  isProjectFrame,
  parseStackFrame,
  resolveCallsite,
  type StackFrame,
  withHandedCallsite,
} from './callsite.js';
export {
  DEFAULT_REDACTED_BODY_FIELDS,
  DEFAULT_REDACTED_HEADERS,
  type DetectOptions,
  normalizeFieldName,
  type PanelOptions,
  type RecordingOptions,
  type RedactOptions,
  type ReqrayMode,
  type ReqrayOptions,
  type ResolvedDetectOptions,
  type ResolvedOptions,
  type ResolvedPanelOptions,
  type ResolvedRedactOptions,
  type ResolvedSamplingOptions,
  type ResolvedStackOptions,
  resolveOptions,
  type SamplingOptions,
  type StackCaptureOptions,
} from './config.js';
export { instrumentConsole, uninstrumentConsole } from './console-capture.js';
export { current, enterScope, runInScope, runOutsideScope } from './context.js';
export { type CostMark, markCost, measureCost, startCostMeter, stopCostMeter } from './cost.js';
export {
  type Detector,
  type DuplicateCacheOptions,
  type DuplicateHttpOptions,
  duplicateCache,
  duplicateHttp,
  type FinishedRequest,
  type HeavyResponseOptions,
  heavyResponse,
  type NPlusOneOptions,
  nPlusOne,
  overlapMs,
  type PoolWaitOptions,
  poolWait,
  runDetectors,
  type SequentialHttpOptions,
  type SlowBudgetOptions,
  type SlowCodeOptions,
  sequentialHttp,
  slowBudget,
  slowCode,
  statementKind,
  type Transaction,
  type TransactionHoldOptions,
  transactionHold,
  transactionsOf,
} from './detectors/index.js';
export {
  type DiagnosticEntry,
  getDiagnostics,
  printDiagnostics,
  printDiagnosticsOnce,
  renderDiagnostics,
  reportInstrumentation,
} from './diagnostics.js';
export {
  type ExplainTarget,
  explainTarget,
  registerExplainTarget,
} from './explain-targets.js';
export { type HostMonitor, startHostMonitor } from './host.js';
export { fingerprintHttp } from './http-fingerprint.js';
export { nextRequestId } from './ids.js';
export {
  guarded,
  isPatched,
  patchMethod,
  settle,
  settleCallback,
  unpatchMethod,
} from './instrument-kit.js';
export { type ReqrayLogSink, setLogSink, warn, warnOnce } from './logger.js';
export {
  assertPanelAllowed,
  isLocalRequest,
  isPanelRequestAllowed,
  type PanelGate,
  PanelGateError,
  type PanelRequestContext,
} from './panel.js';
export {
  type PoolReading,
  type PoolStats,
  poolStats,
  registerPool,
} from './pools.js';
export { isAdapterActive, markAdapterActive } from './presence.js';
export {
  type HotFrame,
  type HotSpots,
  type ProfilerOptions,
  type RequestProfiler,
  startProfiler,
} from './profiler.js';
export { record } from './record.js';
export { isSensitiveField, redactHeaders, redactQuery, redactValue } from './redact.js';
export {
  createReqray,
  type HeaderMap,
  REPLAY_HEADER,
  type Reqray,
  type ReqrayInit,
  type RequestOutcome,
  type RequestStart,
  toSpanError,
} from './reqray.js';
export {
  cutoffOf,
  DAY_MS,
  type RetentionLimits,
  type RetentionOptions,
  type RetentionPolicy,
  retentionPolicy,
} from './retention.js';
export { type SamplingInput, shouldRetain } from './sampling.js';
export { RequestScope, type RequestScopeInit } from './scope.js';
export {
  fingerprintSql,
  type SqlOperation,
  sqlOperation,
} from './sql.js';
export { type Box, globalBox, globalSlot, TwoGenerationCache } from './state.js';
export {
  anyOverlap,
  coveredMs,
  ensureTiming,
  mergeIntervals,
  selfTimes,
  timingOf,
} from './timing.js';
export { multiTransport, nullTransport, type Transport } from './transport.js';
export type {
  BaselineResponse,
  BudgetEvidence,
  CacheOperation,
  CacheSpan,
  CacheSpanInput,
  Callsite,
  DbSpan,
  DbSpanInput,
  DuplicateEvidence,
  DurationBaseline,
  Finding,
  FindingEvidence,
  FindingSeverity,
  HandlerSpan,
  HeavyResponseEvidence,
  HostPressure,
  HostPressureSide,
  HostState,
  HttpSpan,
  HttpSpanInput,
  Instrumentation,
  LabelSpanInput,
  LogEntry,
  MetricSeries,
  MiddlewareSpan,
  NPlusOneEvidence,
  PoolWaitEvidence,
  RecordedBody,
  RecordedRequest,
  RequestTiming,
  RequestWeight,
  SequentialHttpEvidence,
  SeriesMetric,
  SeriesResponse,
  SeriesTotals,
  SlowCodeEvidence,
  Span,
  SpanError,
  SpanInput,
  SpanKind,
  TransactionEvidence,
} from './types.js';
export { biggestQuery, weightOf } from './weight.js';
