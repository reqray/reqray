import { type RequestScope, resolveOptions, runDetectors, setLogSink } from '@reqray/core';
import { resetDetectors } from '@reqray/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = resolveOptions({ mode: 'development' });

/** A request that is not itself slow: the budget detector stays out of the way. */
const FACTS = { durationMs: 100, status: 200, bytesOut: null, contentType: null };

afterEach(() => {
  resetDetectors();
  setLogSink(null);
});

describe('running detectors', () => {
  it('returns findings from most to least costly', () => {
    const builder = scenario();
    builder.loop(6, () => ({
      sql: 'SELECT * FROM a WHERE id = 1',
      duration: 5,
      callsite: 'src/a.ts:1',
    }));
    builder.loop(30, () => ({
      sql: 'SELECT * FROM b WHERE id = 1',
      duration: 20,
      callsite: 'src/b.ts:1',
    }));

    const findings = runDetectors(builder.done(), options, FACTS);
    const costs = findings.map((finding) => finding.costMs);

    expect(costs).toHaveLength(2);
    expect(costs[0]).toBeGreaterThan(costs[1] as number);
  });

  it('a disabled detector does not run', () => {
    const scope = scenario()
      .loop(20, () => ({
        sql: 'SELECT * FROM a WHERE id = 1',
        duration: 10,
        callsite: 'src/a.ts:1',
      }))
      .done();

    expect(runDetectors(scope, resolveOptions({ detect: { nPlusOne: false } }), FACTS)).toEqual([]);
  });

  it('a crashed detector is disabled and warns exactly once', () => {
    const warn = vi.fn();
    setLogSink({ info: vi.fn(), warn });

    const broken = {
      get spans(): never {
        throw new Error('detector is looking into a broken scope');
      },
    } as unknown as RequestScope;

    expect(() => runDetectors(broken, options, FACTS)).not.toThrow();
    expect(runDetectors(broken, options, FACTS)).toEqual([]);
    // One warning per detector that looked into the broken scope, and never a
    // second one for the same detector. The budget detector is not among them:
    // this request is inside its budget, so it never reaches the spans.
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned).toHaveLength(7);
    for (const id of [
      'n_plus_one',
      'sequential_http',
      'dup_http',
      'dup_cache',
      'pool_wait',
      'transaction_hold',
      'slow_code',
    ]) {
      expect(warned.some((message) => message.includes(id))).toBe(true);
    }

    // While the detector is disabled, healthy requests get no findings
    // either — the deliberate price of a failed detector not taking the rest
    // down with it.
    const healthy = scenario()
      .loop(20, () => ({
        sql: 'SELECT * FROM a WHERE id = 1',
        duration: 10,
        callsite: 'src/a.ts:1',
      }))
      .done();
    expect(runDetectors(healthy, options, FACTS)).toEqual([]);

    resetDetectors();
    expect(runDetectors(healthy, options, FACTS)).toHaveLength(1);
  });
});
