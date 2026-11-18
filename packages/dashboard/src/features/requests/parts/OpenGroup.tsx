import type { BurstGroup } from '../lib/bursts';
import { slotOf } from '../lib/marks';
import type { RuleId } from '../lib/rules';
import { tintOf } from '../lib/rules';
import { Row } from './Row';

interface OpenGroupProps {
  group: BurstGroup;
  /** It is a burst that has been expanded, rather than an ordinary row. */
  burst: boolean;
  selected: string | null;
  compare: readonly string[];
  rules: ReadonlySet<RuleId>;
  yardMs: number;
  /**
   * Rows first seen after this moment still flash; `null` while the list is
   * paused, when nothing should.
   */
  freshSince: number | null;
  seenAt: Map<string, number> | null;
  onOpen: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onCompare: (id: string) => void;
  onCollapse: () => void;
}

/** A group of rows shown in full — one request, or a burst opened in place. */
export function OpenGroup({
  group,
  burst,
  selected,
  compare,
  rules,
  yardMs,
  freshSince,
  seenAt,
  onOpen,
  onPin,
  onCompare,
  onCollapse,
}: OpenGroupProps) {
  return (
    <div className={burst ? 'burst-open' : undefined}>
      {burst ? (
        <button type="button" className="burst-strip mono" onClick={onCollapse}>
          {group.rows.length} identical calls · collapse
        </button>
      ) : null}
      {group.rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          selected={row.id === selected}
          fresh={freshSince !== null && (seenAt?.get(row.id) ?? 0) > freshSince}
          tint={tintOf(row, rules, row.id === selected)}
          compareSlot={slotOf(compare, row.id)}
          yardMs={yardMs}
          onOpen={onOpen}
          onPin={onPin}
          onCompare={onCompare}
        />
      ))}
    </div>
  );
}
