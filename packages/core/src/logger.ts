/**
 * Loupe's own logging.
 *
 * The project rule: an instrumentation error is caught, logged as a warning
 * **once** and disables that one instrument without touching the rest. Hence
 * {@link warnOnce}.
 */

import { loupeState } from './state.js';

/** Where Loupe writes its own messages. */
export interface LoupeLogSink {
  info(message: string): void;
  warn(message: string): void;
}

const defaultSink: LoupeLogSink = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};

/** Replaces the message sink. Needed by tests and apps with their own logger. */
export function setLogSink(next: LoupeLogSink | null): void {
  loupeState().sink = next;
}

/** Writes an informational line, such as the startup report. */
export function info(message: string): void {
  try {
    (loupeState().sink ?? defaultSink).info(message);
  } catch {
    // Even a broken logger must not break the application.
  }
}

/** Writes a warning, prefixed so it is obvious where it came from. */
export function warn(message: string): void {
  try {
    (loupeState().sink ?? defaultSink).warn(`loupe: ${message}`);
  } catch {
    // Even a broken logger must not break the application.
  }
}

/**
 * Writes a warning only the first time a key shows up.
 *
 * Instrumentation on the hot path can fail thousands of times a second —
 * repeat messages add no information and only do harm.
 */
export function warnOnce(key: string, message: string): void {
  const warned = loupeState().warned;
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** Forgets which warnings have already been issued. Needed by tests. */
export function resetWarnings(): void {
  loupeState().warned.clear();
}
