/**
 * Showcase routes — each one exists to demonstrate a specific Loupe feature
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
 */

import { pbkdf2Sync, randomBytes } from 'node:crypto';

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
 * the two queries is work Loupe has no instrumentation for, so the waterfall
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

/** A deliberately slow report — what tail-based sampling always retains. */
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
