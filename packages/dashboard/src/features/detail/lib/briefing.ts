/**
 * The briefing: one click turns a recorded request into markdown an assistant
 * can act on — the route, the waterfall as text, SQL groups, findings with
 * their line of code, EXPLAIN plans when already fetched, and a closing ask
 * for a patch.
 *
 * Deliberately not a chat and not an API call: the text goes to the
 * clipboard, works with any assistant and never leaves the machine by itself.
 */

import type {
  ExplainResult,
  Finding,
  RequestDetail,
  SlowCodeEvidence,
  Span,
} from '../../../api/index';
import { bytes, oneLine } from '../../../shared/format';
import { buildWaterfall } from '../../../shared/waterfall/model';

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

/**
 * Where an unaccounted stretch sits, as a line.
 *
 * A slow-code finding has no call to quote — the whole point of it is that
 * nothing ran — so what it shows is the bracket around the hole.
 */
function stretchLine(evidence: SlowCodeEvidence): string {
  const ms = `${Math.round(evidence.stretchMs)} ms`;
  if (evidence.before && evidence.after)
    return `${ms} between ${evidence.before} and ${evidence.after}`;
  if (evidence.after) return `${ms} before ${evidence.after}`;
  if (evidence.before) return `${ms} after ${evidence.before}`;
  return `${ms} with nothing instrumented around it`;
}

/**
 * The one line of evidence a finding can show.
 *
 * A budget finding has no sample call to quote — it describes the request as
 * a whole, so it reports where the time went instead.
 */
export function evidenceLine(finding: Finding): string {
  const evidence = finding.evidence;
  if (evidence.kind === 'budget') {
    return `${Math.round(evidence.durationMs)} ms total · ${Math.round(evidence.externalMs)} ms external · ${Math.round(evidence.sqlMs)} ms SQL`;
  }
  if (evidence.kind === 'heavy_response') {
    // The query, when one of them can be named; otherwise what came back.
    const rows = evidence.rows > 0 ? ` · ${evidence.rows.toLocaleString('en-US')} rows` : '';
    return evidence.sample ?? `${bytes(evidence.bytes)} of ${evidence.contentType ?? 'it'}${rows}`;
  }
  if (evidence.kind === 'transaction') {
    // The call that held the connection, when one did. Otherwise the shape of
    // the transaction itself, which is what there is to look at.
    if (evidence.sample) return evidence.sample;
    const between = evidence.closedBy ? `the ${evidence.closedBy}` : 'the end of the request';
    return `${evidence.queries} quer${evidence.queries === 1 ? 'y' : 'ies'} between BEGIN and ${between}`;
  }
  if (evidence.kind === 'slow_code') return stretchLine(evidence);
  return evidence.sample;
}

/**
 * The figure a finding shows next to its title.
 *
 * Most findings measure their damage in milliseconds this request would get
 * back. Two do not, and printing `0 ms recoverable` for them would put a lie
 * in the one field that is supposed to be measured: a response too large
 * costs bytes, and a connection held too long costs other requests their turn
 * at the pool.
 */
export function costLine(finding: Finding, durationMs: number): string {
  const evidence = finding.evidence;

  if (evidence.kind === 'heavy_response') {
    const rows = evidence.rows > 0 ? ` from ${evidence.rows.toLocaleString('en-US')} rows` : '';
    return `${bytes(evidence.bytes)}${rows}`;
  }

  if (evidence.kind === 'transaction') {
    const held = `${Math.round(evidence.heldMs)} ms holding a connection`;
    return evidence.externalMs > 0
      ? `${held} · ${Math.round(evidence.externalMs)} ms of it on a call`
      : held;
  }

  // Clamped: spans that overlap can add up to more than the wall-clock time,
  // and "112% of request time" reads as a bug rather than as a measurement.
  const share = durationMs > 0 ? Math.min(100, (finding.costMs / durationMs) * 100) : 0;
  return `${Math.round(finding.costMs)} ms recoverable · ${Math.round(share)}% of request time`;
}

export function buildBriefing(
  detail: RequestDetail,
  explains?: ReadonlyMap<number, ExplainResult>,
): string {
  const lines: string[] = [];

  lines.push(`# ${detail.method} ${detail.path} — ${detail.status}, ${ms(detail.durationMs)}`);
  lines.push('');
  lines.push(
    'A single HTTP request recorded by Reqray (a request inspector for Node.js). ' +
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
      const sample = evidenceLine(finding);
      if (sample) lines.push(`  sample: ${oneLine(sample)}`);
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
