/*
 * Client for the panel HTTP API.
 *
 * The wire shapes come from `@reqray/protocol` — types only, no runtime code,
 * safe in a browser bundle. Redeclaring them here would be a copy free to
 * drift from what the server actually sends.
 *
 * What is declared here is what only a client has: the query it sends, and how
 * it sends it.
 */

export type {
  ActivityReport,
  BlameLine,
  BudgetEvidence,
  Callsite,
  DetectorSetting,
  DiagnosticEntry,
  DurationBaseline,
  ExceptionFrame,
  ExceptionGroup,
  ExplainNote,
  ExplainPlanNode,
  ExplainResult,
  Finding,
  FindingPattern,
  FindingsResponse,
  HeavyResponseEvidence,
  HostPressure,
  HostPressureSide,
  HostState,
  HotFrame,
  LogEntry,
  MetricSeries,
  NPlusOneEvidence,
  Outlier,
  PanelMeta,
  PatternExample,
  PatternRoute,
  PatternState,
  PoolStats,
  PoolWaitEvidence,
  ProjectReport,
  RecordedBody,
  ReplayComparison,
  ReplayMetrics,
  RequestCost,
  RequestDetail,
  RequestRow,
  RequestSummary,
  RequestTiming,
  RequestWeight,
  RetentionLimits,
  RouteFinding,
  RouteSeries,
  RouteStats,
  SequentialHttpEvidence,
  SeriesBucket,
  SeriesMetric,
  SeriesResponse,
  SeriesTotals,
  SlowCodeEvidence,
  Span,
  SpanError,
  StoredPatternState,
  TimelineBucket,
  TransactionEvidence,
} from '@reqray/protocol';

export { apiUrl, type RequestFilterQuery, toSearchParams } from './client';
export { fetchFindings, isRunEvidence, saveFindingState } from './findings';
export { fetchActivity, fetchSeries, fetchTimeline } from './history';
export { fetchExceptions, fetchMeta, fetchProject, saveRetention } from './project';
export {
  clearRequests,
  fetchBaseline,
  fetchRequest,
  fetchRequests,
  pinRequest,
  subscribeToRequests,
} from './requests';
export { fetchRouteSeries, fetchRoutes } from './routes';
export { explainSpan, fetchBlame, openInEditor, replayRequest } from './tools';
