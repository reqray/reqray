/**
 * Adapter presence flag.
 *
 * Framework adapters announce themselves so the standalone mode in
 * `@loupe/register` can stand down: it exists only for applications with no
 * adapter, and recording the same request twice would be worse than either
 * record alone.
 */

import { loupeState } from './state.js';

/** Called by every framework adapter at initialization. */
export function markAdapterActive(): void {
  loupeState().adapterActive = true;
}

/** Whether any framework adapter has been initialized in this process. */
export function isAdapterActive(): boolean {
  return loupeState().adapterActive;
}

/** Resets the flag. Needed by tests. */
export function resetAdapterActive(): void {
  loupeState().adapterActive = false;
}
