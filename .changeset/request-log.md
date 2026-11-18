---
'@reqray/transport-file': minor
'@reqray/core': minor
'@reqray/store-sqlite': minor
'@reqray/server': minor
'@reqray/dashboard': minor
---

A log on disk, and one retention setting the panel can change.

A database is what the panel reads. It is not what `grep` reads, what `tail -f`
follows, what a log shipper picks up, or what an operator copies off a machine
before the container is gone. `@reqray/transport-file` writes the same requests
as one line of JSON each, in a file per day, beside whatever store the panel is
reading:

```js
import { fileTransport, retentionPolicy } from '@reqray/transport-file';

const retention = retentionPolicy({ days: 7, file: '.reqray/retention.json' });

await app.register(reqray, {
  retention,
  transport: [
    sqliteTransport({ file: '.reqray/requests.db', retention }),
    fileTransport({ dir: '.reqray/log', retention }),
  ],
});
```

On the collector it is two variables: `REQRAY_LOG=/var/lib/reqray/log` and
`REQRAY_DAYS=7`.

**Several transports, one stream of requests.** `transport` takes a list now. A
store and a log have nothing to say to each other, and a transport that throws
is reported once and skipped — a broken log must not cost the panel its data.
The panel finds the store among them; when none of the transports keeps
anything it says so at startup rather than leaving a 404 to be explained.

**One retention policy, three readers.** `retentionPolicy` holds days, size and
count, and the SQLite store, the log and the panel all read the same object, so
"a week" means one thing wherever it is shown. Age is a limit the store did not
have: it sweeps when the policy changes, on a throttle while requests arrive,
and it declines to store a request that is already past the limit — batches
from a collector arrive late, and writing something only to sweep it a minute
later is work nobody asked for. Pinned requests are exempt, as they are from
every other limit.

**The Project tab can change it.** A Retention card shows what is kept, what
the store holds, what the log holds and where it is, and — when the application
passed a writable policy — changes the number. The stores sweep on the news
rather than at the next restart, and the value is remembered in a small JSON
file that is read at startup and wins over what is written in code: a setting
that resets when the process does is not a setting. Lowering it deletes data,
which is why it is the only setting the panel writes, why the numbers are
checked again on arrival, and why a policy can be created `writable: false`.

Writing is streamed and never on the request path. A write that fails takes the
log down and nothing else, with one warning; a log that falls behind the
application drops lines and counts them rather than growing the heap, and the
count is on the card.

Also fixed: the panel's relative times counted minutes forever, so anything
older than a couple of hours read as `10080m ago`. They degrade through hours
and days now — which the git blame lines on the Exceptions screen needed too.
