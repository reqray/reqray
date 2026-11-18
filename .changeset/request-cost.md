---
'@reqray/protocol': minor
'@reqray/core': minor
'@reqray/store-sqlite': minor
'@reqray/dashboard': minor
---

What a request cost to run, on every row.

The waterfall answers how long a request took. It never answered what running
it cost, and the two come apart constantly: a request waiting 800 ms on a
database is cheap, one spending 200 ms hashing a password is expensive, and a
list ordered by duration puts them the wrong way round. The demo has both —
`/api/report` waits 854 ms for 6% of a processor, `/api/register` burns 234 ms
for 100% of one — and until now the panel drew them as the same kind of slow.

Every request now carries a `cost`: processor time in its window, that time as
a share of the wall clock, the garbage collector's time inside it, and how
many other requests shared the window. The list has a CPU column beside the
duration, on the same yardstick, because the two are only useful read
together — a long bar next to a short one is a request that waited, two long
bars are a request that worked. It sorts, and the detail header says the same
thing in words.

Measured at the edges of the request with `process.cpuUsage()`, which costs
0.28 µs a call, so it is always on rather than sampled and nothing here is a
setting.

**What it does not claim.** Retained memory: there is no way in V8 to ask what
a request still holds, and a number invented for that column would be wrong in
exactly the cases somebody would act on it. What is measured instead is the
collector's time in the window, which is what allocation pressure actually
costs the request that causes it.

`cpuShare` is deliberately uncapped. `process.cpuUsage()` counts every thread
the process has, so a request the libuv pool worked for genuinely spends more
processor time than wall time; the panel reports 138% and says more than one
thread worked for it, rather than rounding the most interesting reading on the
screen down to 100%. Where other requests shared the window, the figure
belongs to the window and the panel says so instead of dividing by a guess.

Records written before this have `cost: null` and read as unmeasured — never
as free.
