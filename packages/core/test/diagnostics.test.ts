import {
  createReqray,
  type DiagnosticEntry,
  getDiagnostics,
  printDiagnostics,
  renderDiagnostics,
  reportInstrumentation,
  setLogSink,
} from '@reqray/core';
import { clearDiagnostics, resetDiagnosticsPrinted } from '@reqray/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  clearDiagnostics();
  setLogSink(null);
});

const entries: DiagnosticEntry[] = [
  { name: 'fastify', version: '5.2.0', captures: 'requests', ok: true },
  { name: 'pg', version: '8.13.1', captures: 'SQL', ok: true },
  { name: 'undici', builtin: true, captures: 'outgoing HTTP', ok: true },
  {
    name: 'prisma',
    captures: 'SQL',
    ok: false,
    reason: 'found, but loaded before reqray',
    hint: 'start with `node --import @reqray/register`',
  },
];

describe('startup diagnostics', () => {
  it('prints the promised startup report', () => {
    expect(renderDiagnostics(entries)).toBe(
      [
        'reqray  instrumentation active',
        '  ✔ fastify@5.2.0        requests',
        '  ✔ pg@8.13.1            SQL',
        '  ✔ undici (built-in)    outgoing HTTP',
        '  ✘ prisma               found, but loaded before reqray',
        '                         → start with `node --import @reqray/register`',
      ].join('\n'),
    );
  });

  it('honestly reports when nothing attached', () => {
    const failed: DiagnosticEntry[] = [
      { name: 'pg', captures: 'SQL', ok: false, reason: 'not found' },
    ];
    expect(renderDiagnostics(failed)).toContain('instrumentation not attached');
  });

  it('an empty report is a single header line', () => {
    expect(renderDiagnostics([])).toBe('reqray  instrumentation not attached');
  });

  it('accumulates entries and prints them through the logger', () => {
    const info = vi.fn();
    setLogSink({ info, warn: vi.fn() });

    for (const entry of entries) reportInstrumentation(entry);
    expect(getDiagnostics()).toHaveLength(4);

    printDiagnostics();
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toContain('✔ fastify@5.2.0');
  });

  it.each([
    [undefined, true],
    ['open' as const, false],
  ])('says a panel with gate %s answers this machine only: %s', async (gate, said) => {
    // The 403 is otherwise met from inside a dev container, with nothing at
    // startup having mentioned that a gate was missing.
    const info = vi.fn();
    setLogSink({ info, warn: vi.fn() });
    resetDiagnosticsPrinted();

    const reqray = createReqray({ mode: 'development', ...(gate ? { panel: { gate } } : {}) });
    await new Promise((resolve) => setImmediate(resolve));
    await reqray.close();

    expect(String(info.mock.calls[0]?.[0]).includes('answers this machine only')).toBe(said);
  });
});
