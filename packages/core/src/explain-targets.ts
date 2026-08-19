/**
 * Registry of live database pools and clients able to run EXPLAIN.
 *
 * The pg instrumentation registers whatever executed a query; the recorded
 * span carries the id, so the panel later sends EXPLAIN to the very same
 * database the query ran against. References are weak: a closed pool must be
 * collectable, and a dead entry simply means EXPLAIN is no longer available
 * for that span.
 */

import { loupeState } from './state.js';

/** The one method a target must have — both pg `Pool` and `Client` fit. */
export interface ExplainTarget {
  query(sql: string): Promise<unknown>;
}

/** Ids already assigned, so one pool registers once. */
const assigned = new WeakMap<object, number>();

/** Registers a target (idempotent) and returns its id. */
export function registerExplainTarget(target: object): number {
  const known = assigned.get(target);
  if (known !== undefined) return known;

  const state = loupeState();
  state.explainTargetSeq += 1;
  const id = state.explainTargetSeq;
  assigned.set(target, id);
  state.explainTargets.set(id, new WeakRef(target));
  return id;
}

/** The live target for an id, or `null` if it has been collected. */
export function explainTarget(id: number): ExplainTarget | null {
  const state = loupeState();
  const ref = state.explainTargets.get(id);
  if (!ref) return null;

  const target = ref.deref();
  if (!target) {
    state.explainTargets.delete(id);
    return null;
  }
  if (typeof (target as Partial<ExplainTarget>).query !== 'function') return null;
  return target as ExplainTarget;
}

/** Forgets every target. Needed by tests. */
export function resetExplainTargets(): void {
  loupeState().explainTargets.clear();
}
