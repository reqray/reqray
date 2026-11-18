/**
 * The suggested-fix template.
 *
 * One rule above all: no confident template, no diff. A fabricated rewrite
 * is worse than the sentence and the prompt — the same false-positive law
 * the detectors live under, applied to fixes.
 */

import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/api/index';
import { suggestedFix } from '../src/features/detail/lib/fix';

function nPlusOne(sample: string, over: Partial<Finding> = {}): Finding {
  return {
    detector: 'n_plus_one',
    severity: 'warn',
    title: '150 identical queries ran in a loop',
    costMs: 24,
    callsite: null,
    evidence: {
      kind: 'n_plus_one',
      repeats: 150,
      fingerprint: sample.replace(/\$\d+/g, '?'),
      sample,
      totalMs: 30,
      spanIds: [],
    },
    hint: 'fetch them in one query',
    ...over,
  };
}

describe('the N+1 template on pg', () => {
  it('turns the trailing equality into ANY', () => {
    const fix = suggestedFix(
      nPlusOne('SELECT id, title, price FROM line_items WHERE order_id = $1'),
    );

    expect(fix?.removed).toEqual(['SELECT id, title, price FROM line_items WHERE order_id = $1']);
    expect(fix?.added).toEqual([
      'SELECT id, title, price FROM line_items WHERE order_id = ANY($1)',
    ]);
    expect(fix?.note).toContain('1 query instead of 150');
    expect(fix?.note).toContain('order_id');
  });

  it('keeps a compound WHERE, transforming only the last equality', () => {
    const fix = suggestedFix(
      nPlusOne('SELECT * FROM items WHERE deleted = false AND owner_id = $2'),
    );

    expect(fix?.added).toEqual([
      'SELECT * FROM items WHERE deleted = false AND owner_id = ANY($2)',
    ]);
  });

  it('declines an ORDER BY tail — per-group order is not global order', () => {
    expect(
      suggestedFix(nPlusOne('SELECT * FROM items WHERE owner_id = $1 ORDER BY created_at')),
    ).toBeNull();
    expect(suggestedFix(nPlusOne('SELECT * FROM items WHERE owner_id = $1 LIMIT 5'))).toBeNull();
  });

  it('declines placeholders it does not know', () => {
    expect(suggestedFix(nPlusOne('SELECT * FROM items WHERE owner_id = ?'))).toBeNull();
  });

  it('declines anything that is not a SELECT, and any other detector', () => {
    expect(suggestedFix(nPlusOne('UPDATE items SET seen = true WHERE id = $1'))).toBeNull();
    expect(
      suggestedFix(
        nPlusOne('SELECT * FROM items WHERE owner_id = $1', { detector: 'sequential_http' }),
      ),
    ).toBeNull();
  });
});
