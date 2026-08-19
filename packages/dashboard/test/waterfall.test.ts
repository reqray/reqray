/**
 * Gap logic: a 600 ms request with a 2 ms query must answer "where did the
 * other 598 ms go" instead of showing one full bar and silence.
 */

import { describe, expect, it } from 'vitest';
import type { RequestDetail, Span } from '../src/api';
import { buildWaterfall, uninstrumentedMs } from '../src/waterfall';

let id = 0;

function span(kind: 'handler' | 'db' | 'http', startedAt: number, duration: number): Span {
  return {
    id: ++id,
    parentId: null,
    startedAt,
    duration,
    callsite: null,
    error: null,
    ...(kind === 'db'
      ? { kind, sql: 'SELECT 1', fingerprint: 'SELECT 1', rowCount: 1, source: 'pg' }
      : kind === 'http'
        ? { kind, method: 'GET', url: 'https://api.example.com/x', statusCode: 200 }
        : { kind, label: 'GET /report' }),
  } as Span;
}

function detailWith(durationMs: number, spans: Span[]): RequestDetail {
  return { durationMs, spans, findings: [] } as unknown as RequestDetail;
}

const gaps = (detail: RequestDetail) => buildWaterfall(detail).filter((bar) => bar.kind === 'gap');

describe('uninstrumented time', () => {
  it('a long request with a tiny SQL query gets a gap bar', () => {
    const detail = detailWith(609, [span('handler', 0, 609), span('db', 1, 1.5)]);

    const [gap, ...rest] = gaps(detail);

    expect(rest).toHaveLength(0);
    expect(gap).toMatchObject({ kind: 'gap', label: expect.stringContaining('uninstrumented') });
    expect(gap?.startedAt).toBeCloseTo(2.5, 1);
    expect(gap?.duration).toBeCloseTo(606.5, 1);
    expect(uninstrumentedMs(buildWaterfall(detail))).toBeCloseTo(606.5, 1);
  });

  it('a fully covered request has no gaps', () => {
    const detail = detailWith(100, [
      span('handler', 0, 100),
      span('db', 0, 60),
      span('http', 60, 40),
    ]);

    expect(gaps(detail)).toHaveLength(0);
  });

  it('small pauses between spans are noise, not a gap', () => {
    // 5 ms of slack in a 100 ms request is below both thresholds.
    const detail = detailWith(100, [
      span('handler', 0, 100),
      span('db', 0, 45),
      span('db', 50, 50),
    ]);

    expect(gaps(detail)).toHaveLength(0);
  });

  it('overlapping spans count as a single stretch of coverage', () => {
    // Two parallel calls cover [0, 50]; the gap is only the tail.
    const detail = detailWith(200, [
      span('handler', 0, 200),
      span('http', 0, 50),
      span('http', 10, 40),
    ]);

    const [gap] = gaps(detail);
    expect(gap?.startedAt).toBe(50);
    expect(gap?.duration).toBe(150);
  });

  it('handler and middleware are containers, not coverage', () => {
    const detail = detailWith(300, [span('handler', 0, 300)]);

    const [gap] = gaps(detail);
    expect(gap).toMatchObject({ startedAt: 0, duration: 300 });
  });

  it('a fast request without spans draws nothing', () => {
    expect(gaps(detailWith(3, [span('handler', 0, 3)]))).toHaveLength(0);
  });
});
