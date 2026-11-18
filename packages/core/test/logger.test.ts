import { setLogSink, warn, warnOnce } from '@reqray/core';
import { resetWarnings } from '@reqray/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  setLogSink(null);
  resetWarnings();
});

describe('logger', () => {
  it('tags its own messages', () => {
    const sink = { info: vi.fn(), warn: vi.fn() };
    setLogSink(sink);

    warn('pg: failed to patch');
    expect(sink.warn).toHaveBeenCalledWith('reqray: pg: failed to patch');
  });

  it('warns exactly once per key', () => {
    const sink = { info: vi.fn(), warn: vi.fn() };
    setLogSink(sink);

    for (let i = 0; i < 100; i++) warnOnce('pg.patch', 'pg: instrumentation disabled');
    warnOnce('mysql.patch', 'mysql2: instrumentation disabled');

    expect(sink.warn).toHaveBeenCalledTimes(2);
  });

  it('a broken sink does not break the application', () => {
    setLogSink({
      info() {
        throw new Error('logger crashed');
      },
      warn() {
        throw new Error('logger crashed');
      },
    });

    expect(() => warn('something')).not.toThrow();
  });
});
