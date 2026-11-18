import type { RequestDetail } from '../../../api/index';
import { clock, duration, durationTone, methodTone, statusTone } from '../../../shared/format';

interface SideHeadProps {
  tag: string;
  detail: RequestDetail;
}

export function SideHead({ tag, detail }: SideHeadProps) {
  return (
    <div className="detail-head" style={{ border: 'none', paddingLeft: 0 }}>
      <span className="mono s-dim">{tag}</span>
      <span className={`mono ${methodTone(detail.method)}`}>{detail.method}</span>
      <span className="detail-path ellipsis">{detail.path}</span>
      <span className={`status-badge ${statusTone(detail.status)}`}>{detail.status}</span>
      <span className={`mono num ${durationTone(detail.durationMs)}`}>
        {duration(detail.durationMs)}
      </span>
      <span className="mono s-dim" style={{ fontSize: 11 }}>
        {clock(detail.startedAt)}
      </span>
    </div>
  );
}
