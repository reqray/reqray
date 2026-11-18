/**
 * Records both stores are fed, so their answers can be compared.
 *
 * Deliberately varied: methods, statuses, durations, findings, a query
 * string, a pinned candidate — everything the filter can discriminate on.
 */

import { type Finding, type RecordedRequest, timingOf, weightOf } from '@reqray/core';

/** The first record's start; each one after it is a second later. */
export const BASE_TIME = Date.UTC(2026, 7, 20, 9, 0, 0);

const nPlusOne = {
  detector: 'n_plus_one',
  severity: 'critical',
  title: '150 identical queries ran in a loop',
  costMs: 29,
  callsite: null,
  evidence: {
    kind: 'n_plus_one',
    repeats: 150,
    fingerprint: 'SELECT * FROM line_items WHERE order_id = ?',
    sample: 'SELECT * FROM line_items WHERE order_id = 1',
    totalMs: 30,
    spanIds: [],
  },
  hint: 'fetch them in one query',
} as unknown as Finding;

export function record(over: Partial<RecordedRequest> = {}): RecordedRequest {
  const index = Number(String(over.id ?? 'r0').replace(/\D/g, '')) || 0;
  const base = {
    id: 'r0',
    method: 'GET',
    path: '/api/orders',
    query: null,
    status: 200,
    durationMs: 12,
    startedAt: BASE_TIME + index * 1000,
    spans: [],
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
    ...over,
  };
  return {
    ...base,
    timing: timingOf(base.spans, base.durationMs),
    host: base.host ?? null,
    weight: weightOf(base),
    cost: null,
  };
}

/** A fixed set both stores are filled with, oldest first. */
export function sample(): RecordedRequest[] {
  return [
    record({ id: 'r1', path: '/api/orders', durationMs: 48, findings: [nPlusOne] }),
    record({ id: 'r2', path: '/api/orders/eager', durationMs: 13 }),
    record({ id: 'r3', method: 'POST', path: '/api/checkout', status: 201, durationMs: 620 }),
    record({ id: 'r4', path: '/api/report', durationMs: 855 }),
    record({ id: 'r5', path: '/api/boom', status: 500, durationMs: 2 }),
    record({ id: 'r6', path: '/api/search', query: 'q=walnut', durationMs: 30 }),
    record({ id: 'r7', method: 'POST', path: '/api/login', status: 401, durationMs: 8 }),
    record({
      id: 'r8',
      path: '/api/profile/1',
      durationMs: 3,
      test: 'profile.spec.ts:12 > shows the profile',
    }),
  ];
}

/**
 * The sample plus two rows for the search box.
 *
 * The box is free text: `%` and `_` are wildcards to SQL and ordinary
 * characters to a reader. `r10` is the decoy an unescaped `a_i` would match.
 */
export function sampleWithWildcards(): RecordedRequest[] {
  return [
    ...sample(),
    record({ id: 'r9', path: '/api/a_i/1', query: 'discount=100%' }),
    record({ id: 'r10', path: '/api/aXi/1' }),
  ];
}
