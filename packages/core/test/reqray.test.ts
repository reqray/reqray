import {
  assertPanelAllowed,
  createReqray,
  type Finding,
  isPanelRequestAllowed,
  multiTransport,
  PanelGateError,
  type RecordedRequest,
  type Reqray,
  resolveOptions,
  shouldRetain,
  type Transport,
} from '@reqray/core';
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

  it('createReqray fails at startup when the panel is open without a gate', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => createReqray()).toThrow(PanelGateError);
  });

  it('checks a specific panel request', () => {
    const context = { headers: { 'x-reqray-token': 'correct' }, ip: '127.0.0.1' };

    expect(isPanelRequestAllowed('open', context)).toBe(true);
    expect(
      isPanelRequestAllowed((ctx) => ctx.headers['x-reqray-token'] === 'correct', context),
    ).toBe(true);
    expect(isPanelRequestAllowed(() => false, context)).toBe(false);
  });

  it('no gate means this machine only, not everyone', () => {
    // "No gate" is granted to local development, and NODE_ENV is a poor
    // witness of that: a server deployed without it reads as a laptop.
    const local = { headers: { host: 'localhost:3000' }, ip: '127.0.0.1' };

    expect(isPanelRequestAllowed(null, local)).toBe(true);
    expect(isPanelRequestAllowed(null, { ...local, ip: '::ffff:127.0.0.1' })).toBe(true);
    expect(isPanelRequestAllowed(null, { headers: { host: '[::1]:3000' }, ip: '::1' })).toBe(true);
    expect(isPanelRequestAllowed(null, { ...local, ip: '203.0.113.7' })).toBe(false);
    expect(isPanelRequestAllowed(null, { ...local, ip: null })).toBe(false);
    expect(
      isPanelRequestAllowed(null, { headers: { host: 'evil.example' }, ip: '127.0.0.1' }),
    ).toBe(false);
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
  it('disabled Reqray creates no scope', () => {
    const runtime = createReqray({ enabled: false });
    expect(runtime.begin({ method: 'GET', path: '/' })).toBeUndefined();
  });

  it('finish on an empty scope does nothing', () => {
    const transport = collector();
    const runtime = createReqray({ enabled: false, transport });

    expect(() => runtime.finish(undefined, { status: 200 })).not.toThrow();
    expect(transport.sent).toEqual([]);
  });

  it('brackets the log with request start and end', async () => {
    const transport = collector();
    const runtime = createReqray({ mode: 'development', transport });

    const scope = runtime.begin({ method: 'GET', path: '/api/orders' });
    runtime.finish(scope, { status: 200 });
    await new Promise((resolve) => setImmediate(resolve));

    const messages = transport.sent[0]?.logs.map((entry) => entry.message) ?? [];
    expect(messages[0]).toBe('→ GET /api/orders');
    expect(messages.at(-1)).toMatch(/^← 200 in /);
  });

  it('records the request off the hot path, not synchronously', () => {
    const transport = collector();
    const runtime = createReqray({ mode: 'development', transport });

    const scope = runtime.begin({ method: 'GET', path: '/' });
    runtime.finish(scope, { status: 200 });

    // Right after finish nothing is recorded yet: detectors and redaction run
    // after the response has been sent.
    expect(transport.sent).toEqual([]);
  });
});

describe('what a request may put into its own record', () => {
  async function recorded(outcome: Parameters<Reqray['finish']>[1]): Promise<RecordedRequest> {
    const transport = collector();
    const runtime = createReqray({ mode: 'development', transport });
    runtime.finish(runtime.begin({ method: 'GET', path: '/api/orders' }), outcome);
    await new Promise((resolve) => setImmediate(resolve));
    const [only] = transport.sent;
    if (!only) throw new Error('nothing was recorded');
    return only;
  }

  it('a decoded test name carries no control characters', async () => {
    // `%0A` decodes to a line break — which a header could never hold, and
    // which later lands in an exported shell script and on a terminal.
    const record = await recorded({
      status: 200,
      requestHeaders: { 'x-reqray-test': 'checkout%0Atouch /tmp/owned%1B[2J' },
    });

    expect(record.test).toBe('checkout touch /tmp/owned [2J');
  });

  it('masks a sensitive parameter in the query string', async () => {
    const record = await recorded({ status: 200, query: 'page=2&reset_token=abc&q=a%3Db' });

    expect(record.query).toBe('page=2&reset_token=[redacted]&q=a%3Db');
  });
});

describe('several transports', () => {
  it('all get the request, in order', () => {
    const seen: string[] = [];
    const one: Transport = { name: 'one', send: () => seen.push('one') };
    const two: Transport = { name: 'two', send: () => seen.push('two') };

    multiTransport([one, two]).send({ id: 'r1' } as never);

    expect(seen).toEqual(['one', 'two']);
  });

  it('a broken one does not cost the others the request', () => {
    const seen: string[] = [];
    const broken: Transport = {
      name: 'broken',
      send: () => {
        throw new Error('the disk is full');
      },
    };
    const store: Transport = { name: 'store', send: () => seen.push('store') };

    expect(() => multiTransport([broken, store]).send({ id: 'r1' } as never)).not.toThrow();
    expect(seen).toEqual(['store']);
  });

  it('flushes and closes every one of them', async () => {
    const closed: string[] = [];
    const make = (name: string): Transport => ({
      name,
      send: () => {},
      flush: async () => void closed.push(`flush:${name}`),
      close: async () => void closed.push(`close:${name}`),
    });

    const both = multiTransport([make('a'), make('b')]);
    await both.flush?.();
    await both.close?.();

    expect(closed).toEqual(['flush:a', 'flush:b', 'close:a', 'close:b']);
    expect(both.name).toBe('a+b');
  });

  it('one transport is that transport, not a wrapper around it', () => {
    const only: Transport = { name: 'only', send: () => {} };

    expect(multiTransport([only])).toBe(only);
  });
});
