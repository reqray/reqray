import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ExplainResult,
  explainSpan,
  fetchBaseline,
  fetchRequest,
  type RequestDetail,
} from '../../api/index';
import { clock, duration, durationTone, methodTone, statusTone } from '../../shared/format';
import { useFlash } from '../../shared/ui/useFlash';
import { useLiveQuery } from '../../shared/useLiveQuery';
import { Waterfall } from '../../shared/waterfall/Waterfall';
import { buildBriefing } from './lib/briefing';
import { Breakdown } from './parts/Breakdown';
import { DetailRail } from './parts/DetailRail';
import { Findings } from './parts/Findings';
import { Flamegraph } from './parts/Flamegraph';
import { ReplayDrawer } from './parts/ReplayDrawer';
import { SelfTime } from './parts/SelfTime';
import { UnderPressure } from './parts/UnderPressure';
import { BodyTab } from './tabs/BodyTab';
import { CacheTab } from './tabs/CacheTab';
import { HeadersTab } from './tabs/HeadersTab';
import { LogsTab } from './tabs/LogsTab';
import { type PlanState, SqlTab } from './tabs/SqlTab';
import { TABS, type Tab } from './tabs/tabs';

interface DetailScreenProps {
  id: string;
  replayEnabled: boolean;
  onBack: () => void;
  onCompare: (id: string) => void;
  /** Opens another request — what the rail's neighbours are for. */
  onOpen: (id: string) => void;
}

