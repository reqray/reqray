# @reqray/store-sqlite

A request history for Reqray that outlives the process. By default Reqray keeps
the last 500 requests in memory — right for a dev panel, wrong for "what
happened an hour ago". This store keeps them in a SQLite file.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## Use

```bash
npm install @reqray/store-sqlite
```

```js
import { sqliteTransport } from '@reqray/store-sqlite';

await app.register(reqray, {
  transport: sqliteTransport({ file: '.reqray/requests.db' }),
});
```

The panel then pages by cursor instead of loading everything, and filters go
to the store — "only the errors" means every error there is, not every error
on screen.

Node 22.5 or newer, where SQLite is built in. Nothing is compiled at install
time.

## Options

| Option | Default | |
|---|---|---|
| `file` | required | Path to the database file |
| `maxRequests` | `20000` | Oldest requests are evicted past this |
| `maxBytes` | 256 MB | …or past this, whichever runs out first |
| `pinLimit` | `50` | Pinned requests are exempt from eviction, so they get a bound of their own |
| `retention` | none | A shared `retentionPolicy({ days })`, so the store and a log on disk evict by one number |

```js
import { retentionPolicy, sqliteTransport } from '@reqray/store-sqlite';

const retention = retentionPolicy({ days: 7, file: '.reqray/retention.json' });
sqliteTransport({ file: '.reqray/requests.db', retention });
```

The collector takes the same store: `REQRAY_DB=/var/lib/reqray/requests.db`.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
