/**
 * `@loupe/instrumentation-prisma` — not implemented, and largely not needed.
 *
 * ## Prisma 7 queries are already visible
 *
 * Prisma 7 dropped `url` from the datasource block: a direct database
 * connection now goes exclusively through a driver adapter. For Postgres that
 * adapter is `@prisma/adapter-pg`, and it runs every query as plain
 * node-postgres — `client.query({ name, text, values, rowMode: 'array' })`.
 *
 * That is a shape `@loupe/instrumentation-pg` already handles, so Prisma
 * queries land in the waterfall, group by fingerprint and feed the N+1
 * detector without any Prisma-specific code. Verified against a real Postgres
 * engine in `packages/instrumentation-pg/test/pg.integration.test.ts`.
 *
 * What is lost without a dedicated instrumentation:
 *
 * - spans are attributed to `pg`, so a finding carries the generic
 *   "collect the ids and use one `IN (…)` query" hint instead of
 *   "add `include`";
 * - the model and operation (`order.findMany`) are not recorded, only the SQL;
 * - whether the callsite points at the user's `prisma.order.findMany()` call
 *   is unverified — the query engine may have left the synchronous stack by
 *   the time the adapter reaches the driver.
 *
 * ## Why the package is still empty
 *
 * The obvious hooks all have problems, and none of them can be checked without
 * a generated client and a live database:
 *
 * - a loader hook on the module name `@prisma/client` is unreliable: Prisma 7
 *   generates the client into a directory the user chooses, and the
 *   application imports from there;
 * - `$extends` is the official extension point but returns a NEW client whose
 *   method set differs and which fails `instanceof` — that changes application
 *   behaviour, which instrumentation must not do;
 * - `$use` mutates the instance in place but is deprecated and may be gone.
 *
 * The remaining candidate worth evaluating first is `@prisma/instrumentation`
 * as a span source — a ready-made OpenTelemetry instrumentation. It would
 * supply model and operation names, at the cost of a bridge from OTel spans
 * to the Loupe model.
 */

export {};
