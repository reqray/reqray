import { useEffect, useId, useRef, useState } from 'react';
import {
  type ActivityReport,
  type FindingPattern,
  fetchActivity,
  fetchFindings,
  fetchSeries,
  fetchTimeline,
  type Outlier,
  type SeriesMetric,
  type SeriesResponse,
} from '../../api/index';
import { useLive } from '../../app/PanelContext';
import { usePeek } from '../../shared/chart/usePeek';
import { clock, count } from '../../shared/format';
import { asQuery, type FilterState } from '../../shared/list/filter';
import { badgeFor } from '../../shared/waterfall/badge';
import type { Annotation } from './lib/annotations';
import { EventMark } from './parts/EventMark';

/**
 * One metric, one period, and the requests behind every point.
 *
 * Every column is a way in: click one and the rail pins to the requests that
 * made it. The line not to cross is a wall of gauges — hence a fixed list of
 * metrics rather than a query language, two lines at most, no saved
 * dashboards, nothing that alerts.
 */

import { usePlotPointer } from '../../shared/chart/usePlotPointer';
import { METRICS, type PeriodName, type Window, windowFor } from './lib/metrics';
import { columnSpan, HEIGHT, MAX_BRIDGED, peakOf, TICKS, tickAt, WIDTH } from './lib/scale';
import { useZoomPan } from './lib/useZoomPan';
import { HistoryHead } from './parts/HistoryHead';
import { HistoryRail } from './parts/HistoryRail';
import { Line } from './parts/Line';
import { Totals } from './parts/Totals';

/** Narrower than this and a zoom is aiming, not reading. */
const MIN_ZOOM_MS = 1_000;

/**
 * How long the window may keep moving before the store is asked again.
 *
 * A wheel spin changes the window dozens of times a second, and every change
 * is one request to the store. The reading waits for the hand to pause; the
 * chart that is already on screen stays up meanwhile, so the pause is not a
 * blink.
 */
const SETTLE_MS = 160;

/**
 * How often a live window slides forward.
 *
 * Half the strip's cadence: the strip is a backdrop, this chart is the thing
 * being watched.
 */
const LIVE_REFRESH_MS = 5_000;

const MAX_EVENTS = 4;
const EVENT_APART = 0.03;

interface HistoryScreenProps {
  filter: FilterState;
  /** When this process started, epoch ms — an annotation when it lands here. */
  processStartedAt: number | null;
  /** Drops the list's filter, from here. */
  onClearFilter: () => void;
  /** Opens the list on one stretch of this period, filtered as the chart is. */
  onOpenRange: (from: number, to: number) => void;
  /** Opens the findings tab scoped to the drawn window. */
  onOpenFindings: (from: number, to: number) => void;
  /** Opens one request — the peek's rows lead straight to the detail. */
  onOpenRequest: (id: string) => void;
}

