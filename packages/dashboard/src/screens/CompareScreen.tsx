/**
 * Two requests side by side: waterfalls on ONE time scale and a diff table
 * by work shape. Reached by `#/compare/<a>/<b>` — the comparison itself is a
 * shareable link.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchRequest, fetchRequests, type RequestDetail, type RequestRow } from '../api';
import { buildComparison, buildMetrics, buildVerdict } from '../compare';
import { Waterfall } from '../components/Waterfall';
import { clock, duration, durationTone, methodTone, spanColor, statusTone } from '../format';

function useDetail(id: string | null): { detail: RequestDetail | null; error: string | null } {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    fetchRequest(id, controller.signal)
      .then(setDetail)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [id]);

  return { detail, error };
}

function SideHead({ tag, detail }: { tag: string; detail: RequestDetail }) {
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

/** Chooser for the second request, same-path candidates first. */
function PickSecond({ first, onPick }: { first: RequestDetail; onPick: (id: string) => void }) {
  const [rows, setRows] = useState<RequestRow[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetchRequests({}, controller.signal)
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

export function CompareScreen({
  a,
  b,
  onPick,
  onSwap,
  onClear,
  onBack,
}: {
  a: string;
  b: string | null;
  onPick: (id: string) => void;
  onSwap: () => void;
  onClear: () => void;
  onBack: () => void;
}) {
  const left = useDetail(a);
  const right = useDetail(b);
  const error = left.error ?? right.error;

  if (error) {
    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-body">
            <h1 className="empty-title">Comparison unavailable</h1>
            <p className="empty-text">{error}</p>
            <button type="button" className="btn-secondary" onClick={onBack}>
              ← requests
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!left.detail) return <div className="empty s-dim mono">loading…</div>;

  if (!b) {
    return (
      <div className="detail">
        <header className="detail-head">
          <button type="button" className="back" onClick={onBack}>
            ← requests
          </button>
          <span className="divider" />
          <span className="detail-path ellipsis">
            compare: {left.detail.method} {left.detail.path}
          </span>
        </header>
        <div className="detail-body">
          <PickSecond first={left.detail} onPick={onPick} />
        </div>
      </div>
    );
  }

  if (!right.detail) return <div className="empty s-dim mono">loading…</div>;

  // One scale for both: the shorter request must LOOK shorter.
  const scale = Math.max(left.detail.durationMs, right.detail.durationMs, 1);
  const rows = buildComparison(left.detail, right.detail);
  const metrics = buildMetrics(left.detail, right.detail);
  // One scale for the paired bars as well, for the same reason.
  const widest = Math.max(1, ...rows.map((row) => Math.max(row.a.totalMs, row.b.totalMs)));

  return (
    <div className="detail">
      <header className="detail-head">
        <button type="button" className="back" onClick={onBack}>
          ← requests
        </button>
        <span className="divider" />
        <span className="detail-path ellipsis">Compare</span>
        <span className="mono s-dim" style={{ fontSize: 12 }}>
          #{a} ↔ #{b}
        </span>
        <span className="spacer" />
        <button type="button" className="btn-secondary" onClick={onSwap}>
          swap A ↔ B
        </button>
        <button type="button" className="btn-secondary" onClick={onClear}>
          clear
        </button>
      </header>

      <div className="detail-body">
        <section className="waterfall">
          <div className="waterfall-head">
            <span className="label">METRICS</span>
            <span className="label">Δ = B − A</span>
          </div>
          <div className="metrics-row label">
            <span />
            <span>A · #{a}</span>
            <span>B · #{b}</span>
            <span className="cell-right">Δ</span>
          </div>
          {metrics.map((metric) => (
            <div key={metric.label} className="metrics-row">
              <span className="s-dim">{metric.label}</span>
              <span className="ellipsis">{metric.a}</span>
              <span className="ellipsis">{metric.b}</span>
              <span className={`cell-right s-${metric.tone === 'dim' ? 'dim' : metric.tone}`}>
                {metric.delta}
              </span>
            </div>
          ))}
        </section>

        <SideHead tag="A" detail={left.detail} />
        <Waterfall detail={left.detail} totalOverride={scale} />
        <SideHead tag="B" detail={right.detail} />
        <Waterfall detail={right.detail} totalOverride={scale} />

        <section className="waterfall" style={{ marginTop: 16 }}>
          <div className="waterfall-head">
            <span className="label">SPAN BY SPAN</span>
            <span className="label">Δ = B − A</span>
          </div>
          <div className="span-row label">
            <span>WORK</span>
            <span>A</span>
            <span>B</span>
            <span className="cell-right">Δ MS</span>
          </div>
          {rows.map((row) => (
            <div key={row.key} className="span-row">
              <span className="ellipsis" title={row.label}>
                <span className="wf-swatch" style={{ background: spanColor(row.kind) }} />
                {row.a.calls === 0 || row.b.calls === 0 ? (
                  <span className="s-warn" title="present on one side only">
                    A ⟷ B{' '}
                  </span>
                ) : null}
                {row.label}
              </span>
              {/* Both bars share one scale, so the pair reads as before/after
                  rather than as two unrelated charts. */}
              <span className="pair-track" title={`A: ${duration(row.a.totalMs)}`}>
                <span
                  className="pair-bar pair-a"
                  style={{
                    width: `${(row.a.totalMs / widest) * 100}%`,
                    background: spanColor(row.kind),
                  }}
                />
              </span>
              <span className="pair-track" title={`B: ${duration(row.b.totalMs)}`}>
                <span
                  className="pair-bar"
                  style={{
                    width: `${(row.b.totalMs / widest) * 100}%`,
                    background: spanColor(row.kind),
                  }}
                />
              </span>
              <span
                className={`cell-right ${
                  Math.abs(row.deltaMs) < 1 ? 's-dim' : row.deltaMs > 0 ? 's-err' : 's-ok'
                }`}
              >
                {Math.abs(row.deltaMs) < 1
                  ? '='
                  : `${row.deltaMs > 0 ? '+' : '−'}${Math.round(Math.abs(row.deltaMs))}`}
              </span>
            </div>
          ))}
        </section>

        <section className="verdict">{buildVerdict(left.detail, right.detail)}</section>
      </div>
    </div>
  );
}
