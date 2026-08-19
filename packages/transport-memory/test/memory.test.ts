import type { RecordedRequest } from '@loupe/core';
import { memoryTransport } from '@loupe/transport-memory';
import { describe, expect, it, vi } from 'vitest';

function request(id: string, startedAt = 1_000): RecordedRequest {
  return {
    id,
    method: 'GET',
    path: `/${id}`,
    query: null,
    status: 200,
    durationMs: 5,
    startedAt,
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
  };
}

describe('in-memory transport', () => {
  it('lists requests from newest to oldest', () => {
    const store = memoryTransport();
    store.send(request('a'));
    store.send(request('b'));

    expect(store.list().map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('finds a request by id', () => {
    const store = memoryTransport();
    store.send(request('a'));

    expect(store.get('a')?.path).toBe('/a');
    expect(store.get('no-such-id')).toBeUndefined();
  });

  it('does not grow past the limit and forgets evicted ids', () => {
    const store = memoryTransport({ capacity: 2 });
    store.send(request('a'));
    store.send(request('b'));
    store.send(request('c'));

    expect(store.list().map((item) => item.id)).toEqual(['c', 'b']);
    expect(store.get('a')).toBeUndefined();
    expect(store.stats()).toMatchObject({ size: 2, capacity: 2, evicted: 1 });
  });

  it('reports the age of the oldest record', () => {
    const store = memoryTransport();
    store.send(request('a', 1_000));
    store.send(request('b', 2_000));

    expect(store.stats().oldestAt).toBe(1_000);
    store.clear();
    expect(store.stats()).toMatchObject({ size: 0, oldestAt: null });
  });

  it('notifies subscribers and can unsubscribe them', () => {
    const store = memoryTransport();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.send(request('a'));
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    store.send(request('b'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('a broken subscriber does not break data collection', () => {
    const store = memoryTransport();
    store.subscribe(() => {
      throw new Error('subscriber crashed');
    });
    const healthy = vi.fn();
    store.subscribe(healthy);

    expect(() => store.send(request('a'))).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    expect(store.list()).toHaveLength(1);
  });
});