export function HistoryScreen({
  filter,
  processStartedAt,
  onClearFilter,
  onOpenRange,
  onOpenFindings,
  onOpenRequest,
}: HistoryScreenProps) {
  const live = useLive();
  // Everything the store holds, to begin with. A fresh session has minutes of
  // history and a staging collector has days, and in both cases the honest
  // opening question is "what is there" rather than an hour that may be empty.
  const [period, setPeriod] = useState<PeriodName>('all');
  /** The picked period's window — fixed when picked, never derived in render. */
  const [win, setWin] = useState<Window | null>(null);
  const [zoom, setZoom] = useState<Window | null>(null);
  const [metric, setMetric] = useState<SeriesMetric>('p95');
  const [companion, setCompanion] = useState<SeriesMetric | null>(null);
  /**
   * Whether the period before is drawn behind the line.
   *
   * On by default: the figures above already claim "+21% from last hour",
   * and a claim about a shape belongs on the shape.
   */
  const [ghostOn, setGhostOn] = useState(true);
  const [stored, setStored] = useState<Window | null>(null);
  /** The last reading that landed; it stays on screen while the next one is read. */
  const [answer, setAnswer] = useState<SeriesResponse | 'unavailable' | null>(null);
  const [busy, setBusy] = useState(true);
  /** Bumped by the live tick when zoomed: the same window, read again. */
  const [tick, setTick] = useState(0);

  // Unique per instance: two charts on one page would otherwise share a
  // pattern id, and the second would fill itself from the first one's.
  const hatch = useId();
  const reveal = useId();

  /**
   * What the rail is focused on: a hovered column, or the whole period.
   *
   * No rest delay — nothing floats over the chart here. A long grace, so the
   * hand can cross to the rail without the column's list dissolving on the way.
   */
  const peek = usePeek({ restMs: 0, graceMs: 900 });
  /**
   * A column the rail is locked to, as a stretch of time.
   *
   * Hover alone could not do this job: the rail is on the far side of the
   * plot, and travelling to it sweeps the pointer across every column in
   * between — each one stealing the list on the way, so the rows meant to be
   * clicked were gone before the hand arrived. A click pins the column, and
   * then the pointer is free. A stretch of time rather than an index, so a
   * live window sliding underneath does not quietly change which requests
   * the pin means.
   */
  const [pinned, setPinned] = useState<{ from: number; to: number; total: number } | null>(null);
  /** The second pinned column, from a shift-click: two moments compared. */
  const [against, setAgainst] = useState<{ from: number; to: number; total: number } | null>(null);
  /** What the panel witnessed inside the drawn window — the rules and the rail. */
  const [changed, setChanged] = useState<{
    patterns: FindingPattern[];
    outliers: readonly Outlier[];
  } | null>(null);
  const periodRef = useRef(period);
  periodRef.current = period;
  const drawnOnce = useRef(false);

  // The store's own range: the opening window, and what "everything" means.
  useEffect(() => {
    const controller = new AbortController();
    fetchTimeline(1, null, controller.signal)
      .then((timeline) => {
        const range = timeline ? { from: timeline.from, to: timeline.to } : null;
        setStored(range);
        // Only if nothing was picked while this was in flight.
        setWin((current) => current ?? windowFor('all', range));
      })
      .catch(() => {
        if (!controller.signal.aborted) setWin((current) => current ?? windowFor('all', null));
      });
    return () => controller.abort();
  }, []);

  const pickPeriod = (name: PeriodName) => {
    setZoom(null);
    // A new period is a new world; the pin belonged to the old one.
    setPinned(null);
    setPeriod(name);
    setWin(windowFor(name, stored));
    if (name !== 'all') return;
    // The store's range was read once, at mount; "everything" should mean
    // everything as of this click, not as of then.
    fetchTimeline(1)
      .then((timeline) => {
        if (!timeline || periodRef.current !== 'all') return;
        const range = { from: timeline.from, to: timeline.to };
        setStored(range);
        setWin(range);
      })
      .catch(() => undefined);
  };

  const view = zoom ?? win;
  const from = view?.from ?? 0;
  const to = view?.to ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the trigger for re-reading a pinned zoom, whose window does not move
  useEffect(() => {
    // No window yet (both default to 0), or a degenerate one: nothing to ask.
    if (to <= from) return;
    const controller = new AbortController();
    setBusy(true);

    const ask = () => {
      fetchSeries(
        {
          // The same translation the list uses, so chips and search tokens
          // compose here as they do there. Built by hand, the chips' empty
          // arrays overwrote what `status:5xx` had said, and the chart drew
          // every request under a filter the head line claimed.
          ...asQuery(filter),
          from,
          to,
          metrics: companion ? [metric, companion] : [metric],
        },
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setAnswer(result ?? 'unavailable');
          if (result) drawnOnce.current = true;
          setBusy(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // A blip in the live poll keeps the chart that is up; only a
          // screen with nothing drawn has an apology to show.
          setAnswer((current) =>
            typeof current === 'object' && current ? current : 'unavailable',
          );
          setBusy(false);
        });
    };

    // The first reading goes out at once; after that the window settles
    // first, so a wheel spin is one request rather than forty.
    const timer = setTimeout(ask, drawnOnce.current ? SETTLE_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `from` and `to` carry the period and the zoom between them; `tick` is
    // the live re-read of a pinned zoom, whose window does not move.
  }, [
    tick,
    from,
    to,
    metric,
    companion,
    filter.query,
    filter.methods,
    filter.statusClasses,
    filter.route,
    filter.duration,
  ]);

  // What happened in this window, asked once per window rather than per
  // render: the patterns first seen inside it, and the routes that strayed
  // from their usual. Both come from endpoints the panel already has — this
  // screen only asks them about a stretch rather than about a moment.
  useEffect(() => {
    if (to <= from) return;
    const controller = new AbortController();
    // The section already on screen stays while the next reading is in
    // flight. Clearing it first made the rail blink every five seconds under
    // the live tick, which is the habit this screen was cured of.
    Promise.all([
      fetchFindings([from, to], controller.signal).catch(() => null),
      // The window against everything the store holds: a route is unusual
      // here only if it was not like this the rest of the time.
      stored
        ? fetchActivity({ from, to }, stored, controller.signal).catch(
            (): ActivityReport | null => null,
          )
        : Promise.resolve<ActivityReport | null>(null),
    ])
      .then(([findings, activity]) => {
        if (controller.signal.aborted) return;
        setChanged({
          patterns: (findings?.patterns ?? []).filter(
            (pattern) => pattern.firstSeen >= from && pattern.firstSeen <= to,
          ),
          outliers: activity?.outliers ?? [],
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [from, to, stored]);

  /**
   * The rules on the chart: what the panel witnessed inside the window.
   *
   * Derived rather than fetched again — the rail's own section is asking the
   * same question, and two answers to it would eventually disagree.
   */
  const found: Annotation[] = [];
  if (changed) {
    for (const pattern of changed.patterns) {
      found.push({
        at: pattern.firstSeen,
        kind: 'finding',
        label: badgeFor(pattern.detector),
        detail: pattern.callsite
          ? `${pattern.title} · ${pattern.callsite.relative}:${pattern.callsite.line}`
          : pattern.title,
      });
    }
  }
  if (processStartedAt !== null && processStartedAt > from && processStartedAt < to) {
    found.push({
      at: processStartedAt,
      kind: 'restart',
      label: 'start',
      detail: 'this process started here — everything left of it is another run',
    });
  }

  // Thinned, oldest first: within a cluster the first one is the event, and
  // the rest are the same news arriving again.
  const annotations: Annotation[] = [];
  const eventSpan = Math.max(1, to - from);
  for (const event of [...found].sort((a, b) => a.at - b.at)) {
    if (annotations.length >= MAX_EVENTS) break;
    const last = annotations[annotations.length - 1];
    if (last && (event.at - last.at) / eventSpan < EVENT_APART) continue;
    annotations.push(event);
  }

  const drawn = typeof answer === 'object' && answer !== null ? answer : null;
  const columns = drawn?.calls.length ?? 0;
  const step = columns > 0 ? WIDTH / columns : WIDTH;

  // The pinned stretch in plot units — clamped, because a zoom or a live
  // slide can carry part of it out of view without unpinning it.
  let pinBand: { x: number; width: number } | null = null;
  if (pinned && drawn && drawn.to > drawn.from) {
    const spanMs = drawn.to - drawn.from;
    const x0 = Math.max(0, ((pinned.from - drawn.from) / spanMs) * WIDTH);
    const x1 = Math.min(WIDTH, ((pinned.to - drawn.from) / spanMs) * WIDTH);
    if (x1 > x0) pinBand = { x: x0, width: x1 - x0 };
  }

  let againstBand: { x: number; width: number } | null = null;
  if (against && drawn && drawn.to > drawn.from) {
    const spanMs = drawn.to - drawn.from;
    const x0 = Math.max(0, ((against.from - drawn.from) / spanMs) * WIDTH);
    const x1 = Math.min(WIDTH, ((against.to - drawn.from) / spanMs) * WIDTH);
    if (x1 > x0) againstBand = { x: x0, width: x1 - x0 };
  }

  /** What the rail answers for: the pin, the hovered column, or the period. */
  const railScope = !drawn
    ? null
    : (pinned ??
      (peek.column !== null
        ? {
            from: drawn.from + peek.column * drawn.bucketMs,
            to: drawn.from + (peek.column + 1) * drawn.bucketMs,
            total: drawn.calls[peek.column] ?? 0,
          }
        : { from: drawn.from, to: drawn.to, total: drawn.totals.calls }));

  const plotRef = useZoomPan({
    zoom,
    win,
    minZoomMs: MIN_ZOOM_MS,
    onZoom: setZoom,
    onClosePeek: peek.close,
  });

  const timeAt = (fraction: number): number => from + (to - from) * fraction;

  /**
   * What a gesture means on this chart: a click pins the column's requests
   * beside the plot, shift adds a second one to compare, and a drag zooms.
   */
  const { gesture, handlers, dragging } = usePlotPointer({
    columns,
    onDragStart: peek.close,
    onLeave: peek.leave,
    // A pinned rail does not chase the pointer; that is the pin.
    onHover: (column) => {
      if (pinned === null) peek.move(column);
    },
    onPick: (column, alsoThis) => {
      if (!drawn) return;
      const stretch = {
        from: drawn.from + column * drawn.bucketMs,
        to: drawn.from + (column + 1) * drawn.bucketMs,
        total: drawn.calls[column] ?? 0,
      };
      const same = (other: { from: number; to: number } | null) =>
        other !== null && other.from === stretch.from && other.to === stretch.to;

      // Shift is "and also this one": two columns held side by side, which is
      // how "was it always like this" gets asked.
      if (alsoThis && pinned && !same(pinned)) {
        setAgainst((current) => (same(current) ? null : stretch));
        return;
      }
      // A plain click is a fresh question, so the comparison the last one
      // built goes with it; and clicking the pinned column again releases it.
      setAgainst(null);
      setPinned((current) => (same(current) ? null : stretch));
    },
    onDrag: (fromFraction, toFraction) =>
      narrow({ from: timeAt(fromFraction), to: timeAt(toFraction) }),
  });
  const { hovered, dragFrom, dragTo } = gesture;

  /**
   * The live tick, and a window is three different promises: a relative period
   * slides whole, "everything" grows only at its right edge, and a zoom is
   * re-read in place — moving a stretch somebody pinned down would be hostile.
   */
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      // Not under a hand: sliding the window mid-drag shifts what the drag's
      // fractions mean, and the selection lands somewhere else.
      if (dragging()) return;
      if (zoom) {
        setTick((current) => current + 1);
        return;
      }
      if (period === 'all') {
        setWin((current) => (current ? { from: current.from, to: Date.now() } : current));
        return;
      }
      setWin(windowFor(period, stored));
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, zoom, period, stored, dragging]);

  const narrow = (range: Window) => {
    if (range.to - range.from < MIN_ZOOM_MS) return;
    setZoom(range);
  };

  // Stretches nothing was recorded in, drawn rather than left blank: an empty
  // middle between two lines reads as a broken chart, not as a quiet night.
  const voids: Array<[start: number, end: number]> = [];
  if (drawn) {
    let run: number | null = null;
    drawn.calls.forEach((calls, index) => {
      if (calls === 0) {
        run ??= index;
        return;
      }
      if (run !== null && index - run > MAX_BRIDGED) voids.push([run, index]);
      run = null;
    });
    if (run !== null && drawn.calls.length - run > MAX_BRIDGED) {
      voids.push([run, drawn.calls.length]);
    }
  }

  const readout = (): string => {
    if (!drawn || hovered === null) return '';
    const at = drawn.from + hovered * drawn.bucketMs;
    const calls = drawn.calls[hovered] ?? 0;
    if (calls === 0) return `${clock(at)} · nothing ran`;
    const values = drawn.series
      .map((line) => {
        const value = line.values[hovered];
        const info = METRICS[line.metric];
        return value === null || value === undefined
          ? `${info.label} —`
          : `${info.label} ${info.format(value)}`;
      })
      .join(' · ');
    return `${clock(at)} · ${count(calls)} calls · ${values}`;
  };

  /**
   * What makes the lines redraw themselves.
   *
   * The question, not the window: a new metric or period sweeps in from the
   * left, while a wheel zoom only swaps the data — replaying a reveal on
   * every notch of the wheel would be the blinking this screen was cured of.
   */
  const revealKey = `${metric}|${companion ?? ''}|${period}|${asQuery(filter).q ?? ''}`;

  /** Why there is no chart, when there is none: a store that cannot, or a wait. */
  const notice = () => {
    if (answer === 'unavailable') {
      return (
        <p className="history-empty s-dim mono">
          this store cannot read a stretch of history — the panel would be drawing a week it never
          recorded
        </p>
      );
    }
    if (!drawn && busy) return <p className="history-empty s-dim mono">reading the period…</p>;
    return null;
  };

  return (
    <div className="history">
      <HistoryHead
        period={period}
        metric={metric}
        companion={companion}
        ghostOn={ghostOn}
        zoom={zoom}
        view={view}
        filter={filter}
        onPickPeriod={pickPeriod}
        onPickMetric={setMetric}
        onPickCompanion={setCompanion}
        onToggleGhost={setGhostOn}
        onClearZoom={() => setZoom(null)}
        onClearFilter={onClearFilter}
      />

      {notice()}

      {drawn ? (
        <>
          {drawn.totals.calls === 0 ? (
            // The chart stays: all hatch, which is what an empty stretch looks
            // like — and the way back out (the wheel, the exit button) stays
            // with it. A message that replaced the chart would strand whoever
            // zoomed into a quiet night.
            <p className="history-empty s-dim mono">nothing ran in this period</p>
          ) : (
            <Totals totals={drawn.totals} previous={drawn.previous} />
          )}

          {drawn.truncated ? (
            <p className="history-note s-warn mono">
              the store stopped reading before the period ended — these numbers are its most recent
              requests, not all of them
            </p>
          ) : null}

          <div className="history-legend">
            {drawn.series.map((line, index) => (
              <span key={line.metric} className={index === 0 ? 'key-p95' : 'key-companion'}>
                — {METRICS[line.metric].label}
                <span className="s-dim"> peak {METRICS[line.metric].format(peakOf(line))}</span>
              </span>
            ))}
          </div>

          <div className="history-chart">
            <div className="history-plot-box">
              <button
                ref={plotRef}
                type="button"
                className="chart-plot history-plot"
                data-busy={busy}
                aria-label={`${METRICS[metric].label} over the period — click a column to pin its requests beside the chart, drag or scroll to zoom`}
                {...handlers}
              >
                <svg
                  className="chart-svg history-svg"
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={METRICS[metric].label}
                >
                  <title>{METRICS[metric].label}</title>

                  <defs>
                    <pattern
                      id={hatch}
                      width="6"
                      height="6"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <line className="chart-hatch" x1="0" y1="0" x2="0" y2="6" />
                    </pattern>
                    <clipPath id={reveal} clipPathUnits="userSpaceOnUse">
                      {/* Keyed so a new question replays the sweep; scaling a
                        clip rather than dashing the stroke, because the plot
                        is stretched non-uniformly and dash lengths stretch
                        with it. */}
                      <rect
                        key={revealKey}
                        className="chart-reveal"
                        x={0}
                        y={0}
                        width={WIDTH}
                        height={HEIGHT}
                      />
                    </clipPath>
                  </defs>
                  {voids.map(([start, end]) => (
                    <rect
                      key={`void-${start}`}
                      className="chart-void"
                      fill={`url(#${hatch})`}
                      x={start * step}
                      y={0}
                      width={(end - start) * step}
                      height={HEIGHT}
                    >
                      <title>Nothing ran in this stretch</title>
                    </rect>
                  ))}

                  <g clipPath={`url(#${reveal})`}>
                    {/* Drawn first, so the present is on top. */}
                    {ghostOn && drawn.ghost ? (
                      <Line
                        line={{ metric: metric, values: drawn.ghost }}
                        columns={columns}
                        className="chart-ghost"
                        peak={drawn.series[0] ? peakOf(drawn.series[0]) : 0}
                      />
                    ) : null}
                    {drawn.series.map((line, index) => (
                      <Line
                        key={line.metric}
                        line={line}
                        columns={columns}
                        className={index === 0 ? 'chart-p95' : 'chart-companion'}
                      />
                    ))}
                  </g>

                  {/* Only what was witnessed: a pattern first seen, a
                      process starting. Never an inferred deploy. */}
                  {drawn.to > drawn.from
                    ? annotations.map((event) => (
                        <EventMark
                          key={`${event.kind}-${event.at}`}
                          event={event}
                          from={drawn.from}
                          to={drawn.to}
                        />
                      ))
                    : null}

                  {pinBand ? (
                    <rect
                      className="chart-pin"
                      x={pinBand.x}
                      y={0}
                      width={pinBand.width}
                      height={HEIGHT}
                    />
                  ) : null}

                  {againstBand ? (
                    <rect
                      className="chart-pin chart-pin-b"
                      x={againstBand.x}
                      y={0}
                      width={againstBand.width}
                      height={HEIGHT}
                    />
                  ) : null}

                  {hovered !== null && dragFrom === null ? (
                    <rect
                      className="chart-hover"
                      x={hovered * step}
                      y={0}
                      width={step}
                      height={HEIGHT}
                    />
                  ) : null}

                  {dragFrom !== null && dragTo !== null ? (
                    <rect
                      className="chart-drag"
                      x={Math.min(dragFrom, dragTo) * WIDTH}
                      y={0}
                      width={Math.abs(dragTo - dragFrom) * WIDTH}
                      height={HEIGHT}
                    />
                  ) : null}
                </svg>
              </button>

              {/* The chips that name the rules. HTML for the same reason the
                  ticks are: text inside a stretched viewBox is unreadable,
                  and this layer must never swallow a click on a column. */}
              {drawn.to > drawn.from && annotations.length > 0 ? (
                <div className="history-events" aria-hidden="true">
                  {annotations.map((event) => (
                    <span
                      key={`${event.kind}-${event.at}`}
                      className="event-chip"
                      data-kind={event.kind}
                      style={{
                        // The rule sits exactly on the moment; its label is
                        // nudged in from the edges, because half a chip
                        // hanging off the plot is not a label.
                        left: `${Math.min(96, Math.max(4, ((event.at - drawn.from) / (drawn.to - drawn.from)) * 100))}%`,
                      }}
                      title={`${clock(event.at)} · ${event.detail}`}
                    >
                      {event.label}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* The scale, in HTML rather than in the SVG: the plot is stretched
              to the width of the screen and text stretched with it is
              unreadable. Each line gets its own side, because two metrics
              share a box and almost never a unit. */}
              {drawn.series.map((line, index) => (
                <div
                  key={`axis-${line.metric}`}
                  className={index === 0 ? 'history-axis' : 'history-axis history-axis-right'}
                  aria-hidden="true"
                >
                  <span>{METRICS[line.metric].format(peakOf(line))}</span>
                  <span>{METRICS[line.metric].format(peakOf(line) / 2)}</span>
                  <span>0</span>
                </div>
              ))}
            </div>

            {railScope && drawn ? (
              <HistoryRail
                scope={railScope}
                drawn={drawn}
                metric={metric}
                filter={filter}
                pinned={pinned}
                against={against}
                changed={changed}
                peek={peek}
                zoom={zoom}
                onUnpin={() => setPinned(null)}
                onDropAgainst={() => setAgainst(null)}
                onOpenRange={onOpenRange}
                onOpenFindings={onOpenFindings}
                onOpenRequest={onOpenRequest}
              />
            ) : null}
          </div>

          <div className="history-ticks" aria-hidden="true">
            {Array.from({ length: TICKS }, (_, index) => {
              const at = drawn.from + ((drawn.to - drawn.from) * index) / (TICKS - 1);
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length axis; a degenerate window makes `at` the same for every tick
              return <span key={index}>{tickAt(at, drawn.to - drawn.from)}</span>;
            })}
          </div>

          <div className="history-foot">
            <span className="mono s-fg2">
              {readout() ||
                `${count(drawn.totals.calls)} calls · ${columns} columns · ${columnSpan(drawn.bucketMs)} each`}
            </span>
            <span className="spacer" />
            <span className="s-dim mono">
              click a column to pin its requests · shift-click a second to compare · drag or scroll
              to zoom
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
