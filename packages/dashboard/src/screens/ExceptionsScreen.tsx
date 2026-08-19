import { useEffect, useState } from 'react';
import { type ExceptionGroup, fetchExceptions } from '../api';
import { ago, count } from '../format';

/** Bar heights from the design: 3px minimum so an empty bucket stays visible. */
function barHeight(value: number, peak: number): number {
  if (peak <= 0) return 3;
  return 3 + Math.round((value / peak) * 14);
}

function Sparkline({ buckets }: { buckets: number[] }) {
  const peak = Math.max(...buckets, 0);
  return (
    <span className="sparkline">
      {buckets.map((value, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
          key={index}
          className="spark-bar"
          data-recent={index >= buckets.length - 3}
          style={{ height: `${barHeight(value, peak)}px` }}
        />
      ))}
    </span>
  );
}

function Group({
  group,
  open,
  onToggle,
  onOpenRequest,
}: {
  group: ExceptionGroup;
  open: boolean;
  onToggle: () => void;
  onOpenRequest: (id: string) => void;
}) {
  const firstRequest = group.requestIds[0];

  return (
    <div>
      <button type="button" className="exc-row" onClick={onToggle}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span style={{ minWidth: 0 }}>
          <span className="exc-title ellipsis" style={{ display: 'block' }}>
            <span className="s-err">{group.type}</span>
            <span className="s-dim">: </span>
            {group.message}
          </span>
          <span className="exc-origin ellipsis" style={{ display: 'block' }}>
            {group.origin ?? 'origin unknown'}
            {group.where ? ` · in ${group.where}` : ''}
          </span>
        </span>
        <span className="exc-count">{count(group.count)} ×</span>
        <span className="exc-seen">{ago(group.lastSeenAt)}</span>
        <Sparkline buckets={group.buckets} />
      </button>

      {open ? (
        <div className="exc-open">
          <div className="label">STACK TRACE</div>
          <div className="frames">
            {group.frames.map((frame, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stack order is the identity
              <div key={index} className="frame" data-project={frame.project}>
                <span className="ellipsis">{frame.raw}</span>
                <span className="frame-tag">{frame.project ? 'project' : 'node_modules'}</span>
              </div>
            ))}
          </div>
          {firstRequest ? (
            <div className="exc-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onOpenRequest(firstRequest)}
              >
                view request #{firstRequest}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ExceptionsScreen({ onOpenRequest }: { onOpenRequest: (id: string) => void }) {
  const [groups, setGroups] = useState<ExceptionGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    fetchExceptions(controller.signal)
      .then((payload) => {
        setGroups(payload);
        // The first group is expanded by default — usually the one that matters.
        const first = payload[0];
        if (first) setOpen(new Set([first.id]));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="empty s-err mono">{error}</div>;
  if (!groups) return <div className="empty s-dim mono">loading…</div>;

  if (groups.length === 0) {
    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-body">
            <h1 className="empty-title">No exceptions recorded</h1>
            <p className="empty-text">
              Nothing in the buffer has thrown. Exceptions are grouped by normalized stack, so a
              repeating error shows up as one row with a count.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const occurrences = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <div className="exceptions">
      <header className="exceptions-head">
        <span>
          {count(groups.length)} groups · {count(occurrences)} occurrences
        </span>
        <span className="spacer" />
        <span>grouped by normalized stack</span>
      </header>

      <div className="exceptions-body">
        {groups.map((group) => (
          <Group
            key={group.id}
            group={group}
            open={open.has(group.id)}
            onToggle={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(group.id)) next.delete(group.id);
                else next.add(group.id);
                return next;
              })
            }
            onOpenRequest={onOpenRequest}
          />
        ))}
      </div>
    </div>
  );
}
