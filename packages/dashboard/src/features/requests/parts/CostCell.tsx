import { duration } from '../../../shared/format';

interface CostCellProps {
  /** Processor time in the request's window, or `null` when unmeasured. */
  cpuMs: number | null;
  /** That time as a share of the wall clock, 0..1. */
  cpuShare: number | null;
  /** The slowest duration in view — the same yardstick the duration uses. */
  yardMs: number;
}

/**
 * How much of its own life the request spent on a processor.
 *
 * The thresholds are about what the reader should do, not about the numbers:
 * under a third, the request was mostly waiting and the duration column is
 * where the answer is; over seven tenths, it was working, and no amount of
 * database tuning will help it.
 */
function toneFor(busy: number): 'err' | 'warn' | 'dim' {
  if (busy >= 0.7) return 'err';
  if (busy >= 0.35) return 'warn';
  return 'dim';
}

/**
 * How busy a request kept a processor, on the yardstick beside it.
 *
 * Deliberately the same scale as the duration cell, because the two are only
 * useful read together: a long bar next to a short one is a request that
 * waited, and two long bars are a request that worked. That comparison is the
 * whole column — a number on its own would need the duration held in mind.
 */
export function CostCell({ cpuMs, cpuShare, yardMs }: CostCellProps) {
  if (cpuMs === null) {
    return (
      <span className="cell-right cell-cost s-dim" title="not measured for this request">
        —
      </span>
    );
  }

  // The bar is clamped because a bar has to fit; the figure beside it is not.
  const share = yardMs > 0 ? Math.min(1, Math.sqrt(cpuMs / yardMs)) : 0;
  // How much of its life the request spent on a processor, which is what
  // makes it expensive rather than merely slow.
  const busy = cpuShare ?? 0;
  const tone = toneFor(busy);

  return (
    <span
      className="cell-right cell-cost"
      title={
        busy > 1
          ? `${duration(cpuMs)} of processor time in a ${duration(cpuMs / busy)} request — ${Math.round(busy * 100)}%, so more than one thread worked for it`
          : `${duration(cpuMs)} of processor time — ${Math.round(busy * 100)}% of the request`
      }
    >
      <span className="dur-track">
        <span
          className="cpu-fill"
          data-tone={tone}
          style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}
        />
      </span>
      <span className={`s-${tone}`}>{duration(cpuMs)}</span>
    </span>
  );
}
