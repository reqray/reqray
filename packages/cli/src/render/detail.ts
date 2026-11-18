/**
 * One request, whole.
 *
 * Waterfall, then findings, then the response. The order is the reading
 * order: where the time went, what to do about it, and what came back. Each
 * block is a heading in the left margin and its summary in one column, so the
 * three read as a table when they are scrolled past.
 */

import type { BaselineResponse, RequestDetail } from '@reqray/protocol';
import { findingLines } from './findings.js';
import { bytes, clock, duration } from './format.js';
import { frameOf } from './row.js';
import type { Theme } from './theme.js';
import { waterfallLines } from './waterfall.js';
import { cut } from './width.js';

/** Where a block's summary starts. */
const SUMMARY = 31;
/**
 * Below this the loop was on time and saying so is noise: one sampling
 * interval of lateness is the measurement's granularity, not an event.
 */
const LOOP_WORTH_SAYING = 15;
/** Right-aligned columns stop here, however wide the terminal is. */
const BLOCK = 100;

/** A block heading: a word in the margin, the numbers beside it. */
function heading(label: string, summary: string, theme: Theme): string {
  const left = `  ${label}`;
  return theme.paint('dim', left + ' '.repeat(Math.max(2, SUMMARY - left.length)) + summary);
}

/** The line that says which request this is. */
export function detailHeader(detail: RequestDetail, theme: Theme): string {
  const status = statusStyle(detail.status);
  const from = detail.test ? `   from ${detail.test}` : '';
  return (
    theme.paint('plain', `  ${detail.method} ${detail.path}`) +
    theme.paint(status, `   ${detail.status}`) +
    theme.paint('plain', `   ${duration(detail.durationMs)}`) +
    theme.paint('dim', `   ${clock(detail.startedAt)}   #${detail.id}${from}`)
  );
}

function statusStyle(status: number): 'dim' | 'warn' | 'errLoud' {
  if (status >= 500) return 'errLoud';
  if (status >= 400) return 'warn';
  return 'dim';
}

/**
 * Where the time went, and whether this call was unusual.
 *
 * Two facts the duration cannot carry on its own: which layer spent it, and
 * whether spending that much is normal for this route. Both are read off the
 * record — the arithmetic happens in the collector, so this line and the
 * panel's cannot drift apart.
 */
export function timingLines(
  detail: RequestDetail,
  compared: BaselineResponse,
  theme: Theme,
): string[] {
  const timing = detail.timing;
  if (!timing) return [];

  // A layer that cost nothing is left out rather than printed as zero.
  const waited: Array<[string, number]> = (
    [
      ['sql', timing.sqlMs],
      ['external', timing.externalMs],
      ['cache', timing.cacheMs],
    ] as Array<[string, number]>
  ).filter(([, ms]) => ms >= 0.05);
  const own: Array<[string, number]> = timing.selfMs >= 0.05 ? [['your code', timing.selfMs]] : [];

  // The loop, when it was behind far enough for the granularity not to be
  // the story. A property of the process, and the wording says so.
  const loopText =
    detail.host && detail.host.loopMaxMs >= LOOP_WORTH_SAYING
      ? `   loop behind ${duration(detail.host.loopMaxMs)}`
      : '';
  const parallelText = timing.parallel ? '   (overlapping)' : '';

  // What the layers have left after the notes have taken their share: the
  // note is the news, and the layer it displaces is the one nobody was going
  // to read anyway.
  const full = Math.min(theme.width, BLOCK) - SUMMARY;
  const line = (shown: ReadonlyArray<[string, number]>): string =>
    [
      duration(detail.durationMs),
      ...shown.map(([label, ms]) => `${duration(ms)} ${label}`),
      ...own.map(([label, ms]) => `${duration(ms)} ${label}`),
    ].join('   ');

  // A narrow screen gives up the cheapest layer it waited on first — never
  // the total, and never the application's own time, which is the one figure
  // here that nothing else on the screen carries and the only one the reader
  // can go and change.
  const fit = (room: number): Array<[string, number]> => {
    let shown = waited;
    while (shown.length > 1 && line(shown).length > room) {
      const cheapest = shown.reduce((least, part) => (part[1] < least[1] ? part : least));
      shown = shown.filter((part) => part !== cheapest);
    }
    return shown;
  };

  // The notes go before the last layer does. A line reading "94ms · 36ms your
  // code · loop behind 45ms" has quietly dropped the 58 ms of SQL that was the
  // largest thing in the request, which is not a summary of anything.
  let notes = parallelText + loopText;
  let shown = fit(full - notes.length);
  if (line(shown).length > full - notes.length) {
    notes = '';
    shown = fit(full);
  }
  const summary = line(shown);

  const lines = [
    heading('TIME', summary, theme) +
      theme.paint('dim', notes.includes('(overlapping)') ? parallelText : '') +
      theme.paint('warn', notes.includes('loop behind') ? loopText : ''),
  ];
  const { baseline, pressure } = compared;
  if (baseline) {
    lines.push(
      theme.paint(
        baseline.verdict === 'slower' ? 'warn' : 'dim',
        ' '.repeat(SUMMARY) + verdictOf(baseline),
      ),
    );
  }
  if (pressure) {
    // Said as a property of the process, never of this request: what follows
    // is the route's own calls compared against themselves.
    const calls = pressure.elevated.calls + pressure.normal.calls;
    const slower = `${pressure.ratio.toFixed(1)}× slower`;
    const forms = [
      `when the loop was over ${duration(pressure.cutoffMs)} behind, this route's p95 was ${slower} — ${Math.round(pressure.share)}% of ${calls} calls`,
      `loop over ${duration(pressure.cutoffMs)} behind → p95 ${slower} on ${Math.round(pressure.share)}% of ${calls} calls`,
      `loop over ${duration(pressure.cutoffMs)} → p95 ${slower} (${Math.round(pressure.share)}%)`,
    ];
    const fits = forms.find((form) => form.length <= full) ?? (forms.at(-1) as string);
    lines.push(theme.paint('dim', ' '.repeat(SUMMARY) + fits));
  }
  return lines;
}

