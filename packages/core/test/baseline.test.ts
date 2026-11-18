/**
 * The verdict on one call.
 *
 * The rules that matter here are the ones about when *not* to speak: a
 * comparison drawn from three calls is a coin toss wearing a statistic's
 * name, and a panel that calls an ordinary request slow teaches the reader to
 * stop reading the card.
 */

import { type RecordedRequest, timingOf, weightOf } from '@reqray/core';
import { baselineFor, type DurationSample } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

function request(over: Partial<RecordedRequest> = {}): RecordedRequest {
  const base = {
    id: 'r1',
    method: 'GET',
    path: '/api/orders/8812',
    query: null,
    status: 200,
    durationMs: 100,
    startedAt: 10_000,
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

/** The route's other calls, a second apart. */
const calls = (durations: readonly number[]): DurationSample[] =>
  durations.map((durationMs, index) => ({
    durationMs,
    startedAt: 1_000 + index * 1_000,
    hasError: false,
    loopDelayMs: null,
  }));

/** Twenty calls between 40 and 60 ms — an ordinary, boring route. */
const ordinary = calls(Array.from({ length: 20 }, (_, index) => 40 + index));

describe('the baseline', () => {
  it('names the route rather than the path it was called by', () => {
    expect(baselineFor(request({ path: '/api/orders/8812' }), ordinary)?.route).toBe(
      '/api/orders/:id',
    );
  });

  it('says nothing when the store cannot answer', () => {
    expect(baselineFor(request(), undefined)).toBeNull();
  });

  it('says nothing when a call would be measuring itself', () => {
    expect(baselineFor(request(), calls([]))).toBeNull();
    expect(baselineFor(request(), calls([50]))).toBeNull();
  });

  it('withholds a percentile it does not have the samples for', () => {
    const result = baselineFor(request({ durationMs: 500 }), calls([40, 50, 60, 70, 80]));

    expect(result?.samples).toBe(5);
    expect(result?.p95Ms).toBeNull();
    // Five samples cannot support "slower than 95% of calls" — and a request
    // ten times the mean is exactly the case where it would be tempting.
    expect(result?.verdict).toBe('typical');
  });

  it('calls a call slow only past a p95 worth the name', () => {
    const slow = baselineFor(request({ durationMs: 400 }), ordinary);

    expect(slow?.samples).toBe(20);
    expect(slow?.p95Ms).toBeCloseTo(58.05, 2);
    expect(slow?.verdict).toBe('slower');
  });

  it('reads a call under the mean as faster, and one above it as typical', () => {
    expect(baselineFor(request({ durationMs: 41 }), ordinary)?.verdict).toBe('faster');
    // Slower than the mean is true of roughly half of all calls, and half of
    // all calls are not a problem.
    expect(baselineFor(request({ durationMs: 55 }), ordinary)?.verdict).toBe('typical');
  });

  it('reports the stretch of time the samples cover', () => {
    const result = baselineFor(request(), ordinary);
    expect(result?.windowMs).toBe(19_000);
    expect(result?.avgMs).toBeCloseTo(49.5, 5);
  });
});
