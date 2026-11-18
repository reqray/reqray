import type { ExceptionFrame } from '../../../api/index';

interface FrameProps {
  frame: ExceptionFrame;
  /** The blame line, already worded — empty when there is nothing to say. */
  blamed: string;
  onOpen: (file: string, line: number) => void;
}

/**
 * One frame of the stack.
 *
 * A project frame opens in the editor, so it is a button; the rest of the
 * stack is text and must not pretend otherwise.
 */
export function Frame({ frame, blamed, onOpen }: FrameProps) {
  if (!frame.project || frame.file === null) {
    return (
      <div className="frame" data-project={frame.project}>
        <span className="ellipsis">{frame.raw}</span>
        <span className="frame-blame">{blamed}</span>
      </div>
    );
  }

  const file = frame.file;
  const at = frame.line ?? 1;

  return (
    <button
      type="button"
      className="frame"
      data-project={true}
      data-clickable={true}
      title={`open ${file}:${at} in the editor`}
      onClick={() => onOpen(file, at)}
    >
      <span className="ellipsis">
        {frame.raw}
        <span className="s-acc"> ↗</span>
      </span>
      <span className="frame-blame">{blamed}</span>
    </button>
  );
}
