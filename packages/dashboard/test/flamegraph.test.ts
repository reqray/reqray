import { describe, expect, it } from 'vitest';
import type { RequestDetail, Span } from '../src/api/index';
import {
  buildFlamegraph,
  flameLevels,
  LABEL_MIN_WIDTH,
} from '../src/features/detail/lib/flame-blocks';

let id = 0;

/** Fills in whatever the span kind requires, so labels are real strings. */
function span(over: Partial<Span> & Pick<Span, 'kind'>): Span {
  id += 1;
  const shape =
    over.kind === 'db'
      ? { sql: 'SELECT 1', fingerprint: 'SELECT ?', rowCount: 1, source: 'pg' }
      : over.kind === 'http'
        ? { method: 'GET', url: 'https://api.example.com/x', statusCode: 200 }
        : over.kind === 'cache'
          ? { operation: 'get', key: 'user:1', hit: true }
          : { label: 'GET /api/orders' };

  return {
    id,
    parentId: null,
    startedAt: 0,
    duration: 10,
    callsite: null,
    error: null,
    ...shape,
    ...over,
  } as Span;
}

const detail = (durationMs: number, spans: Span[]) =>
  ({ durationMs, spans, findings: [] }) as unknown as RequestDetail;

describe('flamegraph layout', () => {
  it('places a span by its share of the request', () => {
    const blocks = buildFlamegraph(
      detail(100, [span({ kind: 'handler', startedAt: 25, duration: 50 })]),
    );

    expect(blocks[0]).toMatchObject({ left: 25, width: 50, depth: 0 });
  });

  it('stacks children under their parent', () => {
    const parent = span({ kind: 'handler', duration: 100 });
    const child = span({ kind: 'db', parentId: parent.id, duration: 40 });
    const grandchild = span({ kind: 'http', parentId: child.id, duration: 10 });

    const blocks = buildFlamegraph(detail(100, [parent, child, grandchild]));

    expect(blocks.map((block) => block.depth)).toEqual([0, 1, 2]);
    expect(flameLevels(blocks)).toBe(3);
  });

  it('keeps a sub-millisecond span clickable', () => {
    const blocks = buildFlamegraph(detail(1_000, [span({ kind: 'db', duration: 0.2 })]));

    expect(blocks[0]?.width).toBeGreaterThan(0);
  });

  it('never runs off the end, whatever the timings say', () => {
    // A span that outlives its request would otherwise draw past the edge.
    const blocks = buildFlamegraph(
      detail(50, [span({ kind: 'db', startedAt: 40, duration: 400 })]),
    );

    expect(blocks[0]?.left).toBeLessThanOrEqual(100);
    expect(blocks[0]?.width).toBeLessThanOrEqual(100);
  });

  it('carries the duration in the tooltip, since the block may be tiny', () => {
    const blocks = buildFlamegraph(detail(100, [span({ kind: 'db', duration: 3 })]));

    expect(blocks[0]?.title).toContain('3.0 ms');
    expect(blocks[0]?.width).toBeLessThan(LABEL_MIN_WIDTH);
  });

  it('an empty request has no levels', () => {
    expect(flameLevels(buildFlamegraph(detail(10, [])))).toBe(0);
  });
});
