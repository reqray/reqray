/**
 * Where the time went, drawn with characters.
 *
 * The bar is the only flexible column; the tag and the label keep their width
 * so the shape of a request is comparable between two terminals. A span
 * shorter than one cell is drawn as a sliver rather than dropped — losing a
 * span is worse than showing it imprecisely.
 *
 * Spans belonging to one N+1 collapse into a single `47× SELECT line_items`,
 * exactly as they do in the panel: forty-seven identical bars are one fact
 * printed forty-seven times.
 */

import type { RequestDetail, Span } from '@reqray/protocol';
import { buildWaterfall as buildBars, type WaterfallBar } from '@reqray/waterfall';
import { badgeFor, duration, spanDuration } from './format.js';
import type { Style, Theme } from './theme.js';
import { cut, pad, padStart } from './width.js';

/** Width of the kind tag, `sql` and friends. */
const TAG = 6;
/** Width of the label column. */
const LABEL = 28;
/** Everything left of the bar: two spaces, the tag, the label, a space. */
export const INDENT = 2 + TAG + LABEL + 1;
/** Bar plus two spaces, the duration and a badge. */
const RIGHT = 2 + 7 + 1 + 4;

/** One line of the waterfall. */
export interface WaterfallRow {
  readonly tag: string;
  readonly label: string;
  readonly depth: number;
  /** Offset from the request start, ms. */
  readonly startedAt: number;
  readonly duration: number;
  readonly badge: string | null;
  readonly style: Style;
  /** Handler spans are drawn as a bracket: a container, not work. */
  readonly bracket: boolean;
  /**
   * Milliseconds this query queued for a connection before it ran.
   *
   * The panel draws it as a lead-in on the bar. The terminal has one cell to
   * spare, so it says so in the label instead — but it must not simply drop
   * it: a query that took 340 ms because it waited for 338 of them looks
   * exactly like one that worked for 340.
   */
  readonly waitMs: number;
}

/**
 * How many cells the bar gets at this width.
 *
 * `width - 55` at a glance: the indent, the duration and the badge, plus four
 * columns that stay empty so a badge at the right edge never wraps.
 */
export function barCells(width: number): number {
  return Math.max(12, Math.min(60, width - INDENT - RIGHT - 4));
}

const KIND_STYLE: Readonly<Record<WaterfallBar['kind'], Style>> = {
  middleware: 'dim',
  handler: 'cmd',
  db: 'ok',
  http: 'warn',
  cache: 'faint',
  // Faint on purpose: a gap is the absence of an answer, and it must not read
  // as louder than the work around it.
  gap: 'faint',
};

const KIND_TAG: Readonly<Record<WaterfallBar['kind'], string>> = {
  middleware: 'mw',
  handler: 'fn',
  db: 'sql',
  http: 'http',
  cache: 'cache',
  gap: '—',
};

/**
 * A query, shortened to what identifies it.
 *
 * The table and the clause that selects inside it are what tell two queries
 * apart at a glance; the column list never is.
 */
