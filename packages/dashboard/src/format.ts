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
export function ago(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s ago`;
}

/** `6m 12s` — how long the buffer has been retaining data. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

export type Tone = 's-ok' | 's-warn' | 's-err' | 's-dim' | 's-fg2' | 's-acc' | '';

export function statusTone(status: number): Tone {
  if (status >= 500) return 's-err';
  if (status >= 400) return 's-warn';
  if (status >= 300) return 's-dim';
  return 's-ok';
}

export function durationTone(ms: number): Tone {
  if (ms >= 700) return 's-err';
  if (ms >= 300) return 's-warn';
  return 's-fg2';
}

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

/** Collapses a query to a single line for the closed accordion row. */
export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
