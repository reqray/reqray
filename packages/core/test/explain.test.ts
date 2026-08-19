/**
 * EXPLAIN from the panel: the analysis is pure and tested on canned plans;
 * the runner is tested against a fake target that records what SQL it got —
 * the wire-level truth (real Postgres) lives in the pg integration suite.
 */

import {
  analyzePlan,
  ExplainError,
  type RecordedRequest,
  registerExplainTarget,
  resetExplainTargets,
  runExplain,
} from '@loupe/core';
import { beforeEach, describe, expect, it } from 'vitest';

const SEQ_SCAN_PLAN = {
  Plan: {
    'Node Type': 'Sort',
    'Total Cost': 120.5,
    'Plan Rows': 150,
    'Sort Key': ['created_at DESC'],
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        'Total Cost': 98.2,
        'Plan Rows': 150,
        Filter: '(user_id = 1)',
      },
    ],
  },
};

function recordWith(span: Partial<Record<string, unknown>>): RecordedRequest {
  return {
    id: 'r1',
    method: 'GET',
    path: '/orders',
    query: null,
    status: 200,
    durationMs: 10,
    startedAt: Date.now(),
    spans: [
      {
        id: 7,
        parentId: null,
        kind: 'db',
        sql: 'SELECT * FROM orders WHERE user_id = 1',
        fingerprint: 'SELECT * FROM orders WHERE user_id = ?',
        rowCount: 150,
        source: 'pg',
        clientId: null,
        startedAt: 0,
        duration: 5,
        callsite: null,
        error: null,
        ...span,
      } as RecordedRequest['spans'][number],
    ],
    findings: [],
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    logs: [],
    error: null,
    droppedSpans: 0,
    droppedLogs: 0,
    test: null,
  };
}

/** A fake pool: hands back a canned plan and remembers the statement. */
function fakeTarget(plan: unknown = SEQ_SCAN_PLAN) {
  const statements: string[] = [];
  const target = {
    statements,
    query(sql: string) {
      statements.push(sql);
      return Promise.resolve({ rows: [{ 'QUERY PLAN': [plan] }] });
    },
  };
  return target;
}

beforeEach(() => resetExplainTargets());

describe('plan analysis', () => {
  it('flattens the tree and finds a Seq Scan with a filter', () => {
    const { nodes, notes } = analyzePlan(SEQ_SCAN_PLAN);

    expect(nodes.map((node) => `${node.depth}:${node.label}`)).toEqual([
      '0:Sort',
      '1:Seq Scan on orders',
    ]);
    expect(notes.some((note) => note.severity === 'warn' && note.message.includes('orders'))).toBe(
      true,
    );
    expect(notes.some((note) => note.message.includes('Sorting'))).toBe(true);
  });

  it('an index plan gets no notes', () => {
    const { nodes, notes } = analyzePlan({
      Plan: {
        'Node Type': 'Index Scan',
        'Index Name': 'orders_pkey',
        'Relation Name': 'orders',
        'Total Cost': 8.3,
        'Plan Rows': 1,
      },
    });

    expect(nodes[0]?.label).toBe('Index Scan using orders_pkey on orders');
    expect(notes).toEqual([]);
  });
});

describe('running EXPLAIN', () => {
  it('sends EXPLAIN to the same pool and returns the analysis', async () => {
    const target = fakeTarget();
    const id = registerExplainTarget(target);

    const result = await runExplain(recordWith({ clientId: id }), 7);

    expect(target.statements[0]).toBe(
      'EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE user_id = 1',
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('a parameterized query is planned via GENERIC_PLAN', async () => {
    const target = fakeTarget();
    const id = registerExplainTarget(target);

    await runExplain(
      recordWith({ clientId: id, sql: 'SELECT * FROM orders WHERE user_id = $1' }),
      7,
    );

    expect(target.statements[0]).toContain('GENERIC_PLAN');
    // ANALYZE executes the query and must never appear.
    expect(target.statements[0]).not.toContain('ANALYZE');
  });

  it('an unknown span is a 404, not a 500', async () => {
    await expect(runExplain(recordWith({}), 999)).rejects.toMatchObject({
      name: 'ExplainError',
      status: 404,
    });
  });

  it('without a recorded executor explains why it cannot run', async () => {
    await expect(runExplain(recordWith({ clientId: null }), 7)).rejects.toThrow(
      /executor of this query was not recorded/,
    );
  });

  it('a dead pool gets an honest message about the application process', async () => {
    // Id 12345 was never registered — the collector case.
    await expect(runExplain(recordWith({ clientId: 12345 }), 7)).rejects.toThrow(
      /lives inside the application process/,
    );
  });

  it('a database error is relayed as is', async () => {
    const target = {
      query: () => Promise.reject(new Error('relation "orders" does not exist')),
    };
    const id = registerExplainTarget(target);

    await expect(runExplain(recordWith({ clientId: id }), 7)).rejects.toThrow(
      /database rejected EXPLAIN: relation/,
    );
    expect(new ExplainError('x').status).toBe(400);
  });
});
