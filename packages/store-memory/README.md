# @reqray/store-memory

The default store of Reqray: a ring buffer in process memory that holds the
most recent requests and answers the panel's queries.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

You do not normally install this yourself — the adapters depend on it and use
it when no other transport is given. It keeps the last 500 requests and
forgets them when the process restarts.

```js
import { memoryTransport } from '@reqray/store-memory';

const store = memoryTransport({ capacity: 2000 });
```

Pinned requests survive the ring, up to 50 of them: pinning suspends the
promise that memory is bounded, so it gets a bound of its own.

For a history that survives a restart, use
[`@reqray/store-sqlite`](https://www.npmjs.com/package/@reqray/store-sqlite).

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
