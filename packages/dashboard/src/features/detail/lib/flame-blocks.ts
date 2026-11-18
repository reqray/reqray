import type { RequestDetail, Span } from '../../../api/index';
import { depthOf, labelOf } from '../../../shared/waterfall/model';

/**
 * Flamegraph layout.
 *
 * The waterfall answers "when did each thing happen"; the flamegraph answers
 * "what was running inside what". Same spans, same colours — only the axis
 * changes, so the two views are a toggle rather than two screens.
 */

export interface FlameBlock {
  key: string;
  kind: Span['kind'];
  label: string;
  /** Percentages of the request's total duration. */
  left: number;
  width: number;
  depth: number;
  /** The native tooltip: everything that does not fit inside the block. */
  title: string;
}

/** Pixels per nesting level. */
export const LEVEL_HEIGHT = 22;

/**
 * Below this width a label cannot be read anyway, and drawing it turns the
 * graph into a smear of clipped letters. No text measurement — a share of the
 * width is enough and costs nothing.
 */
export const LABEL_MIN_WIDTH = 7;

export function buildFlamegraph(detail: RequestDetail): FlameBlock[] {
  const total = Math.max(detail.durationMs, 1);
  const byId = new Map(detail.spans.map((span) => [span.id, span]));

  return detail.spans.map((span) => {
    const label = labelOf(span);
    return {
      key: `f${span.id}`,
      kind: span.kind,
      label,
      left: Math.max(0, Math.min(100, (span.startedAt / total) * 100)),
      // Never zero: a sub-millisecond span still has to be clickable.
      width: Math.max(0.2, Math.min(100, (span.duration / total) * 100)),
      depth: depthOf(span, byId),
      title: `${label} — ${span.duration.toFixed(1)} ms`,
    };
  });
}

/** How tall the graph is, in levels. */
export function flameLevels(blocks: readonly FlameBlock[]): number {
  let deepest = 0;
  for (const block of blocks) {
    if (block.depth > deepest) deepest = block.depth;
  }
  return blocks.length === 0 ? 0 : deepest + 1;
}