export function sqlLabel(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const select = /^select\b.*?\bfrom\s+([\w."]+)(.*)$/i.exec(flat);
  if (select) return tidy(`SELECT ${table(select[1])}${select[2] ?? ''}`);

  const insert = /^insert\s+into\s+([\w."]+)/i.exec(flat);
  if (insert) return `INSERT ${table(insert[1])}`;

  const update = /^update\s+([\w."]+)(.*)$/i.exec(flat);
  if (update) return tidy(`UPDATE ${table(update[1])}${update[2] ?? ''}`);

  const remove = /^delete\s+from\s+([\w."]+)(.*)$/i.exec(flat);
  if (remove) return tidy(`DELETE ${table(remove[1])}${remove[2] ?? ''}`);

  return flat;
}

/** The table name without its schema or quotes. */
function table(name: string | undefined): string {
  return (name ?? '?').replace(/"/g, '').split('.').pop() ?? '?';
}

/** Keeps the clause that narrows the query and drops the joins between. */
function tidy(text: string): string {
  const clause = /\b(where|limit|order by|group by)\b/i.exec(text);
  const head = clause ? text.slice(0, clause.index).trim() : text.trim();
  const tail = clause ? ` ${text.slice(clause.index).trim()}` : '';
  return `${head}${tail}`.replace(/\s*=\s*/g, '=').replace(/\s+/g, ' ');
}

/** The label a span carries in the waterfall. */
export function labelOf(span: Span): string {
  switch (span.kind) {
    case 'middleware':
    case 'handler':
      return span.label;
    case 'db':
      return sqlLabel(span.sql);
    case 'http': {
      try {
        const url = new URL(span.url);
        return `${url.host} ${url.pathname}`;
      } catch {
        return span.url;
      }
    }
    case 'cache':
      return span.key;
  }
}

/** Which spans a finding is about, by detector. */
function spanIdsOf(detail: RequestDetail, detector: string): Set<number> {
  const ids = new Set<number>();
  for (const finding of detail.findings) {
    if (finding.detector !== detector) continue;
    for (const id of finding.evidence.spanIds) ids.add(id);
  }
  return ids;
}

/**
 * The repeats of a duplicated call — every one of them but the first.
 *
 * The first call is the work; the ones after it are what was wasted. Marking
 * all of them would say the request did something wrong twice when it did it
 * once too often.
 */
function repeatsOf(detail: RequestDetail, detectors: readonly string[]): Set<number> {
  const ids = new Set<number>();
  for (const finding of detail.findings) {
    if (!detectors.includes(finding.detector)) continue;
    for (const id of [...finding.evidence.spanIds].sort((a, b) => a - b).slice(1)) ids.add(id);
  }
  return ids;
}

/** The rows a waterfall is made of. */
export function buildWaterfall(detail: RequestDetail, theme: Theme): WaterfallRow[] {
  // Structure from the shared model, words from here: the same request must
  // not show a different number of bars in the terminal and in the panel.
  const duplicated = repeatsOf(detail, ['dup_http', 'dup_cache']);
  const sequential = spanIdsOf(detail, 'sequential_http');

  return buildBars(detail).map((bar): WaterfallRow => {
    const label =
      bar.span === null
        ? 'uninstrumented'
        : bar.count > 1
          ? `${bar.count}${theme.glyph('times')} ${labelOf(bar.span)}`
          : labelOf(bar.span);

    return {
      tag: KIND_TAG[bar.kind],
      label,
      depth: bar.depth,
      startedAt: bar.startedAt,
      duration: bar.duration,
      badge: badgeOf(bar, duplicated, sequential),
      style: KIND_STYLE[bar.kind],
      bracket: bar.kind === 'handler',
      waitMs: bar.waitMs,
    };
  });
}

/** What is worth saying about a bar in four columns. */
function badgeOf(
  bar: WaterfallBar,
  duplicated: ReadonlySet<number>,
  sequential: ReadonlySet<number>,
): string | null {
  if (bar.finding === 'n_plus_one') return 'N+1';
  if (bar.finding !== null) return badgeFor(bar.finding);
  if (bar.span === null) return null;
  if (duplicated.has(bar.span.id)) return 'DUP';
  return sequential.has(bar.span.id) ? badgeFor('sequential_http') : null;
}

/**
 * One bar.
 *
 * A span narrower than three fifths of a cell becomes a sliver in its own
 * cell; anything wider is rounded to at least two, so a bar always reads as a
 * bar. A bar that would run past the last cell is pulled back rather than
 * clipped — the total is the scale, and nothing may draw outside it.
 */
export function barParts(
  startedAt: number,
  length: number,
  total: number,
  cells: number,
  theme: Theme,
  bracket = false,
): { lead: string; body: string; trail: string } {
  const per = total > 0 ? total / cells : 1;
  let offset = Math.max(0, Math.floor(startedAt / per));
  let width = length / per;
  let body: string;

  if (width < 0.6) {
    body = theme.glyph('barSliver');
    width = 1;
  } else {
    width = Math.max(2, Math.round(width));
    body = bracket
      ? theme.glyph('bracketOpen') +
        theme.glyph('bracketFill').repeat(width - 2) +
        theme.glyph('bracketClose')
      : theme.glyph('barFull').repeat(width);
  }

  if (offset + width > cells) offset = Math.max(0, cells - width);
  return {
    lead: ' '.repeat(offset),
    body,
    trail: ' '.repeat(Math.max(0, cells - offset - width)),
  };
}

/** The same bar as one string. The parts exist so only the bar is painted. */
export function bar(
  startedAt: number,
  length: number,
  total: number,
  cells: number,
  theme: Theme,
  bracket = false,
): string {
  const { lead, body, trail } = barParts(startedAt, length, total, cells, theme, bracket);
  return lead + body + trail;
}

/** The ruler under the scale, and where its ticks sit. */
export function ruler(cells: number, theme: Theme): { line: string; ticks: number[] } {
  const inner = Math.max(4, cells - 5);
  const segments = [0, 1, 2, 3].map((index) => Math.floor(inner / 4) + (index < inner % 4 ? 1 : 0));

  let line = theme.glyph('bracketOpen');
  const ticks = [0];
  segments.forEach((length, index) => {
    line += theme.glyph('bracketFill').repeat(length);
    line += index === segments.length - 1 ? theme.glyph('bracketClose') : theme.glyph('rulerTick');
    ticks.push(line.length - 1);
  });
  return { line, ticks };
}

/**
 * The times printed above the ruler.
 *
 * Five of them when they fit, three when they do not, two when even that is
 * too many. A narrow terminal gets a coarser scale rather than five numbers
 * running into each other.
 */
export function scale(total: number, ticks: readonly number[], room?: number): string {
  const cells = (ticks[ticks.length - 1] ?? 0) + 1;
  // The scale line carries nothing else, so it may run a little past the
  // ruler — up to the edge of the terminal, which is what `room` is.
  const allowed = Math.max(cells, room ?? cells);

  for (const step of [1, 2, 4]) {
    const line = layout(total, ticks, step);
    if (line.length <= allowed) return line;
  }
  // Nothing fits but the total, which is the number the scale is for.
  return padStart(duration(total), cells);
}

/** Places every `step`-th label along the ruler. */
function layout(total: number, ticks: readonly number[], step: number): string {
  const last = ticks.length - 1;
  let line = '';

  ticks.forEach((position, index) => {
    if (index % step !== 0 && index !== last) return;
    const at = (total * index) / last;
    const text = at === 0 ? '0ms' : duration(at);
    const start =
      index === 0
        ? 0
        : index === last
          ? position - text.length + 1
          : position - Math.floor(text.length / 2);
    line += ' '.repeat(Math.max(index === 0 ? 0 : 1, start - line.length)) + text;
  });
  return line;
}

/** The whole waterfall: scale, ruler, one line per span. */
export function waterfallLines(detail: RequestDetail, theme: Theme): string[] {
  const cells = barCells(theme.width);
  const { line, ticks } = ruler(cells, theme);
  const rows = buildWaterfall(detail, theme);
  const total = Math.max(detail.durationMs, ...rows.map((row) => row.startedAt + row.duration));

  const lines = [
    theme.paint('dim', ' '.repeat(INDENT) + scale(total, ticks, theme.width - INDENT)),
    theme.paint('dim', ' '.repeat(INDENT) + line),
  ];

  for (const row of rows) {
    // A query that took 340 ms because it queued for 338 of them looks exactly
    // like one that worked for 340. The panel draws the wait as a lead-in on
    // the bar; a terminal has no room for that, so it says it in words.
    const waited = row.waitMs >= 1 ? ` (${spanDuration(row.waitMs)} queued)` : '';
    const label = cut(
      ' '.repeat(row.depth * 2) + row.label + waited,
      LABEL,
      theme.glyph('ellipsis'),
    );
    const drawn = barParts(row.startedAt, row.duration, total, cells, theme, row.bracket);
    lines.push(
      theme.paint('dim', `  ${pad(row.tag, TAG)}`) +
        theme.paint(row.tag === 'mw' ? 'dim' : 'plain', pad(label, LABEL)) +
        ' ' +
        drawn.lead +
        theme.paint(row.style, drawn.body) +
        drawn.trail +
        '  ' +
        theme.paint('plain', padStart(spanDuration(row.duration), 7)) +
        ' ' +
        (row.badge ? theme.paint(row.badge === 'N+1' ? 'warnLoud' : 'warn', row.badge) : ''),
    );
  }
  return lines.map((entry) => entry.trimEnd());
}
