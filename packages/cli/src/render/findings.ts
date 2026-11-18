/**
 * What the detectors found, and what to do about it.
 *
 * Two levels, and the reason is the two-bright rule: at most the two
 * costliest findings get the loud form — a mark in the gutter, a bright tag,
 * the sample, the callsite and the fix. Everything else is stated quietly.
 * Three alarms on one screen is not a report, it is a siren.
 */

import type { Finding, RequestDetail } from '@reqray/protocol';
import { badgeFor, bytes, share, spanDuration } from './format.js';
import type { Theme } from './theme.js';
import { pad, padStart } from './width.js';

/** How many findings may shout. */
const LOUD = 2;
/** Below this a finding is real but not worth a mark, ms. */
const LOUD_FLOOR_MS = 1;
/** Right-aligned columns stop here, however wide the terminal is. */
export const BLOCK = 100;

/** Loudest first, so a sort can put the worse of two findings above. */
const SEVERITY: Record<string, number> = { critical: 2, warn: 1, info: 0 };

/**
 * Findings, worst first.
 *
 * By severity and then by cost, the same order the collector sorts them in.
 * Cost alone was enough while every detector measured its damage in
 * milliseconds; a twelve-megabyte response costs bytes, and it would sort
 * below a duplicate cache read that wasted a third of one.
 */
export function ranked(detail: RequestDetail): Finding[] {
  return [...detail.findings].sort(
    (a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || b.costMs - a.costMs,
  );
}

/**
 * What the finding costs, in whatever it costs.
 *
 * Milliseconds for the detectors that measure time. A response that is too
 * large costs bytes, and printing `0ms` for it would be stating the one
 * number the screen treats as measured, wrongly.
 */
function costOf(finding: Finding): string {
  const evidence = finding.evidence;
  return evidence.kind === 'heavy_response' ? bytes(evidence.bytes) : spanDuration(finding.costMs);
}

/**
 * The right-hand note: a share of the request, or what the response was.
 *
 * For a heavy response the title already carries the size and the rows, and
 * the content type is the thing it does not say — and the thing the detector's
 * judgement turned on, since a document of this size is a document and a JSON
 * body of it is a mistake.
 */
function noteOf(finding: Finding, durationMs: number): string {
  const evidence = finding.evidence;
  if (evidence.kind !== 'heavy_response') return share(finding.costMs, durationMs);
  return evidence.contentType ?? '';
}

/** Whether a finding is worth the gutter mark and the loud tag. */
function worthShouting(finding: Finding): boolean {
  // A finding whose cost is not time cannot clear a floor measured in it.
  return finding.evidence.kind === 'heavy_response' || finding.costMs >= LOUD_FLOOR_MS;
}

/** Where a finding points, as one line of text. */
function where(finding: Finding): string {
  const site = finding.callsite;
  return site ? `${site.relative}:${site.line}` : '';
}

/** The sample a finding carries, if its evidence has one. */
function sampleOf(finding: Finding): string | null {
  return 'sample' in finding.evidence ? finding.evidence.sample : null;
}

/** The findings block, heading excluded. */
export function findingLines(detail: RequestDetail, theme: Theme): string[] {
  const width = Math.min(theme.width, BLOCK);
  const lines: string[] = [];
  const findings = ranked(detail);

  findings.forEach((finding, index) => {
    const loud = index < LOUD && worthShouting(finding);
    const cost = costOf(finding);
    const percent = noteOf(finding, detail.durationMs);
    const tag = badgeFor(finding.detector);

    if (index > 0) lines.push('');

    if (loud) {
      const head = `  ${theme.paint('warn', '! ')}${theme.paint('warnLoud', pad(tag, 6))}`;
      const title = finding.title;
      const room = width - 10 - 8 - 3 - percent.length;
      lines.push(
        head +
          theme.paint('plain', pad(title, Math.max(10, room))) +
          theme.paint('plain', padStart(cost, 8)) +
          theme.paint('dim', `   ${percent}`),
      );

      const sample = sampleOf(finding);
      if (sample) lines.push(theme.paint('plain', `        ${sample}`));
      const site = where(finding);
      if (site) lines.push(theme.paint('dim', `        ${site}`));
      lines.push(theme.paint('dim', '        fix   ') + theme.paint('plain', finding.hint));
      return;
    }

    // The quiet form: lower case, no gutter, one line of context under it.
    const room = width - 10 - 8;
    lines.push(
      theme.paint(
        'dim',
        `    ${pad(tag.toLowerCase(), 6)}${pad(finding.title, Math.max(10, room))}`,
      ) + theme.paint('dim', padStart(cost, 8)),
    );
    const context = [sampleOf(finding), where(finding)].filter(Boolean).join('   ');
    if (context) lines.push(theme.paint('dim', `        ${context}`));
  });

  return lines.map((line) => line.trimEnd());
}
