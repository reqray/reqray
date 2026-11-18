import type { RequestRow } from '../../../api/index';
import type { Accent } from '../../../shared/format';

/**
 * Highlight rules.
 *
 * A tinted row is a claim about severity, so the set is fixed and small: five
 * rules, evaluated in order, first match wins. Stacking tints or letting
 * everything light up would turn the list into a fruit salad and stop meaning
 * anything — the rows worth noticing are the ones that stand out from the
 * rest.
 */

export type RuleId = 'slow_external' | 'server_error' | 'n_plus_one' | 'chatty_sql' | 'from_test';

export interface Rule {
  readonly id: RuleId;
  readonly label: string;
  /** Severity colour of the swatch in the popover. */
  readonly tone: Accent;
  readonly matches: (row: RequestRow) => boolean;
}

/** Evaluation order — the earlier rule wins a row. */
export const RULES: readonly Rule[] = [
  {
    id: 'slow_external',
    label: '> 1s and an external HTTP call',
    tone: 'err',
    matches: (row) => row.durationMs > 1000 && row.httpCount > 0,
  },
  {
    id: 'server_error',
    label: 'status ≥ 500',
    tone: 'err',
    matches: (row) => row.status >= 500,
  },
  {
    id: 'n_plus_one',
    label: 'N+1 detected',
    tone: 'warn',
    matches: (row) => row.nPlusOne,
  },
  {
    id: 'chatty_sql',
    label: 'more than 20 SQL queries',
    tone: 'warn',
    matches: (row) => row.sqlCount > 20,
  },
  {
    id: 'from_test',
    label: 'issued from a test run',
    tone: 'acc',
    matches: (row) => row.test !== null,
  },
];

/** The three that earn their keep without being asked. */
export const DEFAULT_RULES: readonly RuleId[] = ['slow_external', 'server_error', 'n_plus_one'];

/**
 * The rule that tints a row, or `null`.
 *
 * @param selected the row is the current selection, which keeps its own
 * background — a tint underneath it would only muddy the highlight.
 */
export function tintOf(
  row: RequestRow,
  enabled: ReadonlySet<RuleId>,
  selected = false,
): RuleId | null {
  if (selected) return null;
  for (const rule of RULES) {
    if (enabled.has(rule.id) && rule.matches(row)) return rule.id;
  }
  return null;
}

const STORAGE_KEY = 'reqray.rules.v1';

/** Which rules are on, remembered across reloads. */
export function loadRules(storage: Pick<Storage, 'getItem'> | null): Set<RuleId> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_RULES);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set(DEFAULT_RULES);
    const known = new Set(RULES.map((rule) => rule.id));
    return new Set(parsed.filter((id): id is RuleId => known.has(id as RuleId)));
  } catch {
    // A corrupt or unavailable store is not worth a broken panel.
    return new Set(DEFAULT_RULES);
  }
}

export function saveRules(
  storage: Pick<Storage, 'setItem'> | null,
  ids: ReadonlySet<RuleId>,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Private browsing and full quotas both land here; the panel works anyway.
  }
}
