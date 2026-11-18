---
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
'@reqray/protocol': minor
'@reqray/dashboard': minor
'@reqray/core': minor
---

History: any metric, any period, and the requests behind the point

Everything the panel drew was scoped to something. The strip above the list
spans the whole store but counts only requests; the route charts cover the
whole store for one endpoint at a time. There was no way to ask what latency
did this week, and nowhere that stated a period's numbers as numbers.

The new History screen does both. Ten metrics, all of them things Reqray
already measured — percentiles, throughput, error rate, queries and outgoing
calls per request, response size, event-loop delay, findings per request — over
the last hour, today, seven days, or everything the store holds, narrowed
further by dragging across the chart. Two at once where they share a story:
latency against how far behind the event loop was is a question worth putting
on one chart, and each line gets its own scale and its own side.

The chart is zoomed three ways: a drag across a stretch, the wheel, or a
trackpad pinch — anchored on the cursor, so the spike being looked at stays
put while the window tightens around it. Two fingers sideways pan a zoomed
window; winding back out past the whole period clears the zoom. While a new
reading is in flight the chart already on screen stays up and dims instead of
blanking, and a new question sweeps its answer in from the left.

A rail beside the plot names the requests behind the chart: idle, the ten
slowest of the whole period in view under the chart's current filter;
hovering a column narrows it to that column, leaving widens it back, and
every row opens the request directly. Beside the plot rather than over it,
so the chart is never covered. Clicking a column pins it — the stretch is
marked on the chart, the rail locks to it, and the pointer is free to cross
the plot without every column on the way stealing the list — and "open all
in the list" carries whatever the rail is scoped to into the request list.
The route charts carry the same list as a card under the hovered column,
scoped to the route.

The charts are live, and follow the panel's own toggle. While live, the
history window slides forward every few seconds — a relative period whole,
"everything" at its right edge, and a pinned zoom re-read in place rather than
moved under the reader's eyes; the routes screen re-reads on the same cadence,
with an open route's charts riding the refresh instead of resetting. Paused
means nothing moves.

Above it, the period as figures: calls, error rate, p50/p95/p99, time in SQL
against time in application code, the busiest endpoint and the detector that
fired most — each against the same period immediately before, because a number
with nothing to compare it to is a number nobody acts on.

**What keeps it from being a dashboard.** Every column is the set of requests
that made it: click one and the list opens on exactly those, filtered as the
chart was. A fixed list of metrics rather than a query language, two lines at
most, nothing saved, nothing that alerts. The filter the list is showing is
inherited — "what did *this endpoint* do this week" is the question the screen
is for — and named in a pill that clears it, because an inherited filter
nobody can see turns an empty chart into a mystery.

Under it: `/api/series`, and a `history()` method beside `durations()` and
`counts()`. Stores hand over a few numbers per request and say when they
stopped reading; the bucketing and the percentiles happen once, in the core, so
the same data cannot produce different figures depending on which store is
behind it. A stretch nothing ran in is drawn as a void rather than as a zero,
and a period the store could not read to the end says so instead of presenting
its recent part as the whole.

The SQLite store gains three columns — time in SQL, time in application code,
and bytes sent — through the same migration path the event-loop reading used.
Existing databases keep working and answer `null` for the requests recorded
before them, which is what "not measured" is.
