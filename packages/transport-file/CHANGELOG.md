# @reqray/transport-file

## 0.1.1

### Patch Changes

- Updated dependencies [a52e790]
  - @reqray/core@0.1.1
  - @reqray/protocol@0.1.1

## 0.1.0

### Minor Changes

- cf04d37: A log on disk, and one retention setting the panel can change.
  
  A database is what the panel reads. It is not what `grep` reads, what `tail -f`
  follows, what a log shipper picks up, or what an operator copies off a machine
  before the container is gone. `@reqray/transport-file` writes the same requests
  as one line of JSON each, in a file per day, beside whatever store the panel is
  reading:
  
  ```js
  import { fileTransport, retentionPolicy } from '@reqray/transport-file';
  
  const retention = retentionPolicy({ days: 7, file: '.reqray/retention.json' });
  
  await app.register(reqray, {
    retention,
    transport: [
      sqliteTransport({ file: '.reqray/requests.db', retention }),
      fileTransport({ dir: '.reqray/log', retention }),
    ],
  });
  ```
  
  On the collector it is two variables: `REQRAY_LOG=/var/lib/reqray/log` and
  `REQRAY_DAYS=7`.
  
  **Several transports, one stream of requests.** `transport` takes a list now. A
  store and a log have nothing to say to each other, and a transport that throws
  is reported once and skipped — a broken log must not cost the panel its data.
  The panel finds the store among them; when none of the transports keeps
  anything it says so at startup rather than leaving a 404 to be explained.
  
  **One retention policy, three readers.** `retentionPolicy` holds days, size and
  count, and the SQLite store, the log and the panel all read the same object, so
  "a week" means one thing wherever it is shown. Age is a limit the store did not
  have: it sweeps when the policy changes, on a throttle while requests arrive,
  and it declines to store a request that is already past the limit — batches
  from a collector arrive late, and writing something only to sweep it a minute
  later is work nobody asked for. Pinned requests are exempt, as they are from
  every other limit.
  
  **The Project tab can change it.** A Retention card shows what is kept, what
  the store holds, what the log holds and where it is, and — when the application
  passed a writable policy — changes the number. The stores sweep on the news
  rather than at the next restart, and the value is remembered in a small JSON
  file that is read at startup and wins over what is written in code: a setting
  that resets when the process does is not a setting. Lowering it deletes data,
  which is why it is the only setting the panel writes, why the numbers are
  checked again on arrival, and why a policy can be created `writable: false`.
  
  Writing is streamed and never on the request path. A write that fails takes the
  log down and nothing else, with one warning; a log that falls behind the
  application drops lines and counts them rather than growing the heap, and the
  count is on the card.
  
  Also fixed: the panel's relative times counted minutes forever, so anything
  older than a couple of hours read as `10080m ago`. They degrade through hours
  and days now — which the git blame lines on the Exceptions screen needed too.

### Patch Changes

- cf04d37: Twenty fixes from an audit of the whole repository.
  
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
- cf04d37: One wire contract.
  
  `@reqray/protocol` now holds every panel response type, not the half that
  happened to be extracted first: exceptions, routes and their charts, the
  timeline and the activity behind one of its columns, EXPLAIN, replay and
  blame, and the project report down to diagnostics, pools and retention.
  Core imports them back and re-exports them, so nothing downstream changes.
  
  The dashboard imports that contract instead of transcribing it — `api.ts`
  falls from 1 041 lines to 529 — which fixes two bugs the hand-copy had
  already produced. A truncated response body reported the capture limit as
  its own size, because the copy lacked the `bytes` field recorded for
  exactly that reason. And `isRunEvidence` narrowed to a merged evidence
  type that still admitted the `duplicate` kind it had just excluded; a new
  detector kind is now a compile error rather than a hole in the waterfall.
  
  `@reqray/cli` moves `@reqray/protocol` into its dependencies: its published
  types import it, so `import { ReqrayClient } from '@reqray/cli'` failed to
  compile. The transports name the contract in their own manifests rather
  than reaching it through core.
  
  `@reqray/core` describes itself accurately — "no third-party runtime
  dependencies", since its one dependency is types that emit nothing — and a
  test now reads the built bundle to keep that true.
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [c136fbd]
- Updated dependencies [c136fbd]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [c136fbd]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [21cfe4f]
- Updated dependencies [c136fbd]
  - @reqray/core@0.1.0
  - @reqray/protocol@0.1.0
