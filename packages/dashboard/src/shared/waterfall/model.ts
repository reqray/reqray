/**
 * The waterfall, as this screen draws it.
 *
 * What a bar *is* — which spans collapse into one, where the uninstrumented
 * stretches are, how deep each sits — comes from `@reqray/waterfall`, shared
 * with the terminal client so the same request cannot show a different number
 * of bars in `reqray show` and in the browser. What stays here is the part that
 * is genuinely this screen's: how a bar is worded when there is room for a
 * whole line of SQL.
 */

import {
  buildWaterfall as buildBars,
  type WaterfallBar as ModelBar,
  type WaterfallInput,
} from '@reqray/waterfall';
import type { Span } from '../../api/index';
import { cacheCall, oneLine } from '../format';

export { depthOf, isRunEvidence, parallelSpans, uninstrumentedMs } from '@reqray/waterfall';

/** One bar of the waterfall, with the words this screen puts on it. */
export interface WaterfallBar extends ModelBar {
  readonly label: string;
}

/** What a span is called here: the whole line, and let CSS truncate it. */
export function labelOf(span: Span): string {
  switch (span.kind) {
    case 'db':
      return oneLine(span.sql);
    case 'http':
      return `${span.method} ${span.url}`;
    case 'cache':
      return cacheCall(span);
    default:
      return span.label;
  }
}

/** What a bar is called: a gap says so, a collapsed run counts itself. */
function barLabel(bar: ModelBar): string {
  if (bar.span === null) return 'uninstrumented — app code or waiting';
  if (bar.count > 1) return `${bar.count}× ${labelOf(bar.span)}`;
  return labelOf(bar.span);
}

/** The bars, labelled. */
export function buildWaterfall(detail: WaterfallInput): WaterfallBar[] {
  return buildBars(detail).map((bar) => ({ ...bar, label: barLabel(bar) }));
}
