# @reqray/transport-file

Reqray's request log on disk: every recorded request as one line of JSON, a
file per day. A database is what the panel reads; this is what `grep` reads,
what `tail -f` follows and what a log shipper picks up.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## Use

```bash
npm install @reqray/transport-file
```

```js
import { fileTransport, retentionPolicy } from '@reqray/transport-file';
import { sqliteTransport } from '@reqray/store-sqlite';

const retention = retentionPolicy({ days: 7, file: '.reqray/retention.json' });

await app.register(reqray, {
  retention,
  transport: [
    sqliteTransport({ file: '.reqray/requests.db', retention }),
    fileTransport({ dir: '.reqray/log', retention }),
  ],
});
```

Writing is streamed and never on the request path. A write that fails takes
the log down and nothing else; a log that falls behind the application drops
lines and counts them rather than growing the heap.

## Options

| Option | Default | |
|---|---|---|
| `dir` | required | Directory the daily files go to |
| `retention` | none | A shared `retentionPolicy`, so the log and the store evict by one number |
| `days` | none | How many days of files to keep, when no shared policy is given |
| `maxBytes` | none | Total size of the log on disk |

On the collector it is two variables: `REQRAY_LOG=/var/lib/reqray/log` and
`REQRAY_DAYS=7`.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
