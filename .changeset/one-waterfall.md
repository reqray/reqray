---
'@reqray/waterfall': minor
'@reqray/cli': minor
'@reqray/dashboard': minor
'@reqray/core': patch
---

One waterfall, and the terminal starts answering the question.

The waterfall was built twice — once for the browser, once for the terminal —
and the two disagreed about what a waterfall is. The panel collapsed both
kinds of run a detector reports; the terminal collapsed only N+1, so one
request showed four bars in one client and a single bar in the other. The
panel drew the stretches no instrumentation covers; the terminal drew none,
so `reqray show` on a 2.14-second request with a 12-millisecond query printed
the query and said nothing about the remaining 2.13 seconds. The panel showed
a query's wait for a connection; the terminal dropped it, so a query that took
340 ms because it queued for 338 of them looked exactly like one that worked
for 340.

**New:** `@reqray/waterfall` holds the model — which spans collapse into one
bar, where the uninstrumented stretches are, how deep each bar sits, which
parents ran their children in parallel. Types only from `@reqray/protocol`, so
it is safe in a browser bundle and the terminal client still imports no part
of core.

It decides nothing about drawing. A terminal has twenty-eight columns for a
label and a browser has an ellipsis; both clients keep their own words, their
own colours and their own bars, because that is a difference between screens
rather than between answers.

**Fixed in `@reqray/cli`:** uninstrumented time now appears in the terminal
waterfall, sequential-HTTP runs collapse the way they do in the panel, and a
query that queued says so.

**Also in the dashboard:** free text in the search box is matched the way the
server matches it — within one field rather than across the join of several,
so `GET /api` no longer selects rows a page would never have returned — and a
route chip ignores the case of its method. A parity test now runs both filters
over the same rows through the server's own parser. A failed mute or a refused
clear reports the failure instead of showing success, and a pattern last seen
a week ago says "7d ago" rather than "10080m ago".
