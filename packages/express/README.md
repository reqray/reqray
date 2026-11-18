# @reqray/express

Reqray for Express: every request as a waterfall — SQL, outgoing HTTP, cache,
bodies after masking — and N+1 queries pointed at the file and the line.

![A request arrives, is flagged N+1, and one click shows the line and the fix](https://raw.githubusercontent.com/reqray/reqray/main/docs/screenshots/00-demo.gif)

## Use

```bash
npm install @reqray/express @reqray/register
```

```js
import express from 'express';
import { reqray } from '@reqray/express';

const app = express();
const inspector = reqray();

app.use(inspector.middleware);     // before the routes
// ...routes...
app.use(inspector.errorHandler);   // after the routes
```

```bash
node --import @reqray/register app.js
# open http://localhost:3000/_reqray/
```

Two handlers, because Express hands an exception only to an error-handling
middleware installed after the routes. `errorHandler` is optional: without it
a failed request is still recorded with its status, just without the exception
itself.

`--import @reqray/register` is what instruments the database driver, the cache
client and `fetch`. A CommonJS application can `require('@reqray/express')` and
start with `node --require @reqray/register app.js`.

Express 4 and 5. Node 20 or newer.

## Options

```js
const inspector = reqray({
  panel: { gate: ({ headers }) => headers['x-admin'] === process.env.ADMIN_KEY },
  redact: { headers: ['x-api-key'] },
  detect: { nPlusOne: { threshold: 10 } },
});
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | `NODE_ENV !== 'production'` | Off means off: nothing is recorded and nothing is mounted |
| `mode` | from `NODE_ENV` | `'development'` keeps every request; `'production'` samples |
| `panel` | `{ path: '/_reqray' }` | `false` to not mount it; `{ gate }` decides who gets in |
| `transport` | memory, last 500 requests | Where records go — see `@reqray/store-sqlite`, `@reqray/transport-http`, `@reqray/transport-file` |
| `redact` | see below | `{ headers: [...], body: [...] }` extend the masked names |
| `detect` | all on | `{ nPlusOne: { threshold: 10 }, slowBudget: false }` |
| `sampling` | 100% locally, 1% in production | `{ rate, slowMs, alwaysOnError, alwaysOnFinding }` |
| `replay`, `explain`, `blame` | local development only | Opt-in anywhere else |
| `collectSqlValues` | `false` | SQL parameter values are never recorded unless you ask |

Masked before anything is stored: `authorization`, `cookie`, `set-cookie` in
headers; `password`, `token`, `secret`, `cardNumber`, `cvv`, `apiKey`,
`signature` in bodies and query strings.

Outside local development the panel does not mount without an explicit gate —
the application fails at startup with an explanation rather than opening
access. `panel: { gate: 'open' }` if open is what you mean, or a function:
`gate: ({ headers, ip }) => headers['x-admin'] === process.env.ADMIN_KEY`.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
