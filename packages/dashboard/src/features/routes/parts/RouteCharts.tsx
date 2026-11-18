import { useEffect, useRef, useState } from 'react';
import {
  type ActivityReport,
  fetchActivity,
  fetchRouteSeries,
  type RouteSeries,
  type RouteStats,
} from '../../../api/index';
import { clock, count, duration } from '../../../shared/format';
import { Bars } from './Bars';
import { Chart } from './Chart';
import { Latency } from './Latency';
import { TopFinding } from './TopFinding';

/**
 * Three charts for one endpoint, and nothing beyond them.
 *
 * Enough to see "it got slower at 14:20, after the deploy" and to stop there.
 * Not a dashboard builder, not alerting, not aggregates over arbitrary
 * dimensions. Every column is clickable — a chart nobody can click is
 * decoration.
 */
const BUCKETS = 48;

/** How a route strayed from itself, in the words the drawer uses. */
function strayed(outlier: ActivityReport['outliers'][number]): string {
  if (outlier.firstSeen) return 'first seen here';
  const parts: string[] = [];
  if ((outlier.rateRatio ?? 0) >= 1.5) parts.push(`×${outlier.rateRatio?.toFixed(1)} calls`);
  if ((outlier.slowerRatio ?? 0) >= 1.5) parts.push(`×${outlier.slowerRatio?.toFixed(1)} slower`);
  return parts.join(' · ');
}

/**
 * A route's latency, in one sentence — or in none.
 *
 * Only two shapes are worth naming: calls that all cost the same are paying a
 * constant somebody wrote down, and a tail many times the median is the whole
 * story. Anything in between gets silence — a tool that says something about
 * everything says nothing.
 */
function readingOf(row: RouteStats): string | null {
  // Under a few milliseconds the spread is measurement noise, and every
  // route looks either flat or wildly variable depending on the machine.
  if (row.calls < 3 || row.p50 < 5) return null;

  const spread = row.p50 > 0 ? row.p99 / row.p50 : 1;
  if (spread <= 1.2) {
    return `every call costs about the same — ${duration(row.p50)} to ${duration(row.p99)}. That is a constant in the code, not load.`;
  }
  if (spread >= 4) {
    return `most calls cost ${duration(row.p50)} and the slowest cost ${duration(row.p99)} — the tail is where the story is, not the median.`;
  }
  return null;
}

/**
 * Traffic here was well above this route's usual rate.
 *
 * The same test twice over: the head line says the box rose, and the sentence
 * under it says no single route explains the rise.
 */
const ROSE_RATIO = 1.5;

function roseOverall(activity: ActivityReport): boolean {
  return (activity.rateRatio ?? 1) >= ROSE_RATIO;
}

interface RouteChartsProps {
  row: RouteStats;
  /** The stretch the table above was computed over, epoch ms. */
  from: number;
  to: number;
  /** Opens one request — the hover peeks lead straight to the detail. */
  onOpenRequest: (id: string) => void;
  onPickRoute: (route: { method: string; route: string }) => void;
}

