/**
 * Startup diagnostics.
 *
 * The library prints what it instrumented and what it could not, with a hint
 * on how to fix it. This heads off most of the future "I don't see my
 * requests" issues.
 */

import { info } from './logger.js';
import { loupeState } from './state.js';

/** One report line: one package Loupe tried to instrument. */
export interface DiagnosticEntry {
  /** Package name as the application sees it: `fastify`, `pg`, `prisma`. */
  readonly name: string;
  /** Package version, if it could be resolved. */
  readonly version?: string | undefined;
  /** Package is built into Node — no version is printed. */
  readonly builtin?: boolean;
  /** What is captured: "requests", "SQL", "outgoing HTTP". */
  readonly captures: string;
  readonly ok: boolean;
  /** Why it failed. Printed instead of `captures` for failed entries. */
  readonly reason?: string | undefined;
  /** What the user should do to fix it. */
  readonly hint?: string | undefined;
}

/** Records the outcome of an attempt to instrument a package. */
export function reportInstrumentation(entry: DiagnosticEntry): void {
  loupeState().diagnostics.push(entry);
}

/** Everything collected so far. */
export function getDiagnostics(): readonly DiagnosticEntry[] {
  return loupeState().diagnostics;
}

/** Clears the report. Needed by tests. */
export function clearDiagnostics(): void {
  loupeState().diagnostics.length = 0;
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
  const header = active ? 'loupe  instrumentation active' : 'loupe  instrumentation not attached';
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

/** Prints the report. Called once when Loupe initializes. */
export function printDiagnostics(): void {
  info(renderDiagnostics(loupeState().diagnostics));
}

/**
 * Prints the report at most once per process lifetime.
 *
 * An application may have several adapters, but only needs one report.
 */
export function printDiagnosticsOnce(): void {
  const state = loupeState();
  if (state.printed) return;
  state.printed = true;
  printDiagnostics();
}

/** Allows the report to be printed again. Needed by tests. */
export function resetDiagnosticsPrinted(): void {
  loupeState().printed = false;
}