export function DetailScreen({ id, replayEnabled, onBack, onCompare, onOpen }: DetailScreenProps) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // SQL is the default tab — it is what the developer came for.
  const [tab, setTab] = useState<Tab>('sql');
  /** Same spans, two axes: by time or by nesting. */
  const [view, setView] = useState<'wf' | 'flame'>('wf');
  const [replayOpen, setReplayOpen] = useState(false);
  const [copied, flashCopied] = useFlash();
  const [briefed, flashBriefed] = useFlash();
  // EXPLAIN plans live here, not in the SQL tab: the briefing includes them.
  const [plans, setPlans] = useState<Map<number, PlanState>>(new Map());
  /** The statement the SQL tab should open on — set by the fix card. */
  const [sqlFocus, setSqlFocus] = useState<string | null>(null);
  /** The rail, on a window too narrow to keep it docked. */
  const [railOpen, setRailOpen] = useState(false);

  /** The fix card's way into the statements behind the finding. */
  const showCalls = (fingerprint: string) => {
    setTab('sql');
    setSqlFocus(fingerprint);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      flashCopied();
    } catch {
      // Clipboard denied — the address bar still has the same link.
    }
  };

  // Span ids restart at 1 in every request, so a plan that arrives after the
  // reader has moved on would land on the same-numbered span of another
  // request — a different statement — and into its briefing.
  const shownId = useRef(id);

  const explain = async (spanId: number) => {
    const askedFor = id;
    const keep = (plan: PlanState) => {
      if (shownId.current !== askedFor) return;
      setPlans((current) => new Map(current).set(spanId, plan));
    };
    keep({ status: 'loading' });
    try {
      keep({ status: 'done', result: await explainSpan(id, spanId) });
    } catch (cause) {
      keep({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const copyBriefing = async () => {
    if (!detail) return;
    const explains = new Map<number, ExplainResult>();
    for (const [spanId, plan] of plans) {
      if (plan.status === 'done') explains.set(spanId, plan.result);
    }
    try {
      await navigator.clipboard.writeText(buildBriefing(detail, explains));
      flashBriefed();
    } catch {
      // Clipboard denied — nothing to break.
    }
  };

  // Asked for separately, and allowed to fail: reading a route's history is
  // the one part of this screen that touches every request the store keeps,
  // and it must never be why the request itself does not open.
  const asked = useLiveQuery(useCallback((signal: AbortSignal) => fetchBaseline(id, signal), [id]));
  const baseline = asked.data?.baseline ?? null;
  const pressure = asked.data?.pressure ?? null;

  useEffect(() => {
    const controller = new AbortController();
    shownId.current = id;
    setDetail(null);
    setPlans(new Map());
    fetchRequest(id, controller.signal)
      .then((payload) => {
        setDetail(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [id]);

  if (error) {
    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-body">
            <h1 className="empty-title">Request unavailable</h1>
            <p className="empty-text">{error}</p>
            <button type="button" className="btn-secondary" onClick={onBack}>
              ← requests
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!detail) return <div className="empty s-dim mono">loading…</div>;

  return (
    <div className="detail">
      <header className="detail-head">
        <button type="button" className="back" onClick={onBack}>
          ← requests
        </button>
        <span className="divider" />
        <span className={`mono ${methodTone(detail.method)}`} style={{ fontWeight: 500 }}>
          {detail.method}
        </span>
        <span className="detail-path ellipsis">{detail.path}</span>
        <span className={`status-badge ${statusTone(detail.status)}`}>{detail.status}</span>
        <span className={`mono num ${durationTone(detail.durationMs)}`}>
          {duration(detail.durationMs)}
        </span>
        <span className="mono s-dim" style={{ fontSize: 11 }}>
          {clock(detail.startedAt)}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn-secondary rail-toggle"
          aria-pressed={railOpen}
          title="the context rail — this request against its route, and its neighbours"
          onClick={() => setRailOpen((open) => !open)}
        >
          context
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onCompare(id)}
          title="Put side by side with another request"
        >
          compare
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void copyLink()}
          title="Permanent link to this request"
        >
          {copied ? 'copied ✓' : 'copy link'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void copyBriefing()}
          title="Briefing for an assistant: waterfall, SQL, findings, EXPLAIN plans"
        >
          {briefed ? 'copied ✓' : 'copy for AI'}
        </button>
        {replayEnabled ? (
          <button type="button" className="btn-primary" onClick={() => setReplayOpen(true)}>
            REPLAY
          </button>
        ) : (
          <span className="mono s-dim" style={{ fontSize: 11 }} title="reqray({ replay: true })">
            replay off
          </span>
        )}
      </header>

      <Breakdown detail={detail} baseline={baseline} />
      <UnderPressure pressure={pressure} />

      <div className="detail-columns" data-rail={railOpen ? 'open' : undefined}>
        <div className="detail-body">
          {/* Fix first: the screen answers "what do I change", then explains
              itself. The waterfall is the explanation, not the headline. */}
          <Findings
            detail={detail}
            replayEnabled={replayEnabled}
            onShowCalls={showCalls}
            onReplay={() => setReplayOpen(true)}
          />

          <div className="view-toggle">
            <div className="segmented">
              <button type="button" aria-pressed={view === 'wf'} onClick={() => setView('wf')}>
                waterfall
              </button>
              <button
                type="button"
                aria-pressed={view === 'flame'}
                onClick={() => setView('flame')}
              >
                flamegraph
              </button>
            </div>
          </div>
          {view === 'wf' ? <Waterfall detail={detail} /> : <Flamegraph detail={detail} />}
          {view === 'wf' ? <SelfTime detail={detail} /> : null}

          <div className="tabs" role="tablist">
            {TABS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div key={tab} className="tab-body" role="tabpanel">
            {tab === 'sql' ? (
              <SqlTab
                detail={detail}
                plans={plans}
                focus={sqlFocus}
                onExplain={(spanId) => void explain(spanId)}
              />
            ) : null}
            {tab === 'headers' ? <HeadersTab detail={detail} /> : null}
            {tab === 'body' ? <BodyTab detail={detail} /> : null}
            {tab === 'cache' ? <CacheTab detail={detail} /> : null}
            {tab === 'logs' ? <LogsTab detail={detail} /> : null}
          </div>
        </div>

        <DetailRail detail={detail} baseline={baseline} onOpen={onOpen} />
      </div>

      {replayOpen ? <ReplayDrawer detail={detail} onClose={() => setReplayOpen(false)} /> : null}
    </div>
  );
}
