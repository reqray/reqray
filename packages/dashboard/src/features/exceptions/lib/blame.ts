import type { BlameLine, ExceptionFrame } from '../../../api/index';
import { ago } from '../../../shared/format';

/**
 * What the blame column shows for one frame.
 *
 * Nothing for a frame in `node_modules` — whose commit that is answers no
 * question anybody has — and a dash rather than a blank when blame is off,
 * so an empty column is not read as "nobody touched this".
 */
export function blameOf(
  frame: ExceptionFrame,
  line: BlameLine | null | undefined,
  blameEnabled: boolean,
): string {
  if (!frame.project) return 'node_modules';
  if (line) return `${line.sha} · ${line.author} · ${ago(line.at)}`;
  return blameEnabled ? '—' : '';
}