/** The verdict as a sentence, with the sample it rests on. */
function verdictOf(baseline: NonNullable<BaselineResponse['baseline']>): string {
  const of = `${baseline.samples} call${baseline.samples === 1 ? '' : 's'} to ${baseline.route}`;
  if (baseline.verdict === 'slower') return `slower than 95% of ${of}`;
  if (baseline.verdict === 'faster') return `faster than the average of ${of}`;
  return `typical for this route, over ${of}`;
}

/** How many spans the waterfall stands for, and what is odd about them. */
function spanSummary(detail: RequestDetail): string {
  // Counted the way the waterfall badges them: every repeat but the first.
  const duplicated = new Set<number>();
  for (const finding of detail.findings) {
    if (finding.detector === 'dup_http' || finding.detector === 'dup_cache') {
      for (const id of [...finding.evidence.spanIds].sort((a, b) => a - b).slice(1)) {
        duplicated.add(id);
      }
    }
  }
  const parts = [`${detail.spans.length} spans`];
  if (duplicated.size > 0) parts.push(`${duplicated.size} of them duplicated`);
  if (detail.droppedSpans > 0) parts.push(`${detail.droppedSpans} dropped`);
  return parts.join(', ');
}

/** Status, type, size and etag — what the response was, in one line. */
function responseSummary(detail: RequestDetail, theme: Theme): string {
  const headers = detail.responseHeaders;
  const type = headers['content-type']?.split(';')[0];
  const length = Number(headers['content-length'] ?? Number.NaN);
  const size = Number.isFinite(length)
    ? bytes(length)
    : detail.responseBody
      ? bytes(Buffer.byteLength(detail.responseBody.text))
      : null;

  // Rows sit next to the size on purpose: a small response built out of a
  // hundred thousand rows is a different mistake from a large one.
  const rows = detail.weight?.rows ? `${detail.weight.rows.toLocaleString('en-US')} rows` : null;
  const parts = [
    String(detail.status),
    type,
    size,
    rows,
    headers['etag'] ? `etag ${headers['etag']}` : null,
  ];
  return cut(
    parts.filter(Boolean).join('   '),
    Math.min(theme.width, BLOCK) - SUMMARY - 1,
    theme.glyph('ellipsis'),
  );
}

/** The response block: the summary line, timings, and the body's first line. */
export function responseLines(detail: RequestDetail, theme: Theme): string[] {
  const lines = [heading('RESPONSE', responseSummary(detail, theme), theme)];
  const timing = detail.responseHeaders['server-timing'];
  if (timing) {
    lines.push(theme.paint('dim', `        server-timing   ${timing.split(/,\s*/).join('   ')}`));
  }
  if (detail.responseBody) {
    const room = Math.min(theme.width, BLOCK) - 16;
    const body = detail.responseBody.text.replace(/\s+/g, ' ').trim();
    lines.push(
      theme.paint('dim', '        body   ') +
        theme.paint('plain', cut(body, room, theme.glyph('ellipsis'))),
    );
  }
  if (detail.error) {
    lines.push(
      '',
      theme.paint('err', `  ${detail.error.name}`) +
        theme.paint('dim', `: ${detail.error.message}`),
    );
    const frame = frameOf(detail.error.stack);
    if (frame) lines.push(theme.paint('dim', `  ${frame}`));
  }
  return lines;
}

/** What else can be asked about this request. */
export function trailingCommands(detail: RequestDetail, theme: Theme): string[] {
  const queries = detail.sqlCount;
  const commands: Array<[string, string]> = [];
  if (detail.responseBody) {
    commands.push([`reqray show ${detail.id} --body`, 'the whole response body']);
  }
  if (queries > 0) {
    commands.push([
      `reqray show ${detail.id} --sql`,
      queries === 1
        ? 'the query it ran, and where from'
        : `all ${queries} queries with their callsites`,
    ]);
  }

  const column = Math.max(...commands.map(([command]) => command.length), 0) + 8;
  return commands.map(
    ([command, note]) =>
      theme.paint('cmd', `  ${command}`) +
      theme.paint('dim', ' '.repeat(Math.max(2, column - command.length)) + note),
  );
}

/** The whole screen. */
export function detailScreen(
  detail: RequestDetail,
  theme: Theme,
  compared: BaselineResponse = { baseline: null, pressure: null },
): string[] {
  const lines = [detailHeader(detail, theme), ''];

  const timing = timingLines(detail, compared, theme);
  if (timing.length > 0) lines.push(...timing, '');

  if (detail.spans.length > 0) {
    lines.push(heading('WATERFALL', spanSummary(detail), theme));
    lines.push(...waterfallLines(detail, theme));
    lines.push('');
  }

  if (detail.findings.length > 0) {
    lines.push(heading('FINDINGS', String(detail.findings.length), theme), '');
    lines.push(...findingLines(detail, theme));
    lines.push('');
  }

  lines.push(...responseLines(detail, theme));

  const trailing = trailingCommands(detail, theme);
  if (trailing.length > 0) lines.push('', ...trailing);
  return lines;
}
