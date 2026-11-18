/**
 * Every query the request ran.
 *
 * SQL is wrapped rather than truncated: a path can be recognised from a
 * fragment and a query cannot. Wrapping is capped at three lines, and the
 * line that says how many are left ends in the command that shows them —
 * truncation without a way out is a dead end.
 */

import type { DbSpan, RequestDetail } from '@reqray/protocol';
import { spanDuration } from './format.js';
import type { Theme } from './theme.js';
import { pad } from './width.js';

/** How many lines of one query are printed before the rest is behind a flag. */
const MAX_LINES = 3;
/** The hanging indent a wrapped query lines up under. */
const HANG = 7;
/** Right-aligned columns stop here, however wide the terminal is. */
const BLOCK = 100;

/** One query, or one group of identical ones. */
export interface QueryEntry {
  /** How it is referred to on the command line: `q2`. */
  readonly ref: string;
  readonly sql: string;
  readonly totalMs: number;
  /** How many times it ran. More than one means a loop. */
  readonly calls: number;
  readonly rows: number | null;
  readonly callsite: string | null;
  /** Set when the group is what a detector flagged. */
  readonly badge: string | null;
}

const isDb = (span: { kind: string }): span is DbSpan => span.kind === 'db';

/**
 * The queries of a request, in the order they ran.
 *
 * Identical queries flagged as an N+1 are one entry: the point of the screen
 * is which queries the request ran, and forty-seven copies of one of them is
 * a single answer.
 */
export function queriesOf(detail: RequestDetail): QueryEntry[] {
  const looped = new Set<number>();
  for (const finding of detail.findings) {
    if (finding.detector !== 'n_plus_one') continue;
    for (const id of finding.evidence.spanIds) looped.add(id);
  }

  const entries: QueryEntry[] = [];
  let loopDone = false;

  for (const span of detail.spans.filter(isDb)) {
    if (looped.has(span.id)) {
      if (loopDone) continue;
      loopDone = true;
      const group = detail.spans.filter((entry) => isDb(entry) && looped.has(entry.id)) as DbSpan[];
      entries.push({
        ref: `q${entries.length + 1}`,
        sql: span.sql,
        totalMs: group.reduce((sum, entry) => sum + entry.duration, 0),
        calls: group.length,
        rows: span.rowCount,
        callsite: siteOf(span),
        badge: 'N+1',
      });
      continue;
    }

    entries.push({
      ref: `q${entries.length + 1}`,
      sql: span.sql,
      totalMs: span.duration,
      calls: 1,
      rows: span.rowCount,
      callsite: siteOf(span),
      badge: null,
    });
  }
  return entries;
}

function siteOf(span: DbSpan): string | null {
  return span.callsite ? `${span.callsite.relative}:${span.callsite.line}` : null;
}

const KEYWORDS =
  /^(SELECT|FROM|WHERE|INNER|OUTER|LEFT|RIGHT|JOIN|ON|AND|OR|ORDER|GROUP|BY|LIMIT|OFFSET|IN|AS|COUNT|SUM|AVG|MIN|MAX|NOT|NULL|IS|DESC|ASC|INSERT|INTO|VALUES|UPDATE|SET|DELETE|RETURNING|DISTINCT|HAVING|WITH|CASE|WHEN|THEN|ELSE|END)$/i;

/**
 * Paints one line of SQL.
 *
 * Keywords cyan, literals and placeholders green — the same two colours the
 * panel uses, and the only place in this client where colour is applied
 * inside a line rather than to a column.
 */
export function paintSql(line: string, theme: Theme): string {
  return line
    .split(/(\s+|,|\(|\))/)
    .filter((token) => token !== '')
    .map((token) => {
      const bare = token.trim();
      if (!bare) return token;
      if (KEYWORDS.test(bare)) return theme.paint('cmd', token);
      if (/^'.*'$/.test(bare) || /^\$\d+$/.test(bare) || /^\d+$/.test(bare)) {
        return theme.paint('ok', token);
      }
      return theme.paint('plain', token);
    })
    .join('');
}

/** Breaks a query into lines that fit, on whitespace. */
export function wrapSql(sql: string, width: number): string[] {
  const words = sql.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** The `--sql` screen. */
export function sqlLines(
  detail: RequestDetail,
  theme: Theme,
  options: { only?: string | null; full?: boolean } = {},
): string[] {
  const entries = queriesOf(detail);
  const asked = options.only?.toLowerCase() ?? null;
  const wanted = asked ? entries.filter((entry) => entry.ref === asked) : entries;

  if (entries.length === 0) {
    return [theme.paint('plain', '  this request ran no queries')];
  }
  if (wanted.length === 0) {
    return [
      theme.paint('plain', `  no query called ${options.only} in this request`),
      theme.paint('dim', `  it has ${entries.length}: ${entries.map((e) => e.ref).join(' ')}`),
    ];
  }

  const width = Math.max(20, Math.min(theme.width, BLOCK) - HANG - 1);
  const lines: string[] = [];

  wanted.forEach((entry, index) => {
    if (index > 0) lines.push('');

    // Built twice on purpose: once plain to measure, once painted to print.
    // Measuring painted text means measuring escape sequences.
    const cells: Array<[string, (text: string) => string]> = [
      [entry.badge ? '! ' : '  ', (text) => theme.paint('warn', text)],
      [pad(entry.ref, 5), (text) => theme.paint('dim', text)],
      [pad(spanDuration(entry.totalMs), 8), (text) => theme.paint('plain', text)],
      [
        pad(entry.calls > 1 ? `${entry.calls} calls` : rowsOf(entry), 12),
        (t) => theme.paint('dim', t),
      ],
      [entry.callsite ?? '', (text) => theme.paint('dim', text)],
    ];
    const plain = cells
      .map(([text]) => text)
      .join('')
      .trimEnd();
    let head = cells
      .map(([text, paint]) => paint(text))
      .join('')
      .trimEnd();

    if (entry.badge) {
      const gap = Math.max(3, Math.min(theme.width, BLOCK) - plain.length - entry.badge.length - 1);
      head += ' '.repeat(gap) + theme.paint('warnLoud', entry.badge);
    }
    lines.push(head, '');

    const wrapped = wrapSql(entry.sql, width);
    const shown = options.full ? wrapped : wrapped.slice(0, MAX_LINES);
    for (const line of shown) lines.push(' '.repeat(HANG) + paintSql(line, theme));

    const rest = wrapped.length - shown.length;
    if (rest > 0) {
      const tail = `${' '.repeat(HANG)}${theme.glyph('ellipsis')} ${rest} more lines`;
      const command = `reqray show ${detail.id} --sql ${entry.ref} --full`;
      const gap = Math.max(3, Math.min(theme.width, BLOCK) - tail.length - command.length - 1);
      lines.push(theme.paint('dim', tail) + ' '.repeat(gap) + theme.paint('cmd', command));
    }
  });

  return lines.map((line) => line.trimEnd());
}

/** `25 rows`, or nothing when the driver did not say. */
function rowsOf(entry: QueryEntry): string {
  return entry.rows === null ? '' : `${entry.rows} rows`;
}
