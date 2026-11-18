/** The charts' shared geometry, and the runs a broken series splits into. */

import type { SeriesBucket } from '../../../api/index';

/** Chart geometry, in the SVG's own units. */
export const WIDTH = 480;
export const HEIGHT = 64;

/**
 * A stretch with no traffic is a gap; a line through it would be invented.
 *
 * One empty column between two busy ones is not that. It is sampling — a
 * column happened to fall between two bursts — and breaking the line there
 * turns an ordinary series into a row of dashes. Two in a row is a stretch
 * where nothing ran, and that is worth showing as a hole.
 */
export const MAX_BRIDGED = 1;

export function segments(buckets: readonly SeriesBucket[], pick: (bucket: SeriesBucket) => number) {
  const runs: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  let empty = 0;

  buckets.forEach((bucket, index) => {
    if (bucket.calls === 0) {
      empty++;
      if (empty > MAX_BRIDGED && current.length > 0) {
        runs.push(current);
        current = [];
      }
      return;
    }
    empty = 0;
    current.push({ index, value: pick(bucket) });
  });
  if (current.length > 0) runs.push(current);
  return runs;
}
