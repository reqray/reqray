/* Formatting rules from the design spec, kept in one place so the list,
 * the detail screen and the replay comparison cannot drift apart. */

/** `4.2 ms` under ten milliseconds, `1,284 ms` above. */
export function duration(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms).toLocaleString('en-US')} ms`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** `HH:MM:SS.mmm` — the clock column of the request list. */
export function clock(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(
    at.getMilliseconds(),
    3,
  )}`;
}

/** `12s ago`, `1m 04s ago` — the last-seen column of exception groups. */
/** A size, as a card prints it: `4.1 MB`, `512 KB`. */
export function bytes(value: number): string {
  return value > 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(value / 1024)} KB`;
}

export function ago(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s ago`;

  // Past an hour the seconds stop being information. A git blame line and the
  // oldest day in a week of history are both read here, and "10080m ago" is
  // not something anyone converts in their head.
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ${hours % 24}h ago` : `${Math.floor(days / 30)}mo ago`;
}

/** `6m 12s` — how long the buffer has been retaining data. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

export type Tone = 's-ok' | 's-warn' | 's-err' | 's-dim' | 's-fg2' | 's-acc' | '';

/**
 * The accents the CSS reads off `data-tone`, as opposed to the text classes
 * above. A marker, a swatch and a bar all speak this vocabulary.
 */
export type Accent = 'err' | 'warn' | 'acc';

/** A detector's thresholds as one line; `off` when it is not running at all. */
export function detectorOptions(options: Record<string, number | boolean | string> | null): string {
  if (!options) return 'off';
  return Object.entries(options)
    .map(([name, value]) => `${name} ${value}`)
    .join(' · ');
}

export function statusTone(status: number): Tone {
  if (status >= 500) return 's-err';
  if (status >= 400) return 's-warn';
  if (status >= 300) return 's-dim';
  return 's-ok';
}

export function durationTone(ms: number): Tone {
  if (ms >= DURATION_ERR_MS) return 's-err';
  if (ms >= DURATION_WARN_MS) return 's-warn';
  return 's-fg2';
}

/** Where the number turns amber, and where it turns red. */
const DURATION_WARN_MS = 300;
const DURATION_ERR_MS = 700;

/**
 * The same duration as a bar's accent.
 *
 * Its own thresholds, and lower than the number's: the bar is one of a column
 * of bars, read against its neighbours rather than on its own.
 */
export function durationFill(ms: number): Accent | undefined {
  if (ms >= FILL_ERR_MS) return 'err';
  if (ms >= FILL_WARN_MS) return 'warn';
  return undefined;
}

const FILL_WARN_MS = 200;
const FILL_ERR_MS = 500;

export function methodTone(method: string): Tone {
  switch (method.toUpperCase()) {
    case 'GET':
      return 's-fg2';
    case 'POST':
      return 's-acc';
    case 'DELETE':
      return 's-err';
    default:
      return '';
  }
}

/** Colour of a waterfall bar, by span kind. */
export function spanColor(kind: string): string {
  switch (kind) {
    case 'handler':
      return 'var(--acc)';
    case 'db':
      return 'var(--ok)';
    case 'http':
      return 'var(--warn)';
    case 'cache':
      return 'var(--fg2)';
    default:
      return 'var(--fg3)';
  }
}

/**
 * One cache call as a line: `HGET user:1 email`.
 *
 * The command is what the driver sent. A source that knows no command falls
 * back to the operation, which is all there is to say about it.
 */
export function cacheCall(span: {
  command: string | null;
  operation: string;
  key: string;
}): string {
  return `${span.command ?? `cache.${span.operation}`} ${span.key}`.trimEnd();
}

/** Collapses a query to a single line for the closed accordion row. */
export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
