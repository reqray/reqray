import {
  captureCallsite,
  findProjectFrame,
  isProjectFrame,
  parseStackFrame,
  RequestScope,
  resetLearnedCallsites,
  resolveCallsite,
  resolveOptions,
  withHandedCallsite,
} from '@loupe/core';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  resetLearnedCallsites();
});

const ROOT = '/srv/app';
const stackOptions = resolveOptions({ stack: { projectRoot: ROOT } }).stack;

describe('parsing a stack line', () => {
  it('reads a frame with a function name', () => {
    expect(parseStackFrame('    at listOrders (/srv/app/src/orders.ts:118:14)')).toEqual({
      file: '/srv/app/src/orders.ts',
      line: 118,
      column: 14,
    });
  });

  it('reads a frame without a function name', () => {
    expect(parseStackFrame('    at /srv/app/src/orders.ts:9:3')).toEqual({
      file: '/srv/app/src/orders.ts',
      line: 9,
      column: 3,
    });
  });

  it('reads async and method frames', () => {
    expect(parseStackFrame('    at async OrderService.list (/srv/app/src/svc.ts:4:5)')?.file).toBe(
      '/srv/app/src/svc.ts',
    );
    expect(parseStackFrame('    at new Repo (/srv/app/src/repo.ts:1:1)')?.line).toBe(1);
  });

  it('turns an ESM file:// URL into a path', () => {
    expect(parseStackFrame('    at run (file:///srv/app/src/main.mjs:12:1)')?.file).toBe(
      '/srv/app/src/main.mjs',
    );
  });

  it('ignores anything that is not a frame', () => {
    expect(parseStackFrame('Error: boom')).toBeNull();
    expect(parseStackFrame('    at <anonymous>')).toBeNull();
    expect(parseStackFrame('')).toBeNull();
  });
});

describe('what counts as project code', () => {
  it('a file inside the project root counts', () => {
    expect(isProjectFrame('/srv/app/src/orders.ts', stackOptions)).toBe(true);
  });

  it('node_modules does not count', () => {
    expect(isProjectFrame('/srv/app/node_modules/pg/lib/client.js', stackOptions)).toBe(false);
  });

  it('Node internals do not count', () => {
    expect(isProjectFrame('node:internal/process/task_queues', stackOptions)).toBe(false);
    expect(isProjectFrame('internal/process/task_queues.js', stackOptions)).toBe(false);
  });

  it('a file outside the project root does not count', () => {
    expect(isProjectFrame('/opt/other/app.js', stackOptions)).toBe(false);
  });

  it('respects the exclude list', () => {
    const options = resolveOptions({
      stack: { projectRoot: ROOT, exclude: ['/src/generated/'] },
    }).stack;
    expect(isProjectFrame('/srv/app/src/generated/client.ts', options)).toBe(false);
    expect(isProjectFrame('/srv/app/src/orders.ts', options)).toBe(true);
  });
});

describe('finding the first project line', () => {
  const stack = [
    'Error',
    '    at Client.query (/srv/app/node_modules/pg/lib/client.js:520:11)',
    '    at PrismaClient._request (/srv/app/node_modules/@prisma/client/runtime/library.js:1:1)',
    '    at listOrders (/srv/app/src/services/orders.ts:118:14)',
    '    at handler (/srv/app/src/routes.ts:12:3)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');

  it('skips node_modules and takes the first project frame', () => {
    expect(findProjectFrame(stack, stackOptions)).toEqual({
      file: '/srv/app/src/services/orders.ts',
      relative: 'src/services/orders.ts',
      line: 118,
      column: 14,
    });
  });

  it('returns null when the stack has no project code', () => {
    const foreign = [
      'Error',
      '    at Client.query (/srv/app/node_modules/pg/lib/client.js:520:11)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');

    expect(findProjectFrame(foreign, stackOptions)).toBeNull();
  });
});

