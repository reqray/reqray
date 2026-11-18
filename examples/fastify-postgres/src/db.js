/**
 * Database for the demo.
 *
 * Defaults to PGlite — Postgres built to WebAssembly — behind a socket server,
 * so `pnpm start` needs no Docker and no local Postgres. It speaks the same
 * wire protocol, so the app connects with the ordinary `pg` driver and Reqray
 * instruments it exactly as it would a real server.
 *
 * Set `DATABASE_URL` to point at a real Postgres instead.
 */

import { createServer } from 'node:net';
import pg from 'pg';

// Enough rows that the N+1 loop costs real milliseconds even against the
// in-process engine, where a single query takes a fraction of one.
const ORDER_COUNT = 150;
const ITEMS_PER_ORDER = 3;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function startEmbedded() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  const port = await freePort();
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();

  return {
    connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

async function seed(pool) {
  // Idempotent: an external database is reused across runs, and the benchmark
  // starts the app several times against the same one.
  await pool.query('DROP TABLE IF EXISTS line_items, orders, products, users CASCADE');
  await pool.query(`
    CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, password_hash text);
    CREATE TABLE orders (
      id serial PRIMARY KEY,
      user_id int NOT NULL REFERENCES users(id),
      total int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE line_items (
      id serial PRIMARY KEY,
      order_id int NOT NULL REFERENCES orders(id),
      title text NOT NULL,
      price int NOT NULL
    );
    CREATE TABLE products (
      id serial PRIMARY KEY,
      title text NOT NULL,
      price int NOT NULL
    );
  `);

  await pool.query('INSERT INTO users (email) VALUES ($1)', ['ada@example.com']);

  // Deliberately WITHOUT an index on title: the search route exists to show
  // a Seq Scan in EXPLAIN, and honest demo data makes an honest plan.
  await pool.query(`
    INSERT INTO products (title, price)
    SELECT adj || ' ' || noun || ' ' || g, (g % 90 + 10) * 10
    FROM generate_series(1, 400) AS g,
         LATERAL (SELECT (ARRAY['steel','walnut','matte','vintage','compact'])[g % 5 + 1] AS adj) a,
         LATERAL (SELECT (ARRAY['lamp','desk','chair','keyboard','monitor'])[g % 4 + 1] AS noun) n
  `);

  // Seeded with set-returning statements rather than a loop: startup should be
  // quick, and batched inserts are exactly what the detector must not flag.
  await pool.query(
    `INSERT INTO orders (user_id, total)
     SELECT 1, g * 100 FROM generate_series(1, $1) AS g`,
    [ORDER_COUNT],
  );
  await pool.query(
    `INSERT INTO line_items (order_id, title, price)
     SELECT o.id, 'item ' || i, i * 10
     FROM orders o CROSS JOIN generate_series(1, $1) AS i`,
    [ITEMS_PER_ORDER],
  );
}

/** Starts the database and returns a connected pool plus a shutdown hook. */
export async function connect() {
  const embedded = process.env.DATABASE_URL ? null : await startEmbedded();
  const connectionString = process.env.DATABASE_URL ?? embedded.connectionString;

  // PGlite serves a single connection, so the embedded pool has to stay at one.
  const pool = new pg.Pool({ connectionString, max: embedded ? 1 : 4 });
  await seed(pool);

  return {
    pool,
    embedded: embedded !== null,
    async stop() {
      await pool.end();
      await embedded?.stop();
    },
  };
}
