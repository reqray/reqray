import type { SeriesMetric } from '../../../api/index';
import { bytes, duration } from '../../../shared/format';

export const HOUR = 60 * 60 * 1000;

export const DAY = 24 * HOUR;

export interface MetricInfo {
  readonly label: string;
  readonly format: (value: number) => string;
  /**
   * Metrics worth putting on the same chart as this one.
   *
   * Not every pairing: two lines that share no story are two charts drawn on
   * top of each other. Latency against how far behind the event loop was is a
   * question; latency against response size is a coincidence.
   */
  readonly companions: readonly SeriesMetric[];
}

export const share = (value: number) => `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;

export const per = (value: number) => value.toFixed(value < 10 ? 1 : 0);

export const METRICS: Record<SeriesMetric, MetricInfo> = {
  p50: { label: 'p50 latency', format: duration, companions: ['throughput', 'loopDelay'] },
  p95: { label: 'p95 latency', format: duration, companions: ['throughput', 'loopDelay'] },
  p99: { label: 'p99 latency', format: duration, companions: ['throughput', 'loopDelay'] },
  throughput: {
    label: 'throughput',
    format: (value) => `${per(value)}/min`,
    companions: ['errorRate', 'p95'],
  },
  errorRate: { label: 'error rate', format: share, companions: ['throughput', 'p95'] },
  sqlPerRequest: {
    label: 'queries per request',
    format: per,
    companions: ['p95', 'throughput'],
  },
  httpPerRequest: {
    label: 'outgoing calls per request',
    format: per,
    companions: ['p95', 'throughput'],
  },
  bytes: { label: 'response size', format: bytes, companions: ['throughput', 'p95'] },
  loopDelay: { label: 'event-loop delay', format: duration, companions: ['p95', 'throughput'] },
  findingsPerRequest: {
    label: 'findings per request',
    format: per,
    companions: ['throughput', 'p95'],
  },
};

export const ORDER: readonly SeriesMetric[] = [
  'p50',
  'p95',
  'p99',
  'throughput',
  'errorRate',
  'loopDelay',
  'sqlPerRequest',
  'httpPerRequest',
  'bytes',
  'findingsPerRequest',
];

export type PeriodName = 'hour' | 'today' | 'week' | 'all';

export const PERIODS: Array<[PeriodName, string]> = [
  ['hour', 'last hour'],
  ['today', 'today'],
  ['week', '7 days'],
  ['all', 'everything'],
];

export interface Window {
  readonly from: number;
  readonly to: number;
}

/**
 * The period as epoch milliseconds, computed at the moment it is picked.
 *
 * At the moment and not on every render, which is the bug this replaces:
 * derived from `Date.now()` in render, the window moved by a few milliseconds
 * every time the component drew, the fetch effect saw a changed input and
 * asked again, the answer caused a render, and the screen sat in a loop of
 * its own making — flickering "reading the period…" forever.
 */
export function windowFor(period: PeriodName, stored: Window | null): Window {
  const now = Date.now();
  switch (period) {
    case 'hour':
      return { from: now - HOUR, to: now };
    case 'today': {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return { from: midnight.getTime(), to: now };
    }
    case 'week':
      return { from: now - 7 * DAY, to: now };
    default:
      // Everything, as the store reports its own range. Falling back to a day
      // rather than to the epoch: a chart from 1970 is not a wider answer, it
      // is an unreadable one.
      return stored ?? { from: now - DAY, to: now };
  }
}
