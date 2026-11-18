import { type RecordedRequest, timingOf, weightOf } from '@reqray/core';
import { memoryTransport, PIN_LIMIT } from '@reqray/store-memory';
import { describe, expect, it, vi } from 'vitest';

function request(id: string, startedAt = 1_000): RecordedRequest {
  const base = {
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
    test: null,
  };
  return {
    ...base,
    timing: timingOf(base.spans, base.durationMs),
    host: null,
    weight: weightOf(base),
    cost: null,
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

  describe('pinning', () => {
    it('keeps a pinned request the ring has dropped', () => {
      const store = memoryTransport({ capacity: 2 });
      store.send(request('a', 1_000));
      store.pin('a', true);
      store.send(request('b', 2_000));
      store.send(request('c', 3_000));

      // 'a' was pushed out of a two-slot ring, and is still here.
      expect(store.list().map((item) => item.id)).toEqual(['c', 'b', 'a']);
      expect(store.get('a')?.path).toBe('/a');
      expect(store.pinned()).toEqual(['a']);
    });

    it('lets a request go again, and the ring forgets it', () => {
      const store = memoryTransport({ capacity: 2 });
      store.send(request('a', 1_000));
      store.pin('a', true);
      store.send(request('b', 2_000));
      store.send(request('c', 3_000));

      store.pin('a', false);

      expect(store.list().map((item) => item.id)).toEqual(['c', 'b']);
      expect(store.get('a')).toBeUndefined();
      expect(store.pinned()).toEqual([]);
    });

    it('refuses to pin what is already gone', () => {
      const store = memoryTransport({ capacity: 1 });
      store.send(request('a'));
      store.send(request('b'));

      expect(store.pin('a', true)).toBe(false);
      expect(store.pinned()).toEqual([]);
    });

    it('pinning is bounded — it suspends the ring, it does not remove the bound', () => {
      const store = memoryTransport({ capacity: PIN_LIMIT + 10 });
      for (let i = 0; i < PIN_LIMIT + 5; i++) store.send(request(`r${i}`, 1_000 + i));

      const accepted = Array.from({ length: PIN_LIMIT + 5 }, (_, i) => store.pin(`r${i}`, true));

      expect(accepted.filter(Boolean)).toHaveLength(PIN_LIMIT);
      expect(store.pinned()).toHaveLength(PIN_LIMIT);
      // Unpinning always works, and makes room again.
      expect(store.pin('r0', false)).toBe(true);
      expect(store.pin(`r${PIN_LIMIT + 4}`, true)).toBe(true);
    });

    it('unpinning something that was never pinned is not an error', () => {
      const store = memoryTransport();

      expect(store.pin('nope', false)).toBe(true);
    });

    it('counts pins in the stats without inflating the ring', () => {
      const store = memoryTransport({ capacity: 2 });
      store.send(request('a', 1_000));
      store.pin('a', true);
      store.send(request('b', 2_000));
      store.send(request('c', 3_000));

      const stats = store.stats();
      expect(stats.pinned).toBe(1);
      expect(stats.size).toBe(2);
      // The oldest retained request, pinned survivors included.
      expect(stats.oldestAt).toBe(1_000);
    });

    it('clear means clear, pins included', () => {
      const store = memoryTransport();
      store.send(request('a'));
      store.pin('a', true);

      store.clear();

      expect(store.list()).toEqual([]);
      expect(store.pinned()).toEqual([]);
    });
  });
});

describe('findings', () => {
  const flagged = (id: string, startedAt: number): RecordedRequest => ({
    ...request(id, startedAt),
    findings: [
      {
        detector: 'n_plus_one',
        severity: 'warn',
        title: 'queries in a loop',
        costMs: 20,
        callsite: null,
        evidence: {
          kind: 'budget',
          durationMs: 5,
          budgetMs: 1,
          externalMs: 0,
          sqlMs: 0,
          spanIds: [],
        },
        hint: 'batch them',
      },
    ],
  });

  it('hands over occurrence rows for the window, and only those', () => {
    const store = memoryTransport();
    store.send(request('quiet', 1_000));
    store.send(flagged('early', 1_000));
    store.send(flagged('inside', 5_000));

    const read = store.findings({ from: 2_000 });

    expect(read.truncated).toBe(false);
    expect(read.samples).toHaveLength(1);
    expect(read.samples[0]).toMatchObject({ requestId: 'inside', detector: 'n_plus_one' });
  });

  it('remembers ack and mute, and forgets on new', () => {
    const store = memoryTransport();
    store.setFindingState('n_plus_one@/x', 'ack');
    store.setFindingState('dup_cache@/y', 'muted');

    expect(store.findingStates().get('n_plus_one@/x')).toBe('ack');
    expect(store.findingStates().get('dup_cache@/y')).toBe('muted');

    store.setFindingState('n_plus_one@/x', 'new');
    expect(store.findingStates().has('n_plus_one@/x')).toBe(false);
  });
});
