/**
 * The live feed across a broken connection.
 *
 * The browser reconnects an `EventSource` by itself and says nothing about
 * it. The stream carries no backlog, so everything recorded while the
 * connection was down is gone — and the panel would show a list with a hole
 * in the middle of it, which is worse than a list that starts over.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeToRequests } from '../src/api/index';

/** Just enough of `EventSource` to be opened, broken and reopened. */
class FakeEventSource {
  static last: FakeEventSource | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  close(): void {
    this.closed = true;
  }

  /** What the browser does when the connection comes up. */
  open(): void {
    this.onopen?.();
  }

  /** What the browser does when it drops; it retries on its own afterwards. */
  drop(): void {
    this.onerror?.();
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const globals = globalThis as unknown as {
  EventSource?: unknown;
  window?: unknown;
};

function connect(onRow = vi.fn(), onReconnect = vi.fn()) {
  globals.EventSource = FakeEventSource;
  globals.window = { location: { pathname: '/_reqray/' } };
  const stop = subscribeToRequests(onRow, onReconnect);
  const source = FakeEventSource.last as FakeEventSource;
  return { stop, source, onRow, onReconnect };
}

afterEach(() => {
  globals.EventSource = undefined;
  globals.window = undefined;
  FakeEventSource.last = null;
});

describe('the live feed', () => {
  it('connects to the panel it is mounted under', () => {
    const { source } = connect();

    expect(source.url).toBe('/_reqray/api/stream');
  });

  it('hands over the rows it is sent', () => {
    const { source, onRow } = connect();

    source.deliver({ id: 'r1', path: '/api/orders' });

    expect(onRow).toHaveBeenCalledWith({ id: 'r1', path: '/api/orders' });
  });

  it('a malformed frame does not take the feed with it', () => {
    const { source, onRow } = connect();

    expect(() => source.onmessage?.({ data: 'not json' })).not.toThrow();
    source.deliver({ id: 'r2' });
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the connection first comes up', () => {
    const { source, onReconnect } = connect();

    source.open();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('reports a reconnection, so the caller can ask what it missed', () => {
    const { source, onReconnect } = connect();
    source.open();

    source.drop();
    source.open();

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('reports every reconnection, not only the first', () => {
    const { source, onReconnect } = connect();

    source.drop();
    source.open();
    source.drop();
    source.open();

    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('a drop that has not reconnected yet is not a reconnection', () => {
    const { source, onReconnect } = connect();

    source.drop();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('closes the connection when told to stop', () => {
    const { stop, source } = connect();

    stop();

    expect(source.closed).toBe(true);
  });
});
