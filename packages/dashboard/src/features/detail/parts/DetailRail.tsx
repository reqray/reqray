import { useCallback } from 'react';
import { type DurationBaseline, fetchRequests, type RequestDetail } from '../../../api/index';
import { clock, count, duration, durationTone, methodTone } from '../../../shared/format';
import { useLiveQuery } from '../../../shared/useLiveQuery';

/** How many neighbours the rail names, and how far it looks for them. */
const NEARBY_LIMIT = 4;

const NEARBY_WINDOW_MS = 5_000;

interface DetailRailProps {
  detail: RequestDetail;
  baseline: DurationBaseline | null;
  onOpen: (id: string) => void;
}

/**
 * The context rail: what this request is, seen from outside itself.
 *
 * The main column explains the request from within — spans, queries, the
 * fix. The rail answers the questions that need other requests: is this
 * duration normal for the route, who issued it, and what else was happening
 * at that moment. The BASELINE section (pinned p95, compare runs) is not
 * built yet: it needs data the panel does not keep.
 */
export function DetailRail({ detail, baseline, onOpen }: DetailRailProps) {
  const asked = useLiveQuery(
    useCallback(
      async (signal: AbortSignal) => {
        const page = await fetchRequests(
          {
            from: detail.startedAt - NEARBY_WINDOW_MS,
            to: detail.startedAt + NEARBY_WINDOW_MS,
            limit: 50,
          },
          null,
          signal,
        );
        return (
          page.requests
            // The store adds pinned requests to every answer, whenever they
            // were recorded; one from an hour ago is not a neighbour.
            .filter((row) => Math.abs(row.startedAt - detail.startedAt) <= NEARBY_WINDOW_MS)
            .filter((row) => row.id !== detail.id)
            .sort(
              (a, b) =>
                Math.abs(a.startedAt - detail.startedAt) - Math.abs(b.startedAt - detail.startedAt),
            )
            .slice(0, NEARBY_LIMIT)
            .sort((a, b) => b.startedAt - a.startedAt)
        );
      },
      [detail.id, detail.startedAt],
    ),
  );
  // A neighbourhood that could not be read renders as an empty one: the rail
  // is a convenience, and it must not be why the detail shows an apology.
  const nearby = asked.error ? [] : asked.data;

  // The strip is scaled to the slowest comparable call; the marker is this
  // one. Ticks at the percentiles, so "slower than most" is visible as a
  // position before it is read as a verdict.
  const strip =
    baseline && baseline.maxMs > 0
      ? {
          at: Math.min(100, (detail.durationMs / baseline.maxMs) * 100),
          ticks: [
            ['p50', baseline.p50Ms],
            ['p95', baseline.p95Ms],
            ['p99', baseline.p99Ms],
          ].filter((entry): entry is [string, number] => entry[1] !== null),
        }
      : null;

  /** What else the process was doing — still reading, nothing, or the rows. */
  const nearbyRows = () => {
    if (nearby === null) return <div className="s-dim rail-note">reading…</div>;
    if (nearby.length === 0) return <div className="s-dim rail-note">nothing else ran near it</div>;

    return nearby.map((row) => (
      <button key={row.id} type="button" className="nearby-row" onClick={() => onOpen(row.id)}>
        <span className="s-dim">{clock(row.startedAt)}</span>
        <span className={methodTone(row.method)}>{row.method}</span>
        <span className="ellipsis">{row.path}</span>
        <span className={`cell-right ${durationTone(row.durationMs)}`}>
          {duration(row.durationMs)}
        </span>
      </button>
    ));
  };

  return (
    <aside className="detail-rail mono">
      <section className="rail-part">
        <div className="label">THIS REQUEST VS THE ROUTE</div>
        {baseline && strip ? (
          <>
            <div className="s-dim rail-note">
              {count(baseline.samples)} other call{baseline.samples === 1 ? '' : 's'} to{' '}
              {baseline.route}
            </div>
            <div className="vs-strip">
              {strip.ticks.map(([name, ms]) => (
                <span
                  key={name}
                  className="vs-tick"
                  style={{ left: `${Math.min(100, (ms / baseline.maxMs) * 100)}%` }}
                  title={`${name} ${duration(ms)}`}
                />
              ))}
              <span className="vs-marker" style={{ left: `${strip.at}%` }} />
            </div>
            <div className="vs-this" data-verdict={baseline.verdict}>
              this · {duration(detail.durationMs)} · {baseline.verdict}
            </div>
            <div className="vs-figures s-fg2">
              p50 {duration(baseline.p50Ms)}
              {baseline.p95Ms !== null ? ` · p95 ${duration(baseline.p95Ms)}` : ''}
              {baseline.p99Ms !== null ? ` · p99 ${duration(baseline.p99Ms)}` : ''}
            </div>
          </>
        ) : (
          <div className="s-dim rail-note">not enough other calls to compare against</div>
        )}
      </section>

      {detail.test ? (
        <section className="rail-part test-strip">
          <div className="label">ISSUED BY</div>
          <div className="rail-issued">
            <span className="test-badge">TEST</span>
            <span className="s-fg2">issued by {detail.test}</span>
          </div>
        </section>
      ) : null}

      <section className="rail-part">
        <div className="label">NEARBY IN TIME</div>
        {nearbyRows()}
      </section>
    </aside>
  );
}
