import {
  assertPanelAllowed,
  createLoupe,
  type Finding,
  isPanelRequestAllowed,
  PanelGateError,
  type RecordedRequest,
  resolveOptions,
  shouldRetain,
  type Transport,
} from '@loupe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

function collector(): Transport & { sent: RecordedRequest[] } {
  const sent: RecordedRequest[] = [];
  return {
    name: 'test',
    sent,
    send(request) {
      sent.push(request);
    },
  };
}

const finding = { detector: 'n_plus_one', costMs: 40 } as unknown as Finding;

describe('sampling', () => {
  const options = resolveOptions({ mode: 'production', enabled: true }).sampling;

  it('keeps everything locally', () => {
    const local = resolveOptions({ mode: 'development' }).sampling;
    expect(local.rate).toBe(1);
    expect(
      shouldRetain(
        local,
        { durationMs: 1, status: 200, hasError: false, findings: [] },
        () => 0.99,
      ),
    ).toBe(true);
  });

  it('in production trims ordinary requests to the base rate', () => {
    expect(options.rate).toBe(0.01);
    const normal = { durationMs: 10, status: 200, hasError: false, findings: [] };

    expect(shouldRetain(options, normal, () => 0.5)).toBe(false);
    expect(shouldRetain(options, normal, () => 0.001)).toBe(true);
  });

  it('keeps errors and slow requests regardless of the rate', () => {
    const never = () => 0.99;

    expect(
      shouldRetain(options, { durationMs: 1, status: 500, hasError: false, findings: [] }, never),
    ).toBe(true);
    expect(
      shouldRetain(options, { durationMs: 1, status: 200, hasError: true, findings: [] }, never),
    ).toBe(true);
    expect(
      shouldRetain(options, { durationMs: 900, status: 200, hasError: false, findings: [] }, never),
    ).toBe(true);
  });

  it('in production a finding retains the request only when opted in', () => {
    const never = () => 0.99;
    const withFinding = { durationMs: 1, status: 200, hasError: false, findings: [finding] };

    // Off by default: making the finding a retention reason would force the
    // detectors to run on every request; slow N+1s reach the sample anyway.
    expect(shouldRetain(options, withFinding, never)).toBe(false);

    const optIn = resolveOptions({
      mode: 'production',
      enabled: true,
      sampling: { alwaysOnFinding: true },
    }).sampling;
    expect(shouldRetain(optIn, withFinding, never)).toBe(true);
  });

  it('a zero rate keeps nothing ordinary', () => {
    const off = resolveOptions({ sampling: { rate: 0 } }).sampling;
    expect(
      shouldRetain(off, { durationMs: 1, status: 200, hasError: false, findings: [] }, () => 0),
    ).toBe(false);
  });
});

describe('panel access', () => {
  it('local development requires no gate', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => assertPanelAllowed(resolveOptions())).not.toThrow();
  });

  it('unset NODE_ENV counts as local development', () => {
    vi.stubEnv('NODE_ENV', undefined);
    expect(() => assertPanelAllowed(resolveOptions())).not.toThrow();
  });

  it('staging without a gate fails at startup instead of opening silently', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => assertPanelAllowed(resolveOptions())).toThrow(PanelGateError);
    expect(() => assertPanelAllowed(resolveOptions())).toThrow(/gate/);
  });

  it('production without a gate — the same', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertPanelAllowed(resolveOptions({ enabled: true }))).toThrow(PanelGateError);
  });

  it('a configured gate settles the question', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => assertPanelAllowed(resolveOptions({ panel: { gate: () => true } }))).not.toThrow();
    expect(() => assertPanelAllowed(resolveOptions({ panel: { gate: 'open' } }))).not.toThrow();
  });

  it('a disabled panel requires nothing', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => assertPanelAllowed(resolveOptions({ panel: false }))).not.toThrow();
    expect(resolveOptions({ panel: false }).panel).toBeNull();
  });

  it('createLoupe fails at startup when the panel is open without a gate', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => createLoupe()).toThrow(PanelGateError);
  });

  it('checks a specific panel request', () => {
    const context = { headers: { 'x-loupe-token': 'correct' }, ip: '127.0.0.1' };

    expect(isPanelRequestAllowed('open', context)).toBe(true);
    expect(
      isPanelRequestAllowed((ctx) => ctx.headers['x-loupe-token'] === 'correct', context),
    ).toBe(true);
    expect(isPanelRequestAllowed(() => false, context)).toBe(false);
  });

  it('a crashed gate is treated as denial', () => {
    expect(
      isPanelRequestAllowed(
        () => {
          throw new Error('gate crashed');
        },
        { headers: {}, ip: null },
      ),
    ).toBe(false);
  });
});

describe('runtime', () => {
  it('disabled Loupe creates no scope', () => {
    const runtime = createLoupe({ enabled: false });
    expect(runtime.begin({ method: 'GET', path: '/' })).toBeUndefined();
  });

  it('finish on an empty scope does nothing', () => {
    const transport = collector();
    const runtime = createLoupe({ enabled: false, transport });

    expect(() => runtime.finish(undefined, { status: 200 })).not.toThrow();
    expect(transport.sent).toEqual([]);
  });

  it('brackets the log with request start and end', async () => {
    const transport = collector();
    const runtime = createLoupe({ mode: 'development', transport });

    const scope = runtime.begin({ method: 'GET', path: '/api/orders' });
    runtime.finish(scope, { status: 200 });
    await new Promise((resolve) => setImmediate(resolve));

    const messages = transport.sent[0]?.logs.map((entry) => entry.message) ?? [];
    expect(messages[0]).toBe('→ GET /api/orders');
    expect(messages.at(-1)).toMatch(/^← 200 in /);
  });

  it('records the request off the hot path, not synchronously', () => {
    const transport = collector();
    const runtime = createLoupe({ mode: 'development', transport });

    const scope = runtime.begin({ method: 'GET', path: '/' });
    runtime.finish(scope, { status: 200 });

    // Right after finish nothing is recorded yet: detectors and redaction run
    // after the response has been sent.
    expect(transport.sent).toEqual([]);
  });
});
