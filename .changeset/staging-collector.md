---
'@loupe/transport-http': minor
'@loupe/server': minor
'@loupe/nestjs': minor
'@loupe/express': minor
'@loupe/fastify': minor
'@loupe/core': minor
---

Staging: agent and collector.

`@loupe/transport-http` sends records in batches and never blocks the
application: the queue is bounded, the oldest records are dropped on
overflow, and an unreachable collector means a warning and retries with
exponential backoff.

`@loupe/server` — the collector as a separate process: batch ingestion,
storage, and the same dashboard. Without a token it listens on 127.0.0.1
only; with a token, the dashboard is entered via `/auth?token=…`.

`@loupe/nestjs` — a module in `imports`, nothing more; the Express or
Fastify platform is detected automatically, and exceptions reach the record
through a global filter. The Express and Fastify adapters export
`recordFailure` for frameworks that intercept exceptions before they do.
