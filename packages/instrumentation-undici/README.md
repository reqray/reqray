# @reqray/instrumentation-undici

Records outgoing HTTP calls — undici and the built-in `fetch` — into the request that made them, through Node's own `diagnostics_channel`. Nothing is patched.

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
  ✔ undici (built-in)    outgoing HTTP
```

## What is recorded

For each call: method, URL, status and duration. That is what lets Reqray flag calls made one after another that could have run in parallel, and the same URL fetched twice.

**Secrets in the URL are masked** before anything is stored: `?token=abc` becomes `?token=[redacted]`. Request and response bodies of outgoing calls are not recorded.

Supported: any undici, and the `fetch` built into Node 20 or newer. Outside that range nothing is patched, and the startup
report says so.

## Applying it by hand

In a bundled application (esbuild, webpack, tsup) imports are resolved at build
time and loader hooks never fire. Apply the instrumentation yourself, before
the first call:

```js
import { instrumentUndici } from '@reqray/instrumentation-undici';

instrumentUndici().apply();
```

No version range is checked on this path — the choice was yours.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
