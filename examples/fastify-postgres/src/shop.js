/**
 * Showcase routes — each one exists to demonstrate a specific Reqray feature
 * on realistic-looking traffic. What shows what:
 *
 *   GET  /api/search?q=…    Seq Scan in EXPLAIN (products has no index on title)
 *   POST /api/login         masking: password in the request, token in the response
 *   POST /api/checkout      the "incident": sequential HTTP per item, an UPDATE,
 *                           log lines telling the story, cardNumber masked
 *   GET  /api/orders/flaky  sometimes eager, sometimes N+1 — food for Compare
 *   GET  /api/report        deliberately slow: what tail-based sampling retains
 *   POST /api/register      sync password hashing between two queries — the
 *                           uninstrumented stretch in the middle of a waterfall
 *   GET  /api/invoice/:id   the same external call made twice — duplicate work
 *   GET  /api/profile/:id   a cache in front of the database, and one read of
 *                           the same key too many
 */

import { pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * A profile page: the user comes from the cache, the orders from the database.
 *
 * The first call misses and fills the cache; every later one hits. The
 * greeting is built by a helper that fetches the user itself instead of taking
 * the one already in hand — the duplicate read the cache detector points at,
 * with the file and line of the second call.
 */
export async function profile(pool, cache, userId) {
  const user = await cachedUser(pool, cache, userId);
  const greeting = await greetingFor(cache, userId);

  await cache.incr(`profile:views:${userId}`);
  const { rows } = await pool.query(
    'SELECT id, total FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 5',
    [userId],
  );

  return { user, greeting, recentOrders: rows };
}

/** Cache-aside, the ordinary way: read, and on a miss fill it. */
async function cachedUser(pool, cache, userId) {
  const key = `user:${userId}`;
  const cached = await cache.get(key);
  if (cached) return JSON.parse(cached);

  const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  const user = rows[0] ?? null;
  // The value never reaches the panel — only the key does.
  await cache.set(key, JSON.stringify(user), 'EX', 60);
  console.log('user %d cached', userId);
  return user;
}

/** Reads the user again. This is the line the duplicate finding points at. */
async function greetingFor(cache, userId) {
  const cached = await cache.get(`user:${userId}`);
  const user = cached ? JSON.parse(cached) : null;
  return `Welcome back, ${user?.email ?? 'stranger'}`;
}

/** Searches products by title — a LIKE over an unindexed column, on purpose. */
export async function searchProducts(pool, query) {
  console.log('searching products for "%s"', query);
  const { rows } = await pool.query(
    'SELECT id, title, price FROM products WHERE title ILIKE $1 ORDER BY price DESC LIMIT 20',
    [`%${query}%`],
  );
  console.log('products found: %d', rows.length);
  return { query, results: rows };
}

/** Pretend login: the point is what reaches the buffer, not the auth. */
export async function login(pool, credentials) {
  const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [
    credentials?.login ?? 'ada@example.com',
  ]);
  const user = rows[0] ?? null;
  console.log('user %s logged in', user?.email ?? 'unknown');
  // Both sides of the exchange carry secrets; the panel must show them masked.
  return { token: 'jwt-demo-value-never-visible', user };
}

/**
 * Checkout — one request that has everything: SQL, a loop of external calls
 * waiting for each other, an UPDATE and a log trail.
 */
export async function checkout(pool, base, order) {
  const orderId = Number(order?.orderId ?? 1);
  console.log('checking out order %d', orderId);

  const { rows: items } = await pool.query(
    'SELECT id, title, price FROM line_items WHERE order_id = $1',
    [orderId],
  );
  console.log('line items fetched: %d', items.length);

  // Deliberately sequential: each inventory check waits for the previous one.
  const availability = [];
  for (const item of items) {
    const response = await fetch(`${base}/api/external/inventory/${item.id}`);
    availability.push(await response.json());
  }
  console.log('warehouse confirmed %d items', availability.length);

  await pool.query('UPDATE orders SET total = total + 0 WHERE id = $1', [orderId]);
  console.log('order %d placed', orderId);

  return { orderId, items: items.length, availability };
}

/**
 * Charging a card with the transaction still open.
 *
 * The mistake nobody sees in review, because every line of it is correct: the
 * order is locked, the payment provider is called, the result is written, and
 * it all commits together. What it costs is invisible in the code and in the
 * waterfall alike — one connection out of the pool for as long as somebody
 * else's API takes to answer, and under load that is how a pool runs dry
 * while the database sits idle.
 *
 * `pool.connect()` rather than `pool.query()`, because that is the only way
 * a transaction works: every statement has to go down the same wire.
 */
