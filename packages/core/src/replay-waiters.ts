/**
 * Where a replayed request's record is delivered.
 *
 * A replay runs through the application like any other request, so it is
 * recorded like any other request — and it must not appear in the shared list,
 * because nobody made it. The panel marks it with a header, the adapter puts
 * the marker on the scope, and when the request finishes its record goes to
 * whoever started the replay instead of to the store.
 *
 * The registry sits between the two: `reqray.ts` writes into it on the
 * recording path, `panel/replay.ts` reads from it, and neither imports the
 * other. The one piece of state both entry points share.
 */

import { globalSlot } from './state.js';
import type { RecordedRequest } from './types.js';

/** Replays in flight, by the id the panel put on the request. */
const waiters = globalSlot(
  'replay.waiters',
  () => new Map<string, (request: RecordedRequest) => void>(),
);

/** Registers interest in a replay's record. Returns the way to stop waiting. */
export function awaitReplay(id: string, deliver: (request: RecordedRequest) => void): () => void {
  waiters().set(id, deliver);
  return () => {
    waiters().delete(id);
  };
}

/**
 * Hands a finished replay to whoever asked for it.
 *
 * @returns whether anybody was waiting — `false` means the record belongs in
 * the store after all, which is what happens when a replay times out and its
 * response arrives anyway.
 */
export function deliverReplay(id: string, request: RecordedRequest): boolean {
  const waiter = waiters().get(id);
  if (!waiter) return false;
  waiter(request);
  return true;
}
