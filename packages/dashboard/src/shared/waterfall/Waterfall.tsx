import { useMemo, useState } from 'react';
import type { RequestDetail } from '../../api/index';
import { duration } from '../format';
import { BarRow } from './BarRow';
import { buildWaterfall, uninstrumentedMs } from './model';

/** Below this share of the request, a span is noise between the answers. */
const INSIGNIFICANT = 0.01;
/** Above this many bars, that noise is worth folding away. */
const CROWDED = 12;

interface WaterfallProps {
  detail: RequestDetail;
  totalOverride?: number;
}

export function Waterfall({ detail, totalOverride }: WaterfallProps) {
  const bars = useMemo(() => buildWaterfall(detail), [detail]);
  const [showAll, setShowAll] = useState(false);
  const total =
    totalOverride ??
    Math.max(detail.durationMs, ...bars.map((bar) => bar.startedAt + bar.duration), 1);
  const gapMs = uninstrumentedMs(bars);

  // A real trace puts one 34 ms span next to thirty at 0.00 ms. The screen
  // opens on the ones that hold the time; the rest are a click away, with
  // their count visible so nothing looks like it was never recorded. A span a
  // detector named stays regardless of how short it is — being named is the
  // reason it is on screen.
  //
  // Only on a waterfall long enough for the noise to be the problem. On a
  // trace of five spans there is nothing to scroll past, and hiding the one
  // millisecond query would remove the very thing that explains where the
  // rest of the time went.
  const candidates = bars.filter(
    (bar) => !bar.finding && !bar.marks && bar.duration < detail.durationMs * INSIGNIFICANT,
  );
  const slight = bars.length > CROWDED && candidates.length >= 3 ? candidates : [];
  const shown = showAll || slight.length === 0 ? bars : bars.filter((bar) => !slight.includes(bar));

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

      {shown.map((bar, index) => (
        <BarRow key={bar.key} bar={bar} total={total} index={index} />
      ))}
      {slight.length > 0 && !showAll ? (
        <button type="button" className="wf-more" onClick={() => setShowAll(true)}>
          {slight.length} span{slight.length === 1 ? '' : 's'} under{' '}
          {Math.round(INSIGNIFICANT * 100)}% of the request — show
        </button>
      ) : null}
    </section>
  );
}
