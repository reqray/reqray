import type { ReplayComparison } from '../../../api/index';
import { duration } from '../../../shared/format';

/** One side of a replay, as the comparison reads it. */
type ReplaySide = ReplayComparison['original'];

export interface ComparisonField {
  readonly name: string;
  readonly read: (side: ReplaySide) => string;
}

/** What a replay is judged on, in the order the table reads. */
export const FIELDS: readonly ComparisonField[] = [
  { name: 'status', read: (side) => String(side.status) },
  { name: 'duration', read: (side) => duration(side.durationMs) },
  { name: 'sql queries', read: (side) => String(side.sqlCount) },
  { name: 'n+1', read: (side) => (side.nPlusOne ? 'detected' : 'none') },
  { name: 'bytes', read: (side) => (side.bytes === null ? '—' : String(side.bytes)) },
  { name: 'etag', read: (side) => side.etag ?? '—' },
];

interface ComparisonRowProps {
  field: ComparisonField;
  /** `null` while the replay is still in flight — both columns read as dashes. */
  result: ReplayComparison | null;
}

/** One measure, before and after; the replay's column speaks only if it differs. */
export function ComparisonRow({ field, result }: ComparisonRowProps) {
  const before = result ? field.read(result.original) : '—';
  const after = result ? field.read(result.replay) : '—';
  const changed = result !== null && before !== after;

  return (
    <div className="cmp-row">
      <span className="s-dim">{field.name}</span>
      <span className="s-fg2">{before}</span>
      <span className={result === null ? 's-dim' : changed ? 's-ok' : 's-fg2'}>{after}</span>
    </div>
  );
}