describe('stack capture', () => {
  it('finds the calling line and puts Error.stackTraceLimit back', () => {
    const before = Error.stackTraceLimit;
    const callsite = captureCallsite(resolveOptions().stack);

    expect(Error.stackTraceLimit).toBe(before);
    expect(callsite?.relative).toContain('callsite.test.ts');
  });

  it('does not show internal Loupe frames', () => {
    const callsite = captureCallsite(resolveOptions().stack);
    expect(callsite?.file).not.toContain('/src/callsite.ts');
  });

  it('returns null instead of throwing when no project code is found', () => {
    const options = resolveOptions({ stack: { projectRoot: '/nonexistent/root' } }).stack;
    expect(captureCallsite(options)).toBeNull();
  });

  it('the boundary drops instrumentation frames', () => {
    const options = resolveOptions().stack;

    // This is what a driver interceptor looks like: its own frames sit between
    // user code and the stack capture, and they must not end up in the
    // callsite. When developing against a linked copy of Loupe the
    // `node_modules` filter does not help — the sources live inside the
    // project root.
    function loupeQuery(withBoundary: boolean) {
      function instrumentationInternals() {
        return withBoundary ? captureCallsite(options, loupeQuery) : captureCallsite(options);
      }
      return instrumentationInternals();
    }

    const insideInstrumentation = loupeQuery(false);
    const insideUserCode = loupeQuery(true);

    expect(insideInstrumentation?.line).not.toBe(insideUserCode?.line);
    // With the boundary the top frame becomes the call line in user code.
    expect(insideUserCode?.line).toBeGreaterThan(insideInstrumentation?.line ?? 0);
  });
});

describe('policy for binding a span to code', () => {
  const scopeFor = (mode: 'development' | 'production') =>
    new RequestScope({
      id: 'r1',
      method: 'GET',
      path: '/',
      options: resolveOptions({ mode, enabled: true }),
    });

  it('a handed-down callsite wins — it is the only one captured in time', () => {
    const handed = { file: '/srv/app/a.ts', relative: 'a.ts', line: 1, column: 1 };

    const resolved = withHandedCallsite({ callsite: handed }, () =>
      resolveCallsite(scopeFor('development'), 'SELECT ?'),
    );

    expect(resolved).toBe(handed);
  });

  it('in development captures every time and remembers nothing', () => {
    const scope = scopeFor('development');

    for (let i = 0; i < 5; i++) {
      expect(resolveCallsite(scope, 'SELECT ?')?.relative).toContain('callsite.test.ts');
    }
  });

  it('in production stops capturing but keeps returning what it learned', () => {
    const scope = scopeFor('production');
    // All calls come from a single line — just like a query in real code.
    const capture = () => resolveCallsite(scope, 'SELECT ?');

    const first = capture();
    expect(first?.relative).toContain('callsite.test.ts');

    // The default budget is three captures per fingerprint; after that the cache serves.
    capture();
    capture();
    expect(scope.shouldCaptureStack('SELECT ?')).toBe(false);
    expect(capture()).toEqual(first);
  });

  it('the same SQL from different places stops being bound at all', () => {
    // A wrong code line is worse than a missing one, and the N+1 detector
    // needs a single origin anyway.
    const scope = scopeFor('production');

    const fromHere = () => resolveCallsite(scope, 'SELECT ?');
    const fromThere = () => resolveCallsite(scope, 'SELECT ?');

    expect(fromHere()).not.toBeNull();
    expect(fromThere()).toBeNull();
    expect(resolveCallsite(scope, 'SELECT ?')).toBeNull();
  });

  it('does not throw on a broken scope', () => {
    const broken = {
      get options(): never {
        throw new Error('scope is broken');
      },
      shouldCaptureStack: () => true,
    } as unknown as RequestScope;

    expect(() => resolveCallsite(broken, 'SELECT ?')).not.toThrow();
    expect(resolveCallsite(broken, 'SELECT ?')).toBeNull();
  });
});
