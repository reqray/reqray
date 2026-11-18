/** The model both clients draw from, and the rules that keep it honest. */

import type { Finding, Span } from '@reqray/protocol';
import { buildWaterfall, findGaps, parallelSpans, uninstrumentedMs } from '@reqray/waterfall';
import { describe, expect, it } from 'vitest';

function db(over: Partial<Span> & { id: number; startedAt: number; duration: number }): Span {
  return {
    parentId: null,
    kind: 'db',
    sql: 'SELECT * FROM orders WHERE id = 1',
    fingerprint: 'SELECT * FROM orders WHERE id = ?',
    rowCount: 1,
    source: 'pg',
    clientId: null,
    connectionId: null,
    waitMs: null,
    values: null,
    selfMs: over.duration,
    callsite: null,
    error: null,
    ...over,
  } as Span;
}

function finding(detector: string, kind: string, spanIds: number[]): Finding {
  return {
    detector,
    severity: 'warn',
    title: detector,
    costMs: 10,
    callsite: null,
    hint: '',
    evidence: {
      kind,
      repeats: spanIds.length,
      fingerprint: 'SELECT ?',
      sample: 'SELECT 1',
      totalMs: 10,
      spanIds,
    },
  } as unknown as Finding;
}

describe('collapsing a run', () => {
  it('draws one bar for an N+1, spanning the whole run', () => {
    const spans = [1, 2, 3, 4].map((id) => db({ id, startedAt: id * 10, duration: 5 }));
    const bars = buildWaterfall({
      spans,
      findings: [finding('n_plus_one', 'n_plus_one', [1, 2, 3, 4])],
      durationMs: 60,
    });

    const run = bars.find((bar) => bar.finding === 'n_plus_one');
    expect(run?.count).toBe(4);
    expect(run?.startedAt).toBe(10);
    // From the first of them to the end of the last.
    expect(run?.duration).toBe(35);
    expect(bars.filter((bar) => bar.kind === 'db')).toHaveLength(1);
  });

  it('collapses sequential HTTP as well', () => {
    const spans = [1, 2, 3].map((id) => db({ id, startedAt: id * 10, duration: 5 }));
    const bars = buildWaterfall({
      spans,
      findings: [finding('sequential_http', 'sequential_http', [1, 2, 3])],
      durationMs: 60,
    });

    expect(bars.filter((bar) => bar.finding === 'sequential_http')).toHaveLength(1);
  });

  it('does not collapse a duplicate — it only marks it', () => {
    // Two calls far apart. One bar spanning them would swallow everything in
    // between and claim the time as its own.
    const spans = [
      db({ id: 1, startedAt: 0, duration: 5 }),
      db({ id: 2, startedAt: 900, duration: 5 }),
    ];
    const bars = buildWaterfall({
      spans,
      findings: [finding('dup_http', 'duplicate', [1, 2])],
      durationMs: 1_000,
    });

    expect(bars.filter((bar) => bar.kind === 'db')).toHaveLength(2);
    expect(bars.find((bar) => bar.span?.id === 2)?.marks).toContain('dup_http');
  });
});

describe('the time nothing accounts for', () => {
  it('names the stretch a slow request spent elsewhere', () => {
    // The question the whole tool exists to answer: 2.14s of request, 12ms of
    // query, and what happened in between.
    const bars = buildWaterfall({
      spans: [db({ id: 1, startedAt: 5, duration: 12 })],
      findings: [],
      durationMs: 2_140,
    });

    const gap = bars.find((bar) => bar.kind === 'gap');
    expect(gap).toBeDefined();
    expect(Math.round(uninstrumentedMs(bars))).toBe(2_123);
  });

  it('counts a queued query as covered, not as a gap', () => {
    // A wait for a connection is the one stretch of an idle-looking request
    // that is fully accounted for. Calling it uninstrumented would hide the
    // answer behind the word for "no answer".
    const spans = [db({ id: 1, startedAt: 300, duration: 10, waitMs: 295 })];
    expect(findGaps({ spans, findings: [], durationMs: 320 })).toEqual([]);
  });

  it('says nothing about a stretch too short to matter', () => {
    const bars = buildWaterfall({
      spans: [db({ id: 1, startedAt: 2, duration: 96 })],
      findings: [],
      durationMs: 100,
    });
    expect(bars.some((bar) => bar.kind === 'gap')).toBe(false);
  });

  it('a container is not coverage', () => {
    // A handler span covers the whole request by definition; letting it count
    // would mean no request ever has a gap.
    const handler = {
      id: 1,
      parentId: null,
      kind: 'handler',
      label: 'orders.list',
      startedAt: 0,
      duration: 500,
      selfMs: 500,
      callsite: null,
      error: null,
    } as Span;

    const bars = buildWaterfall({ spans: [handler], findings: [], durationMs: 500 });
    expect(bars.some((bar) => bar.kind === 'gap')).toBe(true);
  });
});

describe('reading the span tree', () => {
  it('finds the parents whose children overlapped', () => {
    const parent = { ...db({ id: 1, startedAt: 0, duration: 100 }), kind: 'handler' } as Span;
    const spans = [
      parent,
      db({ id: 2, parentId: 1, startedAt: 10, duration: 40 }),
      db({ id: 3, parentId: 1, startedAt: 20, duration: 40 }),
    ];
    expect(parallelSpans(spans).has(1)).toBe(true);
  });

  it('touching is not overlapping', () => {
    // One query ending where the next begins is a loop, and calling that
    // concurrency would contradict what the N+1 detector says about it.
    const spans = [
      db({ id: 1, startedAt: 0, duration: 100 }),
      db({ id: 2, parentId: 1, startedAt: 10, duration: 10 }),
      db({ id: 3, parentId: 1, startedAt: 20, duration: 10 }),
    ];
    expect(parallelSpans(spans).has(1)).toBe(false);
  });

  it('a broken parent chain stops rather than loops forever', () => {
    const spans = [
      db({ id: 1, parentId: 2, startedAt: 0, duration: 5 }),
      db({ id: 2, parentId: 1, startedAt: 1, duration: 5 }),
    ];
    // Bounded, so this returns at all.
    const bars = buildWaterfall({ spans, findings: [], durationMs: 10 });
    expect(bars.every((bar) => bar.depth <= 32)).toBe(true);
  });
});
