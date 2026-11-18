import type { RequestDetail } from '../../../api/index';

interface HeadersTabProps {
  detail: RequestDetail;
}

export function HeadersTab({ detail }: HeadersTabProps) {
  const column = (title: string, headers: Record<string, string>) => (
    <div>
      <div className="label">{title}</div>
      {Object.entries(headers).map(([key, value]) => (
        <div key={key} className="kv-row">
          <span className="kv-key ellipsis">{key}</span>
          <span className="ellipsis">{value}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="headers">
      {column('REQUEST', detail.requestHeaders)}
      {column('RESPONSE', detail.responseHeaders)}
    </div>
  );
}
