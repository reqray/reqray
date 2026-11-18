/**
 * The demo drives itself, and the plan has to keep up with the app.
 *
 * A route added to the demo and forgotten here is a feature nobody sees: the
 * panel is only convincing if what it shows covers what the application does.
 * So the plan is checked against the routes the app actually registers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trafficPlan } from '../src/demo-traffic.js';

const source = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');

/** Every `app.get('/…')` and `app.post('/…')` the demo registers. */
function registeredRoutes(): string[] {
  return [...source.matchAll(/app\.(get|post)\('([^']+)'/g)].map((match) => match[2] as string);
}

/**
 * Routes the plan is not expected to call directly.
 *
 * The two `external` ones are stand-ins for somebody else's API — the price
 * and inventory routes call them, which is exactly how they should appear —
 * and the bench route only exists while the benchmark is running.
 */
const INDIRECT = [/^\/api\/external\//, /^\/__bench\//];

/** `/api/invoice/:id` matches `/api/invoice/1`. */
function matches(route: string, path: string): boolean {
  const pattern = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+')}$`);
  return pattern.test(path.split('?')[0] ?? path);
}

describe('the self-driving demo', () => {
  const plan = trafficPlan();

  it('calls every route the app advertises', () => {
    const missed = registeredRoutes()
      .filter((route) => !INDIRECT.some((pattern) => pattern.test(route)))
      .filter((route) => !plan.some((entry) => matches(route, entry.path)));

    expect(missed).toEqual([]);
  });

  it('covers each detector the panel can show', () => {
    const paths = plan.map((entry) => entry.path);

    // N+1 and its fixed twin, sequential and parallel calls, the duplicate
    // external call, the duplicate cache read, the budget breach.
    expect(paths).toContain('/api/orders');
    expect(paths).toContain('/api/orders/eager');
    expect(paths).toContain('/api/prices');
    expect(paths).toContain('/api/prices/parallel');
    expect(paths).toContain('/api/invoice/1');
    expect(paths).toContain('/api/report');
    // Twice, or the cache is never read a second time.
    expect(paths.filter((path) => path === '/api/profile/1')).toHaveLength(2);
    // Twice, or the Compare screen has nothing to pair.
    expect(paths.filter((path) => path === '/api/orders/flaky')).toHaveLength(2);
  });

  it('sends a body only where there is one to send', () => {
    for (const entry of plan) {
      if (entry.body) expect(entry.method).toBe('POST');
      if (entry.method === 'POST') expect(entry.body).toBeDefined();
    }
  });

  it('marks some requests as issued by a test, and keeps the names sendable', () => {
    const names = plan.map((entry) => entry.test).filter((name): name is string => Boolean(name));

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // Header values are latin1 on the wire: a name that cannot be encoded
      // would throw inside `fetch` and take the pass down with it.
      expect(() => new Headers({ 'x-reqray-test': encodeURIComponent(name) })).not.toThrow();
    }
  });
});
