import { useEffect, useState } from 'react';
import { type ReplayComparison, type RequestDetail, replayRequest } from '../../../api/index';
import { initialHeaders, noteOf, type Phase, parseHeaders } from '../lib/replay-form';
import { Comparison } from './Comparison';

interface ReplayDrawerProps {
  detail: RequestDetail;
  onClose: () => void;
}

export function ReplayDrawer({ detail, onClose }: ReplayDrawerProps) {
  const [method, setMethod] = useState(detail.method);
  const [path, setPath] = useState(detail.query ? `${detail.path}?${detail.query}` : detail.path);
  const [headers, setHeaders] = useState(() => initialHeaders(detail));
  // The stored body is already text; re-indenting JSON keeps it editable.
  const [body, setBody] = useState(() => {
    const stored = detail.requestBody;
    if (!stored) return '';
    try {
      return JSON.stringify(JSON.parse(stored.text), null, 2);
    } catch {
      return stored.text;
    }
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ReplayComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    setPhase('pending');
    setError(null);
    try {
      setResult(
        await replayRequest({
          id: detail.id,
          method,
          path,
          headers: parseHeaders(headers),
          ...(body.trim() ? { body } : {}),
        }),
      );
      setPhase('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('failed');
    }
  };

  const note = noteOf(phase, error);

  return (
    <>
      <button type="button" className="scrim" aria-label="close replay" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <span className="drawer-title">Replay</span>
          <span className="drawer-sub">editable copy of #{detail.id}</span>
          <span className="spacer" />
          <button type="button" className="drawer-close" onClick={onClose}>
            esc ✕
          </button>
        </header>

        <div className="drawer-body">
          <div className="replay-target">
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((verb) => (
                <option key={verb} value={verb}>
                  {verb}
                </option>
              ))}
            </select>
            <input value={path} onChange={(event) => setPath(event.target.value)} />
          </div>

          <div className="empty-label">HEADERS</div>
          <textarea
            className="replay-area"
            style={{ height: 82 }}
            spellCheck={false}
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
          />

          <div className="empty-label">BODY</div>
          <textarea
            className="replay-area"
            style={{ height: 96 }}
            spellCheck={false}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />

          <div className="replay-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={phase === 'pending'}
              onClick={() => void send()}
            >
              SEND ⏎
            </button>
            <span className={`replay-note ${phase === 'failed' ? 's-err' : ''}`}>{note}</span>
          </div>

          {result?.partial ? (
            <div className="replay-note s-warn" style={{ marginTop: 8 }}>
              the replay's own record did not arrive in time — query counts are unknown
            </div>
          ) : null}

          <Comparison result={result} />
        </div>
      </aside>
    </>
  );
}
