import { useMemo } from 'react';
import type { RequestDetail } from '../api';
import { duration, spanColor } from '../format';
import { buildWaterfall, uninstrumentedMs } from '../waterfall';

/** Short badge for a detector; new detectors fall back to their id. */
export function badgeFor(detector: string): string {
  switch (detector) {
    case 'n_plus_one':
      return 'N+1';
    case 'sequential_http':
      return 'SEQ HTTP';
    case 'dup_http':
    case 'dup_cache':
      return 'DUP';
    case 'slow_budget':
      return 'SLOW';
    default:
      return detector.toUpperCase();
  }
}

/**
 * The waterfall of one request.
 *
 * `totalOverride` pins the time scale from outside — the compare screen puts
 * two waterfalls on one scale, otherwise the shorter request would look
 * deceptively similar to the longer one.
 */
export function Waterfall({
  detail,
  totalOverride,
}: {
  detail: RequestDetail;
  totalOverride?: number;
}) {
  const bars = useMemo(() => buildWaterfall(detail), [detail]);
  const total =
    totalOverride ??
    Math.max(detail.durationMs, ...bars.map((bar) => bar.startedAt + bar.duration), 1);
  const gapMs = uninstrumentedMs(bars);

  return (
    <section className="waterfall">
      <div className="waterfall-head">
        <span className="label">WATERFALL</span>
        <span className="label">
          {/* The real span count, not the number of bars: a run of repeats is
              drawn as one bar but was many queries. */}
          {detail.spans.length} spans · {duration(detail.durationMs)} total
          {gapMs > 0 ? ` · ${duration(gapMs)} uninstrumented` : ''}
        </span>
      </div>

      <div className="wf-row">
        <span />
        <div className="wf-scale">
          <span>0</span>
          <span>{duration(total * 0.25)}</span>
          <span>{duration(total * 0.5)}</span>
          <span>{duration(total * 0.75)}</span>
          <span>{duration(total)}</span>
        </div>
        <span />
      </div>

      {bars.map((bar, index) => (
        <div key={bar.key} className="wf-row wf-span">
          <span className="wf-label" style={{ paddingLeft: `${bar.depth * 16}px` }}>
            <span
              className="wf-swatch"
              style={
                bar.kind === 'gap'
                  ? { background: 'transparent', border: '1px dashed var(--fg3)' }
                  : { background: spanColor(bar.kind) }
              }
            />
            <span
              className={`ellipsis ${bar.kind === 'middleware' || bar.kind === 'gap' ? 's-fg2' : ''}`}
            >
              {bar.label}
            </span>
            {bar.finding ? <span className="badge-nplus">{badgeFor(bar.finding)}</span> : null}
            {bar.marks?.map((detector) => (
              <span key={detector} className="badge-nplus" title="duplicate work">
                {badgeFor(detector)}
              </span>
            ))}
          </span>
          <span className="wf-track">
            <span
              className={bar.kind === 'gap' ? 'wf-bar wf-bar-gap' : 'wf-bar'}
              style={{
                // A gap is an absence: an outline where a bar would be, so it
                // reads as "nothing was measured here", not as more work.
                ...(bar.kind === 'gap'
                  ? {
                      background: 'transparent',
                      border: '1px dashed var(--fg3)',
                      boxSizing: 'border-box' as const,
                    }
                  : { background: spanColor(bar.kind) }),
                left: `${(bar.startedAt / total) * 100}%`,
                width: `${Math.max((bar.duration / total) * 100, 0.2)}%`,
                // A slight cascade top to bottom, so the trace reads as being
                // replayed; capped so long lists do not turn it into a wait.
                animationDelay: `${Math.min(index * 20, 160)}ms`,
              }}
              title={`${bar.label} — ${duration(bar.duration)} @ +${duration(bar.startedAt)}`}
            />
          </span>
          <span className="wf-duration">{duration(bar.duration)}</span>
        </div>
      ))}
    </section>
  );
}
