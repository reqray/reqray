/**
 * How a cache call reads on screen.
 *
 * The command is part of the identity, not decoration: `HGET user:1 email`
 * and `HGET user:1 plan` are two different reads, and the panel must not put
 * them on one row or mark them as a duplicate of each other.
 */

import { describe, expect, it } from 'vitest';
import type { RequestDetail, Span } from '../src/api/index';
import { buildComparison } from '../src/features/compare/lib/compare';
import { cacheCall } from '../src/shared/format';
import { labelOf } from '../src/shared/waterfall/model';

let id = 0;

function cache(over: { command?: string | null; operation?: string; key: string }): Span {
  return {
    id: ++id,
    parentId: null,
    startedAt: 0,
    duration: 0.4,
    callsite: null,
    error: null,
    kind: 'cache',
    operation: over.operation ?? 'get',
    command: over.command === undefined ? 'GET' : over.command,
    key: over.key,
    hit: true,
  } as Span;
}

const detail = (spans: Span[]) => ({ spans }) as unknown as RequestDetail;

describe('a cache call as a line', () => {
  it('reads as the driver sent it', () => {
    expect(cacheCall({ command: 'HGET', operation: 'get', key: 'user:1 email' })).toBe(
      'HGET user:1 email',
    );
  });

  it('falls back to the operation for a source with no command', () => {
    expect(cacheCall({ command: null, operation: 'get', key: 'user:1' })).toBe('cache.get user:1');
  });

  it('leaves no trailing space when there is no key to show', () => {
    expect(cacheCall({ command: 'PING', operation: 'other', key: '' })).toBe('PING');
  });

  it('labels the waterfall bar with the same line', () => {
    expect(labelOf(cache({ command: 'HGETALL', key: 'user:1' }))).toBe('HGETALL user:1');
  });
});

describe('comparing cache calls', () => {
  it('pairs the same read across two requests', () => {
    const rows = buildComparison(
      detail([cache({ key: 'user:1' })]),
      detail([cache({ key: 'user:1' })]),
    );
    const row = rows.find((entry) => entry.kind === 'cache');

    expect(row?.label).toBe('GET user:1');
    expect(row?.a.calls).toBe(1);
    expect(row?.b.calls).toBe(1);
  });

  it('keeps two reads of different fields apart', () => {
    const rows = buildComparison(
      detail([cache({ command: 'HGET', key: 'user:1 email' })]),
      detail([cache({ command: 'HGET', key: 'user:1 plan' })]),
    );

    expect(rows.filter((entry) => entry.kind === 'cache')).toHaveLength(2);
  });
});
