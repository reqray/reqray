/**
 * The search field's grammar.
 *
 * Two promises carry it: a word that is a token narrows the filter, and a
 * word that is not one stays free text — a URL with a colon in it must keep
 * matching paths, or the box broke the thing it always did.
 */

import { describe, expect, it } from 'vitest';
import { apiQueryOf, parseQuery } from '../src/shared/list/tokens';

describe('tokens narrow, text stays text', () => {
  it('an ordinary query is all text', () => {
    const parsed = parseQuery('orders 500');

    expect(parsed.text).toBe('orders 500');
    expect(parsed.status).toBeNull();
    expect(parsed.methods).toEqual([]);
  });

  it('reads status classes and exact codes apart', () => {
    expect(parseQuery('status:5xx').statusClasses).toEqual([5]);
    expect(parseQuery('status:404').status).toBe(404);
    // Half-typed excludes nothing — the reader is mid-word.
    const half = parseQuery('status:4');
    expect(half.status).toBeNull();
    expect(half.statusClasses).toEqual([]);
  });

  it('reads methods, upper-cased, in lists', () => {
    expect(parseQuery('method:get,post').methods).toEqual(['GET', 'POST']);
    expect(parseQuery('method:teapot').methods).toEqual([]);
  });

  it('reads durations in either unit, keeping the stricter of two', () => {
    expect(parseQuery('>100ms').minDurationMs).toBe(100);
    expect(parseQuery('>1.5s').minDurationMs).toBe(1500);
    expect(parseQuery('>100ms >2s').minDurationMs).toBe(2000);
    // A bare `>` or a word after it is not a duration.
    expect(parseQuery('>fast').minDurationMs).toBeNull();
    expect(parseQuery('>fast').text).toBe('>fast');
  });

  it('reads sql>N as "more than", not "at least"', () => {
    expect(parseQuery('sql>10').minSql).toBe(11);
  });

  it('maps has: onto the detectors, n+1 through the findings', () => {
    expect(parseQuery('has:n+1').nPlusOne).toBe(true);
    expect(parseQuery('has:seq').flagged).toEqual(['sequential_http']);
    expect(parseQuery('has:dup').flagged).toEqual(['dup_http', 'dup_cache']);
    expect(parseQuery('has:findings').onlyFindings).toBe(true);
    expect(parseQuery('has:error').onlyErrors).toBe(true);
    // An unknown kind excludes nothing rather than everything.
    expect(parseQuery('has:gremlins')).toMatchObject({ flagged: [], onlyFindings: false });
  });

  it('reads test: bare as "any test", and with a word as a name', () => {
    expect(parseQuery('test:').test).toBe('');
    expect(parseQuery('test:orders.spec').test).toBe('orders.spec');
    expect(parseQuery('slow test:orders').text).toBe('slow');
  });

  it('keeps a path with a colon in it as free text', () => {
    // `localhost:3000` is not a token; only the known prefixes are.
    expect(parseQuery('localhost:3000').text).toBe('localhost:3000');
  });

  it('composes tokens and text in one query', () => {
    const parsed = parseQuery('checkout status:5xx >100ms method:post');

    expect(parsed.text).toBe('checkout');
    expect(parsed.statusClasses).toEqual([5]);
    expect(parsed.minDurationMs).toBe(100);
    expect(parsed.methods).toEqual(['POST']);
  });
});

describe('what goes to the server', () => {
  it('sends the unfolded tokens, never the raw string', () => {
    const query = apiQueryOf(parseQuery('checkout status:5xx sql>10 test:'));

    expect(query).toMatchObject({
      q: 'checkout',
      statusClasses: [5],
      minSql: 11,
      onlyTests: true,
    });
    expect(query.test).toBeUndefined();
  });

  it('sends nothing for an empty query', () => {
    const query = apiQueryOf(parseQuery(''));

    expect(query.q).toBeUndefined();
    expect(query.methods).toBeUndefined();
    expect(query.statusClasses).toBeUndefined();
  });
});