export function RouteCharts({ row, from, to, onOpenRequest, onPickRoute }: RouteChartsProps) {
  /**
   * The stretch the charts are drawn over.
   *
   * `null` is the window the table was computed over. A drag across the plot
   * narrows it — a chart of a long window cannot be read by aiming at one of
   * forty-eight columns, and telling somebody to aim better is not an answer.
   */
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null);
  /**
   * Three states again.
   *
   * `null` meant both "still reading" and "the collector had nothing for this
   * stretch", and after a zoom into a quiet minute that left the panel saying
   * "reading this route's history…" for ever.
   */
  const [series, setSeries] = useState<RouteSeries | 'asking' | 'empty'>('asking');
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  /**
   * Three states, not two.
   *
   * `null` was doing double duty for "still asking" and "the collector had no
   * answer", and a store that cannot group by route left the drawer saying
   * "asking…" for ever.
   */
  const [activity, setActivity] = useState<ActivityReport | 'asking' | 'unavailable'>('asking');

  // Whether a chart is up, for the poll's failure path below.
  const haveChart = useRef(false);
  haveChart.current = typeof series !== 'string';

  // The question and the reading are separate effects on purpose. Changing
  // the question — another route, a zoom in or out — makes the old chart the
  // wrong answer, so it leaves at once and the picked column goes with it.
  // The window merely sliding under the live refresh is the *same* question
  // asked again: the chart stays up, the picked column stays picked, and the
  // fresh answer swaps in when it lands. Resetting on every slide was a
  // ten-second metronome of "reading this route's history…".
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the trigger — this effect resets state when the question changes
  useEffect(() => {
    setSeries('asking');
    setPicked(null);
    setActivity('asking');
  }, [row.method, row.route, zoom?.from, zoom?.to]);

  useEffect(() => {
    const controller = new AbortController();
    fetchRouteSeries(
      row.method,
      row.route,
      BUCKETS,
      { from: zoom?.from ?? from, to: zoom?.to ?? to },
      controller.signal,
    )
      .then((answer) => {
        setSeries(answer ?? 'empty');
        setError(null);
      })
      .catch((cause: unknown) => {
        // A blip in the poll keeps the chart that is up; only a screen with
        // nothing drawn yet has an apology to show.
        if (controller.signal.aborted || haveChart.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [row.method, row.route, from, to, zoom?.from, zoom?.to]);

  /**
   * Narrows the charts to a dragged stretch.
   *
   * Refused when it would be shorter than a second: a slip of the hand must
   * not leave somebody staring at an empty chart with no way to tell why.
   */
  const narrow = (range: { from: number; to: number }) => {
    // A click is already filtered by the drag threshold; this only stops a
    // slip of the hand from zooming into a range with no width at all.
    if (range.to - range.from < 200) return;
    setZoom(range);
  };

  const pick = (index: number) => {
    if (typeof series === 'string') return;
    setPicked(index);
    setActivity('asking');
    const bucket = series.buckets[index];
    if (!bucket) return;
    void fetchActivity(
      { from: bucket.at, to: bucket.at + series.bucketMs },
      { from: series.from, to: series.to },
    )
      .then((answer) => setActivity(answer ?? 'unavailable'))
      .catch(() => setActivity('unavailable'));
  };

  if (error) return <div className="route-charts s-dim">charts unavailable — {error}</div>;

  // The head stays whatever the body is doing: it carries the way back out of
  // a zoom, and a zoom into a quiet minute is exactly when that is needed.
  if (typeof series === 'string') {
    return (
      <div className="route-charts">
        <div className="route-charts-head">
          <span className="s-dim mono">
            {series === 'asking' ? "reading this route's history…" : 'nothing in this stretch'}
          </span>
          {zoom ? (
            <button type="button" className="tl-scope" onClick={() => setZoom(null)}>
              zoomed in · back to the whole window
            </button>
          ) : null}
          <span className="spacer" />
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onPickRoute({ method: row.method, route: row.route })}
          >
            show these requests
          </button>
        </div>
        <div className="charts-waiting s-dim mono">
          {series === 'asking' ? 'reading…' : 'no calls to this route in the stretch you picked'}
        </div>
      </div>
    );
  }

  const perSecond = 1_000 / series.bucketMs;
  const reading = readingOf(row);
  // The tallest thing on the latency chart, said out loud: an axis that is
  // only ever implied leaves the reader to guess what the top of the box is.
  const peak = Math.max(...series.buckets.map((entry) => entry.p99), 0);
  const errors = series.buckets.reduce((total, bucket) => total + bucket.errors, 0);
  const bucket = picked === null ? null : series.buckets[picked];

  /**
   * What ran in the moment the picked column stands for.
   *
   * Four of the five answers are reasons there is nothing to name: still
   * asking, a store that cannot group by route, a stretch nothing ran in at
   * all, and a rise across the board that no single route explains.
   */
  const whatRan = () => {
    if (activity === 'asking') return <div className="s-dim mono">asking…</div>;

    if (activity === 'unavailable') {
      return (
        <div className="s-dim">
          This store cannot group its requests by route, so there is no answer to give.
        </div>
      );
    }

    if (activity.calls === 0) {
      return (
        <div className="s-dim">
          Nothing ran here at all — no request of any route was recorded in this stretch. The
          application was not running, or nothing was calling it.
        </div>
      );
    }

    if (activity.outliers.length === 0) {
      return (
        <div className="s-dim">
          {roseOverall(activity)
            ? `Traffic here was ×${activity.rateRatio?.toFixed(1)} its usual rate, and it rose across the board — no single route explains it.`
            : 'Nothing here was unusual — every route ran about as often, and about as fast, as it does the rest of the time. Whatever moved the chart came from garbage collection, a neighbour on the box, or the host itself.'}
        </div>
      );
    }

    return (
      <ul className="outliers">
        {activity.outliers.map((outlier) => (
          <li key={`${outlier.method} ${outlier.route}`}>
            <button
              type="button"
              className="outlier"
              onClick={() => onPickRoute({ method: outlier.method, route: outlier.route })}
            >
              <span className="outlier-ratio">{strayed(outlier)}</span>
              <span className="ellipsis mono">
                {outlier.method} {outlier.route}
              </span>
              <span className="s-dim mono">
                {count(outlier.calls)} calls · {duration(outlier.avgMs)} avg
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="route-charts">
      <div className="route-charts-head">
        <span className="s-dim mono">
          {count(series.calls)} calls · {clock(series.from)} → {clock(series.to)} ·{' '}
          {Math.round(series.bucketMs / 1000) || '<1'}s per column
        </span>
        {zoom ? (
          <button type="button" className="tl-scope" onClick={() => setZoom(null)}>
            zoomed in · back to the whole window
          </button>
        ) : (
          <span className="s-dim mono">· drag across a chart to zoom</span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onPickRoute({ method: row.method, route: row.route })}
        >
          show these requests
        </button>
      </div>

      <div className="charts">
        <Chart
          title="LATENCY"
          note={
            <>
              <span className="key-p95">p95</span>, <span className="key-spread">p50–p99</span> ·
              peak {duration(peak)}
            </>
          }
          series={series}
          selected={picked}
          onPick={pick}
          onZoom={narrow}
          onOpenRequest={onOpenRequest}
        >
          <Latency series={series} />
        </Chart>
        <Chart
          title="ERRORS"
          note={errors === 0 ? 'none' : `${count(errors)} of ${count(series.calls)}`}
          series={series}
          selected={picked}
          onPick={pick}
          onZoom={narrow}
          onOpenRequest={onOpenRequest}
        >
          <Bars
            series={series}
            pick={(entry) => (entry.calls > 0 ? (entry.errors / entry.calls) * 100 : 0)}
            className="chart-errors"
          />
        </Chart>
        <Chart
          title="THROUGHPUT"
          note="calls per second"
          series={series}
          selected={picked}
          onPick={pick}
          onZoom={narrow}
          onOpenRequest={onOpenRequest}
        >
          <Bars series={series} pick={(entry) => entry.calls * perSecond} className="chart-calls" />
        </Chart>
      </div>

      {bucket ? (
        <div className="what-ran">
          <div className="what-ran-head">
            <span className="label">WHAT RAN HERE</span>
            <span className="s-dim mono">
              {clock(bucket.at)} · {count(bucket.calls)} call{bucket.calls === 1 ? '' : 's'} on this
              route · {duration(bucket.p95)} p95
              {typeof activity === 'object' && roseOverall(activity)
                ? ` · traffic overall ×${activity.rateRatio?.toFixed(1)}`
                : ''}
            </span>
          </div>
          {whatRan()}
        </div>
      ) : (
        <div className="s-dim charts-hint">Click a column to ask what ran in that moment.</div>
      )}

      <div className="route-read">
        {reading ? <div className="s-fg2 route-reading">{reading}</div> : null}
        <TopFinding row={row} />
      </div>
    </div>
  );
}
