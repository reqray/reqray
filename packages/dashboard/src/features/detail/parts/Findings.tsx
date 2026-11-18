import type { RequestDetail } from '../../../api/index';
import { Callout, keyOf } from './Callout';
import { FixCard } from './FixCard';

interface FindingsProps {
  detail: RequestDetail;
  replayEnabled: boolean;
  onShowCalls: (fingerprint: string) => void;
  onReplay: () => void;
}

export function Findings({ detail, replayEnabled, onShowCalls, onReplay }: FindingsProps) {
  const [worst, ...rest] = detail.findings;
  if (!worst) return null;

  return (
    <section className="findings">
      <div className="findings-label label">
        {rest.length === 0 ? 'THE FIX' : `THE FIX · AND ${rest.length} MORE`}
      </div>
      {/* The costliest finding is answered in full; the rest stay compact —
          one fix at a time is how fixes actually happen. */}
      <FixCard
        detail={detail}
        finding={worst}
        replayEnabled={replayEnabled}
        onShowCalls={onShowCalls}
        onReplay={onReplay}
      />
      {rest.map((finding) => (
        <Callout key={keyOf(finding)} finding={finding} ofMs={detail.durationMs} />
      ))}
    </section>
  );
}
