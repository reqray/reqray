/**
 * One request, on one line.
 *
 * The grid is fixed so the eye can hold a vertical: the same fact is always in
 * the same place, and the gutter reserves its two columns even when they are
 * empty, so a `!` appearing does not shift the line under it.
 *
 * Severity is carried by a glyph first and by colour second. Every renderer
 * here paints padded text, never pads painted text — an escape sequence has
 * no width, and measuring one is how columns drift.
 */

import type { RequestDetail, RequestRow } from '@reqray/protocol';
import {
  badgeFor,
  clock,
  duration,
  MANY_QUERIES,
  queries,
  SLOW_MS,
  VERY_SLOW_MS,
} from './format.js';
import type { Style, Theme } from './theme.js';
import { fitPath, pad, padStart, streamColumns } from './width.js';

/** A painted cell: what it says, and what it means. */
type Cell = readonly [Style, string];

/** The flag at the right edge — the one thing the eye scans for. */
function flagOf(row: RequestRow, showStatus: boolean): Cell | null {
  // With the status column dropped, a non-2xx prints its code here instead:
  // the code is the more serious fact, and the flag is one `show` away.
  if (!showStatus && row.status >= 400) {
    return [row.status >= 500 ? 'errLoud' : 'warn', String(row.status)];
  }
  if (row.hasError) return ['errLoud', 'ERR'];
  if (row.flag) return [row.flag === 'n_plus_one' ? 'warnLoud' : 'warn', badgeFor(row.flag)];
  if (row.test) return ['cmd', 'TEST'];
  return null;
}

/** Two columns of severity, before any colour is involved. */
function gutterOf(row: RequestRow): Cell {
  if (row.hasError) return ['err', '!!'];
  if (row.findingCount > 0 || row.durationMs >= SLOW_MS) return ['warn', '!'];
  return ['dim', ''];
}

function statusStyle(status: number): Style {
  if (status >= 500) return 'errLoud';
  if (status >= 400) return 'warn';
  // 2xx is not green: in a stream that would be a green column on every line,
  // and the rare thing worth seeing would weigh no more than the usual one.
  return 'dim';
}

function durationStyle(ms: number): Style {
  if (ms >= VERY_SLOW_MS) return 'err';
  if (ms >= SLOW_MS) return 'warn';
  return 'plain';
}

/**
 * Paints a fitted path.
 *
 * What reqray added — the ellipsis, the `?` that stands in for a query string
 * — is muted; what was in the request is not. Colour is what separates the
 * two, which is why the markers are never painted as data.
 */
function paintPath(text: string, theme: Theme): string {
  const ellipsis = theme.glyph('ellipsis');
  const parts = text.split(ellipsis);
  return parts
    .map((part, index) => {
      const last = index === parts.length - 1;
      // A `?` right before an ellipsis belongs to the marker, not to the path.
      if (!last && part.endsWith('?')) {
        return theme.paint('plain', part.slice(0, -1)) + theme.paint('dim', '?');
      }
      return theme.paint('plain', part);
    })
    .join(theme.paint('dim', ellipsis));
}

/**
 * Paints cells and puts them together.
 *
 * Never trims: a separator at the end of a chunk is a column boundary, and
 * trimming one is how the status column ends up glued to the path. Only the
 * finished line is trimmed, once, at the end.
 */
function join(theme: Theme, cells: readonly Cell[]): string {
  return cells.map(([style, text]) => theme.paint(style, text)).join('');
}

/**
 * How wide an id is printed: an eight-character process prefix and room for
 * the first million and a half requests of that process. A cut id opens
 * nothing, so the column is as wide as an id really is.
 */
const ID = 12;

/** What a stream line may show beyond the fixed grid. */
export interface RowOptions {
  /** Print the identifier `show` takes, so a row on screen can be opened. */
  readonly ids?: boolean;
}

