import { describe, expect, it } from 'vitest';
import { hashFor, parseHash } from '../src/routing';

describe('hash routing', () => {
  it('reads the current scheme', () => {
    expect(parseHash('#l/requests')).toMatchObject({ screen: 'requests' });
    expect(parseHash('#l/exc')).toMatchObject({ screen: 'exceptions' });
    expect(parseHash('#l/routes')).toMatchObject({ screen: 'routes' });
    expect(parseHash('#l/req/8812')).toMatchObject({ screen: 'detail', selected: '8812' });
    expect(parseHash('#l/cmp/a1,b2')).toMatchObject({
      screen: 'compare',
      compare: { a: 'a1', b: 'b2' },
    });
  });

  it('keeps a half-picked comparison open', () => {
    expect(parseHash('#l/cmp/a1')).toMatchObject({ compare: { a: 'a1', b: null } });
  });

  it('still opens links written in the original scheme', () => {
    // Permalinks were shipped before the `l/` namespace existed; those links
    // live in chat threads and must not rot.
    expect(parseHash('#/req/8812')).toMatchObject({ screen: 'detail', selected: '8812' });
    expect(parseHash('#/exceptions')).toMatchObject({ screen: 'exceptions' });
    expect(parseHash('#/compare/a1/b2')).toMatchObject({
      screen: 'compare',
      compare: { a: 'a1', b: 'b2' },
    });
  });

  it('falls back to the list on anything unrecognised', () => {
    for (const hash of ['', '#', '#l/nonsense', '#/nonsense', '#l/cmp/', '#some-host-hash']) {
      expect(parseHash(hash), hash).toMatchObject({ screen: 'requests' });
    }
  });

  it('writes only the current scheme', () => {
    expect(hashFor(parseHash('#/req/8812'))).toBe('#l/req/8812');
    expect(hashFor(parseHash('#/compare/a1/b2'))).toBe('#l/cmp/a1,b2');
    expect(hashFor(parseHash('#/exceptions'))).toBe('#l/exc');
  });

  it('round-trips ids that need escaping', () => {
    const id = 'req/with space';
    const route = parseHash(hashFor({ screen: 'detail', selected: id, compare: null }));

    expect(route.selected).toBe(id);
  });
});
