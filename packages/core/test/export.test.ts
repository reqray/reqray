import { type RecordedRequest, timingOf, weightOf } from '@reqray/core';
import { toCurlScript, toHar } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

function request(over: Partial<RecordedRequest> = {}): RecordedRequest {
  const base = {
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
    responseBody: { text: '{"ok":true}', truncated: false, bytes: 11 },
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

  it('carries what Reqray knows and HAR does not, under an extension key', () => {
    const [entry] = (
      toHar([
        request({
          spans: [{ kind: 'db' }, { kind: 'db' }] as never,
          findings: [{ detector: 'n_plus_one' }] as never,
          test: 'orders.spec.ts:42',
        }),
      ]) as { log: { entries: Array<{ _reqray: unknown }> } }
    ).log.entries;

    expect(entry?._reqray).toEqual({ sqlQueries: 2, nPlusOne: true, test: 'orders.spec.ts:42' });
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
          requestBody: { text: '{"orderId":3}', truncated: false, bytes: 13 },
        }),
      ],
      'http://localhost:3000',
    );

    expect(script).toContain('--data \'{"orderId":3}\'');
  });

  it('leaves out the headers curl owns', () => {
    const script = toCurlScript(
      [
        request({
          requestHeaders: { host: 'x', 'content-length': '10', accept: 'application/json' },
        }),
      ],
      'http://localhost:3000',
    );

    expect(script).toContain('accept: application/json');
    expect(script).not.toContain('content-length');
    expect(script).not.toContain('host: x');
  });

  it('quotes values that would otherwise break out of the shell', () => {
    const script = toCurlScript([request({ query: "q=';rm -rf /" })], 'http://localhost:3000');

    // The dangerous quote is escaped rather than closing the argument.
    expect(script).toContain(`'\\''`);
    expect(script).not.toMatch(/curl -i -X GET '[^']*';rm/);
  });

  it('says out loud that masked values will not authenticate', () => {
    expect(toCurlScript([request()], 'http://x')).toContain('masked');
  });

  it('a cut export says it was cut, in both formats', () => {
    // An export is evidence — it gets attached to a ticket and argued from.
    // One presented as complete when it is a slice is worse than none.
    const note = '3 older requests matched and were left out';

    expect(toCurlScript([request()], 'http://x', note)).toContain(note);
    const har = toHar([request()], new Date(0), note) as {
      log: { comment?: string };
    };
    expect(har.log.comment).toBe(note);
  });

  it('an export that carried everything claims nothing', () => {
    expect(toCurlScript([request()], 'http://x')).not.toContain('left out');
    expect((toHar([request()]) as { log: { comment?: string } }).log.comment).toBeUndefined();
  });
});

describe('a script somebody will run', () => {
  it('keeps a test name on its comment line, whatever it holds', () => {
    // The name is attacker-reachable: any client can send the header. A line
    // break in it would end the comment and start a command.
    const script = toCurlScript(
      [request({ test: 'checkout\ntouch /tmp/owned' })],
      'http://localhost:3000',
    );

    expect(script).toContain('# 200 · 43 ms · checkout touch /tmp/owned');
    expect(script.split('\n').filter((line) => line.startsWith('touch'))).toEqual([]);
  });
});
