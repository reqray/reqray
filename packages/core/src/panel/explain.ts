/**
 * EXPLAIN of a recorded query, straight from the panel.
 *
 * Safety comes from three rules that are not options:
 * - the SQL is taken from the record — the panel client sends only ids and
 *   can never inject a statement;
 * - `ANALYZE` is never used: it executes the query, and an executed
 *   INSERT is a write. Plain EXPLAIN plans without running anything;
 * - the query goes to the same pool that ran the original (see
 *   `explain-targets.ts`), so "which database" is never a guess.
 *
 * Parameterized queries have no recorded values (values are deliberately not
 * collected), so they are planned with `GENERIC_PLAN` — PostgreSQL 16+.
 */

import { explainTarget } from '../explain-targets.js';
import type { RecordedRequest } from '../types.js';

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

const PLACEHOLDER = /\$\d+/;
const EXPLAIN_TIMEOUT_MS = 5_000;

interface PlanJson {
  readonly [key: string]: unknown;
  readonly Plans?: readonly PlanJson[];
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function labelOf(node: PlanJson): string {
  const type = typeof node['Node Type'] === 'string' ? (node['Node Type'] as string) : 'node';
  const relation = node['Relation Name'];
  const index = node['Index Name'];
  if (typeof index === 'string' && typeof relation === 'string') {
    return `${type} using ${index} on ${relation}`;
  }
  if (typeof relation === 'string') return `${type} on ${relation}`;
  return type;
}

/** Flattens the plan tree and derives the warnings. */
export function analyzePlan(plan: PlanJson): {
  nodes: ExplainPlanNode[];
  notes: ExplainNote[];
} {
  const nodes: ExplainPlanNode[] = [];
  const notes: ExplainNote[] = [];

  const walk = (node: PlanJson, depth: number): void => {
    nodes.push({
      depth,
      label: labelOf(node),
      rows: numberOf(node['Plan Rows']),
      cost: numberOf(node['Total Cost']),
    });

    if (node['Node Type'] === 'Seq Scan' && typeof node['Filter'] === 'string') {
      const relation = typeof node['Relation Name'] === 'string' ? node['Relation Name'] : '?';
      notes.push({
        severity: 'warn',
        message:
          `Seq Scan over "${relation}" with filter ${node['Filter']} — ` +
          'the whole table is read for a fraction of its rows. An index on the filtered column may help.',
      });
    }
    if (node['Node Type'] === 'Sort' && Array.isArray(node['Sort Key'])) {
      notes.push({
        severity: 'info',
        message:
          `Sorting by ${(node['Sort Key'] as unknown[]).join(', ')} happens in memory — ` +
          'an index in the sort order would remove it entirely.',
      });
    }

    for (const child of node.Plans ?? []) walk(child, depth + 1);
  };

  walk(node0(plan), 0);
  return { nodes, notes };

  function node0(root: PlanJson): PlanJson {
    // `EXPLAIN (FORMAT JSON)` wraps the tree as [{ "Plan": {...} }].
    const inner = (root as { Plan?: PlanJson }).Plan;
    return inner ?? root;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`EXPLAIN did not answer within ${ms} ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A user-facing failure: the message is shown in the panel as-is. */
export class ExplainError extends Error {
  override readonly name = 'ExplainError';
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Runs EXPLAIN for one recorded span.
 *
 * @throws ExplainError with a message meant for the panel.
 */
export async function runExplain(record: RecordedRequest, spanId: number): Promise<ExplainResult> {
  const span = record.spans.find((candidate) => candidate.id === spanId);
  if (span?.kind !== 'db') {
    throw new ExplainError('span not found, or it is not a SQL query', 404);
  }
  if (span.source !== 'pg') {
    throw new ExplainError(
      `EXPLAIN is supported for queries made through pg; this one went through ${span.source ?? 'an unknown driver'}`,
    );
  }
  if (span.clientId === null) {
    throw new ExplainError(
      'the executor of this query was not recorded — EXPLAIN has nowhere to go',
    );
  }

  const target = explainTarget(span.clientId);
  if (!target) {
    throw new ExplainError(
      'the pool that ran this query lives inside the application process and is not reachable here — ' +
        'EXPLAIN works in the panel mounted in the application',
    );
  }

  const parameterized = PLACEHOLDER.test(span.sql);
  const statement = parameterized
    ? `EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${span.sql}`
    : `EXPLAIN (FORMAT JSON) ${span.sql}`;

  let rows: unknown;
  try {
    const result = (await withTimeout(
      Promise.resolve(target.query(statement)),
      EXPLAIN_TIMEOUT_MS,
    )) as { rows?: unknown };
    rows = result?.rows;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (parameterized && /GENERIC_PLAN|generic_plan|syntax error/i.test(reason)) {
      throw new ExplainError(
        `EXPLAIN of a parameterized query needs PostgreSQL 16+ (GENERIC_PLAN). The database said: ${reason}`,
      );
    }
    throw new ExplainError(`the database rejected EXPLAIN: ${reason}`);
  }

  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const planColumn = first?.['QUERY PLAN'];
  const plan = Array.isArray(planColumn) ? planColumn[0] : planColumn;
  if (!plan || typeof plan !== 'object') {
    throw new ExplainError('the database returned the plan in an unexpected shape');
  }

  const { nodes, notes } = analyzePlan(plan as PlanJson);
  return { sql: span.sql, nodes, notes, plan };
}
