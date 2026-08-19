import { useEffect, useState } from 'react';
import { type ReplayComparison, type RequestDetail, replayRequest } from '../api';
import { duration } from '../format';

type Phase = 'idle' | 'pending' | 'done' | 'failed';

/** Headers worth offering for editing; the rest is noise in a small textarea. */
const EDITABLE_HEADERS = ['authorization', 'x-request-id', 'accept', 'content-type'];

function initialHeaders(detail: RequestDetail): string {
  const picked = Object.entries(detail.requestHeaders).filter(([key]) =>
    EDITABLE_HEADERS.includes(key.toLowerCase()),
  );
  return picked.map(([key, value]) => `${key}: ${value}`).join('\n');
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    // A masked value would be replayed literally as `[redacted]`; dropping it
    // sends the request without the header, which is at least honest.
    const value = line.slice(at + 1).trim();
    if (key && value && value !== '[redacted]') out[key] = value;
  }
  return out;
}

function Comparison({ result }: { result: ReplayComparison | null }) {
  const rows: Array<[string, (side: ReplayComparison['original']) => string]> = [
    ['status', (side) => String(side.status)],
    ['duration', (side) => duration(side.durationMs)],
    ['sql queries', (side) => String(side.sqlCount)],
    ['n+1', (side) => (side.nPlusOne ? 'detected' : 'none')],
    ['bytes', (side) => (side.bytes === null ? '—' : String(side.bytes))],
    ['etag', (side) => side.etag ?? '—'],
  ];

  return (
    <div className="comparison">
      <div className="label">COMPARISON</div>
      <div className="cmp-row cmp-head">
        <span />
        <span>original</span>
        <span>replay</span>
      </div>
      {rows.map(([name, read]) => {
        const before = result ? read(result.original) : '—';
        const after = result ? read(result.replay) : '—';
        const improved = result !== null && before !== after;
        return (
          <div key={name} className="cmp-row">
            <span className="s-dim">{name}</span>
            <span className="s-fg2">{before}</span>
            <span className={result === null ? 's-dim' : improved ? 's-ok' : 's-fg2'}>{after}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ReplayDrawer({ detail, onClose }: { detail: RequestDetail; onClose: () => void }) {
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

  const note =
    phase === 'pending'
      ? 'sending…'
      : phase === 'done'
        ? 'replayed · not recorded in the list'
        : phase === 'failed'
          ? (error ?? 'replay failed')
          : 'runs through the same middleware stack';

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
