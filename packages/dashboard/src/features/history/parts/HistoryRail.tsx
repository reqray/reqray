import type { FindingPattern, Outlier, SeriesMetric, SeriesResponse } from '../../../api/index';
import { RequestList } from '../../../shared/chart/RequestList';
import type { usePeek } from '../../../shared/chart/usePeek';
import { clock, count } from '../../../shared/format';
import { asQuery, type FilterState } from '../../../shared/list/filter';
import { badgeFor } from '../../../shared/waterfall/badge';
import { CompareSide } from './CompareSide';

/** What the rail is answering for. */
type RailFocus = 'pinned' | 'column' | 'zoom' | 'period';

/** The one decision behind both the title and what the CSS is told. */
function focusOf({
  pinned,
  hovering,
  zoomed,
}: {
  pinned: boolean;
  hovering: boolean;
  zoomed: boolean;
}): RailFocus {
  if (pinned) return 'pinned';
  if (hovering) return 'column';
  return zoomed ? 'zoom' : 'period';
}

const RAIL_TITLE: Record<RailFocus, string> = {
  pinned: 'slowest · pinned column',
  column: 'slowest · under the pointer',
  zoom: 'slowest · this zoom',
  period: 'slowest · this period',
};

/**
 * What `data-scope` says, which is not quite the focus: a zoom is a period
 * that has been narrowed, and the stylesheet treats it as one.
 */
const RAIL_SCOPE: Record<RailFocus, string> = {
  pinned: 'pinned',
  column: 'column',
  zoom: 'period',
  period: 'period',
};

/**
 * How many strayed routes the rail lists.
 *
 * Four is what fits beside the plot without the section becoming a second
 * table; the findings tab is where the whole list lives.
 */
const SHOWN_OUTLIERS = 4;

/** Why a route stands out: it is new, it got slower, or it got busier. */
function verdictOf(outlier: Outlier): string {
  if (outlier.firstSeen) return 'new';
  if (outlier.slowerRatio) return `${outlier.slowerRatio.toFixed(1)}× slower`;
  return `${(outlier.rateRatio ?? 1).toFixed(1)}× busier`;
}

/** A stretch of the plot the rail is answering for. */
export interface RailScope {
  readonly from: number;
  readonly to: number;
  readonly total: number;
}

interface HistoryRailProps {
  scope: RailScope;
  drawn: SeriesResponse;
  metric: SeriesMetric;
  filter: FilterState;
  pinned: RailScope | null;
  against: RailScope | null;
  changed: { patterns: FindingPattern[]; outliers: readonly Outlier[] } | null;
  peek: ReturnType<typeof usePeek>;
  zoom: unknown;
  onUnpin: () => void;
  onDropAgainst: () => void;
  onOpenRange: (from: number, to: number, query?: string) => void;
  onOpenFindings: (from: number, to: number) => void;
  onOpenRequest: (id: string) => void;
}

/**
 * The requests behind whatever is being looked at.
 *
 * Beside the plot rather than over it, so the chart is never covered. Idle it
 * answers for the whole period in view; hovering a column narrows it to that
 * column, and clicking one pins it — reaching the rail means crossing the
 * plot, and an unpinned list changes hands on the way.
 */
export function HistoryRail({
  scope,
  drawn,
  metric,
  filter,
  pinned,
  against,
  changed,
  peek,
  zoom,
  onUnpin,
  onDropAgainst,
  onOpenRange,
  onOpenFindings,
  onOpenRequest,
}: HistoryRailProps) {
  const focus = focusOf({
    pinned: pinned !== null,
    hovering: peek.column !== null,
    zoomed: !!zoom,
  });

  // Absent rather than empty: a section that says "nothing changed" every
  // time is a section nobody reads.
  const patterns = changed?.patterns ?? [];
  const outliers = (changed?.outliers ?? []).slice(0, SHOWN_OUTLIERS);
  const somethingChanged = patterns.length > 0 || outliers.length > 0;

  return (
    <aside
      className="history-rail"
      data-scope={RAIL_SCOPE[focus]}
      onPointerEnter={peek.hold}
      onPointerLeave={peek.leave}
    >
      <div className="rail-title label">
        <span>{RAIL_TITLE[focus]}</span>
        <span className="spacer" />
        {pinned ? (
          <button type="button" className="rail-unpin" onClick={() => onUnpin()}>
            unpin ✕
          </button>
        ) : null}
      </div>
      {pinned && against ? (
        <div className="rail-compare mono">
          <CompareSide name="A" stretch={pinned} drawn={drawn} metric={metric} />
          <CompareSide name="B" stretch={against} drawn={drawn} metric={metric} />
          <button type="button" className="rail-unpin" onClick={() => onDropAgainst()}>
            drop B ✕
          </button>
        </div>
      ) : null}

      <RequestList
        from={scope.from}
        to={scope.to}
        total={scope.total}
        filter={asQuery(filter)}
        onOpen={onOpenRequest}
      />
      {scope.total > 0 ? (
        <button
          type="button"
          className="rail-open mono"
          onClick={() => onOpenRange(scope.from, scope.to)}
        >
          open all {count(scope.total)} in the list →
        </button>
      ) : null}

      {/* What the shape is made of, when the panel witnessed something that
          explains it. */}
      {somethingChanged ? (
        <section className="rail-changed">
          <div className="rail-title label">
            <span>WHAT CHANGED IN THIS WINDOW</span>
          </div>
          {patterns.map((pattern) => (
            <div key={pattern.id} className="changed-row">
              <span className="badge-nplus">{badgeFor(pattern.detector)}</span>
              <span className="ellipsis" title={pattern.title}>
                first seen · {pattern.title}
              </span>
              <span className="s-dim">{clock(pattern.firstSeen)}</span>
            </div>
          ))}
          {outliers.map((outlier) => (
            <div key={`${outlier.method} ${outlier.route}`} className="changed-row">
              <span className="s-warn">{verdictOf(outlier)}</span>
              <span className="ellipsis">
                {outlier.method} {outlier.route}
              </span>
              <span className="s-dim">{count(outlier.calls)}</span>
            </div>
          ))}
          <button
            type="button"
            className="rail-open mono"
            onClick={() => onOpenFindings(drawn.from, drawn.to)}
          >
            findings in this window →
          </button>
        </section>
      ) : null}
    </aside>
  );
}
