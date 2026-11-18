/**
 * The panel API, as a client sees it.
 *
 * One endpoint, one response type. What the server needs to *produce* these —
 * stores, filters, cursors — stays in `@reqray/core`: a client has no use for
 * it and should not have to compile it.
 */

import type { RecordedRequest } from './record.js';

/** A list row — exactly what a request table shows, and nothing heavier. */
export interface RequestRow {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly query: string | null;
  /** The path with its variable segments collapsed (`/api/orders/:id`). */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly sqlCount: number;
  /** Outgoing HTTP calls — what "slow, and it called someone" is made of. */
  readonly httpCount: number;
  readonly nPlusOne: boolean;
  /** How many findings the detectors produced. */
  readonly findingCount: number;
  /** The detector behind the costliest finding, for the flag in the list. */
  readonly flag: string | null;
  readonly hasError: boolean;
  /**
   * Processor time in the request's window, ms, or `null` when unmeasured.
   *
   * On the row rather than only on the record because the whole point of it
   * is to be visible while scanning: duration alone cannot tell an expensive
   * request from a patient one.
   */
  readonly cpuMs: number | null;
  /**
   * Of the wall clock, how much of it was spent on a processor.
   *
   * Above `1` when more than one thread worked for the request; a client
   * clamps the bar it draws, never the number it prints.
   */
  readonly cpuShare: number | null;
  /** Held past its turn in the ring buffer, and exempt from filters. */
  readonly pinned: boolean;
  /** The test that issued the request, or `null` for ordinary traffic. */
  readonly test: string | null;
}

/** Numbers for a status bar: over the whole store, not over the page. */
export interface RequestSummary {
  readonly shown: number;
  readonly total: number;
  readonly slow: number;
  readonly errors: number;
  readonly withFindings: number;
}

/** `GET /api/requests` — one page of the list. */
export interface RequestsResponse {
  readonly requests: readonly RequestRow[];
  readonly summary: RequestSummary;
  /** Feed back as `cursor` for the next page. `null` — the end. */
  readonly nextCursor: string | null;
}

/**
 * `GET /api/requests/:id` — one request, whole.
 *
 * The row fields travel with the record: a client that has a row on screen
 * must not have to recompute `route` or `sqlCount` to render the detail.
 */
export type RequestDetail = RequestRow & RecordedRequest;

/**
 * How one call compares against other calls of the same route.
 *
 * A duration on its own means nothing: 400 ms is alarming for a cache read
 * and excellent for a report. The only baseline worth comparing against is
 * the route's own history.
 */
export interface DurationBaseline {
  readonly method: string;
  readonly route: string;
  /** Comparable calls the numbers rest on — this one is not among them. */
  readonly samples: number;
  /** The stretch of time those calls cover, ms. */
  readonly windowMs: number;
  readonly avgMs: number;
  /**
   * `null` below the sample count at which a p95 means anything.
   *
   * A ninety-fifth percentile of five calls is one call wearing a statistic's
   * name, and a client is better told there isn't one than handed it.
   */
  readonly p95Ms: number | null;
  /** The median — honest at far smaller samples than the tails. */
  readonly p50Ms: number;
  /** `null` under the same rule as p95: a tail needs samples to be a tail. */
  readonly p99Ms: number | null;
  /** The slowest comparable call — what the rail's strip is scaled to. */
  readonly maxMs: number;
  /** Never `slower` without a p95 to be slower than. */
  readonly verdict: 'faster' | 'typical' | 'slower';
}

/** One half of a host-pressure comparison. */
export interface HostPressureSide {
  readonly calls: number;
  readonly p95Ms: number;
  readonly avgMs: number;
}

/**
 * What the route looked like when the process was struggling.
 *
 * A route's own calls, split by whether the event loop was in its own top
 * quartile at the time. Evidence that the two moved together — not proof that
 * one caused the other, which is why both halves travel with it.
 */
export interface HostPressure {
  /** Which host metric was tested. Only the event loop, for now. */
  readonly metric: 'loop';
  /** The top-quartile boundary, ms — printed, so the claim can be checked. */
  readonly cutoffMs: number;
  /** How many times slower the elevated half's p95 was. */
  readonly ratio: number;
  /** Share of calls that landed in the elevated half, percent. */
  readonly share: number;
  readonly elevated: HostPressureSide;
  readonly normal: HostPressureSide;
}

/**
 * `GET /api/requests/:id/baseline`.
 *
 * `null` when there is nothing to compare against: fewer than two other calls
 * to the route, or a store that cannot answer the question. Absence is an
 * ordinary answer here, not an error.
 */
export interface BaselineResponse {
  readonly baseline: DurationBaseline | null;
  /**
   * Whether this route is slower when the host is under strain.
   *
   * `null` far more often than not: it takes forty measured calls, a loop
   * that actually varied, and a difference worth a sentence.
   */
  readonly pressure: HostPressure | null;
}

/**
 * Operating mode.
 *
 * It is a wire value as much as a setting: the panel reports the mode the
 * process is running in, and what it may offer depends on it.
 */
export type ReqrayMode = 'development' | 'production';

/** `GET /api/meta` — what the process behind the panel is. */
export interface PanelMeta {
  readonly pid: number;
  /** When the process started, epoch ms. */
  readonly startedAt: number;
  readonly mode: ReqrayMode;
  /** How many requests the store keeps. */
  readonly bufferSize: number;
  readonly replayEnabled: boolean;
  readonly blameEnabled: boolean;
  /**
   * Every detector this process knows, with its resolved thresholds.
   *
   * `options` is `null` for a detector somebody turned off. What the findings
   * tab shows when it has nothing to show — an empty work list must say what
   * was looking, or it reads as "the code is clean" when the detector that
   * would have said otherwise was disabled.
   */
  readonly detectors: readonly DetectorSetting[];
}

/** One detector, as `/api/meta` reports it. */
export interface DetectorSetting {
  readonly id: string;
  readonly enabled: boolean;
  /** The resolved thresholds it runs with, or `null` when disabled. */
  readonly options: Record<string, number | boolean | string> | null;
}

/**
 * How every endpoint reports a refusal.
 *
 * One sentence addressed to a person: the panel answers browsers and command
 * lines, and neither has anywhere to put an error code.
 */
export interface ApiError {
  readonly error: string;
}

/** How the list may be sorted. */
export type RequestSort = 'recent' | 'slowest';
