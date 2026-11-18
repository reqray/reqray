---
'@reqray/protocol': minor
'@reqray/core': minor
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
'@reqray/dashboard': minor
'@reqray/cli': minor
---

Self time, and how this call compares.

The panel answered "the database took 26 ms". It did not answer "and where
did the other 400 ms go", which for a Node backend is the more common
question — and it did not answer "is 400 ms even unusual here", which is the
question a reader asks before the first one.

**Where the time went, in one line.** Every record now carries `timing`: SQL,
outgoing HTTP, cache, and the time covered by no instrumented work at all.
The detail header reads `30 ms · 26 ms sql · 3.8 ms your code`, and
`reqray show` prints the same three figures in a `TIME` block.

These are unions, never sums. Four 100 ms queries fired together cost a
120 ms request 100 ms of it, not 400 — a sum there is not merely imprecise,
it is larger than the request that contains it. When the layers overlap the
panel says so, because the parts can then add up past the whole.

**And what did the work.** Every span carries `selfMs`: its duration minus
the stretch its children occupied. Under the waterfall is a table ranked by
it, because ranking by duration is what everyone tries first and always
returns the same useless answer — the handler at the top, since it contains
everything and did none of it. Identical spans collapse into one row the way
the waterfall draws them as one bar: `150× SELECT line_items · 86% · 26 ms`.

**Is this call unusual?** `GET /api/requests/:id/baseline` compares a request
against the route's own history and says: faster than average, typical, or
slower than 95% of calls. Both stores answer it with a query for that route
rather than by reading a page and sorting it. Under twenty comparable calls
there is no ninety-fifth percentile worth the name, so none is reported and
nothing is ever called slow; under two there is no card at all. A tool that
calls an ordinary request slow teaches you to stop reading the card.

**Also fixed:** the budget detector contradicted the header directly above
it. It summed span durations and named the first layer above zero, so a
request that spent 857 of its 867 ms in application code was advised that
"1% of the time went to SQL — start there". It reads the same timing now and
names the layer that actually holds the time.

Records written before this exist in stores on disk; the panel fills their
timing in on read rather than showing a blank header for yesterday's request.
