/**
 * Sampling.
 *
 * The decision is made **after** the request finishes (tail-based): only then
 * is it known whether it was slow, whether it failed and whether anything was
 * found in it. Exactly the requests Loupe is installed for are always
 * retained, while the stream of ordinary ones is cut down by the base rate.
 */

import type { ResolvedSamplingOptions } from './config.js';
import type { Finding } from './types.js';

/** Request outcome the decision is based on. */
export interface SamplingInput {
  readonly durationMs: number;
  readonly status: number;
  readonly hasError: boolean;
  readonly findings: readonly Finding[];
}

/**
 * Whether to retain the request in full.
 *
 * Checks run from "retain unconditionally" down to the base rate, so the
 * interesting requests are never lost to chance.
 */
export function shouldRetain(
  options: ResolvedSamplingOptions,
  input: SamplingInput,
  random: () => number = Math.random,
): boolean {
  if (options.rate >= 1) return true;
  if (options.alwaysOnError && (input.hasError || input.status >= 500)) return true;
  if (options.alwaysOnFinding && input.findings.length > 0) return true;
  if (options.slowMs > 0 && input.durationMs >= options.slowMs) return true;
  if (options.rate <= 0) return false;
  return random() < options.rate;
}
