# @reqray/instrumentation-pg

Records every query made through `pg` (node-postgres) into the request that issued it — and therefore every query made by Prisma 7, which goes through node-postgres.

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
  ✔ pg@8.23.0            SQL
```

## What is recorded

For each query: the statement, its duration, the number of rows, the line of your code that issued it, and — when the query had to wait for a pooled connection — how long it waited. Statements are normalized into a fingerprint, which is what the N+1 detector counts.

**Parameter values are not recorded**, in any mode. `collectSqlValues: true` is an explicit opt-in for local debugging.

Supported: `pg` 8.x. Outside that range nothing is patched, and the startup
report says so.

## Applying it by hand

In a bundled application (esbuild, webpack, tsup) imports are resolved at build
time and loader hooks never fire. Apply the instrumentation yourself, before
the first call:

```js
import pg from 'pg';
import { instrumentPg } from '@reqray/instrumentation-pg';

instrumentPg().apply(pg);
```

No version range is checked on this path — the choice was yours.

Callback and promise styles are both supported, and a driver error reaches
your code unchanged.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
