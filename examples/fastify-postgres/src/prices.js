/**
 * Price enrichment — the sequential-HTTP counterpart of orders.js.
 *
 * `listPricesSequentially` and `listPricesInParallel` return exactly the same
 * data. The first one awaits an external call per item in a loop, the second
 * fires them through `Promise.all`. Open both in the panel and compare.
 *
 * The "external API" is a route of this same application with an artificial
 * delay — the demo must not depend on the outside network.
 */

const PRICED_ITEMS = [1, 2, 3, 4, 5];

/** Deliberate sequential HTTP: one call per item, each waiting for the previous. */
export async function listPricesSequentially(base) {
  const prices = [];
  for (const id of PRICED_ITEMS) {
    const response = await fetch(`${base}/api/external/price/${id}`);
    prices.push(await response.json());
  }
  return prices;
}

/** The same calls in parallel — the shape the detector must stay silent on. */
export async function listPricesInParallel(base) {
  return Promise.all(
    PRICED_ITEMS.map((id) => fetch(`${base}/api/external/price/${id}`).then((r) => r.json())),
  );
}
