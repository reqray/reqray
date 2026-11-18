/**
 * Saved views: the whole question under a name, minus the moment.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, type FilterState } from '../src/shared/list/filter';
import { filterOf, loadViews, saveViews, viewOf, withView } from '../src/shared/list/views';

const FILTER: FilterState = {
  query: 'checkout status:5xx',
  methods: ['POST'],
  statusClasses: [5],
  duration: 'slow100',
  route: null,
  range: [1_000, 2_000],
};

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('a view keeps the question, not the moment', () => {
  it('round-trips everything but the time range', () => {
    const restored = filterOf(viewOf('slow checkouts', FILTER));

    expect(restored).toEqual({ ...FILTER, range: null });
  });

  it('saving under an existing name updates it, newest first', () => {
    const first = viewOf('a', FILTER);
    const second = viewOf('b', { ...EMPTY_FILTER, query: 'other' });
    const updated = viewOf('a', { ...EMPTY_FILTER, query: 'changed' });

    const views = withView(withView(withView([], first), second), updated);

    expect(views.map((view) => view.name)).toEqual(['a', 'b']);
    expect(views[0]?.query).toBe('changed');
  });

  it('survives the storage round-trip, and shrugs at corruption', () => {
    const storage = memoryStorage();
    saveViews(storage, [viewOf('kept', FILTER)]);

    expect(loadViews(storage).map((view) => view.name)).toEqual(['kept']);

    storage.data.set('reqray.views', 'not json at all');
    expect(loadViews(storage)).toEqual([]);
    expect(loadViews(null)).toEqual([]);
  });
});
