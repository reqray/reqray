/**
 * `@reqray/core/panel` — reading back what was recorded.
 *
 * A separate entry point from `@reqray/core` on purpose. The recording side
 * runs inside somebody's application on the hot path and loads nothing it does
 * not need; this side spawns `git`, serves static files, opens sockets and
 * calls back into the application to replay a request. Joined in one barrel,
 * an instrumentation that only wants to time a query linked the HAR exporter
 * and the blame subprocess runner along with it.
 *
 * Nothing here is imported by the recording path — the split is a fact about
 * the code, not a convention this file asks anyone to keep.
 */

export {
  type ActivityReport,
  type Outlier,
  type RouteWindow,
  whatRanAt,
} from './activity.js';
export {
  createPanelHandler,
  type DurationSample,
  type PageQuery,
  type PanelHandler,
  type PanelHandlerInit,
  type PanelSource,
  panelSourceFor,
  parseFilter,
  type RequestPage,
  type RequestRow,
  toRow,
} from './api.js';
export { type BaselineQuery, baselineFor } from './baseline.js';
export { type BlameLine, blameLine, parsePorcelain } from './blame.js';
export {
  type ExceptionFrame,
  type ExceptionGroup,
  groupExceptions,
} from './exceptions.js';
export {
  analyzePlan,
  ExplainError,
  type ExplainNote,
  type ExplainPlanNode,
  type ExplainResult,
  runExplain,
} from './explain.js';
export { toCurlScript, toHar } from './export.js';
export {
  filterRequests,
  type RequestFilter,
  type RequestSummary,
  summarize,
} from './filters.js';
export {
  type FindingSample,
  type FindingSamples,
  type FindingsQuery,
  findingSamplesOf,
  flagWithMutes,
  patternKey,
  patternsOf,
} from './findings.js';
export {
  columnsFor,
  type HistoryOptions,
  type HistoryQuery,
  type HistorySample,
  type HistorySamples,
  historyOf,
  historySampleOf,
  SERIES_COLUMNS,
  totalsOf,
} from './history.js';
export { type PageContext, pageFromList } from './page-from-list.js';
export {
  type Cursor,
  decodeCursor,
  encodeCursor,
  isAfterCursor,
} from './paging.js';
export { pressureFor } from './pressure.js';
export {
  type GitHead,
  type ProjectApp,
  type ProjectReport,
  type ProjectRuntime,
  type ProjectStorage,
  projectReport,
  storageOf,
} from './project.js';
export {
  metricsOf,
  type ReplayComparison,
  type ReplayInput,
  type ReplayMetrics,
  runReplay,
} from './replay.js';
export {
  normalizeRoute,
  percentile,
  type RouteFinding,
  type RouteStats,
  type RoutesReport,
  routeStats,
  TREND_BUCKETS,
} from './routes.js';
export {
  type RouteSeries,
  routeSeries,
  SERIES_BUCKETS,
  type SeriesBucket,
} from './series.js';
export {
  bucketIndex,
  buildTimeline,
  TIMELINE_BUCKETS,
  type TimelineBucket,
  type TimelineReport,
  type TimePoint,
} from './timeline.js';
