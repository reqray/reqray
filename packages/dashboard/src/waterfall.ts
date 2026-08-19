import { type Finding, isRunEvidence, type RequestDetail, type Span } from './api';
import { oneLine } from './format';

/** One bar of the waterfall. `gap` is time no instrumentation covers. */
export interface WaterfallBar {
  key: string;
  kind: Span['kind'] | 'gap';
  label: string;
  depth: number;
  startedAt: number;
  duration: number;
  /** Detector id when the bar is a collapsed finding run, `null` otherwise. */
  finding: string | null;
  /** Detector ids that merely mark this span — duplicates, for instance. */
  readonly marks?: readonly string[];
}

/** Gaps shorter than this are noise, not an answer to "where did time go". */
const GAP_MIN_MS = 20;
const GAP_MIN_SHARE = 0.1;

/**
 * Stretches of the request not covered by any instrumented work.
 *
 * A 600 ms request with one 2 ms query would otherwise show a full bar and no
 * explanation — the honest answer is a visible "uninstrumented" stretch:
 * application code, timers, awaiting something Loupe has no instrumentation
 * for. Handler and middleware spans are containers, not work, so they do not
 * count as coverage.
 */
function findGaps(detail: RequestDetail): Array<{ start: number; end: number }> {
  const total = detail.durationMs;
  const threshold = Math.max(GAP_MIN_MS, total * GAP_MIN_SHARE);

  const intervals = detail.spans
    .filter((span) => span.kind !== 'handler' && span.kind !== 'middleware')
    .map((span) => ({ start: span.startedAt, end: span.startedAt + span.duration }))
    .sort((a, b) => a.start - b.start);

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start - cursor >= threshold) gaps.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (total - cursor >= threshold) gaps.push({ start: cursor, end: total });
  return gaps;
}

function labelOf(span: Span): string {
  switch (span.kind) {
    case 'db':
      return oneLine(span.sql);
    case 'http':
      return `${span.method} ${span.url}`;
    case 'cache':
      return `cache.${span.operation} ${span.key}`;
    default:
      return span.label;
  }
}

function depthOf(span: Span, byId: Map<number, Span>): number {
  let depth = 0;
  let parentId = span.parentId;
  // Bounded by the span count; a malformed chain cannot loop forever.
  while (parentId !== null && depth < 32) {
    const parent = byId.get(parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentId;
  }
  return depth;
}

/**
 * Builds the waterfall rows.
 *
 * Spans belonging to one N+1 finding collapse into a single `47× SELECT …`
 * bar spanning the whole run. Forty-seven identical rows would be honest and
 * unreadable; the point of the screen is to show where the time went.
 */
export function buildWaterfall(detail: RequestDetail): WaterfallBar[] {
  const byId = new Map(detail.spans.map((span) => [span.id, span]));
  // Runs collapse into one bar; everything else only badges the spans it
  // names, so a duplicate two seconds apart does not draw a bar over
  // everything between its two calls.
  const grouped = new Map<number, Finding>();
  const marked = new Map<number, string[]>();
  for (const finding of detail.findings) {
    for (const id of finding.evidence.spanIds) {
      if (isRunEvidence(finding.evidence)) grouped.set(id, finding);
      else marked.set(id, [...(marked.get(id) ?? []), finding.detector]);
    }
  }

  const bars: WaterfallBar[] = [];
  const emitted = new Set<Finding>();

  for (const span of detail.spans) {
    const finding = grouped.get(span.id);
    if (!finding) {
      const marks = marked.get(span.id);
      bars.push({
        key: `s${span.id}`,
        kind: span.kind,
        label: labelOf(span),
        depth: depthOf(span, byId),
        startedAt: span.startedAt,
        duration: span.duration,
        finding: null,
        ...(marks ? { marks } : {}),
      });
      continue;
    }

    if (emitted.has(finding)) continue;
    emitted.add(finding);

    const members = finding.evidence.spanIds
      .map((id) => byId.get(id))
      .filter((member): member is Span => member !== undefined);
    if (members.length === 0) continue;

    const start = Math.min(...members.map((member) => member.startedAt));
    const end = Math.max(...members.map((member) => member.startedAt + member.duration));

    bars.push({
      key: `f${finding.detector}${isRunEvidence(finding.evidence) ? finding.evidence.fingerprint : ''}`,
      kind: span.kind,
      label: `${members.length}× ${labelOf(span)}`,
      depth: depthOf(span, byId),
      startedAt: start,
      duration: end - start,
      finding: finding.detector,
    });
  }

  for (const gap of findGaps(detail)) {
    bars.push({
      key: `g${gap.start}`,
      kind: 'gap',
      label: 'uninstrumented — app code or waiting',
      depth: 1,
      startedAt: gap.start,
      duration: gap.end - gap.start,
      finding: null,
    });
  }

  return bars.sort((a, b) => a.startedAt - b.startedAt);
}

/** Total uninstrumented time — what the waterfall header reports. */
export function uninstrumentedMs(bars: readonly WaterfallBar[]): number {
  let total = 0;
  for (const bar of bars) {
    if (bar.kind === 'gap') total += bar.duration;
  }
  return total;
}
