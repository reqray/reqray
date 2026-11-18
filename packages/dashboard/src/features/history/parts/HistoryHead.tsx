import type { SeriesMetric } from '../../../api/index';
import { clock } from '../../../shared/format';
import { type FilterState, isFiltering } from '../../../shared/list/filter';
import { METRICS, ORDER, PERIODS, type PeriodName, type Window } from '../lib/metrics';

/** The filter in a few words, for the chip that says the chart is narrowed. */
function describe(filter: FilterState): string {
  const parts: string[] = [];
  if (filter.route) parts.push(`${filter.route.method} ${filter.route.route}`);
  if (filter.query.trim()) parts.push(`"${filter.query.trim()}"`);
  if (filter.methods.length > 0) parts.push(filter.methods.join('/'));
  if (filter.statusClasses.length > 0) {
    parts.push(filter.statusClasses.map((cls) => `${cls}xx`).join('/'));
  }
  if (filter.duration !== 'any') parts.push(filter.duration);
  return parts.join(' · ');
}

interface HistoryHeadProps {
  period: PeriodName;
  metric: SeriesMetric;
  companion: SeriesMetric | null;
  ghostOn: boolean;
  zoom: unknown;
  view: Window | null;
  filter: FilterState;
  onPickPeriod: (period: PeriodName) => void;
  onPickMetric: (metric: SeriesMetric) => void;
  onPickCompanion: (metric: SeriesMetric | null) => void;
  onToggleGhost: (on: boolean) => void;
  onClearZoom: () => void;
  onClearFilter: () => void;
}

/**
 * The controls above the plot: which period, which metric, what to compare
 * against.
 *
 * Labels sit above their controls rather than beside them — four in a row all
 * reading "metric: …" is a sentence nobody finishes.
 */
export function HistoryHead({
  period,
  metric,
  companion,
  ghostOn,
  zoom,
  view,
  filter,
  onPickPeriod,
  onPickMetric,
  onPickCompanion,
  onToggleGhost,
  onClearZoom,
  onClearFilter,
}: HistoryHeadProps) {
  /**
   * A companion that no longer shares a story with the new metric would be two
   * charts in one box, so it goes with the metric it belonged to.
   */
  const pickMetric = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as SeriesMetric;
    onPickMetric(next);
    if (companion && !METRICS[next].companions.includes(companion)) onPickCompanion(null);
  };

  const pickCompanion = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    onPickCompanion(value === '' ? null : (value as SeriesMetric));
  };

  return (
    <div className="history-head">
      <span className="label">HISTORY</span>

      <div className="history-periods">
        {PERIODS.map(([name, label]) => (
          <button
            key={name}
            type="button"
            className="chip"
            aria-pressed={zoom === null && period === name}
            onClick={() => onPickPeriod(name)}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="history-pick">
        <span className="fact-label">metric</span>
        <select value={metric} onChange={pickMetric}>
          {ORDER.map((name) => (
            <option key={name} value={name}>
              {METRICS[name].label}
            </option>
          ))}
        </select>
      </label>

      <label className="history-pick">
        {/* `with` rather than `against`: this control adds a second line to
              the same chart, and `against` now names the comparison period. */}
        <span className="fact-label">with</span>
        <select value={companion ?? ''} onChange={pickCompanion}>
          <option value="">nothing</option>
          {METRICS[metric].companions.map((name) => (
            <option key={name} value={name}>
              {METRICS[name].label}
            </option>
          ))}
        </select>
      </label>

      <label className="history-pick">
        <span className="fact-label">against</span>
        <select
          value={ghostOn ? 'previous' : ''}
          onChange={(event) => onToggleGhost(event.target.value === 'previous')}
        >
          <option value="previous">the period before</option>
          <option value="">nothing</option>
        </select>
      </label>

      {/* The list's filter, said out loud.
            Inherited on purpose — "what did *this endpoint* do this week" is
            the question this screen is for — but an inherited filter nobody
            can see turns an empty chart into a mystery: the reader is looking
            at one route and reading it as the whole application. */}
      {isFiltering(filter) ? (
        <button
          type="button"
          className="route-filter"
          title="draw the whole application instead"
          onClick={onClearFilter}
        >
          filtered: {describe(filter) || 'a stretch of time'} ✕
        </button>
      ) : null}

      <span className="spacer" />

      {zoom ? (
        <button type="button" className="tl-scope" onClick={() => onClearZoom()}>
          zoomed in · back to the whole period
        </button>
      ) : (
        <span className="s-dim mono">{view ? `${clock(view.from)} → ${clock(view.to)}` : ''}</span>
      )}
    </div>
  );
}
