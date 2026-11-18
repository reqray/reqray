/** The replay drawer's plumbing: its phases, and the editable header text. */

import type { RequestDetail } from '../../../api/index';

export type Phase = 'idle' | 'pending' | 'done' | 'failed';

/** The line under the button: where the replay is, or what it costs to run one. */
export function noteOf(phase: Phase, error: string | null): string {
  if (phase === 'pending') return 'sending…';
  if (phase === 'done') return 'replayed · not recorded in the list';
  if (phase === 'failed') return error ?? 'replay failed';
  return 'runs through the same middleware stack';
}

/** Headers worth offering for editing; the rest is noise in a small textarea. */
const EDITABLE_HEADERS = ['authorization', 'x-request-id', 'accept', 'content-type'];

export function initialHeaders(detail: RequestDetail): string {
  const picked = Object.entries(detail.requestHeaders).filter(([key]) =>
    EDITABLE_HEADERS.includes(key.toLowerCase()),
  );
  return picked.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    // A masked value would be replayed literally as `[redacted]`; dropping it
    // sends the request without the header, which is at least honest.
    const value = line.slice(at + 1).trim();
    if (key && value && value !== '[redacted]') out[key] = value;
  }
  return out;
}
