import type { Finding } from '../../../api/index';
import { oneLine } from '../../../shared/format';
import { badgeFor } from '../../../shared/waterfall/badge';
import { costLine, evidenceLine } from '../lib/briefing';

/**
 * What tells two findings apart in a list.
 *
 * Two from one detector differ by their evidence. The ones about the request
 * rather than about a repeated span — the budget, the response's size — occur
 * once, so their detector is enough.
 */
export function keyOf(finding: Finding): string {
  const evidence = finding.evidence;
  return `${finding.detector}-${'fingerprint' in evidence ? evidence.fingerprint : ''}`;
}

interface CalloutProps {
  finding: Finding;
  /** The request's own duration, which the cost is weighed against. */
  ofMs: number;
}

/** A finding stated but not answered — the compact form under THE FIX. */
export function Callout({ finding, ofMs }: CalloutProps) {
  return (
    <section className="callout" data-severity={finding.severity}>
      <div className="callout-head">
        <span className="badge-nplus" data-severity={finding.severity}>
          {badgeFor(finding.detector)}
        </span>
        <span className="callout-title">{finding.title}</span>
        <span className="spacer" />
        <span className="mono s-fg2" style={{ fontSize: 11 }}>
          {costLine(finding, ofMs)}
        </span>
      </div>
      <div className="callout-sql ellipsis">{oneLine(evidenceLine(finding))}</div>
      <div className="callout-hint">
        {finding.callsite
          ? `called from ${finding.callsite.relative}:${finding.callsite.line} → ${finding.hint}`
          : finding.hint}
      </div>
    </section>
  );
}
