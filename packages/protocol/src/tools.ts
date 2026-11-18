/**
 * The three tools that act on the machine rather than read from the store:
 * EXPLAIN a recorded query, replay a recorded request, blame a stack frame.
 *
 * They share a file because they share a gate. Each one reaches outside the
 * panel — into the database, back into the application, into `git` — and each
 * is off outside local development unless somebody turned it on deliberately.
 * A client should see them as one capability, because that is how they are
 * granted.
 */

/** One node of the plan tree, flattened for display. */
export interface ExplainPlanNode {
  readonly depth: number;
  /** `Seq Scan on line_items`, `Index Scan using orders_pkey on orders`. */
  readonly label: string;
  readonly rows: number | null;
  readonly cost: number | null;
}

/** A warning derived from the plan. */
export interface ExplainNote {
  readonly severity: 'warn' | 'info';
  readonly message: string;
}

/** What `POST /api/explain` answers. */
export interface ExplainResult {
  readonly sql: string;
  readonly nodes: readonly ExplainPlanNode[];
  readonly notes: readonly ExplainNote[];
  /** The raw plan, for those who want the full detail. */
  readonly plan: unknown;
}

/** What the panel asks to replay. */
export interface ReplayInput {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
}

/** Metrics of one run — what the comparison block shows. */
export interface ReplayMetrics {
  readonly status: number;
  readonly durationMs: number;
  readonly sqlCount: number;
  readonly nPlusOne: boolean;
  readonly bytes: number | null;
  readonly etag: string | null;
}

/** Original versus replay. */
export interface ReplayComparison {
  readonly original: ReplayMetrics;
  readonly replay: ReplayMetrics;
  /**
   * The replay's record could not be obtained — metrics were collected from
   * the response alone. The database query count is unknown in that case.
   */
  readonly partial: boolean;
}

/** What blame knows about one line. */
export interface BlameLine {
  /** Abbreviated commit hash. */
  readonly sha: string;
  readonly author: string;
  /** Commit time, epoch ms. */
  readonly at: number;
}
