import { useEffect, useMemo, useState } from 'react';
import { fetchRequests, type RequestDetail, type RequestRow } from '../../../api/index';
import { clock, duration, durationTone, methodTone } from '../../../shared/format';

interface PickSecondProps {
  first: RequestDetail;
  onPick: (id: string) => void;
}

/** Chooser for the second request, same-path candidates first. */
export function PickSecond({ first, onPick }: PickSecondProps) {
  const [rows, setRows] = useState<RequestRow[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetchRequests({}, null, controller.signal)
      .then((payload) => setRows(payload.requests.filter((row) => row.id !== first.id)))
      .catch(() => setRows([]));
    return () => controller.abort();
  }, [first.id]);

  const candidates = useMemo(() => {
    const same = rows.filter((row) => row.path === first.path);
    const rest = rows.filter((row) => row.path !== first.path);
    return [...same, ...rest].slice(0, 50);
  }, [rows, first.path]);

  return (
    <div>
      <p className="s-dim mono" style={{ margin: '12px 0' }}>
        compare with what? Same-path requests first
      </p>
      {candidates.map((row) => (
        <button key={row.id} type="button" className="sql-row" onClick={() => onPick(row.id)}>
          <span className={`mono ${methodTone(row.method)}`}>{row.method}</span>
          <span className="ellipsis s-fg2">{row.path}</span>
          <span className={`cell-right ${durationTone(row.durationMs)}`}>
            {duration(row.durationMs)}
          </span>
          <span className="sql-note">{clock(row.startedAt)}</span>
        </button>
      ))}
    </div>
  );
}
