/**
 * The heavy-response detector.
 *
 * It names one mistake — a missing limit — and it has to tell that apart from
 * a file, which is the whole difficulty. Telling somebody their PDF download
 * is a bug is how a tool gets switched off.
 */

import { heavyResponse } from '@reqray/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = heavyResponse.defaultOptions;
const MB = 1024 * 1024;

const run = (
  scope: Parameters<typeof heavyResponse.run>[0],
  bytesOut: number | null,
  contentType: string | null = 'application/json',
) => heavyResponse.run(scope, options, { durationMs: 100, status: 200, bytesOut, contentType });

/** A query that returned a great many rows, from a known line of code. */
const bigQuery = () =>
  scenario()
    .query({ sql: 'SELECT * FROM line_items', duration: 40, callsite: 'src/export.ts:12' })
    .done();

describe('heavy response — finds', () => {
  it('a response past the megabyte', () => {
    const [finding] = run(bigQuery(), 12 * MB);

    expect(finding?.detector).toBe('heavy_response');
    expect(finding?.severity).toBe('warn');
    expect(finding?.title).toContain('12.0 MB');
  });

  it('and names the query it came out of, with its line', () => {
    const scope = scenario()
      .query({ sql: 'SELECT id FROM users', duration: 1, callsite: 'src/a.ts:1' })
      .done();
    const [finding] = run(scope, 4 * MB);

    expect(finding?.callsite?.relative).toBe('src/a.ts');
    expect(finding?.evidence).toMatchObject({
      kind: 'heavy_response',
      bytes: 4 * MB,
      sample: 'SELECT id FROM users',
    });
  });

  it('but points nowhere when several queries could have produced it', () => {
    // No driver said how many rows came back and there were three queries.
    // Picking the slowest and calling it the source would be a guess wearing
    // evidence's clothes.
    const scope = scenario()
      .query({ sql: 'SELECT * FROM a', duration: 30, callsite: 'src/a.ts:1' })
      .query({ sql: 'SELECT * FROM b', duration: 1, callsite: 'src/b.ts:2' })
      .query({ sql: 'SELECT * FROM c', duration: 1, callsite: 'src/c.ts:3' })
      .done();

    const [finding] = run(scope, 4 * MB);
    expect(finding?.callsite).toBeNull();
    expect(finding?.evidence).toMatchObject({ sample: null });
  });

  it('costs bytes, not milliseconds', () => {
    // The seconds a twelve-megabyte response spends reaching a phone are not
    // something this process measured, and inventing them would put a made-up
    // number in the one field the panel treats as measured.
    expect(run(bigQuery(), 12 * MB)[0]?.costMs).toBe(0);
  });

  it('reads text and XML as answers too, not only JSON', () => {
    expect(run(bigQuery(), 3 * MB, 'text/csv')).toHaveLength(1);
    expect(run(bigQuery(), 3 * MB, 'application/xml')).toHaveLength(1);
    expect(run(bigQuery(), 3 * MB, 'application/ld+json')).toHaveLength(1);
  });
});

describe('heavy response — does NOT find', () => {
  it('an ordinary page of results', () => {
    expect(run(bigQuery(), 40 * 1024)).toHaveLength(0);
  });

  it('a response exactly at the limit', () => {
    expect(run(bigQuery(), options.maxBytes)).toHaveLength(0);
  });

  it('a file, however large', () => {
    // A twelve-megabyte PDF is a document. A twelve-megabyte JSON document is
    // a forgotten LIMIT, and the content type is the only thing that knows.
    expect(run(bigQuery(), 12 * MB, 'application/pdf')).toHaveLength(0);
    expect(run(bigQuery(), 40 * MB, 'video/mp4')).toHaveLength(0);
    expect(run(bigQuery(), 12 * MB, 'application/octet-stream')).toHaveLength(0);
  });

  it('a response nobody labelled', () => {
    // Bytes with no type might be an export somebody meant to write.
    expect(run(bigQuery(), 12 * MB, null)).toHaveLength(0);
  });

  it('a response nothing measured', () => {
    expect(run(bigQuery(), null)).toHaveLength(0);
  });
});
