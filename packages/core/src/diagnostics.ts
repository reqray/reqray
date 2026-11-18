/**
 * Startup diagnostics.
 *
 * The library prints what it instrumented and what it could not, with a hint
 * on how to fix it. This heads off most of the future "I don't see my
 * requests" issues.
 */

import type { DiagnosticEntry } from '@reqray/protocol';
import { info } from './logger.js';
import { globalBox, globalSlot } from './state.js';

/** The instrumentation report, collected at startup. */
const report = globalSlot('diagnostics.report', () => [] as DiagnosticEntry[]);

const printed = globalBox('diagnostics.printed', false);

export type { DiagnosticEntry };

/** Records the outcome of an attempt to instrument a package. */
export function reportInstrumentation(entry: DiagnosticEntry): void {
  report().push(entry);
}

/** Everything collected so far. */
export function getDiagnostics(): readonly DiagnosticEntry[] {
  return report();
}

/** Clears the report. Needed by tests. */
export function clearDiagnostics(): void {
  report().length = 0;
}

function labelOf(entry: DiagnosticEntry): string {
  if (entry.builtin) return `${entry.name} (built-in)`;
  return entry.version ? `${entry.name}@${entry.version}` : entry.name;
}

/**
 * Renders the report as text.
 *
 * Kept as a separate pure function so the format can be asserted in a test
 * without intercepting the console.
 */
export function renderDiagnostics(report: readonly DiagnosticEntry[]): string {
  const active = report.some((entry) => entry.ok);
  const header = active ? 'reqray  instrumentation active' : 'reqray  instrumentation not attached';
  if (report.length === 0) return header;

  const width = Math.max(...report.map((entry) => labelOf(entry).length)) + 4;
  const lines = [header];

  for (const entry of report) {
    const mark = entry.ok ? '✔' : '✘';
    const detail = entry.ok ? entry.captures : (entry.reason ?? entry.captures);
    lines.push(`  ${mark} ${labelOf(entry).padEnd(width)}${detail}`);
    if (entry.hint) lines.push(`  ${' '.repeat(width + 2)}→ ${entry.hint}`);
  }

  return lines.join('\n');
}

/**
 * What to say under the report about a panel with no gate.
 *
 * Such a panel answers its own machine and nobody else, and the person who
 * finds that out is looking at a 403 from inside a dev container or behind a
 * local proxy. Said at startup, it is a line read once instead of an issue.
 */
export const UNGATED_PANEL_NOTE = [
  '  panel answers this machine only: no gate is set',
  "  → from a container, a proxy or another machine: reqray({ panel: { gate: 'open' } })",
].join('\n');

/** Prints the report. Called once when Reqray initializes. */
export function printDiagnostics(note?: string): void {
  const text = renderDiagnostics(report());
  info(note ? `${text}\n${note}` : text);
}

/**
 * Prints the report at most once per process lifetime.
 *
 * An application may have several adapters, but only needs one report.
 */
export function printDiagnosticsOnce(note?: string): void {
  const once = printed();
  if (once.value) return;
  once.value = true;
  printDiagnostics(note);
}

/** Allows the report to be printed again. Needed by tests. */
export function resetDiagnosticsPrinted(): void {
  printed().value = false;
}
