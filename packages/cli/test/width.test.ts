/**
 * Fitting the grid, and giving up columns in the right order.
 *
 * The table in DESIGN.md is what these numbers are. A path is truncated by
 * whole segments: a truncated path that is still a path can be recognised,
 * where a truncated string cannot.
 */

import { describe, expect, it } from 'vitest';
import { cut, fitPath, MIN_WIDTH, pad, padStart, streamColumns } from '../src/render/width.js';

const LONG =
  '/api/v2/organizations/8f2c14/workspaces/3391/projects/checkout-service/deployments/latest/logs';

describe('the stream grid', () => {
  it('gives every spare column to the path', () => {
    expect(streamColumns(100)).toEqual({ path: 49, queries: true, status: true, ids: false });
    expect(streamColumns(80)).toEqual({ path: 29, queries: true, status: true, ids: false });
    expect(streamColumns(200)).toEqual({ path: 149, queries: true, status: true, ids: false });
  });

  it('takes the id column out of the path, so nothing else moves', () => {
    expect(streamColumns(100, true)).toMatchObject({ path: 36, ids: true });
    // And at 80 the id costs the queries column, by the same rule as anything.
    expect(streamColumns(80, true)).toMatchObject({ queries: false, ids: true });
  });

  it('drops the query count first, then the status', () => {
    expect(streamColumns(71)).toMatchObject({ queries: false, status: true });
    expect(streamColumns(60)).toMatchObject({ queries: false, status: false });
  });

  it('never lets the path fall under what a path needs', () => {
    for (let width = MIN_WIDTH; width <= 200; width++) {
      expect(streamColumns(width).path).toBeGreaterThanOrEqual(14);
    }
  });
});

describe('padding', () => {
  it('fills to a width and cuts what is longer', () => {
    expect(pad('GET', 6)).toBe('GET   ');
    expect(pad('DELETE!', 6)).toBe('DELETE');
    expect(padStart('47ms', 7)).toBe('   47ms');
  });

  it('marks a cut rather than ending mid-word in silence', () => {
    expect(cut('abcdefgh', 5, '…')).toBe('abcd…');
    expect(cut('abc', 5, '…')).toBe('abc');
  });
});

describe('fitting a path', () => {
  it('prints it whole when there is room, query string and all', () => {
    expect(fitPath('/api/orders', 'limit=24', 40, '…')).toBe('/api/orders?limit=24');
  });

  it('gives up the query string first', () => {
    expect(fitPath('/api/products', 'limit=24&sort=popular', 20, '…')).toBe('/api/products?…');
  });

  it('then the segments in the middle, keeping the first and the leaf', () => {
    expect(fitPath(LONG, 'tail=200', 49, '…')).toBe(
      '/api/…/checkout-service/deployments/latest/logs?…',
    );
    expect(fitPath(LONG, 'tail=200', 29, '…')).toBe('/api/…/latest/logs?…');
    expect(fitPath(LONG, 'tail=200', 18, '…')).toBe('/api/…/logs?…');
  });

  it('drops the first segment only when the leaf cannot sit beside it', () => {
    // Eleven columns still fit both; ten do not, and the leaf is what matters.
    expect(fitPath(LONG, null, 11, '…')).toBe('/api/…/logs');
    expect(fitPath(LONG, null, 10, '…')).toBe('/…/logs');
  });

  it('cuts the leaf itself when even that does not fit', () => {
    expect(fitPath('/api/deployments', null, 8, '…')).toHaveLength(8);
  });

  it('never returns more than it was given room for', () => {
    for (let width = 8; width <= 60; width++) {
      expect(fitPath(LONG, 'tail=200&level=warn', width, '…').length).toBeLessThanOrEqual(width);
    }
  });

  it('measures the ASCII ellipsis at its real three characters', () => {
    for (let width = 10; width <= 60; width++) {
      expect(fitPath(LONG, 'tail=200', width, '...').length).toBeLessThanOrEqual(width);
    }
  });
});
