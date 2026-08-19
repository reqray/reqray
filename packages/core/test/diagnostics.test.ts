import {
  clearDiagnostics,
  type DiagnosticEntry,
  getDiagnostics,
  printDiagnostics,
  renderDiagnostics,
  reportInstrumentation,
  setLogSink,
} from '@loupe/core';
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
    reason: 'found, but loaded before loupe',
    hint: 'start with `node --import @loupe/register`',
  },
];

describe('startup diagnostics', () => {
  it('prints the promised startup report', () => {
    expect(renderDiagnostics(entries)).toBe(
      [
        'loupe  instrumentation active',
        '  ✔ fastify@5.2.0        requests',
        '  ✔ pg@8.13.1            SQL',
        '  ✔ undici (built-in)    outgoing HTTP',
        '  ✘ prisma               found, but loaded before loupe',
        '                         → start with `node --import @loupe/register`',
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
    expect(renderDiagnostics([])).toBe('loupe  instrumentation not attached');
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
});
