/**
 * The client against a collector that is really listening.
 *
 * Every failure a person can hit is here: nothing listening at all, a gate
 * that wants a token, an id that has left the buffer, and a stream that goes
 * away mid-flight.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parsePrintable, ReqrayClient } from '../src/client.js';
import { type CliError, UnreachableError } from '../src/errors.js';
import { fakeCollector } from './fixtures/collector.js';
import { ordersWithNPlusOne } from './fixtures/records.js';
import { calmRows, failedRow } from './fixtures/rows.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const collector of open.splice(0)) await collector.close();
});

async function collector(options: Parameters<typeof fakeCollector>[0] = {}) {
  const started = await fakeCollector(options);
  open.push(started);
  return started;
}

describe('what the panel sends is printed on a terminal', () => {
  it('strips escape sequences from every string, at any depth', () => {
    // Whoever sent the request wrote these: a test name from a header, a
    // message from a body the application echoed into an exception.
    const sent = JSON.stringify({
      test: 'checkout\u001b[2J\u001b]0;owned\u0007',
      error: { message: 'bad\rinput\u009b31m' },
      spans: [{ sql: 'SELECT 1\n\tFROM orders' }],
      status: 500,
    });

    expect(parsePrintable(sent)).toEqual({
      test: 'checkout[2J]0;owned',
      error: { message: 'badinput31m' },
      // Layout survives: a query keeps its line breaks and its indentation.
      spans: [{ sql: 'SELECT 1\n\tFROM orders' }],
      status: 500,
    });
  });
});

describe('asking the panel', () => {
  it('reads the process behind it', async () => {
    const panel = await collector();
    const client = new ReqrayClient({ url: panel.url });

    expect(await client.meta()).toMatchObject({ pid: 41_822, bufferSize: 500 });
  });

  it('reads a page of the list', async () => {
    const panel = await collector({ rows: calmRows() });
    const client = new ReqrayClient({ url: panel.url });

    const page = await client.list({ limit: 3 });
    expect(page.requests).toHaveLength(3);
    expect(page.summary.total).toBe(8);
  });

  it('asks for the slowest, and for what failed, rather than sorting them here', async () => {
    const panel = await collector({ rows: [...calmRows(), failedRow()] });
    const client = new ReqrayClient({ url: panel.url });

    expect((await client.list({ limit: 1, sort: 'slowest' })).requests[0]?.id).toBe('9012');
    expect((await client.list({ limit: 1, onlyErrors: true })).requests[0]?.id).toBe('9012');
  });

  it('reads one request whole, and the same bytes unparsed', async () => {
    const detail = ordersWithNPlusOne();
    const panel = await collector({ details: [detail] });
    const client = new ReqrayClient({ url: panel.url });

    expect((await client.detail('8974')).spans).toHaveLength(detail.spans.length);
    expect(JSON.parse(await client.detailRaw('8974'))).toEqual(JSON.parse(JSON.stringify(detail)));
  });

  it('carries the token a gated collector wants', async () => {
    const panel = await collector({ token: 'shh' });

    await expect(new ReqrayClient({ url: panel.url }).meta()).rejects.toThrow(/refused/);
    await expect(new ReqrayClient({ url: panel.url, token: 'shh' }).meta()).resolves.toMatchObject({
      pid: 41_822,
    });
  });

  it('says a request is gone rather than repeating a status code', async () => {
    const panel = await collector();
    const client = new ReqrayClient({ url: panel.url });

    await expect(client.detail('nope')).rejects.toThrow(/possibly evicted/);
  });

  it('turns nothing-listening into one sentence and a way out', async () => {
    // Port 1 is reserved and never accepts, which is what makes it useful.
    const client = new ReqrayClient({ url: 'http://127.0.0.1:1/_reqray' });

    const failure = await client.meta().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnreachableError);
    expect((failure as CliError).message).toBe('cannot reach the collector');
    expect((failure as CliError).exitCode).toBe(1);
    expect((failure as CliError).hints.join('\n')).toContain('REQRAY_URL=');
  });
});

describe('the live stream', () => {
  it('hands over rows as they arrive', async () => {
    const panel = await collector();
    const client = new ReqrayClient({ url: panel.url });
    const controller = new AbortController();
    const seen: string[] = [];

    const running = client.stream({
      signal: controller.signal,
      onRow: (row) => seen.push((row as { id: string }).id),
      onNotice: () => {},
    });

    await until(() => panel.watchers() === 1);
    for (const row of calmRows().slice(0, 3)) panel.push(row);
    await until(() => seen.length === 3);
    controller.abort();
    await running;

    expect(seen).toEqual(['8970', '8971', '8974']);
  });

  it('reconnects when the application restarts, and says so once', async () => {
    const panel = await collector();
    const client = new ReqrayClient({ url: panel.url });
    const controller = new AbortController();
    const notices: string[] = [];
    const seen: string[] = [];

    const running = client.stream({
      signal: controller.signal,
      onRow: (row) => seen.push((row as { id: string }).id),
      onNotice: (text) => notices.push(text),
      // Backoff without the waiting: the delay is the client's decision, and
      // the test is about what it does, not about how long it sleeps.
      sleep: async () => {},
    });

    await until(() => panel.watchers() === 1);
    panel.push(calmRows()[0] as never);
    await until(() => seen.length === 1);

    panel.drop();
    await until(() => panel.watchers() === 1 && notices.length >= 2);
    panel.push(calmRows()[1] as never);
    await until(() => seen.length === 2);
    controller.abort();
    await running;

    expect(notices[0]).toMatch(/connection lost, reconnecting in 500 ms \(attempt 1\)/);
    expect(notices[1]).toBe('reconnected');
    // And no row was lost in the process.
    expect(seen).toEqual(['8970', '8971']);
  });

  it('stops immediately when asked to, without an error', async () => {
    const panel = await collector();
    const client = new ReqrayClient({ url: panel.url });
    const controller = new AbortController();

    const running = client.stream({
      signal: controller.signal,
      onRow: () => {},
      onNotice: () => {},
    });
    await until(() => panel.watchers() === 1);
    controller.abort();

    await expect(running).resolves.toBeUndefined();
    await until(() => panel.watchers() === 0);
  });

  it('skips the keep-alive comments without a word', async () => {
    const panel = await collector();
    const client = new ReqrayClient({ url: panel.url });
    const controller = new AbortController();
    const notices: string[] = [];
    const seen: unknown[] = [];

    const running = client.stream({
      signal: controller.signal,
      onRow: (row) => seen.push(row),
      onNotice: (text) => notices.push(text),
    });
    await until(() => panel.watchers() === 1);
    panel.push(calmRows()[0] as never);
    await until(() => seen.length === 1);
    controller.abort();
    await running;

    expect(notices).toEqual([]);
  });
});

/** Waits for a condition, or gives up loudly. */
async function until(ready: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the stream');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
