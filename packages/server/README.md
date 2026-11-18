# @reqray/server

The Reqray collector: a separate process that receives request records from
your applications, stores them, and serves the panel. This is how Reqray runs
anywhere the application is reachable from outside — the application only
ships batches, and the data and the panel live here.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## Run

```bash
REQRAY_TOKEN=change-me HOST=0.0.0.0 npx @reqray/server
# panel: http://<host>:4300/auth?token=change-me
```

| Variable | Default | |
|---|---|---|
| `PORT` | `4300` | |
| `HOST` | `127.0.0.1` | Anything else requires a token |
| `REQRAY_TOKEN` | none | Applications send it with their batches; people sign in at `/auth?token=…` |
| `REQRAY_DB` | none (memory) | Path to a SQLite file — a history that survives a restart |
| `REQRAY_LOG` | none | Directory for a log on disk, one JSON line per request, a file per day |
| `REQRAY_DAYS` | none | How many days the store and the log keep |
| `BUFFER_SIZE` | `2000` | Requests kept in memory when there is no `REQRAY_DB` |

Without a token the collector refuses to listen on anything but loopback: the
panel shows request bodies and SQL.

Node 22.5 or newer — SQLite is built in from there, and nothing is compiled at
install time.

## Point an application at it

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

Under load the collector answers `429` with `Retry-After` rather than queueing
without bound, and the transport backs off.

## From code

```js
import { createReqrayServer } from '@reqray/server';

const server = await createReqrayServer({ port: 4300, token: process.env.REQRAY_TOKEN });
console.log(server.url);
await server.close();
```

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
