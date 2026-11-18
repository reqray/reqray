/** Detector findings, grouped into patterns, and their read state. */

import type {
  Finding,
  FindingsResponse,
  NPlusOneEvidence,
  SequentialHttpEvidence,
  StoredPatternState,
} from '@reqray/protocol';
import { apiBase, getJson, sendJson } from './client';

/**
 * The detectors whose findings are a *run* of spans, which the waterfall
 * collapses into one bar. A duplicate is not a run — its spans sit far apart,
 * and one bar spanning them would swallow everything in between.
 */
export function isRunEvidence(
  evidence: Finding['evidence'],
): evidence is NPlusOneEvidence | SequentialHttpEvidence {
  return evidence.kind === 'n_plus_one' || evidence.kind === 'sequential_http';
}

/** `null` — this store cannot read its findings back. */
export async function fetchFindings(
  range?: readonly [number, number] | null,
  signal?: AbortSignal,
): Promise<FindingsResponse | null> {
  const search = range ? `?from=${Math.floor(range[0])}&to=${Math.ceil(range[1])}` : '';
  const { findings } = await getJson<{ findings: FindingsResponse | null }>(
    `${apiBase()}/findings${search}`,
    signal,
  );
  return findings;
}

/** Remembers ack/mute; `new` reopens. `fixed` is computed and cannot be set. */
export async function saveFindingState(id: string, state: StoredPatternState): Promise<void> {
  await sendJson('/findings/state', 'POST', { id, state });
}
