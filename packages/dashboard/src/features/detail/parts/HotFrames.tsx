import type { HotFrame } from '../../../api/index';
import { HotFrameRow } from './HotFrameRow';

interface HotFramesProps {
  frames: readonly HotFrame[];
  /** Share of the stretch's samples that were on a processor, 0..1. */
  busyShare: number | null;
}

/**
 * What the profiler caught inside a stretch nothing else accounts for.
 *
 * The detector can only name the two calls a hole sits between. These are the
 * samples taken inside it — the difference between "somewhere in here" and a
 * function to open.
 */
export function HotFrames({ frames, busyShare }: HotFramesProps) {
  if (frames.length === 0) return null;

  return (
    <div className="hot-frames">
      <div className="hot-head">
        <span className="label">WHAT WAS RUNNING</span>
        {busyShare === null ? null : (
          <span
            className="s-dim"
            title="Of the samples taken inside this stretch, how many caught the process on a processor rather than waiting."
          >
            {Math.round(busyShare * 100)}% of samples on a processor
          </span>
        )}
      </div>
      {frames.map((frame) => (
        <HotFrameRow key={`${frame.relative}:${frame.line}:${frame.functionName}`} frame={frame} />
      ))}
    </div>
  );
}
