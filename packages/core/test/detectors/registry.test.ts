import {
  type RequestScope,
  resetDetectors,
  resolveOptions,
  runDetectors,
  setLogSink,
} from '@loupe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = resolveOptions({ mode: 'development' });

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

    const findings = runDetectors(builder.done(), options);
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

    expect(runDetectors(scope, resolveOptions({ detect: { nPlusOne: false } }))).toEqual([]);
  });

  it('a crashed detector is disabled and warns exactly once', () => {
    const warn = vi.fn();
    setLogSink({ info: vi.fn(), warn });

    const broken = {
      get spans(): never {
        throw new Error('detector is looking into a broken scope');
      },
    } as unknown as RequestScope;

    expect(() => runDetectors(broken, options)).not.toThrow();
    expect(runDetectors(broken, options)).toEqual([]);
    // One warning per detector — both looked into the broken scope — and
    // never a second one for the same detector.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('n_plus_one');
    expect(warn.mock.calls[1]?.[0]).toContain('sequential_http');

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
    expect(runDetectors(healthy, options)).toEqual([]);

    resetDetectors();
    expect(runDetectors(healthy, options)).toHaveLength(1);
  });
});