/** The column heads. Coordinates, so all of it is muted. */
export function streamHead(theme: Theme, options: RowOptions = {}): string {
  const columns = streamColumns(theme.width, options.ids);
  const cells: Cell[] = [['dim', '   ']];
  if (columns.ids) cells.push(['dim', pad('ID', ID)], ['dim', ' ']);
  cells.push(['dim', pad('TIME', 12)], ['dim', ' '], ['dim', pad('METHOD', 6)], ['dim', ' ']);
  if (columns.status) cells.push(['dim', pad('ST', 3)], ['dim', ' ']);
  cells.push(['dim', pad('PATH', columns.path)], ['dim', '  '], ['dim', padStart('DUR', 7)]);
  if (columns.queries) cells.push(['dim', ' '], ['dim', padStart('Q', 4)]);
  cells.push(['dim', ' '], ['dim', 'FLAGS']);
  return join(theme, cells);
}

/** One request. */
export function streamRow(row: RequestRow, theme: Theme, options: RowOptions = {}): string {
  const columns = streamColumns(theme.width, options.ids);
  const gutter = gutterOf(row);
  const flag = flagOf(row, columns.status);
  const path = fitPath(row.path, row.query, columns.path, theme.glyph('ellipsis'));

  const cells: Cell[] = [
    [gutter[0], pad(gutter[1], 2)],
    ['dim', ' '],
  ];
  // Cyan, like every other string here that can be copied into a command.
  if (columns.ids) cells.push(['cmd', pad(row.id, ID)], ['dim', ' ']);
  cells.push(
    ['dim', pad(clock(row.startedAt), 12)],
    ['dim', ' '],
    // POST and DELETE read louder than GET without a colour of their own —
    // only by contrast with a muted one.
    [row.method === 'GET' ? 'dim' : 'plain', pad(row.method, 6)],
    ['dim', ' '],
  );
  if (columns.status) {
    cells.push([statusStyle(row.status), pad(String(row.status), 3)], ['dim', ' ']);
  }

  const painted = [
    join(theme, cells),
    paintPath(pad(path, columns.path), theme),
    theme.paint('dim', '  '),
    theme.paint(durationStyle(row.durationMs), padStart(duration(row.durationMs), 7)),
  ];
  if (columns.queries) {
    painted.push(
      theme.paint('dim', ' '),
      theme.paint(
        row.sqlCount > MANY_QUERIES ? 'warn' : 'dim',
        padStart(queries(row.sqlCount, theme), 4),
      ),
    );
  }
  painted.push(theme.paint('dim', ' '), flag ? theme.paint(flag[0], flag[1]) : '');

  return painted.join('').trimEnd();
}

/**
 * The second line a failed request gets.
 *
 * The only exception to one line per request. An exception with neither type
 * nor file would send the reader to `show` immediately — cheaper to print it
 * here, where they are already looking.
 */
export function failureLines(
  row: RequestRow,
  detail: RequestDetail | null,
  theme: Theme,
): string[] {
  const error = detail?.error ?? null;
  const command = `reqray show ${row.id}`;
  const corner = theme.glyph('corner');

  if (!error) {
    return [`   ${theme.paint('dim', corner)} ${theme.paint('cmd', command)}`];
  }

  const lines = [
    `   ${theme.paint('dim', corner)} ${theme.paint('err', error.name)}${theme.paint('dim', `: ${error.message}`)}`,
  ];

  const frame = frameOf(error.stack);
  const left = `     ${frame ?? ''}`;
  if (frame && left.length + command.length + 3 <= theme.width) {
    const gap = ' '.repeat(theme.width - left.length - command.length - 1);
    lines.push(theme.paint('dim', left) + gap + theme.paint('cmd', command));
  } else {
    if (frame) lines.push(theme.paint('dim', left));
    lines.push(`     ${theme.paint('cmd', command)}`);
  }
  return lines;
}

/**
 * The first frame of a stack that belongs to the application.
 *
 * Two path segments, which is what a reader needs to find the file, and all
 * that can be said without knowing where the project root is — the client is
 * on the other side of an HTTP boundary from the process that threw.
 */
export function frameOf(stack: string | null): string | null {
  if (!stack) return null;
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;

    // The whole location, not a piece of it: `node:internal/process/x` has a
    // slash in it, and a pattern looking for one finds a frame that is not a
    // file at all.
    const match = /^at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const file = match?.[1];
    if (!file || file.startsWith('node:') || file.includes('node_modules')) continue;

    const parts = file.split(/[/\\]/).filter((part) => part !== '' && part !== 'file:');
    return `${parts.slice(-2).join('/')}:${match?.[2]}`;
  }
  return null;
}
