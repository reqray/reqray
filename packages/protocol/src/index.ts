/**
 * `@reqray/protocol` — the panel API contract.
 *
 * Types only: this package emits no runtime code, has no dependencies, and is
 * safe to install in a browser bundle, an editor plugin or a CLI. The server
 * side of the same contract lives in `@reqray/core`, which re-exports
 * everything here.
 */

export type {
  ApiError,
  BaselineResponse,
  DetectorSetting,
  DurationBaseline,
  HostPressure,
  HostPressureSide,
  PanelMeta,
  ReqrayMode,
  RequestDetail,
  RequestRow,
  RequestSort,
  RequestSummary,
  RequestsResponse,
} from './api.js';
export type { ExceptionFrame, ExceptionGroup } from './exceptions.js';
export type {
  FiledPatternState,
  FindingPattern,
  FindingsResponse,
  PatternExample,
  PatternRoute,
  PatternState,
  StoredPatternState,
} from './findings.js';
export type {
  DiagnosticEntry,
  GitHead,
  PoolReading,
  PoolStats,
  ProjectApp,
  ProjectLog,
  ProjectReport,
  ProjectReqray,
  ProjectRetention,
  ProjectRuntime,
  ProjectStorage,
  RetentionLimits,
  SamplingSettings,
  StackSettings,
} from './project.js';
export type {
  BudgetEvidence,
  CacheOperation,
  CacheSpan,
  Callsite,
  DbSpan,
  DuplicateEvidence,
  Finding,
  FindingEvidence,
  FindingSeverity,
  HandlerSpan,
  HeavyResponseEvidence,
  HostState,
  HotFrame,
  HttpSpan,
  LabelSpanKind,
  LogEntry,
  MiddlewareSpan,
  NPlusOneEvidence,
  PoolWaitEvidence,
  RecordedBody,
  RecordedRequest,
  RequestCost,
  RequestTiming,
  RequestWeight,
  SequentialHttpEvidence,
  SlowCodeEvidence,
  Span,
  SpanError,
  SpanKind,
  TransactionEvidence,
} from './record.js';
export type {
  RouteFinding,
  RouteSeries,
  RouteStats,
  RoutesReport,
  SeriesBucket,
} from './routes.js';
export type {
  MetricSeries,
  SeriesMetric,
  SeriesResponse,
  SeriesTotals,
} from './series.js';
export type {
  ActivityReport,
  Outlier,
  TimelineBucket,
  TimelineReport,
} from './timeline.js';
export type {
  BlameLine,
  ExplainNote,
  ExplainPlanNode,
  ExplainResult,
  ReplayComparison,
  ReplayInput,
  ReplayMetrics,
} from './tools.js';
