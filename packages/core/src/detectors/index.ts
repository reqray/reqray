/**
 * Detector registry and its runner.
 *
 * Detectors run after the response has been sent. A failing detector disables
 * only itself: the user must still get the remaining findings.
 */

import type { ResolvedOptions } from '../config.js';
import { warnOnce } from '../logger.js';
import type { RequestScope } from '../scope.js';
import { globalSlot } from '../state.js';

/**
 * Detectors that disabled themselves after throwing.
 *
 * Process-wide, which is a compromise worth naming: two Reqray instances in one
 * process share this, so a detector that fails on one instance's data stops
 * running for the other too.
 */
const disabledDetectors = globalSlot('detectors.disabled', () => new Set<string>());

import type { Finding } from '../types.js';
import { detectorKeys, detectors } from './registry.js';
import type { Detector, FinishedRequest } from './types.js';

/**
 * Every detector with the thresholds it actually runs with.
 *
 * For `/api/meta`: an empty findings tab must be able to say what was
 * looking and how it was tuned, or silence reads as a clean bill of health.
 */
export function detectorSettings(options: ResolvedOptions): Array<{
  id: string;
  enabled: boolean;
  options: Record<string, number | boolean | string> | null;
}> {
  return detectorKeys.map((key) => ({
    id: detectors[key].id,
    enabled: options.detect[key] !== null,
    options: options.detect[key] as Record<string, number | boolean | string> | null,
  }));
}

/** Loudest first, so a sort can put the worse of two findings above. */
const SEVERITY: Record<string, number> = { critical: 2, warn: 1, info: 0 };

/**
 * Runs the enabled detectors over a finished request.
 *
 * Findings are sorted by severity and then by cost. Cost alone was enough
 * while every detector measured its damage in milliseconds; a response of
 * twelve megabytes costs bytes, and sorting it below a duplicate cache read
 * that wasted a third of one would order the screen by what is measurable
 * rather than by what matters.
 */
export function runDetectors(
  scope: RequestScope,
  options: ResolvedOptions,
  request: FinishedRequest,
): Finding[] {
  const findings: Finding[] = [];
  const disabled = disabledDetectors();

  for (const key of detectorKeys) {
    const detector: Detector<unknown> = detectors[key];
    if (disabled.has(detector.id)) continue;

    const detectorOptions = options.detect[key];
    if (!detectorOptions) continue;

    try {
      findings.push(...detector.run(scope, detectorOptions, request));
    } catch (error) {
      disabled.add(detector.id);
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce(
        `detector.${detector.id}`,
        `detector ${detector.id} disabled itself after an error: ${reason}`,
      );
    }
  }

  return findings.sort(
    (a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || b.costMs - a.costMs,
  );
}

/** Puts disabled detectors back into service. Needed by tests. */
export function resetDetectors(): void {
  disabledDetectors().clear();
}

export {
  type DuplicateCacheOptions,
  type DuplicateHttpOptions,
  duplicateCache,
  duplicateHttp,
} from './duplicates.js';
export { type HeavyResponseOptions, heavyResponse } from './heavy-response.js';
export { type NPlusOneOptions, nPlusOne } from './n-plus-one.js';
export { type PoolWaitOptions, poolWait } from './pool-wait.js';
export { type SequentialHttpOptions, sequentialHttp } from './sequential-http.js';
export { type SlowBudgetOptions, slowBudget } from './slow-budget.js';
export { type SlowCodeOptions, slowCode } from './slow-code.js';
export { type TransactionHoldOptions, transactionHold } from './transaction-hold.js';
export {
  overlapMs,
  statementKind,
  type Transaction,
  transactionsOf,
} from './transactions.js';
export type { Detector, FinishedRequest } from './types.js';
