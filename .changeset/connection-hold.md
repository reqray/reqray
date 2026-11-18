---
'@reqray/instrumentation-pg': minor
'@reqray/protocol': minor
'@reqray/dashboard': minor
'@reqray/core': minor
---

What the connection was doing

A query that took 340 ms because it waited 338 of them for a free connection
is drawn exactly like a query that worked for 340, and the reader goes off to
add an index that will not help. Reqray now measures the queue in front of a
query and the time a transaction holds a connection open — the two things a
waterfall cannot show, and the two the pool runs out of connections for.

**The queue.** `Pool.connect` is instrumented, and the wait lands on the query
as `waitMs`, drawn as a hatched lead-in on its own bar rather than as another
row. It is recorded only when the acquire genuinely queues: an idle connection
handed over on the next tick is scheduling, and a brand-new connection is TCP
and authentication, which is fixed by warming the pool rather than enlarging
it. The `pool_wait` finding fires when a query waited longer than it ran, and
says what to look at upstream instead of telling anybody to raise `max`.

**The hold.** Spans now carry the physical connection they ran on, which turns
`BEGIN` … `COMMIT` into a transaction without recording anything new. The
`transaction_hold` finding names the classic that is invisible to anything
seeing only SQL or only outgoing calls: a payment API called with the
transaction still open, two hundred milliseconds of a connection nobody else
can use. It points at the call, not at the `BEGIN`, and reports what was held
rather than a saving — moving the call out does not make that request faster,
it gives the connection back sooner.

The Project tab gained the pools themselves: size, connections open, and
whether anything is queueing right now.

**And a repair worth more than the feature.** A query that had to wait for a
connection was being filed under whoever released one — a request that had
already finished, or no request at all. Five queries issued through
`Promise.all` on a pool of one arrived in the panel as one. The queue now
carries the request across, along with the callsite it was issued from, and
the N+1 detector judges a run by when its queries were *issued* rather than
when they got to run — so a pool with one connection no longer turns
`Promise.all` into an N+1.

The overhead benchmark is unchanged: p99 identical across the matrix, with the
queue check reading four numbers and allocating nothing.
