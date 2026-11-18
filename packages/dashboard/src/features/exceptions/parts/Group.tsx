import { useEffect, useState } from 'react';
import { type BlameLine, type ExceptionGroup, fetchBlame, openInEditor } from '../../../api/index';
import { useToast } from '../../../app/PanelContext';
import { ago, count } from '../../../shared/format';
import { blameOf } from '../lib/blame';
import { Frame } from './Frame';
import { Sparkline } from './Sparkline';

interface GroupProps {
  group: ExceptionGroup;
  open: boolean;
  blameEnabled: boolean;
  onToggle: () => void;
  onOpenRequest: (id: string) => void;
}

export function Group({ group, open, blameEnabled, onToggle, onOpenRequest }: GroupProps) {
  const toast = useToast();
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

  const openFrame = (file: string, line: number) => {
    openInEditor(file, line);
    toast(`opening ${file}:${line} in the editor`);
  };

  /** The button under the stack: the first frame of the project's own code. */
  const openOrigin = () => {
    const frame = group.frames.find((item) => item.project) ?? group.frames[0];
    if (frame?.file) openFrame(frame.file, frame.line ?? 1);
  };

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
            {group.frames.map((frame, index) => (
              <Frame
                // biome-ignore lint/suspicious/noArrayIndexKey: stack order is the identity
                key={index}
                frame={frame}
                blamed={blameOf(frame, blame[index], blameEnabled)}
                onOpen={openFrame}
              />
            ))}
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
                <button type="button" className="btn-secondary" onClick={openOrigin}>
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
