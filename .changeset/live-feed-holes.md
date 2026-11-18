---
'@reqray/dashboard': patch
---

Two ways the request list could lie, both visible in the same screenshot.

**The numbers under the list stopped moving.** They come from the store, which
is asked once when a page is fetched — and nothing updated them afterwards, so
a panel left open showed the totals from the minute it was opened. A list of
fifteen rows under a status bar reading "1 of 1 entries" is not a rounding
error, it is a panel that cannot be trusted. Rows arriving on the live feed now
move the counts, which is exact: the stream carries no backlog, so every row it
delivers is one the store has just gained.

**A dropped connection left a hole in the middle of the list.** The browser
reconnects an `EventSource` by itself and says nothing about it; the stream has
no backlog, so everything recorded while the connection was down was simply
never shown — and the list carried on as if nothing had happened. Restart the
application with the panel open and the gap is minutes wide. The panel now
notices the reconnection and asks the store what it missed.

Also: the status bar counted every finding but was labelled `n+1`, which made a
slow report look like an N+1. It says `findings` now, which is what the number
has always been.
