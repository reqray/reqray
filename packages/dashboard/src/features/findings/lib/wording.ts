/** A pattern, worded: the gutter's grade, the state's word, the copyable forms. */

import type { FindingPattern } from '../../../api/index';
import { duration } from '../../../shared/format';

/** Recoverable time above which the gutter goes red rather than amber. */
export const LOUD_MS = 5_000;

/** How loudly the severity gutter reads for one pattern. */
export function gradeOf(pattern: FindingPattern): 'quiet' | 'loud' | 'warn' {
  if (pattern.state === 'muted') return 'quiet';
  if (pattern.recoverableMs >= LOUD_MS || pattern.severity === 'critical') return 'loud';
  return 'warn';
}

export function stateWord(state: FindingPattern['state']): string {
  // The question mark is the honesty: "silent since the file changed" is a
  // guess about a fix, not a report of one.
  return state === 'fixed' ? 'fixed?' : state;
}

/** The pattern as a markdown report — what two of the exports build on. */
export function toMarkdown(pattern: FindingPattern): string {
  const where = pattern.callsite
    ? `${pattern.callsite.relative}:${pattern.callsite.line}`
    : pattern.routes.map((route) => `${route.method} ${route.route}`).join(', ');
  const lines = [
    `## ${pattern.title}`,
    '',
    `- detector: ${pattern.detector}`,
    `- where: ${where}`,
    `- occurrences: ${pattern.occurrences} across ${pattern.routes.length} route${pattern.routes.length === 1 ? '' : 's'}`,
    ...(pattern.recoverableMs > 0 ? [`- recoverable: ${duration(pattern.recoverableMs)}`] : []),
    `- first seen: ${new Date(pattern.firstSeen).toISOString()}`,
    `- last seen: ${new Date(pattern.lastSeen).toISOString()}`,
    '',
    pattern.hint,
  ];
  if (pattern.examples.length > 0) {
    lines.push('', '### Worst examples', '');
    for (const example of pattern.examples) {
      lines.push(
        `- ${example.method} ${example.route} — ${duration(example.durationMs)}` +
          (example.costMs > 0 ? `, ${duration(example.costMs)} recoverable` : ''),
      );
    }
  }
  return lines.join('\n');
}

/** A GitHub-issue body: the markdown plus a title line to paste first. */
export function toIssue(pattern: FindingPattern): string {
  const where = pattern.callsite ? ` (${pattern.callsite.relative}:${pattern.callsite.line})` : '';
  return `${pattern.title}${where}\n\n${toMarkdown(pattern)}`;
}
