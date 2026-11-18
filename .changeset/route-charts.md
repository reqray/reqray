---
'@reqray/core': minor
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
'@reqray/dashboard': minor
---

Three charts for one endpoint, and a click that asks what ran.

Enough to see "it got slower at 14:20, after the deploy" and to stop there.
Opening a route on the Routes screen draws its latency, the share that
failed, and how often it was called — bucketed by the store, with the strip's
own bucketing function, so a chart and the strip above it cannot disagree
about when something happened. Over the same stretch the table was computed
over, too: a table describing thirteen minutes above a chart describing six
hours is two answers to one question.

**Latency is a p95 line over a p50–p99 band**, and the number of columns
follows the traffic rather than the width of the box. Three lines was the
obvious drawing and the wrong one: a column holding five calls has a p95 and
a p99 that are the same number — the slowest of the five — so the three sat a
pixel apart and read as one thick wobble. A single empty column between two
busy ones is sampling rather than silence, and breaking the line there turned
an ordinary series into a row of dashes.

**Every column is clickable, because a chart nobody can click is
decoration.** Clicking one asks what ran in that moment, and the answer is
ranked by how far each route strayed from *its own* behaviour — never by
volume, because ranked by volume the busiest endpoint tops every moment and
explains nothing.

The first run of this screen listed fifteen endpoints, all at ×6.5. They were
all at ×6.5 because the demo had restarted and every route rose together, and
a route judged against the total it is part of will always look unusual
inside a burst. So each route is judged against how *the rest of the traffic*
moved: one means it rose exactly as much as everything around it, which is
not an answer to "what was different here". When nothing is disproportionate
the panel says the traffic rose across the board and names no culprit.

Two more floors, because a ratio alone is not enough at low rates: three
calls where two were expected is 1.5× and nothing has happened, so an excess
of at least three calls is required as well — and at least five milliseconds
before "slower" means anything, since a route that doubled from 0.2 ms has
doubled and nobody has noticed. When nothing stands out the drawer says so:
garbage collection, a neighbour on the box, or the host. A list of ordinary
routes presented as an explanation is worse than admitting there is none.

**Two endpoints and two store methods.** `GET /api/routes/series` and `GET
/api/timeline/at`, answered by `durations` (now carrying whether the call
failed, and bounded by a time range) and by a new `counts`, which groups by
route with an aggregate rather than by loading a busy minute of requests to
count them. A store that cannot group says so, and the panel prints that
instead of asking for ever.

**One thing moved.** Clicking a row on the Routes screen now opens the route
rather than jumping to a filtered list — looking at a route is the commoner
gesture — and the filter is a *show these requests* button inside the opened
panel.

**A selected column is marked, not filled.** A band from floor to ceiling is
the same shape the throughput chart draws its data with, and at full height
it read as the tallest sample on the chart — a spike that was not there. It
is a faint neutral wash with a tick along the top edge now, the way a
selected tab is marked, which is what it is.

**A stretch with no traffic is drawn, not left blank.** An empty middle with
a mark at each end reads as a broken chart; it is a route nothing called, and
now it says so — hatched, and named on hover. Clicking into one gets the
answer it deserves: either the routes that did run, or that nothing ran there
at all.

Not a dashboard builder, not alerting, not aggregates over arbitrary
dimensions, and not a time-range picker on this screen. That is the line
where this becomes a worse Datadog.
