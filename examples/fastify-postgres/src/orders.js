/**
 * Order queries — the point of the demo.
 *
 * `listOrdersWithNPlusOne` and `listOrdersEagerly` return exactly the same
 * data. The first one queries line items inside a loop, the second takes them
 * with a single `IN (…)`. Open both in the panel and compare.
 */

/**
 * Deliberate N+1: one query for the orders, then one per order.
 *
 * The loop below is the line Reqray reports as the callsite.
 */
export async function listOrdersWithNPlusOne(pool, userId) {
  const { rows: orders } = await pool.query(
    'SELECT id, total FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  // This line lands on the Logs tab of this very request — console output
  // written during handling is captured into the record.
  console.log('loading line items for %d orders one by one', orders.length);

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

/** The same data, one query for all the line items. */
export async function listOrdersEagerly(pool, userId) {
  const { rows: orders } = await pool.query(
    'SELECT id, total FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  if (orders.length === 0) return [];

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

/** A single query — the lightest scenario, where overhead shows up clearest. */
export async function listOneOrder(pool, userId) {
  const { rows } = await pool.query(
    'SELECT id, total FROM orders WHERE user_id = $1 ORDER BY id LIMIT 1',
    [userId],
  );
  return rows[0] ?? null;
}
