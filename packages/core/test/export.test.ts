import { type RecordedRequest, toCurlScript, toHar } from '@loupe/core';
import { describe, expect, it } from 'vitest';

function request(over: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: 'limit=10',
    status: 200,
    durationMs: 42.7,
    startedAt: Date.UTC(2026, 7, 19, 12, 0, 0),
    spans: [],
    findings: [],
    requestHeaders: { host: 'localhost:3000', authorization: '[redacted]' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: null,
    responseBody: { text: '{"ok":true}', truncated: false },
    logs: [],
    error: null,
    droppedSpans: 0,
    droppedLogs: 0,
    test: null,
    ...over,
  };
}

describe('HAR export', () => {
  it('produces a HAR 1.2 log with one entry per request', () => {
    const har = toHar([request(), request({ id: 'r2' })]) as {
      log: { version: string; entries: unknown[] };
    };

    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(2);
  });

  it('fills the fields a HAR viewer reads', () => {
    const [entry] = (toHar([request()]) as { log: { entries: Array<Record<string, never>> } }).log
      .entries;

    expect(entry).toMatchObject({
      startedDateTime: '2026-08-19T12:00:00.000Z',
      time: 42.7,
      request: { method: 'GET', url: '/api/orders?limit=10' },
      response: { status: 200 },
    });
  });

  it('carries what Loupe knows and HAR does not, under an extension key', () => {
    const [entry] = (
      toHar([
        request({
          spans: [{ kind: 'db' }, { kind: 'db' }] as never,
          findings: [{ detector: 'n_plus_one' }] as never,
          test: 'orders.spec.ts:42',
        }),
      ]) as { log: { entries: Array<{ _loupe: unknown }> } }
    ).log.entries;

    expect(entry?._loupe).toEqual({ sqlQueries: 2, nPlusOne: true, test: 'orders.spec.ts:42' });
  });

  it('exports masked values as stored, never the originals', () => {
    const har = JSON.stringify(toHar([request()]));

    expect(har).toContain('[redacted]');
  });

  it('an empty selection is an empty log, not a failure', () => {
    expect((toHar([]) as { log: { entries: unknown[] } }).log.entries).toEqual([]);
  });
});

describe('curl export', () => {
  it('writes one runnable command per request', () => {
    const script = toCurlScript([request()], 'http://localhost:3000');

    expect(script).toContain('#!/bin/sh');
    expect(script).toContain("curl -i -X GET 'http://localhost:3000/api/orders?limit=10'");
    // Status and duration ride along as a comment, so the script reads as a log.
    expect(script).toContain('# 200 · 43 ms');
  });

  it('sends the body of a request that had one', () => {
    const script = toCurlScript(
      [
        request({
          method: 'POST',
          requestBody: { text: '{"orderId":3}', truncated: false },
        }),
      ],
      'http://localhost:3000',
    );

    expect(script).toContain('--data \'{"orderId":3}\'');
  });

  it('leaves out the headers curl owns', () => {
    const script = toCurlScript(
      [request({ requestHeaders: { host: 'x', 'content-length': '10', accept: 'application/json' } })],
      'http://localhost:3000',
    );

    expect(script).toContain('accept: application/json');
    expect(script).not.toContain('content-length');
    expect(script).not.toContain('host: x');
  });

  it('quotes values that would otherwise break out of the shell', () => {
    const script = toCurlScript(
      [request({ query: "q=';rm -rf /" })],
      'http://localhost:3000',
    );

    // The dangerous quote is escaped rather than closing the argument.
    expect(script).toContain(`'\\''`);
    expect(script).not.toMatch(/curl -i -X GET '[^']*';rm/);
  });

  it('says out loud that masked values will not authenticate', () => {
    expect(toCurlScript([request()], 'http://x')).toContain('masked');
  });
});
