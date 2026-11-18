import type { RequestDetail } from '../../../api/index';

interface LogsTabProps {
  detail: RequestDetail;
}

export function LogsTab({ detail }: LogsTabProps) {
  const tone = (level: string) =>
    level === 'error' ? 's-err' : level === 'warn' ? 's-warn' : 's-dim';

  return (
    <div>
      {detail.logs.map((entry, index) => (
        // Log lines carry no identity of their own and never reorder.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
        <div key={index} className="log-row">
          <span className="s-dim">+{entry.at.toFixed(1)} ms</span>
          <span className={tone(entry.level)}>{entry.level}</span>
          <span className="s-fg2">{entry.message}</span>
        </div>
      ))}
    </div>
  );
}
