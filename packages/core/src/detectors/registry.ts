/**
 * Every detector there is, in one object.
 *
 * The single source: `DetectOptions` and `ResolvedDetectOptions` are mapped
 * types over these keys, so a new detector is one line and its options follow.
 *
 * Its own module rather than `detectors/index.ts` because `config.ts` needs
 * it, and the barrel imports `ResolvedDetectOptions` back out of config.
 */

import { duplicateCache, duplicateHttp } from './duplicates.js';
import { heavyResponse } from './heavy-response.js';
import { nPlusOne } from './n-plus-one.js';
import { poolWait } from './pool-wait.js';
import { sequentialHttp } from './sequential-http.js';
import { slowBudget } from './slow-budget.js';
import { slowCode } from './slow-code.js';
import { transactionHold } from './transaction-hold.js';
import type { Detector } from './types.js';

/**
 * The detectors, keyed by the name they are configured under.
 *
 * Order matters only for the startup report and for `/api/meta`: findings
 * themselves are sorted by severity and cost when a request finishes.
 */
export const detectors = {
  nPlusOne,
  sequentialHttp,
  duplicateHttp,
  duplicateCache,
  slowBudget,
  slowCode,
  heavyResponse,
  poolWait,
  transactionHold,
} as const;

/** A key of `reqray({ detect: { … } })`. */
export type DetectorKey = keyof typeof detectors;

/** The options one detector takes. */
export type DetectorOptions<K extends DetectorKey> =
  (typeof detectors)[K] extends Detector<infer Options> ? Options : never;

/** The keys, as an array — `Object.keys` alone loses the type. */
export const detectorKeys = Object.keys(detectors) as readonly DetectorKey[];
