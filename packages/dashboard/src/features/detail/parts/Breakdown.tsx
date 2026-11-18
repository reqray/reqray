import type { DurationBaseline, RequestDetail } from '../../../api/index';
import { bytes, count, duration, spanColor } from '../../../shared/format';
import { CostNote } from './CostNote';

interface BreakdownProps {
  detail: RequestDetail;
  baseline: DurationBaseline | null;
}

/**
 * Where the time went, and whether this call was unusual.
 *
 * The duration in the header says how long it took. It cannot say whether
 * that is the database's doing or the application's, and it cannot say
 * whether 400 ms is a disaster or a Tuesday — which is the same question the
 * reader has both times they open this screen.
 */
export function Breakdown({ detail, baseline }: BreakdownProps) {
  const timing = detail.timing;
  if (!timing) return null;

  // Layers that cost nothing are left out rather than printed as zero: a
  // request that touched no cache has nothing to say about caching.
  const parts: Array<[label: string, ms: number, color: string]> = [
    ['sql', timing.sqlMs, spanColor('db')],
    ['external', timing.externalMs, spanColor('http')],
    ['cache', timing.cacheMs, spanColor('cache')],
    ['your code', timing.selfMs, 'var(--acc-soft)'],
  ];
  const segments = parts.filter(([, ms]) => ms >= 0.05);
  const total = Math.max(
    detail.durationMs,
    segments.reduce((sum, [, ms]) => sum + ms, 0),
    0.001,
  );

  return (
    <div className="breakdown">
      <span className="mono num">{duration(detail.durationMs)}</span>
      {/* The split as lengths, not as a sentence: one 16px bar, each layer's
          share visible before any number is read. Labels live inside the
          segments that can hold them; the rest speak on hover. */}
      <span
        className="split-bar"
        role="img"
        aria-label={segments.map(([label, ms]) => `${duration(ms)} ${label}`).join(', ')}
      >
        {segments.map(([label, ms, color]) => (
          <span
            key={label}
            className="split-seg"
            style={{ width: `${Math.max(1.5, (ms / total) * 100)}%`, background: color }}
            title={`${duration(ms)} ${label}`}
          >
            {ms / total >= 0.16 ? (
              <span className="split-label">
                {duration(ms)} {label}
              </span>
            ) : null}
          </span>
        ))}
      </span>
      {timing.parallel ? (
        <span
          className="s-dim breakdown-note"
          title="Some of it ran at the same time, so the parts add up past the total."
        >
          overlapping
        </span>
      ) : null}
      {weightWorthSaying(detail.weight) ? (
        <span
          className="s-dim breakdown-note"
          title="What the request moved: bytes back to the client, and rows out of the database. This is the honest half of “where did the memory go” — Node cannot attribute heap to a request, but it can say what the request carried."
        >
          · {detail.weight.bytesOut === null ? '' : `${bytes(detail.weight.bytesOut)} out`}
          {detail.weight.rows > 0 ? ` · ${count(detail.weight.rows)} rows` : ''}
        </span>
      ) : null}
      <CostNote cost={detail.cost} />
      {detail.host && detail.host.loopMaxMs >= LOOP_WORTH_SAYING ? (
        <span
          className="s-warn breakdown-note"
          title="The event loop was this far behind schedule while the request was in flight — the process, not this request. Under load the code that blocked it is usually somebody else's."
        >
          · loop behind {duration(detail.host.loopMaxMs)}
        </span>
      ) : null}
      {baseline ? (
        <>
          <span className="spacer" />
          <span className="verdict" data-verdict={baseline.verdict}>
            {verdictOf(baseline)}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** The verdict as a sentence, with the sample it rests on. */
function verdictOf(baseline: DurationBaseline): string {
  const of = `${baseline.samples} call${baseline.samples === 1 ? '' : 's'} to ${baseline.route}`;
  if (baseline.verdict === 'slower') return `slower than 95% of ${of}`;
  if (baseline.verdict === 'faster') return `faster than average of ${of}`;
  // Slower than the mean is true of about half of all calls, and half of all
  // calls are not news.
  return `typical for this route · ${of}`;
}

/**
 * When what the request moved is worth a word.
 *
 * A four-kilobyte response is not news, and neither is one row. The strip
 * speaks up where the weight is the story — which is where the detector is
 * about to fire, or close to it.
 */
function weightWorthSaying(weight: RequestDetail['weight']): boolean {
  if (!weight) return false;
  return (weight.bytesOut ?? 0) >= 256 * 1024 || weight.rows >= 1_000;
}

/**
 * Below this the loop was on time and saying so is noise.
 *
 * One sampling interval of lateness: under it, what is being reported is the
 * measurement's own granularity rather than anything that happened.
 */
const LOOP_WORTH_SAYING = 15;
