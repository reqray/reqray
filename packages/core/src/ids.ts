/**
 * Request identifiers.
 *
 * Generated on the hot path for every request, hence a counter and string
 * concatenation instead of `crypto.randomUUID()`. The id has to be unique
 * across every process whose requests share a store, and short — the panel
 * displays it.
 */

import { randomBytes } from 'node:crypto';

let counter = 0;

/**
 * Random per-process prefix: keeps ids apart across workers and restarts.
 *
 * Forty bits, drawn once. Twenty were not enough: a history on disk collects
 * a prefix per process start, and a few hundred restarts made a repeat likely
 * — after which the store dropped the newer request and opened the older one
 * in its place. Eight characters, so an id stays within the twelve the
 * terminal client gives it for the first million and a half requests.
 */
const prefix = randomBytes(5).readUIntBE(0, 5).toString(36).padStart(8, '0');

export function nextRequestId(): string {
  counter = (counter + 1) % 0xffffffff;
  return `${prefix}${counter.toString(36)}`;
}
