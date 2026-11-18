# @reqray/instrumentation-ioredis

Records every Redis command made through `ioredis` into the request that issued it: standalone and cluster clients, pipelines included.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## You probably do not need to install this

[`@reqray/register`](https://www.npmjs.com/package/@reqray/register) depends on
it and applies it automatically:

```bash
node --import @reqray/register app.js
```

```
reqray  instrumentation active
  ✔ ioredis@5.11.1       cache
```

## What is recorded

For each command: its name, the key, whether a read was a hit or a miss, and the duration. That is what lets Reqray flag the same key being read twice in one request.

**Values are never recorded**, and there is no opt-in: `SET session:9 <jwt>` is stored as `SET session:9`. A command Reqray does not recognise — a custom one, `AUTH` — records its name and nothing else.

Supported: `ioredis` 5.x. Outside that range nothing is patched, and the startup
report says so.

## Applying it by hand

In a bundled application (esbuild, webpack, tsup) imports are resolved at build
time and loader hooks never fire. Apply the instrumentation yourself, before
the first call:

```js
import Redis from 'ioredis';
import { instrumentIoredis } from '@reqray/instrumentation-ioredis';

instrumentIoredis().apply(Redis);
```

No version range is checked on this path — the choice was yours.

The `redis` package (node-redis) is a different client and is not covered.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
