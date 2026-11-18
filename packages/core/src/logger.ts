/**
 * Reqray's own logging.
 *
 * The project rule: an instrumentation error is caught, logged as a warning
 * **once** and disables that one instrument without touching the rest. Hence
 * {@link warnOnce}.
 */

import { type Box, globalBox, globalSlot } from './state.js';

/** Where Reqray writes its own messages. */
export interface ReqrayLogSink {
  info(message: string): void;
  warn(message: string): void;
}

/** Keys of warnings already issued, so `warnOnce` means once per process. */
const warned = globalSlot('logger.warned', () => new Set<string>());

/** Where Reqray writes its own messages. `null` — the default sink. */
const sink: () => Box<ReqrayLogSink | null> = globalBox('logger.sink', null);

const defaultSink: ReqrayLogSink = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};

/** Replaces the message sink. Needed by tests and apps with their own logger. */
export function setLogSink(next: ReqrayLogSink | null): void {
  sink().value = next;
}

/** Writes an informational line, such as the startup report. */
export function info(message: string): void {
  try {
    (sink().value ?? defaultSink).info(message);
  } catch {
    // Even a broken logger must not break the application.
  }
}

/** Writes a warning, prefixed so it is obvious where it came from. */
export function warn(message: string): void {
  try {
    (sink().value ?? defaultSink).warn(`reqray: ${message}`);
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
  const seen = warned();
  if (seen.has(key)) return;
  seen.add(key);
  warn(message);
}

/** Forgets which warnings have already been issued. Needed by tests. */
export function resetWarnings(): void {
  warned().clear();
}
