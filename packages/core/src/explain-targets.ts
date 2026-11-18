/**
 * Registry of live database pools and clients able to run EXPLAIN.
 *
 * The pg instrumentation registers whatever executed a query; the recorded
 * span carries the id, so the panel later sends EXPLAIN to the very same
 * database the query ran against. References are weak: a closed pool must be
 * collectable, and a dead entry simply means EXPLAIN is no longer available
 * for that span.
 */

import { type Box, globalBox, globalSlot } from './state.js';

/** The one method a target must have — both pg `Pool` and `Client` fit. */
export interface ExplainTarget {
  query(sql: string): Promise<unknown>;
}

/**
 * Ids already assigned, so one pool registers once.
 *
 * Must share a slot with the counter that feeds it: split across two module
 * copies, one pool takes two ids from one sequence and `explainTarget(id)`
 * resolves to the wrong pool.
 */
const assigned = globalSlot('explain.assigned', () => new WeakMap<object, number>());

/** Live targets, weakly held: a closed pool must stay collectable. */
const targets = globalSlot('explain.targets', () => new Map<number, WeakRef<object>>());

/** Id source for {@link targets}. */
const sequence: () => Box<number> = globalBox('explain.sequence', 0);

/** Registers a target (idempotent) and returns its id. */
export function registerExplainTarget(target: object): number {
  const ids = assigned();
  const known = ids.get(target);
  if (known !== undefined) return known;

  const seq = sequence();
  seq.value += 1;
  ids.set(target, seq.value);
  targets().set(seq.value, new WeakRef(target));
  return seq.value;
}

/** The live target for an id, or `null` if it has been collected. */
export function explainTarget(id: number): ExplainTarget | null {
  const live = targets();
  const ref = live.get(id);
  if (!ref) return null;

  const target = ref.deref();
  if (!target) {
    live.delete(id);
    return null;
  }
  if (typeof (target as Partial<ExplainTarget>).query !== 'function') return null;
  return target as ExplainTarget;
}

/** Forgets every target. Needed by tests. */
export function resetExplainTargets(): void {
  targets().clear();
}
