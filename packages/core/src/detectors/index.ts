/**
 * Detector registry and its runner.
 *
 * Detectors run after the response has been sent. A failing detector disables
 * only itself: the user must still get the remaining findings.
 */

import type { ResolvedDetectOptions, ResolvedOptions } from '../config.js';
import { warnOnce } from '../logger.js';
import type { RequestScope } from '../scope.js';
import { loupeState } from '../state.js';
import type { Finding } from '../types.js';
import { duplicateCache, duplicateHttp } from './duplicates.js';
import { nPlusOne } from './n-plus-one.js';
import { sequentialHttp } from './sequential-http.js';
import { slowBudget } from './slow-budget.js';
import type { Detector, FinishedRequest } from './types.js';

interface RegistryEntry {
  readonly detector: Detector<any>;
  /** Key under which the detector is configured in `options.detect`. */
  readonly key: keyof ResolvedDetectOptions;
}

const registry: readonly RegistryEntry[] = [
  { detector: nPlusOne, key: 'nPlusOne' },
  { detector: sequentialHttp, key: 'sequentialHttp' },
  { detector: duplicateHttp, key: 'duplicateHttp' },
  { detector: duplicateCache, key: 'duplicateCache' },
  { detector: slowBudget, key: 'slowBudget' },
];

/**
 * Runs the enabled detectors over a finished request.
 *
 * Findings are sorted by descending cost: whatever returns the most time when
 * fixed comes first.
 */
export function runDetectors(
  scope: RequestScope,
  options: ResolvedOptions,
  request: FinishedRequest,
): Finding[] {
  const findings: Finding[] = [];
  const disabled = loupeState().disabledDetectors;

  for (const { detector, key } of registry) {
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

  return findings.sort((a, b) => b.costMs - a.costMs);
}

/** Puts disabled detectors back into service. Needed by tests. */
export function resetDetectors(): void {
  loupeState().disabledDetectors.clear();
}

export {
  type DuplicateCacheOptions,
  type DuplicateHttpOptions,
  duplicateCache,
  duplicateHttp,
} from './duplicates.js';
export { type NPlusOneOptions, nPlusOne } from './n-plus-one.js';
export { type SequentialHttpOptions, sequentialHttp } from './sequential-http.js';
export { type SlowBudgetOptions, slowBudget } from './slow-budget.js';
export type { Detector, FinishedRequest } from './types.js';
