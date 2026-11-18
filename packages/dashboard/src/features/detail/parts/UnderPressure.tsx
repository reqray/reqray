import type { HostPressure } from '../../../api/index';
import { duration } from '../../../shared/format';

interface UnderPressureProps {
  pressure: HostPressure | null;
}

/**
 * Was the process to blame?
 *
 * The route's own calls, split by whether the loop was in its own top
 * quartile at the time. Absent far more often than present — it takes forty
 * measured calls, a loop that actually varied, and a difference worth a
 * sentence — and it never claims cause: a batch job hammering the same
 * process explains the shape as well as this route being its victim.
 */
export function UnderPressure({ pressure }: UnderPressureProps) {
  if (!pressure) return null;

  const side = (label: string, half: HostPressure['elevated']) => (
    <span className="pressure-side">
      <span className="s-dim">{label}</span>
      <span className="mono num">p95 {duration(half.p95Ms)}</span>
      <span className="mono num s-fg2">avg {duration(half.avgMs)}</span>
      <span className="s-dim">{half.calls} calls</span>
    </span>
  );

  return (
    <section className="pressure">
      <div className="pressure-head">
        <span className="pressure-badge">HOST</span>
        <span>
          When event-loop delay was over{' '}
          <span className="mono num">{duration(pressure.cutoffMs)}</span>, this route's p95 was{' '}
          <span className="mono num s-warn">{pressure.ratio.toFixed(1)}× slower</span> —{' '}
          {Math.round(pressure.share)}% of calls landed there.
        </span>
      </div>
      <div className="pressure-sides">
        {side('loop quiet', pressure.normal)}
        {side('loop behind', pressure.elevated)}
      </div>
      <div className="pressure-hint s-dim">
        The cutoff is this process's own top quartile, not a fixed threshold. The two moved
        together, which is evidence and not proof — a neighbour on the same box explains it as well.
      </div>
    </section>
  );
}
