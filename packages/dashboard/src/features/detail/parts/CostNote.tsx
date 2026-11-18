import type { RequestCost } from '../../../api/index';
import { duration } from '../../../shared/format';

interface CostNoteProps {
  cost: RequestCost | null;
}

/**
 * Under this share, the request was waiting and the split bar above already
 * said so. Repeating it as a processor figure adds a number without adding an
 * answer.
 */
const BUSY_WORTH_SAYING = 0.2;

/**
 * How much of the window belonged to this request before the figure needs a
 * caveat. One other request is company; four is a crowd, and the reading is
 * then about the process.
 */
const CROWDED = 1;

/**
 * What the figure is allowed to claim, spelled out for the reader.
 *
 * Three different readings, and printing the same sentence under all of them
 * would be the panel declining to say which one this is.
 */
function titleFor(cost: RequestCost): string {
  if (cost.cpuShare > 1) {
    return 'More processor time than the request took, so more than one thread was working for it — the libuv pool doing filesystem, DNS, compression or crypto work, or a worker thread.';
  }
  if (cost.overlap > CROWDED) {
    return `${cost.overlap} other requests shared this window, so the processor time belongs to the window rather than to this request alone.`;
  }
  return 'Processor time in this request’s window. No other request was in flight, so it is this one’s.';
}

/** What to call it, given how much of its life the request was on a processor. */
function toneFor(busy: number): string {
  if (busy >= 0.7) return 's-err';
  if (busy >= 0.35) return 's-warn';
  return 's-dim';
}

/**
 * Why the request cost what it did, when the answer is the processor.
 *
 * The split bar says where the time went; it cannot say whether the time was
 * spent or merely passed. A request that waits 800 ms on a database and one
 * that hashes for 800 ms draw the same bar and cost the process nothing alike.
 */
export function CostNote({ cost }: CostNoteProps) {
  if (!cost || cost.cpuShare < BUSY_WORTH_SAYING) return null;

  const busy = Math.round(cost.cpuShare * 100);
  const shared = cost.overlap > CROWDED;
  const gc = cost.gcMs >= 1 ? ` · ${duration(cost.gcMs)} gc` : '';
  // More processor time than wall time: the libuv pool or a worker was
  // working for this request, which is a fact worth its own words rather
  // than a number to round down to 100%.
  const threaded = cost.cpuShare > 1;

  return (
    <span className={`${toneFor(cost.cpuShare)} breakdown-note`} title={titleFor(cost)}>
      · {duration(cost.cpuMs)} cpu ({busy}%){gc}
      {threaded ? <span className="s-dim"> · across threads</span> : null}
      {shared ? <span className="s-dim"> · shared with {cost.overlap}</span> : null}
    </span>
  );
}
