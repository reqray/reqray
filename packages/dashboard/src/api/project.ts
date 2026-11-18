/** What the process is, what it holds, and what it threw. */

import type { ExceptionGroup, PanelMeta, ProjectReport, RetentionLimits } from '@reqray/protocol';
import { apiBase, getJson, sendJson } from './client';

export async function fetchMeta(signal?: AbortSignal): Promise<PanelMeta> {
  return getJson(`${apiBase()}/meta`, signal);
}

export async function fetchProject(signal?: AbortSignal): Promise<ProjectReport> {
  return getJson(`${apiBase()}/project`, signal);
}

/**
 * Changes how long requests are kept.
 *
 * The one setting the panel writes rather than reports. The server checks the
 * numbers again — this is a browser, and a browser is not a source of truth.
 */
export async function saveRetention(
  patch: Partial<RetentionLimits>,
  signal?: AbortSignal,
): Promise<RetentionLimits> {
  const payload = await sendJson<{ limits?: RetentionLimits }>('/retention', 'POST', patch, signal);
  if (!payload.limits) throw new Error('the panel answered without the new limits');
  return payload.limits;
}

export async function fetchExceptions(signal?: AbortSignal): Promise<ExceptionGroup[]> {
  const payload = await getJson<{ groups: ExceptionGroup[] }>(`${apiBase()}/exceptions`, signal);
  return payload.groups;
}
