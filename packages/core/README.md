# @reqray/core

The core of Reqray: the request context, the span buffer, masking, sampling and
the detectors. No third-party runtime dependencies.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## You probably want an adapter

To use Reqray in an application, install
[`@reqray/register`](https://www.npmjs.com/package/@reqray/register) and one of
[`@reqray/fastify`](https://www.npmjs.com/package/@reqray/fastify),
[`@reqray/express`](https://www.npmjs.com/package/@reqray/express),
[`@reqray/nestjs`](https://www.npmjs.com/package/@reqray/nestjs). They depend on
this package; you do not need to install it yourself.

This package is for writing an adapter for another framework or an
instrumentation for another driver.

## What is in it

- **Request context.** `AsyncLocalStorage` holds a `RequestScope` for the
  request being handled; `current()` returns it, or `undefined` outside a
  request — in which case an instrumentation simply does nothing.
- **Recording.** `record(scope, span)` adds a span. Masking of sensitive
  fields happens here, before anything reaches the buffer.
- **`createReqray(options)`** — what an adapter calls once: it resolves the
  options, owns the transports and exposes the panel's request handler.
- **The instrumentation kit**: `patchMethod` / `unpatchMethod`, `settle` /
  `settleCallback` for the promise-or-callback split, `guarded` for the
  try/catch that disables one instrumentation instead of reaching the
  application, `fingerprintSql` for normalizing statements.
- **Detectors**: N+1, sequential HTTP, duplicate calls and cache reads, pool
  wait, a transaction held across a call, heavy responses, slow code, time
  budgets. They run after the response has been sent.

```js
import { current, record, fingerprintSql } from '@reqray/core';

const scope = current();
if (scope) {
  record(scope, { kind: 'db', sql, fingerprint: fingerprintSql(sql), duration });
}
```

Two rules an instrumentation has to keep: never change the behaviour of what
it wraps, and never let its own error reach the application.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
