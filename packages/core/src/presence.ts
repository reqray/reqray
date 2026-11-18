/**
 * Adapter presence flag.
 *
 * Framework adapters announce themselves so the standalone mode in
 * `@reqray/register` can stand down: it exists only for applications with no
 * adapter, and recording the same request twice would be worse than either
 * record alone.
 */

import { globalBox } from './state.js';

/**
 * A framework adapter has been initialized.
 *
 * The standalone mode in `@reqray/register` checks this to stand down: an
 * adapter records the same requests with full fidelity.
 */
const adapterActive = globalBox('presence.adapterActive', false);

/** Called by every framework adapter at initialization. */
export function markAdapterActive(): void {
  adapterActive().value = true;
}

/** Whether any framework adapter has been initialized in this process. */
export function isAdapterActive(): boolean {
  return adapterActive().value;
}

/** Resets the flag. Needed by tests. */
export function resetAdapterActive(): void {
  adapterActive().value = false;
}
