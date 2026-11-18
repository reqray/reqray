---
'@reqray/store-sqlite': minor
'@reqray/core': minor
'@reqray/store-memory': minor
'@reqray/server': minor
'@reqray/dashboard': minor
---

A request history that outlives the process, and a list that pages.

Until now every request lived in a ring in memory — the last five hundred in
the application, two thousand in the collector — and a restart threw all of it
away. That is a defensible default for a dev panel and no answer at all to
"what happened an hour ago". Storage was always a transport, so now there is
one for keeping things:

```js
import { sqliteTransport } from '@reqray/store-sqlite';

await app.register(reqray, {
  transport: sqliteTransport({ file: '.reqray/requests.db' }),
});
```

The collector takes the same store through `REQRAY_DB=/var/lib/reqray/requests.db`.

**`node:sqlite`, so nothing is compiled at install time.** Node has shipped
SQLite since 22.5, which is what this package requires — storage that needs a
build toolchain is storage most people never switch on.

**Retention is a promise about disk, not a hope.** Two budgets, whichever runs
out first: `maxRequests` (20 000) and `maxBytes` (256 MB). Past them the oldest
go — except pinned requests, since the point of a pin is that it is the one you
are working on.

**The list pages, and the filter reaches the store.** `/api/requests` answers
with one page and a cursor, and takes the whole filter — method, status,
duration, search text, N+1s, test-issued, one route — so narrowing means
narrowing everything stored rather than everything loaded. The panel loads a
page, keeps the live feed prepending to it, and offers "older requests" at the
end of the list.

Both stores implement the same paging, so the panel behaves identically over
either, and a test fills both with the same records and demands the same ids
back for seventeen filters — including the ones where a search for `%` or `a_i`
would otherwise be read as SQL wildcards.

Fixed along the way: the panel kept exactly 500 rows in the browser regardless
of what the server actually held, so a larger buffer made the list silently
shrink to a third of itself while the reader watched. It now takes the size
from the panel meta.
