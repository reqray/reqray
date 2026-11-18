/**
 * Two requests side by side: waterfalls on ONE time scale and a diff table
 * by work shape. Reached by `#/compare/<a>/<b>` — the comparison itself is a
 * shareable link.
 */

import { duration, spanColor } from '../../shared/format';
import { Waterfall } from '../../shared/waterfall/Waterfall';
import { buildComparison, buildMetrics, buildVerdict } from './lib/compare';
import { useDetail } from './lib/useDetail';
import { PickSecond } from './parts/PickSecond';
import { SideHead } from './parts/SideHead';

interface CompareScreenProps {
  a: string;
  b: string | null;
  onPick: (id: string) => void;
  onSwap: () => void;
  onClear: () => void;
  onBack: () => void;
}

export function CompareScreen({ a, b, onPick, onSwap, onClear, onBack }: CompareScreenProps) {
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
