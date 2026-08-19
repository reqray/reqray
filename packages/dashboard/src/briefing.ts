/**
 * The briefing: one click turns a recorded request into markdown an assistant
 * can act on — the route, the waterfall as text, SQL groups, findings with
 * their line of code, EXPLAIN plans when already fetched, and a closing ask
 * for a patch.
 *
 * Deliberately not a chat and not an API call: the text goes to the
 * clipboard, works with any assistant and never leaves the machine by itself.
 */

import type { ExplainResult, RequestDetail, Span } from './api';
import { oneLine } from './format';
import { buildWaterfall } from './waterfall';

const MAX_TOTAL_CHARS = 16_000;
const MAX_WATERFALL_ROWS = 40;
const MAX_SQL_GROUPS = 20;
const MAX_LOG_LINES = 20;
const MAX_BODY_CHARS = 300;

function ms(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function sqlGroups(spans: readonly Span[]): string[] {
  const groups = new Map<string, { sql: string; calls: number; totalMs: number }>();
  for (const span of spans) {
    if (span.kind !== 'db') continue;
    const existing = groups.get(span.fingerprint) ?? {
      sql: oneLine(span.sql),
      calls: 0,
      totalMs: 0,
    };
    existing.calls += 1;
    existing.totalMs += span.duration;
    groups.set(span.fingerprint, existing);
  }
  return [...groups.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, MAX_SQL_GROUPS)
    .map((group) => `- ${group.calls}× (${ms(group.totalMs)}) ${group.sql}`);
}

function bodyLine(name: string, body: RequestDetail['requestBody']): string | null {
  if (!body) return null;
  const text =
    body.text.length > MAX_BODY_CHARS ? `${body.text.slice(0, MAX_BODY_CHARS)}…` : body.text;
  return `${name} (${body.text.length} chars${body.truncated ? ', truncated at capture' : ''}): ${text}`;
}

/** Builds the markdown briefing for one recorded request. */
export function buildBriefing(
  detail: RequestDetail,
  explains?: ReadonlyMap<number, ExplainResult>,
): string {
  const lines: string[] = [];

  lines.push(`# ${detail.method} ${detail.path} — ${detail.status}, ${ms(detail.durationMs)}`);
  lines.push('');
  lines.push(
    'A single HTTP request recorded by Loupe (a request inspector for Node.js). ' +
      'Work out what makes it slow.',
  );
  lines.push('');

  if (detail.findings.length > 0) {
    lines.push('## Detector findings');
    for (const finding of detail.findings) {
      lines.push(`- [${finding.detector}] ${finding.title} — ~${ms(finding.costMs)} recoverable`);
      if (finding.callsite) {
        lines.push(`  code line: ${finding.callsite.relative}:${finding.callsite.line}`);
      }
      lines.push(`  sample: ${oneLine(finding.evidence.sample)}`);
      lines.push(`  hint: ${finding.hint}`);
    }
    lines.push('');
  }

  const bars = buildWaterfall(detail);
  lines.push(`## Waterfall (${detail.spans.length} spans)`);
  for (const bar of bars.slice(0, MAX_WATERFALL_ROWS)) {
    const pad = '  '.repeat(bar.depth);
    lines.push(`- ${pad}${oneLine(bar.label)} — ${ms(bar.duration)} @ +${ms(bar.startedAt)}`);
  }
  if (bars.length > MAX_WATERFALL_ROWS) {
    lines.push(`- … ${bars.length - MAX_WATERFALL_ROWS} more rows`);
  }
  lines.push('');

  const groups = sqlGroups(detail.spans);
  if (groups.length > 0) {
    lines.push('## SQL by group');
    lines.push(...groups);
    lines.push('');
  }

  if (explains && explains.size > 0) {
    lines.push('## EXPLAIN plans');
    for (const explain of explains.values()) {
      lines.push(`- query: ${oneLine(explain.sql)}`);
      for (const node of explain.nodes) {
        lines.push(
          `  ${'  '.repeat(node.depth)}${node.label}` +
            (node.rows !== null ? ` rows≈${node.rows}` : ''),
        );
      }
      for (const note of explain.notes) lines.push(`  ! ${note.message}`);
    }
    lines.push('');
  }

  if (detail.logs.length > 0) {
    lines.push('## Request log');
    for (const entry of detail.logs.slice(-MAX_LOG_LINES)) {
      lines.push(`- [${entry.level}] +${ms(entry.at)} ${entry.message}`);
    }
    lines.push('');
  }

  const request = bodyLine('Request body', detail.requestBody);
  const response = bodyLine('Response body', detail.responseBody);
  if (request || response) {
    lines.push('## Bodies (after masking)');
    if (request) lines.push(request);
    if (response) lines.push(response);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    'Propose a minimal patch: name the file and line, show the code before and after. ' +
      'If the problem is calls in a loop — rewrite them as a single query or Promise.all.',
  );

  const text = lines.join('\n');
  return text.length > MAX_TOTAL_CHARS ? `${text.slice(0, MAX_TOTAL_CHARS)}\n… [truncated]` : text;
}
