/** What the gutter, the glyph column and the SQL count say about a row. */

import type { RequestRow } from '../../../api/index';

/** A query count that reads as a loop, not a lookup. */
const CHATTY_SQL = 20;

/** `A` for the first picked request, `B` for the second, `null` for the rest. */
export function slotOf(compare: readonly string[], id: string): string | null {
  const index = compare.indexOf(id);
  return index < 0 ? null : index === 0 ? 'A' : 'B';
}

/**
 * The 4px severity gutter — the primary scanning cue.
 *
 * Red for errors and blown budgets, amber for any other finding, nothing
 * otherwise. Driven by the flag rather than the finding count, so a muted
 * pattern stays quiet here too.
 */
export function gradeOf(row: RequestRow): 'err' | 'warn' | undefined {
  if (row.hasError || row.status >= 500 || row.flag === 'slow_budget') return 'err';
  if (row.flag) return 'warn';
  return undefined;
}

/** A query count reads loud when it is a loop's worth rather than a lookup. */
export function sqlTone(row: RequestRow): string {
  if (row.sqlCount === 0) return 's-dim';
  return row.nPlusOne || row.sqlCount >= CHATTY_SQL ? 's-warn' : 's-fg2';
}
