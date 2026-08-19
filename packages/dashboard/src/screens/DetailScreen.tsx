import { useEffect, useMemo, useState } from 'react';
import {
  type ExplainResult,
  explainSpan,
  fetchRequest,
  type RequestDetail,
  type Span,
} from '../api';
import { buildBriefing, evidenceLine } from '../briefing';
import { Flamegraph } from '../components/Flamegraph';
import { ReplayDrawer } from '../components/ReplayDrawer';
import { badgeFor, Waterfall } from '../components/Waterfall';
import { clock, duration, durationTone, methodTone, oneLine, statusTone } from '../format';
import { highlightSql } from '../sqlHighlight';

type Tab = 'headers' | 'body' | 'sql' | 'cache' | 'logs';

const TABS: Array<[Tab, string]> = [
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['sql', 'SQL'],
  ['cache', 'Cache'],
  ['logs', 'Logs'],
];

function Findings({ detail }: { detail: RequestDetail }) {
  if (detail.findings.length === 0) return null;

  return (
    <section className="findings">
      <div className="findings-label label">FINDINGS · {detail.findings.length}</div>
      {detail.findings.map((finding) => {
        // Clamped: spans that overlap can add up to more than the wall-clock
        // time, and "112% of request time" reads as a bug, not a measurement.
        const share =
          detail.durationMs > 0 ? Math.min(100, (finding.costMs / detail.durationMs) * 100) : 0;

        return (
          <section
            className="callout"
            data-severity={finding.severity}
            // Two findings from one detector differ by their evidence; a
            // budget finding is unique per request, so its detector is enough.
            key={`${finding.detector}-${
              finding.evidence.kind === 'budget' ? '' : finding.evidence.fingerprint
            }`}
          >
            <div className="callout-head">
              <span className="badge-nplus" data-severity={finding.severity}>
                {badgeFor(finding.detector)}
              </span>
              <span className="callout-title">{finding.title}</span>
              <span className="spacer" />
              <span className="mono s-fg2" style={{ fontSize: 11 }}>
                {duration(finding.costMs)} recoverable · {Math.round(share)}% of request time
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
      })}
    </section>
  );
}

type DbSpan = Extract<Span, { kind: 'db' }>;

interface QueryGroup {
  id: number;
  sql: string;
  calls: number;
  durationMs: number;
  rowCount: number | null;
  callsite: DbSpan['callsite'];
  /** Values of the first call of the group — only under `collectSqlValues`. */
  values: string[] | null;
}

/**
 * Groups repeats of one fingerprint into a single row.
 *
 * A hundred and fifty identical lines are honest and unreadable; the design
 * shows one row with a `150 calls` note instead.
 */
function groupQueries(spans: readonly Span[]): QueryGroup[] {
  const groups = new Map<string, QueryGroup>();

  for (const span of spans) {
    if (span.kind !== 'db') continue;
    const existing = groups.get(span.fingerprint);
    if (existing) {
      existing.calls++;
      existing.durationMs += span.duration;
      existing.callsite ??= span.callsite;
      continue;
    }
    groups.set(span.fingerprint, {
      id: span.id,
      sql: span.sql,
      calls: 1,
      durationMs: span.duration,
      rowCount: span.rowCount,
      callsite: span.callsite,
      values: span.values ?? null,
    });
  }

  return [...groups.values()];
}

type PlanState =
  | { status: 'loading' }
  | { status: 'done'; result: ExplainResult }
  | { status: 'error'; message: string };

/** The plan tree as indented text — the shape everyone knows from psql. */
function planText(result: ExplainResult): string {
  return result.nodes
    .map((node) => {
      const stats = [
        node.rows !== null ? `rows≈${node.rows}` : null,
        node.cost !== null ? `cost=${node.cost}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      return `${'  '.repeat(node.depth)}${node.depth > 0 ? '→ ' : ''}${node.label}${stats ? `  (${stats})` : ''}`;
    })
    .join('\n');
}

function SqlTab({
  detail,
  plans,
  onExplain,
}: {
  detail: RequestDetail;
  plans: Map<number, PlanState>;
  onExplain: (spanId: number) => void;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const queries = useMemo(() => groupQueries(detail.spans), [detail]);

  if (queries.length === 0)
    return <p className="s-dim mono">no database queries in this request</p>;

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      {queries.map((query) => {
        const plan = plans.get(query.id);
        return (
          <div key={query.id}>
            <button type="button" className="sql-row" onClick={() => toggle(query.id)}>
              <span className="caret">{open.has(query.id) ? '▾' : '▸'}</span>
              <span className="ellipsis s-fg2">{oneLine(query.sql)}</span>
              <span className={`cell-right ${durationTone(query.durationMs)}`}>
                {duration(query.durationMs)}
              </span>
              <span className="sql-note">
                {query.calls > 1
                  ? `${query.calls} calls`
                  : query.rowCount === null
                    ? ''
                    : `${query.rowCount} rows`}
              </span>
            </button>
            {open.has(query.id) ? (
              <div className="sql-open">
                <div className="sql-block">{highlightSql(query.sql)}</div>
                {query.values && query.values.length > 0 ? (
                  <div className="sql-origin mono">
                    {query.values.map((value, index) => `$${index + 1} = ${value}`).join(' · ')}
                    {query.calls > 1 ? '  (values of the first call)' : ''}
                  </div>
                ) : null}
                {query.callsite ? (
                  <div className="sql-origin">
                    {query.callsite.relative}:{query.callsite.line}
                  </div>
                ) : null}
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={plan?.status === 'loading'}
                    onClick={() => onExplain(query.id)}
                  >
                    {plan?.status === 'loading' ? 'planning…' : 'EXPLAIN'}
                  </button>
                </div>
                {plan?.status === 'error' ? (
                  <p className="s-warn mono" style={{ marginTop: 6 }}>
                    {plan.message}
                  </p>
                ) : null}
                {plan?.status === 'done' ? (
                  <div style={{ marginTop: 6 }}>
                    {plan.result.notes.map((note) => (
                      <p
                        key={note.message}
                        className={`mono ${note.severity === 'warn' ? 's-warn' : 's-fg2'}`}
                        style={{ margin: '4px 0', fontSize: 12 }}
                      >
                        {note.severity === 'warn' ? '⚠ ' : 'ℹ '}
                        {note.message}
                      </p>
                    ))}
                    <pre className="json-block">{planText(plan.result)}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function HeadersTab({ detail }: { detail: RequestDetail }) {
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

/** Bodies are stored as text; JSON among them is re-indented for reading. */
function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function BodyTab({ detail }: { detail: RequestDetail }) {
  const body = detail.responseBody;
  if (!body) {
    return <p className="s-dim mono">response body was not captured</p>;
  }
  return (
    <div>
      <div className="label">
        RESPONSE BODY · {detail.responseHeaders['content-type'] ?? 'unknown'} ·{' '}
        {(new TextEncoder().encode(body.text).length / 1024).toFixed(1)} KB
        {body.truncated ? ' · truncated' : ''}
      </div>
      <pre className="json-block">{prettyBody(body.text)}</pre>
    </div>
  );
}

function CacheTab({ detail }: { detail: RequestDetail }) {
  const operations = detail.spans.filter(
    (span): span is Extract<Span, { kind: 'cache' }> => span.kind === 'cache',
  );
  if (operations.length === 0) return <p className="s-dim mono">no cache operations</p>;

  // How many times each key is read: the same key twice in one request is
  // work that did not need doing, and the detector says so on the findings
  // block — here it is marked where it happened.
  const reads = new Map<string, number>();
  for (const operation of operations) {
    if (operation.operation === 'get')
      reads.set(operation.key, (reads.get(operation.key) ?? 0) + 1);
  }

  return (
    <div>
      <div className="cache-row label">
        <span>OP</span>
        <span>KEY</span>
        <span className="cell-right">RESULT</span>
        <span className="cell-right">MS</span>
      </div>
      {operations.map((operation) => (
        <div key={operation.id} className="cache-row">
          <span>{operation.operation.toUpperCase()}</span>
          <span className="ellipsis">
            {operation.key}
            {operation.operation === 'get' && (reads.get(operation.key) ?? 0) > 1 ? (
              <span className="dup-mark">DUP ×{reads.get(operation.key)}</span>
            ) : null}
          </span>
          <span className={`cell-right ${operation.hit ? 's-ok' : 's-warn'}`}>
            {operation.hit === null ? 'OK' : operation.hit ? 'HIT' : 'MISS'}
          </span>
          <span className="cell-right">{operation.duration.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

function LogsTab({ detail }: { detail: RequestDetail }) {
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

export function DetailScreen({
  id,
  replayEnabled,
  onBack,
  onCompare,
}: {
  id: string;
  replayEnabled: boolean;
  onBack: () => void;
  onCompare: (id: string) => void;
}) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // SQL is the default tab — it is what the developer came for.
  const [tab, setTab] = useState<Tab>('sql');
  /** Same spans, two axes: by time or by nesting. */
  const [view, setView] = useState<'wf' | 'flame'>('wf');
  const [replayOpen, setReplayOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [briefed, setBriefed] = useState(false);
  // EXPLAIN plans live here, not in the SQL tab: the briefing includes them.
  const [plans, setPlans] = useState<Map<number, PlanState>>(new Map());

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard denied — the address bar still has the same link.
    }
  };

  const explain = async (spanId: number) => {
    setPlans((current) => new Map(current).set(spanId, { status: 'loading' }));
    try {
      const result = await explainSpan(id, spanId);
      setPlans((current) => new Map(current).set(spanId, { status: 'done', result }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setPlans((current) => new Map(current).set(spanId, { status: 'error', message }));
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
      setBriefed(true);
      setTimeout(() => setBriefed(false), 1_500);
    } catch {
      // Clipboard denied — nothing to break.
    }
  };

  useEffect(() => {
    const controller = new AbortController();
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
          <span className="mono s-dim" style={{ fontSize: 11 }} title="loupe({ replay: true })">
            replay off
          </span>
        )}
      </header>

      {detail.test ? (
        <div className="test-strip">
          <span className="test-badge">TEST</span>
          <span className="s-fg2">issued by {detail.test}</span>
        </div>
      ) : null}

      <div className="detail-body">
        <div className="view-toggle">
          <div className="segmented">
            <button type="button" aria-pressed={view === 'wf'} onClick={() => setView('wf')}>
              waterfall
            </button>
            <button type="button" aria-pressed={view === 'flame'} onClick={() => setView('flame')}>
              flamegraph
            </button>
          </div>
        </div>
        {view === 'wf' ? <Waterfall detail={detail} /> : <Flamegraph detail={detail} />}
        <Findings detail={detail} />

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

        <div className="tab-body" role="tabpanel">
          {tab === 'sql' ? (
            <SqlTab detail={detail} plans={plans} onExplain={(spanId) => void explain(spanId)} />
          ) : null}
          {tab === 'headers' ? <HeadersTab detail={detail} /> : null}
          {tab === 'body' ? <BodyTab detail={detail} /> : null}
          {tab === 'cache' ? <CacheTab detail={detail} /> : null}
          {tab === 'logs' ? <LogsTab detail={detail} /> : null}
        </div>
      </div>

      {replayOpen ? <ReplayDrawer detail={detail} onClose={() => setReplayOpen(false)} /> : null}
    </div>
  );
}
