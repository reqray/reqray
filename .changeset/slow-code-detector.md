---
'@reqray/protocol': minor
'@reqray/core': minor
'@reqray/dashboard': minor
---

`slow_code`: the stretch of a request that nothing accounts for, with an
address.

Every other detector reasons from something Reqray watched happen. This one
reasons from an absence — the stretch where no query, no call and no cache
read was in flight — which for a Node backend is the most common answer once
the database has been ruled out, and the one a waterfall shows worst, because
the evidence for it is empty space. `slow_budget` could already say "82% of
this request is not covered by any instrumentation" and stop there, naming the
fact and never the place.

The finding is addressed by what brackets it — 400 ms between the query at
`orders.ts:18` and the one at `total.ts:47` — and named by the innermost
handler or middleware it sits inside, never the request-wide one, which would
amount to reporting that the time was spent inside the request.

An empty stretch has a second explanation, and it is not the application's
fault: I/O Reqray has no instrumentation for. What separates the two is not how
much of the request was covered but where the silence sits. A process Reqray
cannot see is not slow in one place — it is full of holes, one for every call
it has no instrumentation for. A process Reqray can see, with one slow function
in it, has exactly one. So the finding is made only when the stretch accounts
for most of the request's silence, and never for a request nothing was
recorded in at all. A tool that blames your code for its own blind spot is a
tool nobody keeps installed.

It does not claim CPU. The host monitor measures the event loop and says in as
many words that it can never attribute it to one request; a detector that
quietly did so anyway would contradict the screen above it. What is reported
is a stretch of the request's own wall clock.

How far the heading goes is decided structurally: with instrumented work on
both sides, the silence is demonstrably *between* two things Reqray watched, so
it reads "852 ms of your own code". At either edge of a request it does not —
a leading stretch shares its ground with parsing, a trailing one with
serializing the response — so those read "nothing accounts for" and the hint
keeps the alternative open. The heading never claims more than the hint below
it is prepared to defend.

Also: the largest single stretch rather than the sum of them, so scattered
async overhead cannot add up to a defect that points nowhere; queueing for a
connection is accounted time, not silence, which leaves it to `pool_wait`; and
`isContainer` moved out of `timing.ts` as an export rather than being written
a second time.
