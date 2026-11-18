/**
 * List rows, as the stream sends them.
 *
 * The calm stream from the specification, plus the two that are not calm: an
 * N+1 and a request that threw.
 */

import type { RequestRow } from '@reqray/protocol';
import { AT } from './records.js';

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 'r1',
    method: 'GET',
    path: '/health',
    query: null,
    route: '/health',
    status: 200,
    durationMs: 1.2,
    startedAt: AT,
    sqlCount: 0,
    httpCount: 0,
    nPlusOne: false,
    findingCount: 0,
    flag: null,
    hasError: false,
    cpuMs: null,
    cpuShare: null,
    pinned: false,
    test: null,
    ...over,
  };
}

/** Eight requests in which nothing is wrong. */
export function calmRows(): RequestRow[] {
  const at = (seconds: number, ms: number) => AT + seconds * 1000 + ms;
  return [
    row({ id: '8970', path: '/health', durationMs: 1.2, startedAt: at(-2, 728) }),
    row({ id: '8971', path: '/api/users/me', durationMs: 12, sqlCount: 2, startedAt: at(-1, 60) }),
    row({ id: '8974', path: '/api/orders', durationMs: 47, sqlCount: 6, startedAt: AT }),
    row({
      id: '8975',
      path: '/static/app.js',
      route: '/static/app.js',
      status: 304,
      durationMs: 0.8,
      startedAt: at(0, 226),
    }),
    row({
      id: '8976',
      method: 'POST',
      path: '/api/orders',
      status: 201,
      durationMs: 118,
      sqlCount: 9,
      startedAt: at(0, 893),
    }),
    row({
      id: '8977',
      path: '/api/products',
      query: 'limit=24&sort=popular',
      durationMs: 61,
      sqlCount: 4,
      startedAt: at(2, 328),
    }),
    row({
      id: '8978',
      method: 'PATCH',
      path: '/api/orders/8812/status',
      route: '/api/orders/:id/status',
      durationMs: 38,
      sqlCount: 3,
      startedAt: at(3, 796),
    }),
    row({
      id: '8979',
      method: 'DELETE',
      path: '/api/carts/9f21/items/3',
      route: '/api/carts/:id/items/:id',
      status: 204,
      durationMs: 21,
      sqlCount: 2,
      startedAt: at(7, 476),
    }),
  ];
}

/** A request whose queries ran in a loop. */
export function nPlusOneRow(): RequestRow {
  return row({
    id: '8980',
    path: '/api/orders',
    durationMs: 512,
    sqlCount: 51,
    nPlusOne: true,
    findingCount: 1,
    flag: 'n_plus_one',
    startedAt: AT + 68_000,
  });
}

/** A request that threw. */
export function failedRow(): RequestRow {
  return row({
    id: '9012',
    method: 'POST',
    path: '/api/orders',
    status: 500,
    durationMs: 2140,
    sqlCount: 12,
    hasError: true,
    findingCount: 1,
    flag: 'slow_budget',
    startedAt: AT + 120_000,
  });
}

/** A request slow enough to be worth a look, with nothing else wrong. */
export function slowRow(): RequestRow {
  return row({
    id: '8981',
    path: '/api/report',
    durationMs: 604,
    sqlCount: 63,
    findingCount: 1,
    flag: 'slow_budget',
    startedAt: AT + 70_000,
  });
}

/** A request a test issued. */
export function testRow(): RequestRow {
  return row({
    id: '8982',
    path: '/api/profile/1',
    route: '/api/profile/:id',
    durationMs: 9.4,
    sqlCount: 2,
    test: 'profile.spec.ts:12 › shows the profile',
    startedAt: AT + 71_000,
  });
}

/** The long path, as a row. */
export function longPathRow(): RequestRow {
  return row({
    id: '9101',
    path: '/api/v2/organizations/8f2c14/workspaces/3391/projects/checkout-service/deployments/latest/logs',
    query: 'tail=200&level=warn',
    route:
      '/api/v2/organizations/:id/workspaces/:id/projects/checkout-service/deployments/latest/logs',
    durationMs: 318,
    sqlCount: 8,
    startedAt: AT + 179_000,
  });
}
