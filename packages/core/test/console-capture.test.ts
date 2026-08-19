/**
 * Console capture: the terminal must never notice the tap, the record must
 * get the lines of its own request and nothing else.
 */

import {
  instrumentConsole,
  RequestScope,
  resolveOptions,
  runInScope,
  uninstrumentConsole,
} from '@loupe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

function makeScope(logs = true) {
  return new RequestScope({
    id: 'r1',
    method: 'GET',
    path: '/orders',
    options: resolveOptions({ mode: 'development', logs }),
  });
}

/** Swaps `console[method]` for a spy, runs the body, restores everything. */
function withSpy(method: 'log' | 'error', body: (spy: ReturnType<typeof vi.fn>) => void): void {
  const saved = console[method];
  const spy = vi.fn();
  console[method] = spy as unknown as Console[typeof method];
  try {
    instrumentConsole();
    body(spy);
  } finally {
    uninstrumentConsole();
    console[method] = saved;
  }
}

afterEach(() => uninstrumentConsole());

describe('console capture', () => {
  it('a line lands in the request record and reaches the terminal unchanged', () => {
    withSpy('log', (spy) => {
      const scope = makeScope();
      runInScope(scope, () => console.log('loading %d orders', 42));

      expect(spy).toHaveBeenCalledExactlyOnceWith('loading %d orders', 42);
      expect(scope.logs).toEqual([
        expect.objectContaining({ level: 'info', message: 'loading 42 orders' }),
      ]);
    });
  });

  it('console.error is recorded with the error level', () => {
    withSpy('error', () => {
      const scope = makeScope();
      runInScope(scope, () => console.error('everything broke'));

      expect(scope.logs[0]).toMatchObject({ level: 'error', message: 'everything broke' });
    });
  });

  it('outside a scope only passthrough happens, nothing is recorded', () => {
    withSpy('log', (spy) => {
      console.log('a line outside any request');
      expect(spy).toHaveBeenCalledExactlyOnceWith('a line outside any request');
    });
  });

  it('line cap per request: extras are counted, not hoarded', () => {
    withSpy('log', () => {
      const scope = makeScope();
      runInScope(scope, () => {
        for (let i = 0; i < 205; i++) console.log('line', i);
      });

      expect(scope.logs).toHaveLength(200);
      expect(scope.droppedLogs).toBe(5);
    });
  });

  it('a line with a sensitive word is replaced with a marker', () => {
    withSpy('log', () => {
      const scope = makeScope();
      runInScope(scope, () => console.log('issued api_token=abc123 for ada'));

      expect(scope.logs[0]?.message).not.toContain('abc123');
      expect(scope.logs[0]?.message).toContain('token');
    });
  });

  it('logs: false disables recording but not passthrough', () => {
    withSpy('log', (spy) => {
      const scope = makeScope(false);
      runInScope(scope, () => console.log('a quiet line'));

      expect(spy).toHaveBeenCalledOnce();
      expect(scope.logs).toHaveLength(0);
    });
  });

  it('installing twice does not stack wrappers', () => {
    withSpy('log', (spy) => {
      instrumentConsole();
      instrumentConsole();
      const scope = makeScope();
      runInScope(scope, () => console.log('once'));

      expect(spy).toHaveBeenCalledOnce();
      expect(scope.logs).toHaveLength(1);
    });
  });
});
