# Demo: Fastify + Postgres with a deliberate N+1

The application that shows what Loupe exists for.

## Running

**With Docker** — with a real Postgres in a neighboring container, from the repository root:

```bash
docker compose up --build
```

The first build is not fast: dependencies are installed and the packages are
built inside the image, because `node --import @loupe/register` loads the built
file, not the sources.

**Without Docker** — the database comes up embedded:

```bash
pnpm build                                        # once
pnpm --filter @loupe/example-fastify-postgres start
```

The embedded database is PGlite — Postgres compiled to WebAssembly — behind a
socket server. It speaks the same wire protocol, so the application talks to it
with the ordinary `pg` driver, and Loupe instruments it exactly as it would a
real server.

Variables: `PORT` (default 3000), `HOST` (default `127.0.0.1`,
`0.0.0.0` in a container), `DATABASE_URL` — connect to an external Postgres
instead of the embedded one.

**Staging stand** — the application ships batches to a collector, the panel
lives on it (from the repository root):

```bash
docker compose -f docker-compose.staging.yml up --build
# panel: http://localhost:4300/auth?token=staging-secret
```

The same without Docker: `npx @loupe/server` in one terminal,
`LOUPE_MODE=staging pnpm --filter @loupe/example-fastify-postgres start` —
in another.

## What to look at

The fastest way — fill the panel with ready-made "human" traffic and watch:

```bash
pnpm --filter @loupe/example-fastify-postgres traffic
```

| Route | What it shows |
|---|---|
| `/_loupe/` | the panel itself |
| `/api/orders` | **deliberate N+1**: 1 query for the orders and one per each |
| `/api/orders/eager` | the same data with a single `IN (…)` — for comparison |
| `/api/orders/flaky` | **flaky**: every other time fast or with an N+1 — food for the compare button |
| `/api/prices` | **deliberate sequential HTTP calls** — an `await fetch` loop |
| `/api/prices/parallel` | the same calls through `Promise.all` — for comparison |
| `/api/search?q=walnut` | a LIKE over an unindexed column — EXPLAIN will show a Seq Scan and suggest an index |
| `POST /api/login` | masking: `password` in the request and `token` in the response are hidden before the buffer |
| `POST /api/checkout` | the whole "incident": sequential warehouse calls, an UPDATE, a log trail, a masked `cardNumber` |
| `/api/report` | deliberately slow — what tail-based sampling always retains |
| `/api/boom` | an exception so the Exceptions screen has something to group |

The demo enables `collectSqlValues: true` (an opt-in, not the default), so
`$1 = %walnut%` shows up under the SQL. On the SQL tab every query has an
**EXPLAIN** button — a plan with hints (unindexed tables, the Seq Scan is found
right away). In the detail header — **copy link** (a permanent link) and
**copy for AI** (a request breakdown for an assistant).

Open `/api/orders`, then the panel — the row in the list will carry an `N+1`
flag, and the detail a callout with the repeat count, the recoverable time and
the line of code:

```
150 identical queries ran in a loop
  src/orders.js:26
  ~29 ms recoverable of a 48 ms request
```

Line 26 is the `await pool.query(...)` inside the loop in
[`src/orders.js`](src/orders.js). Next to it lives `listOrdersEagerly`, which
returns the same data without the loop: compare the two records in the panel.

## Why start through `node --import`

```
node --import @loupe/register src/index.js
```

The loader hooks must be in place before the application loads the driver,
otherwise there is nothing left to intercept. If started without `--import`,
Loupe says so honestly at startup:

```
✘ pg    found, but loaded before loupe
        → start with `node --import @loupe/register`
```

## Why not Prisma

The directory was called `fastify-prisma` in the original architecture. It
turned out the ORM adds nothing to the demonstration here: Prisma 7 connects to
the database only through a driver adapter, and `@prisma/adapter-pg` executes
queries with plain node-postgres — so Loupe sees exactly the same thing. On top
of that, Prisma drags in a client generation step and a TypeScript build,
because the Prisma 7 generator emits `.ts`. The demo must start with a single
command, so plain `pg` it is.
