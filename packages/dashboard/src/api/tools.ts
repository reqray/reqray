/*
 * The three that act rather than read: replay a request, EXPLAIN a query,
 * blame a stack frame. Gated together on the server, so they sit together here.
 */

import type { BlameLine, ExplainResult, ReplayComparison } from '@reqray/protocol';
import { apiBase, sendJson } from './client';

export async function replayRequest(payload: {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<ReplayComparison> {
  return sendJson<ReplayComparison>('/replay', 'POST', payload);
}

export async function explainSpan(id: string, spanId: number): Promise<ExplainResult> {
  return sendJson<ExplainResult>('/explain', 'POST', { id, spanId });
}

/**
 * Blame for a list of frames, in the same order.
 *
 * A failure is not worth surfacing: the column simply stays empty, which is
 * also what an untracked file looks like.
 */
export async function fetchBlame(
  frames: Array<{ file: string; line: number }>,
): Promise<Array<BlameLine | null>> {
  try {
    const response = await fetch(`${apiBase()}/blame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames }),
    });
    if (!response.ok) return frames.map(() => null);
    return ((await response.json()) as { frames: Array<BlameLine | null> }).frames;
  } catch {
    return frames.map(() => null);
  }
}

/** Opens a file in the editor via its URL scheme. */
export function openInEditor(file: string, line: number): void {
  window.location.href = `vscode://file/${file}:${line}`;
}
