/**
 * `@reqray/waterfall` — the shape of a request, before anybody draws it.
 *
 * Which spans become one bar, where the uninstrumented stretches are, how deep
 * each bar sits. Shared by the panel and the terminal client, so one request
 * cannot show a different number of bars depending on where it is read.
 *
 * Nothing about drawing: labels, colour, glyphs and bar cells stay with each
 * client, because a terminal has twenty-eight columns for a label and a
 * browser has an ellipsis. That is a difference between screens, not between
 * answers.
 *
 * Types only from `@reqray/protocol`, so this is safe in a browser bundle.
 */

import type { Finding, FindingEvidence, RecordedRequest, Span } from '@reqray/protocol';

/** What a client needs to draw a waterfall: the record, plus its wall time. */
export type WaterfallInput = Pick<RecordedRequest, 'spans' | 'findings' | 'durationMs'>;

/** One bar. `gap` is time no instrumentation covers. */
export interface WaterfallBar {
  /** Stable across rebuilds of the same request — usable as a list key. */
  readonly key: string;
  readonly kind: Span['kind'] | 'gap';
  readonly depth: number;
  /** Milliseconds from the start of the request. */
  readonly startedAt: number;
  readonly duration: number;
  /**
   * The span this bar stands for, or `null` for a gap.
   *
   * Handed over rather than reduced to a string: labelling is the client's,
   * and a model that decided it would be deciding for a terminal and a browser
   * at once.
   */
  readonly span: Span | null;
  /** How many spans collapsed into this bar. `1` for an ordinary span. */
  readonly count: number;
  /** Detector id when the bar is a collapsed run, `null` otherwise. */
  readonly finding: string | null;
  /** Detector ids that merely mark this span — duplicates, for instance. */
  readonly marks: readonly string[];
  /**
   * Milliseconds this span queued for a connection before it ran.
   *
   * Belongs on the bar rather than on a row of its own: the waterfall's job is
   * to show where the time went, and doubling the rows to say "and it waited"
   * makes that harder, not easier.
   */
  readonly waitMs: number;
}

/** Gaps shorter than this are noise, not an answer to "where did time go". */
const GAP_MIN_MS = 20;
const GAP_MIN_SHARE = 0.1;

/** Deeper than this a chain is malformed; the walk stops rather than loops. */
const MAX_DEPTH = 32;

/**
 * The detectors whose findings are a *run* of spans, which collapses into one
 * bar.
 *
 * A duplicate is not a run — its two calls sit far apart, and one bar spanning
 * them would swallow everything in between and claim the time as its own.
 */
export function isRunEvidence(evidence: FindingEvidence): boolean {
  return evidence.kind === 'n_plus_one' || evidence.kind === 'sequential_http';
}

/** How far down the span tree a span sits. */
export function depthOf(span: Span, byId: ReadonlyMap<number, Span>): number {
  let depth = 0;
  let parentId = span.parentId;
  while (parentId !== null && depth < MAX_DEPTH) {
    const parent = byId.get(parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentId;
  }
  return depth;
}

/**
 * Stretches of the request not covered by any instrumented work.
 *
 * A 600 ms request with one 2 ms query would otherwise show a full bar and no
 * explanation — the honest answer is a visible uninstrumented stretch:
 * application code, a timer, something Reqray has no instrumentation for.
 * Handler and middleware spans are containers, not work, so they do not count
 * as coverage.
 */
export function findGaps(input: WaterfallInput): Array<{ start: number; end: number }> {
  const total = input.durationMs;
  const threshold = Math.max(GAP_MIN_MS, total * GAP_MIN_SHARE);

  const intervals = input.spans
    .filter((span) => span.kind !== 'handler' && span.kind !== 'middleware')
    // A query's wait is covered time, not a gap: it is the one stretch of an
    // idle-looking request that is fully accounted for, and calling it
    // uninstrumented would hide the answer behind the word for "no answer".
    .map((span) => ({
      start: span.startedAt - (span.kind === 'db' ? (span.waitMs ?? 0) : 0),
      end: span.startedAt + span.duration,
    }))
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

/**
 * Builds the bars, in the order they start.
 *
 * Spans belonging to one run collapse into a single bar spanning the whole
 * run: forty-seven identical rows would be honest and unreadable, and the
 * point of the screen is to show where the time went.
 */
export function buildWaterfall(input: WaterfallInput): WaterfallBar[] {
  const byId = new Map(input.spans.map((span) => [span.id, span]));

  // Runs collapse into one bar; everything else only badges the spans it
  // names, so a duplicate two seconds apart does not draw a bar over
  // everything between its two calls.
  const grouped = new Map<number, Finding>();
  const marked = new Map<number, string[]>();
  for (const finding of input.findings) {
    for (const id of finding.evidence.spanIds) {
      if (isRunEvidence(finding.evidence)) grouped.set(id, finding);
      else marked.set(id, [...(marked.get(id) ?? []), finding.detector]);
    }
  }

  const bars: WaterfallBar[] = [];
  const emitted = new Set<Finding>();

  for (const span of input.spans) {
    const finding = grouped.get(span.id);

    if (!finding) {
      bars.push({
        key: `s${span.id}`,
        kind: span.kind,
        depth: depthOf(span, byId),
        startedAt: span.startedAt,
        duration: span.duration,
        span,
        count: 1,
        finding: null,
        marks: marked.get(span.id) ?? [],
        waitMs: span.kind === 'db' ? (span.waitMs ?? 0) : 0,
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
    const fingerprint =
      'fingerprint' in finding.evidence ? String(finding.evidence.fingerprint) : '';

    bars.push({
      key: `f${finding.detector}${fingerprint}`,
      kind: span.kind,
      depth: depthOf(span, byId),
      startedAt: start,
      duration: end - start,
      // The first of the run: what the group is *of*, which is what a label
      // needs. The count says how many there were.
      span,
      count: members.length,
      finding: finding.detector,
      marks: [],
      waitMs: 0,
    });
  }

  for (const gap of findGaps(input)) {
    bars.push({
      key: `g${gap.start}`,
      kind: 'gap',
      // One level in: a gap is not a root-level event, it is time inside the
      // request that nothing claimed.
      depth: 1,
      startedAt: gap.start,
      duration: gap.end - gap.start,
      span: null,
      count: 1,
      finding: null,
      marks: [],
      waitMs: 0,
    });
  }

  return bars.sort((a, b) => a.startedAt - b.startedAt);
}

/** Total uninstrumented time — what a waterfall header reports. */
export function uninstrumentedMs(bars: readonly WaterfallBar[]): number {
  let total = 0;
  for (const bar of bars) {
    if (bar.kind === 'gap') total += bar.duration;
  }
  return total;
}

/**
 * Spans whose children ran at the same time as one another.
 *
 * Worth marking wherever self time is shown: a span of 100 ms with 60 ms of
 * self time and four 40 ms children underneath looks like an arithmetic error
 * until you know the four ran together. Touching is not overlapping — one
 * query ending where the next begins is a loop, and calling that concurrency
 * would contradict what the N+1 detector says about the same spans.
 */
export function parallelSpans(spans: readonly Span[]): Set<number> {
  const children = new Map<number, Array<{ start: number; end: number }>>();
  for (const span of spans) {
    if (span.parentId === null) continue;
    const list = children.get(span.parentId) ?? [];
    list.push({ start: span.startedAt, end: span.startedAt + span.duration });
    children.set(span.parentId, list);
  }

  const parallel = new Set<number>();
  for (const [parentId, intervals] of children) {
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.start < previous.end) {
        parallel.add(parentId);
        break;
      }
    }
  }
  return parallel;
}
