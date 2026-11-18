import { duration, spanColor } from '../format';
import { badgeFor } from './badge';
import type { WaterfallBar } from './model';

interface BarRowProps {
  bar: WaterfallBar;
  /** The request's whole duration — every length here is a share of it. */
  total: number;
  /** Its place in the list, which staggers the reveal. */
  index: number;
}

/** One span: its name, its bar on the shared axis, and what it cost. */
export function BarRow({ bar, total, index }: BarRowProps) {
  const gap = bar.kind === 'gap';
  /** A gap is an absence: an outline where a bar would be, so it reads as
      "nothing was measured here", not as more work. */
  const fill = gap
    ? {
        background: 'transparent',
        border: '1px dashed var(--fg3)',
        boxSizing: 'border-box' as const,
      }
    : { background: spanColor(bar.kind) };
  const share = (ms: number) => `${Math.max((ms / total) * 100, 0.2)}%`;

  return (
    <div className="wf-row wf-span">
      <span className="wf-label" style={{ paddingLeft: `${bar.depth * 16}px` }}>
        <span
          className="wf-swatch"
          style={gap ? { background: 'transparent', border: '1px dashed var(--fg3)' } : fill}
        />
        <span className={`ellipsis ${bar.kind === 'middleware' || gap ? 's-fg2' : ''}`}>
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
        {/* The queue in front of the query, drawn where it happened: to the
            left of the bar, in the same row, so the eye reads "waited, then
            ran" without being given another line to match up. */}
        {bar.waitMs ? (
          <span
            className="wf-wait"
            style={{
              left: `${(Math.max(0, bar.startedAt - bar.waitMs) / total) * 100}%`,
              width: share(bar.waitMs),
            }}
            title={`waited ${duration(bar.waitMs)} for a free connection`}
          />
        ) : null}
        <span
          className={gap ? 'wf-bar wf-bar-gap' : 'wf-bar'}
          style={{
            ...fill,
            left: `${(bar.startedAt / total) * 100}%`,
            width: share(bar.duration),
            // A slight cascade top to bottom, so the trace reads as being
            // replayed; capped so long lists do not turn it into a wait.
            animationDelay: `${Math.min(index * 20, 160)}ms`,
          }}
          title={`${bar.label} — ${duration(bar.duration)} @ +${duration(bar.startedAt)}`}
        />
      </span>
      <span className="wf-duration">{duration(bar.duration)}</span>
    </div>
  );
}

/**
 * The waterfall of one request.
 *
 * `totalOverride` pins the time scale from outside — the compare screen puts
 * two waterfalls on one scale, otherwise the shorter request would look
 * deceptively similar to the longer one.
 */