export async function payHolding(pool, base, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id, total FROM orders WHERE id = $1 FOR UPDATE', [orderId]);

    // The connection is held right through this.
    const response = await fetch(`${base}/api/external/charge/${orderId}`);
    const charge = await response.json();

    await client.query('UPDATE orders SET total = total + 0 WHERE id = $1', [orderId]);
    await client.query('COMMIT');
    return { orderId, charged: charge.ok, held: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The same charge, with the connection given back first.
 *
 * Read, call, then open the transaction to write. The request takes just as
 * long — the payment provider is not any faster — and the pool is free the
 * whole time the call is in flight, which is the entire difference and the
 * reason the two routes sit next to each other.
 */
export async function payReleasing(pool, base, orderId) {
  const { rows } = await pool.query('SELECT id, total FROM orders WHERE id = $1', [orderId]);

  const response = await fetch(`${base}/api/external/charge/${orderId}`);
  const charge = await response.json();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE orders SET total = total + 0 WHERE id = $1', [orderId]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  return { orderId, charged: charge.ok, held: false, total: rows[0]?.total ?? 0 };
}

/**
 * The flaky endpoint: same path, two very different fates — exactly the
 * "why is it sometimes fast and sometimes not" the Compare screen answers.
 */
export async function listOrdersFlaky(pool, userId, slowPath) {
  const { rows: orders } = await pool.query(
    'SELECT id, total FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  if (!slowPath) {
    const { rows: items } = await pool.query(
      'SELECT id, order_id, title, price FROM line_items WHERE order_id = ANY($1)',
      [orders.map((order) => order.id)],
    );
    const byOrder = new Map();
    for (const item of items) {
      const bucket = byOrder.get(item.order_id) ?? [];
      bucket.push(item);
      byOrder.set(item.order_id, bucket);
    }
    return orders.map((order) => ({ ...order, items: byOrder.get(order.id) ?? [] }));
  }

  console.log('unlucky request: fetching one by one');
  const result = [];
  for (const order of orders) {
    const { rows: items } = await pool.query(
      'SELECT id, title, price FROM line_items WHERE order_id = $1',
      [order.id],
    );
    result.push({ ...order, items });
  }
  return result;
}

/**
 * Registration — a request whose cost is CPU, not I/O. The hashing between
 * the two queries is work Reqray has no instrumentation for, so the waterfall
 * must show it as an uninstrumented stretch in the middle, not stay silent.
 */
export async function registerUser(pool, credentials) {
  const email = credentials?.email ?? 'grace@example.com';
  const password = credentials?.password ?? 'correct horse battery staple';
  console.log('registering %s', email);

  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) {
    console.log('email is already taken');
    return { error: 'email is taken' };
  }

  // Deliberately synchronous, with the cost tuned to ~200 ms of pure CPU even
  // on fast hardware — the same ballpark bcrypt/scrypt land in for real logins,
  // and enough for the waterfall gap to be unmissable.
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 3_000_000, 32, 'sha256');
  console.log('password hashed');

  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, `${salt.toString('hex')}:${hash.toString('hex')}`],
  );
  console.log('user %d registered', rows[0].id);
  return { id: rows[0].id, email };
}

/**
 * An invoice: the order, then the customer's plan — fetched twice, once for
 * the header and once for the totals, by two functions neither of which knows
 * about the other. The classic duplicate: nobody wrote it on purpose.
 */
export async function invoice(pool, base, orderId) {
  const { rows } = await pool.query('SELECT id, total FROM orders WHERE id = $1', [orderId]);
  const order = rows[0] ?? null;

  const header = await renderHeader(base, orderId);
  const totals = await renderTotals(base, orderId, order);
  return { order, header, totals };
}

async function renderHeader(base, orderId) {
  const response = await fetch(`${base}/api/external/inventory/${orderId}`);
  return { stock: await response.json() };
}

async function renderTotals(base, orderId, order) {
  // The same call the header already made — and the reason the finding exists.
  const response = await fetch(`${base}/api/external/inventory/${orderId}`);
  return { stock: await response.json(), total: order?.total ?? 0 };
}

/**
 * Five reports at once, on a pool that cannot serve five.
 *
 * `pg_sleep` stands in for the query nobody got round to optimising — an
 * unindexed scan, a year of rows grouped on the fly. What matters is not what
 * it does but what it holds: with four connections and five callers, the last
 * one spends its whole life in a queue, and its bar in the waterfall is
 * indistinguishable from a slow query. Whoever reads it goes off to add an
 * index that will not help, which is the mistake this route exists to make
 * visible.
 *
 * The five run through `Promise.all`, so they are not an N+1 either — and the
 * detectors have to say so by staying quiet about them.
 */
export async function reportBurst(pool) {
  console.log('five reports at once');
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      pool.query('SELECT pg_sleep(0.15) AS slept, count(*) AS orders FROM orders'),
    ),
  );
  return { reports: results.length, orders: Number(results[0]?.rows[0]?.orders ?? 0) };
}

/** A deliberately slow report — what tail-based sampling always retains. */
/**
 * The price history for every product, for every day, all at once.
 *
 * The endpoint somebody wrote for a one-off report and then left in the API.
 * Every query in it is fast — that is the point: the waterfall has nothing to
 * show, and the mistake is entirely in how much came back.
 */
export async function exportPriceHistory(pool) {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.price, d::date AS day
     FROM products p
     CROSS JOIN generate_series(now() - interval '120 days', now(), interval '1 day') AS d
     ORDER BY p.id, d`,
  );
  return { rows };
}

export async function slowReport(pool) {
  console.log('building the revenue report');
  const { rows } = await pool.query(
    `SELECT o.user_id, count(*) AS orders, sum(li.price) AS revenue
     FROM orders o JOIN line_items li ON li.order_id = o.id
     GROUP BY o.user_id`,
  );
  // The heavy part of a real report is rarely the query itself. Long enough
  // to break the 700 ms budget, which is the point of the route.
  await new Promise((resolve) => setTimeout(resolve, 850));
  console.log('report ready');
  return { rows };
}
