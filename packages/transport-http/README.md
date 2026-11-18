# @reqray/transport-http

Ships Reqray's request records from an application to a collector
([`@reqray/server`](https://www.npmjs.com/package/@reqray/server)) in batches,
without ever blocking the application.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## Use

```bash
npm install @reqray/transport-http
```

```js
import { httpTransport } from '@reqray/transport-http';

await app.register(reqray, {
  enabled: true,
  mode: 'production',
  panel: false, // the panel lives on the collector
  transport: httpTransport({
    url: 'http://reqray-collector:4300',
    token: process.env.REQRAY_TOKEN,
  }),
});
```

## What it promises

- **The queue is bounded**, by count and by size. On overflow the oldest
  records are dropped — memory does not grow because a collector is down.
- **An unreachable collector is a warning in the log** and retries with
  exponential backoff, up to 30 seconds apart.
- **`429` is honoured**: the transport waits as long as `Retry-After` says.

## Options

| Option | Default | |
|---|---|---|
| `url` | required | The collector's address |
| `token` | none | Sent with every batch |
| `batchSize` | `50` | Records per request |
| `flushIntervalMs` | `2000` | How often a partial batch is sent |
| `maxQueue` | `1000` | Records held while the collector is away |
| `maxQueueBytes` | 8 MB | …and their total size |
| `timeoutMs` | `10000` | Per request to the collector |
| `retryDelayMs` | `1000` | First retry delay; doubles from there |

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
