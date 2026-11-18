/**
 * Console capture: log lines written while a request is being handled land in
 * that request's record.
 *
 * Without this, "you see the whole request" is a third of a lie — the log of
 * the incident stays in the shared stdout haystack. The tap is deliberately
 * humble:
 *
 * - the original console is always called, with the original arguments, and
 *   its output is never altered — capture failing must not cost a single
 *   character of terminal output;
 * - no scope — nothing but the passthrough happens;
 * - a line whose normalized text mentions a sensitive pattern is replaced by
 *   a marker: free-form text has no field names to mask by, and over-masking
 *   is the side this project errs on.
 *
 * Limitation, stated honestly: pino and winston write past `console`, so only
 * `console.*` lines are captured. A pino stream is a separate task.
 */

import { format } from 'node:util';
import { current } from './context.js';
import { sensitivePatternIn, truncate } from './redact.js';
import type { LogEntry } from './types.js';

/** "Already patched" marker: two copies of core must not stack wrappers. */
const PATCHED = Symbol.for('reqray.patched.console');

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof METHODS)[number];

const LEVEL_OF: Record<ConsoleMethod, LogEntry['level']> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

type ConsoleHolder = Console & { [PATCHED]?: Partial<Record<ConsoleMethod, unknown>> };

function capture(method: ConsoleMethod, args: readonly unknown[]): void {
  try {
    const scope = current();
    if (!scope?.options.logs) return;

    const redact = scope.options.redact;
    let line = format(...args);
    const hit = sensitivePatternIn(line, redact.body);
    line = hit ? `[line withheld: mentions "${hit}"]` : truncate(line, redact.maxStringLength);

    scope.addLog(LEVEL_OF[method], line);
  } catch {
    // The passthrough below must survive anything that happens here.
  }
}

/**
 * Installs the console tap. Idempotent; called by `createReqray`.
 *
 * Whether a line is recorded is decided per request from `scope.options`, so
 * one global tap serves any number of runtimes.
 */
export function instrumentConsole(): void {
  const holder = console as ConsoleHolder;
  if (holder[PATCHED]) return;

  const originals: Partial<Record<ConsoleMethod, unknown>> = {};
  for (const method of METHODS) {
    const original = holder[method];
    if (typeof original !== 'function') continue;
    originals[method] = original;

    holder[method] = function reqrayConsole(this: unknown, ...args: unknown[]) {
      capture(method, args);
      return (original as (...inner: unknown[]) => unknown).apply(this, args);
    };
  }
  holder[PATCHED] = originals;
}

/** Restores the original console. Needed by tests. */
export function uninstrumentConsole(): void {
  const holder = console as ConsoleHolder;
  const originals = holder[PATCHED];
  if (!originals) return;

  for (const method of METHODS) {
    const original = originals[method];
    if (original) holder[method] = original as Console[ConsoleMethod];
  }
  delete holder[PATCHED];
}
