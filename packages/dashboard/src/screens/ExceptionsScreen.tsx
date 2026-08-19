import { useEffect, useState } from 'react';
import {
  type BlameLine,
  type ExceptionGroup,
  fetchBlame,
  fetchExceptions,
  openInEditor,
} from '../api';
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
  blameEnabled,
  onToggle,
  onOpenRequest,
  onToast,
}: {
  group: ExceptionGroup;
  open: boolean;
  blameEnabled: boolean;
  onToggle: () => void;
  onOpenRequest: (id: string) => void;
  onToast: (message: string) => void;
}) {
  const firstRequest = group.requestIds[0];
  const [blame, setBlame] = useState<Array<BlameLine | null>>([]);
  const projectFrames = group.frames.filter((frame) => frame.project).length;

  // Blame is asked for only once the group is open: it shells out to git, and
  // a list of collapsed groups would ask about every frame of every one.
  useEffect(() => {
    if (!open || !blameEnabled || blame.length > 0) return;
    const frames = group.frames.map((frame) => ({ file: frame.file ?? '', line: frame.line ?? 0 }));
    void fetchBlame(frames).then(setBlame);
  }, [open, blameEnabled, group.frames, blame.length]);

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
          <div className="exc-stack-head">
            <span className="label">STACK TRACE</span>
            <span className="label">
              {projectFrames} of {group.frames.length} frames in project code
            </span>
          </div>
          <div className="frames">
            {group.frames.map((frame, index) => {
              const line = blame[index];
              const blamed = frame.project
                ? line
                  ? `${line.sha} · ${line.author} · ${ago(line.at)}`
                  : blameEnabled
                    ? '—'
                    : ''
                : 'node_modules';

              // A project frame opens in the editor, so it is a button; the
              // rest of the stack is text and must not pretend otherwise.
              if (!frame.project || frame.file === null) {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stack order is the identity
                  <div key={index} className="frame" data-project={frame.project}>
                    <span className="ellipsis">{frame.raw}</span>
                    <span className="frame-blame">{blamed}</span>
                  </div>
                );
              }

              const file = frame.file;
              const at = frame.line ?? 1;
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: stack order is the identity
                  key={index}
                  type="button"
                  className="frame"
                  data-project={true}
                  data-clickable={true}
                  title={`open ${file}:${at} in the editor`}
                  onClick={() => {
                    openInEditor(file, at);
                    onToast(`opening ${file}:${at} in the editor`);
                  }}
                >
                  <span className="ellipsis">
                    {frame.raw}
                    <span className="s-acc"> ↗</span>
                  </span>
                  <span className="frame-blame">{blamed}</span>
                </button>
              );
            })}
          </div>
          {firstRequest || group.test ? (
            <div className="exc-actions">
              {firstRequest ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onOpenRequest(firstRequest)}
                >
                  view request #{firstRequest}
                </button>
              ) : null}
              {group.origin && group.frames[0]?.file ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    const frame = group.frames.find((item) => item.project) ?? group.frames[0];
                    if (!frame?.file) return;
                    openInEditor(frame.file, frame.line ?? 1);
                    onToast(`opening ${frame.file}:${frame.line} in the editor`);
                  }}
                >
                  open in editor ↗
                </button>
              ) : null}
              {group.test ? (
                <span className="test-badge" title="a test that reproduces this">
                  reproduced by {group.test}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ExceptionsScreen({
  blameEnabled,
  onOpenRequest,
  onToast,
}: {
  blameEnabled: boolean;
  onOpenRequest: (id: string) => void;
  onToast: (message: string) => void;
}) {
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
            blameEnabled={blameEnabled}
            onOpenRequest={onOpenRequest}
            onToast={onToast}
          />
        ))}
      </div>
    </div>
  );
}
