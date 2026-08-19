/**
 * `@loupe/core` — the Loupe core.
 *
 * Request context, buffer, masking, stack capture, detectors.
 * Zero runtime dependencies: Node built-ins only.
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
  resetLearnedCallsites,
  resolveCallsite,
  type StackFrame,
  withHandedCallsite,
} from './callsite.js';
export {
  DEFAULT_REDACTED_BODY_FIELDS,
  DEFAULT_REDACTED_HEADERS,
  type DetectOptions,
  type LoupeMode,
  type LoupeOptions,
  normalizeFieldName,
  type PanelOptions,
  type RedactOptions,
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
export {
  type Detector,
  type NPlusOneOptions,
  nPlusOne,
  resetDetectors,
  runDetectors,
  type SequentialHttpOptions,
  sequentialHttp,
} from './detectors/index.js';
export {
  clearDiagnostics,
  type DiagnosticEntry,
  getDiagnostics,
  printDiagnostics,
  printDiagnosticsOnce,
  renderDiagnostics,
  reportInstrumentation,
  resetDiagnosticsPrinted,
} from './diagnostics.js';
export {
  type ExplainTarget,
  explainTarget,
  registerExplainTarget,
  resetExplainTargets,
} from './explain-targets.js';
export { clearHttpFingerprints, fingerprintHttp } from './http-fingerprint.js';
export { nextRequestId } from './ids.js';
export { type LoupeLogSink, resetWarnings, setLogSink, warn, warnOnce } from './logger.js';
export {
  createLoupe,
  type HeaderMap,
  type Loupe,
  type LoupeInit,
  type RequestOutcome,
  type RequestStart,
  toSpanError,
} from './loupe.js';
export {
  createPanelHandler,
  type PanelHandler,
  type PanelHandlerInit,
  type PanelSource,
  type RequestRow,
  toRow,
} from './panel/api.js';
export {
  type ExceptionFrame,
  type ExceptionGroup,
  groupExceptions,
} from './panel/exceptions.js';
export {
  analyzePlan,
  ExplainError,
  type ExplainNote,
  type ExplainPlanNode,
  type ExplainResult,
  runExplain,
} from './panel/explain.js';
export {
  filterRequests,
  type RequestFilter,
  type RequestSummary,
  summarize,
} from './panel/filters.js';
export {
  metricsOf,
  REPLAY_HEADER,
  type ReplayComparison,
  type ReplayInput,
  type ReplayMetrics,
  runReplay,
} from './panel/replay.js';
export {
  assertPanelAllowed,
  isPanelRequestAllowed,
  type PanelGate,
  PanelGateError,
  type PanelRequestContext,
} from './panel.js';
export { isAdapterActive, markAdapterActive, resetAdapterActive } from './presence.js';
export { record } from './record.js';
export { isSensitiveField, redactHeaders, redactValue } from './redact.js';
export { type SamplingInput, shouldRetain } from './sampling.js';
export { RequestScope, type RequestScopeInit } from './scope.js';
export {
  clearSqlCaches,
  fingerprintSql,
  type SqlOperation,
  sqlOperation,
} from './sql.js';
export { nullTransport, type Transport } from './transport.js';
export type {
  CacheOperation,
  CacheSpan,
  CacheSpanInput,
  Callsite,
  DbSpan,
  DbSpanInput,
  Finding,
  FindingEvidence,
  FindingSeverity,
  HandlerSpan,
  HttpSpan,
  HttpSpanInput,
  Instrumentation,
  LabelSpanInput,
  LogEntry,
  MiddlewareSpan,
  NPlusOneEvidence,
  RecordedBody,
  RecordedRequest,
  SequentialHttpEvidence,
  Span,
  SpanError,
  SpanInput,
  SpanKind,
} from './types.js';
