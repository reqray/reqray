---
'@reqray/protocol': minor
'@reqray/core': minor
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
'@reqray/dashboard': minor
'@reqray/cli': minor
---

The process underneath: event-loop delay, per request and per route.

A route that got slower with no change to its span timings is not a slow
route. It is a process that could not get scheduled — and that is invisible
in a waterfall, where every span is individually fast and the time is
*between* them.

```
341 ms · 2.0 ms sql · 339 ms your code · loop behind 335 ms
```

That is the demo's registration endpoint: two queries of a millisecond each,
and a password hash that holds the event loop for a third of a second. No
span can show it, and until now neither could Reqray.

**Measured as the process, never as the request.** Under concurrency the code
that blocked the loop is usually somebody else's, so the panel says "the loop
was behind by this much while this ran" and never "this request burned this
much CPU". libuv reports the whole sampling interval, so an idle loop reads
as eleven milliseconds at a resolution of ten; the baseline comes off, and
what is left is the lateness. Under one sampling interval nothing is said at
all — that is the granularity of the measurement, not an event.

**Under host pressure, on a route.** `GET /api/requests/:id/baseline` also
answers whether this route is slower when the host is struggling: its own
calls, split by whether the loop was in its *own* top quartile at the time.

> When event-loop delay was over 37 ms, this route's p95 was 1.8× slower —
> 24% of 100 calls landed there.

Elevated is never a fixed threshold: a delay that is alarming for one service
is idle for the next, and the only baseline worth comparing a process against
is the same process. The cutoff is printed so the claim can be checked, both
halves are shown so the size of the effect is visible rather than taken on
faith, and the card says outright that the two moved together — which is
evidence, not proof. A neighbour on the same box explains the shape as well.

It renders only when it holds up: the loop actually varied, at least twenty
calls on each side, and the elevated half at least half again slower. It is
absent far more often than present, and that is the design.

**What it costs.** The histogram's `mean` walks its buckets and costs eleven
microseconds a call — trivial once, and eleven milliseconds of every second
at a thousand requests. It is read at most once every fifty milliseconds,
which is nothing against a window a second long, so the cost stops scaling
with traffic: p99 with the monitor on and off is the same figure across
repeated benchmark runs. `hostMetrics: false` turns it off.

Requests recorded before this carry `host: null`, and the SQLite store adds
its column to a database that already exists rather than failing every insert
against the old shape. "Not measured" and "the loop was fine" stay different
facts everywhere, including through the store.
