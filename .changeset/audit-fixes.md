---
'@reqray/core': minor
'@reqray/server': minor
'@reqray/register': minor
'@reqray/nestjs': minor
'@reqray/cli': patch
'@reqray/dashboard': patch
'@reqray/express': patch
'@reqray/fastify': patch
'@reqray/instrumentation-pg': patch
'@reqray/instrumentation-undici': patch
'@reqray/store-sqlite': patch
'@reqray/transport-file': patch
'@reqray/transport-http': patch
---

Twenty fixes from an audit of the whole repository.

**Behaviour that changes**

- A panel with no gate answers only to its own machine: a loopback connection
  addressed to `localhost` or `127.0.0.1`. Reaching it from another machine,
  through a proxy or from outside a container now takes a gate —
  `panel: { gate: 'open' }` says so explicitly. A collector started without a
  token follows the same rule and accepts `/ingest` only as
  `application/json`.
- Sensitive query parameters are masked like body fields, in the request's
  own URL and in the URLs of outgoing calls.
- `@reqray/nestjs` observes exceptions with an interceptor instead of a
  catch-all filter, so the application's own exception filter decides the
  response again. `ReqrayExceptionFilter` is gone; `rxjs` is a peer dependency.
- `register()` takes no options. Its `instrumentations` list could never be
  honoured — importing the package had already registered. Explicit
  registration is `instrumentPg().apply(pg)`.
- Request ids carry a 40-bit process prefix; the CLI's id column is wider.

**Fixes**

- A test name from a header can no longer inject a line into an exported curl
  script, and control characters never reach the terminal from the CLI.
- A malformed `%` in a panel URL is a 400, not an uncaught exception.
- Streams are never recorded as bodies.
- The N+1 detector no longer reports keyset paging — a `LIMIT` query repeated
  until a short page.
- Outgoing calls are recorded when the headers arrive, so a response whose
  body is never read still leaves a span.
- pg is patched when the loader hands over an ESM namespace with the classes
  under `default`.
- Fastify records requests the client aborted; Express forwards every
  argument of `res.json` / `res.send`.
- The SQLite store counts only what it can evict, sweeps in steps rather than
  on every write, and no longer stays over budget because of a pin.
- The HTTP transport's `close()` waits for the batch on the wire; the file
  transport keeps its size cap under a shared retention policy.
- Paging over an in-memory list is ordered, so a slow request beside a page
  boundary is neither skipped nor repeated.
- The live feed no longer pushes matching rows out of a filtered list, and
  the history chart honours `status:` and `method:` typed into the search.
