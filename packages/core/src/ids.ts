/**
 * Request identifiers.
 *
 * Generated on the hot path for every request, hence a counter and string
 * concatenation instead of `crypto.randomUUID()`. The id has to be unique
 * within the process and short — the panel displays it.
 */

let counter = 0;

/** Random per-process prefix: keeps ids apart across workers and restarts. */
const prefix = Math.floor(Math.random() * 0x100000)
  .toString(36)
  .padStart(4, '0');

/** Next request id. */
export function nextRequestId(): string {
  counter = (counter + 1) % 0xffffffff;
  return `${prefix}${counter.toString(36)}`;
}
