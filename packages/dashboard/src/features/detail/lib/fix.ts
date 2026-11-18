import type { Finding, RequestDetail } from '../../../api/index';
import { duration, oneLine } from '../../../shared/format';
import { costLine, evidenceLine } from './briefing';

/**
 * The suggested fix: a diff when one can be produced honestly, nothing when
 * it cannot.
 *
 * The captured evidence is SQL and a call site — not the reader's code — so
 * the only diff the panel is entitled to draw is over the statement itself.
 * A fabricated rewrite of a loop nobody captured would be a guess wearing a
 * diff's clothing, and a wrong fix is worse than none: the same law the
 * detectors live under. Where no template is confident, the block is simply
 * absent and the copyable prompt carries the work instead.
 */

export interface FixDiff {
  /** The lines that go, `-` implied. */
  readonly removed: readonly string[];
  /** The lines that come, `+` implied. */
  readonly added: readonly string[];
  /** The one-line arithmetic: what this trades for what. */
  readonly note: string;
}

/**
 * The equality an N+1 loop filters by: `WHERE <col> = $1` at the end of the
 * statement, pg placeholders only.
 *
 * Deliberately narrow. A trailing ORDER BY or LIMIT changes meaning when the
 * rows of every iteration come back as one set — per-group order is not
 * global order — so anything after the equality disqualifies the template
 * rather than being carried along wrongly.
 */
const PG_EQUALITY = /^(.*\bWHERE\b.*?)([\w".]+)\s*=\s*(\$\d+)\s*;?\s*$/i;

/** A diff for the finding, or `null` when no template is confident. */
export function suggestedFix(finding: Finding): FixDiff | null {
  if (finding.detector !== 'n_plus_one') return null;
  if (finding.evidence.kind !== 'n_plus_one') return null;

  const sample = oneLine(finding.evidence.sample ?? '').trim();
  if (!/^select\b/i.test(sample)) return null;

  const match = PG_EQUALITY.exec(sample);
  if (!match) return null;
  const [, head, column, placeholder] = match;
  if (!head || !column || !placeholder) return null;

  return {
    removed: [sample],
    added: [`${head}${column} = ANY(${placeholder})`],
    note:
      `1 query instead of ${finding.evidence.repeats} — collect the ids first, ` +
      `pass them as one array, and index the rows by ${column} on the way back`,
  };
}

/**
 * The fix, as a prompt for whatever assistant is at hand.
 *
 * Narrower than the whole-request briefing: one finding, its evidence, and
 * the ask. The reader pastes it next to the file the call site names — the
 * half of the context the panel cannot see.
 */
export function buildFixPrompt(detail: RequestDetail, finding: Finding): string {
  const where = finding.callsite
    ? `${finding.callsite.relative}:${finding.callsite.line}`
    : `${detail.method} ${detail.route}`;
  const lines = [
    `Fix this in ${where}:`,
    '',
    `${finding.title} — found by Reqray in ${detail.method} ${detail.path} ` +
      `(${duration(detail.durationMs)} total, ${costLine(finding, detail.durationMs)}).`,
    '',
    `Evidence: ${oneLine(evidenceLine(finding))}`,
    `Suggested direction: ${finding.hint}`,
    '',
    'Keep the behaviour identical — same rows, same order, same errors.',
    'Show the change as a diff against the current code.',
  ];
  return lines.join('\n');
}
