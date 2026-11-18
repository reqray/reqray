import { type HotFrame, openInEditor } from '../../../api/index';

interface HotFrameRowProps {
  frame: HotFrame;
}

/** One place the samples landed, and what it was calling. */
export function HotFrameRow({ frame }: HotFrameRowProps) {
  const where = `${frame.relative}:${frame.line}`;
  const open = () => openInEditor(frame.relative, frame.line);

  return (
    <div className="hot-frame">
      <span className="hot-share mono">{Math.round(frame.share * 100)}%</span>
      <span className="hot-bar">
        <span style={{ width: `${Math.max(2, Math.round(frame.share * 100))}%` }} />
      </span>
      <button type="button" className="fix-site ellipsis" onClick={open} title={where}>
        {frame.functionName}
        <span className="s-dim"> {where}</span>
      </button>
      {frame.inside ? <span className="s-dim mono">calling {frame.inside}</span> : null}
    </div>
  );
}
