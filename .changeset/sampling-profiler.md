---
'@reqray/protocol': minor
'@reqray/core': minor
'@reqray/dashboard': minor
---

The sampling profiler: which function burned the time.

`slow_code` could find the stretch of a request that nothing accounts for and
say what brackets it. It could not say what ran inside, because nothing was
recorded there — that is what makes it a stretch. On the demo it read "279 ms
of your own code, called from `src/shop.js:231`", and `shop.js:231` is the
`INSERT` the stretch *ends* at: three lines past the `pbkdf2Sync` that spent
the time. The finding pointed at the boundary because the boundary was all it
had.

With sampling on, a slow-code finding is completed from the stack samples
taken inside its own window. It now reads "220 ms in registerUser", points at
`src/shop.js:213`, and says which call inside it held the samples:

    WHAT WAS RUNNING          88% of samples on a processor
    100%  registerUser  src/shop.js:213  calling pbkdf2Sync

It also settles the question `slow_code` had to hedge. A stretch whose samples
are mostly idle was not code at all, and the finding says so and names nobody
rather than blaming whatever the sampler caught in passing.

**What a sample cannot tell you,** stated because both limits are V8's and
both are load-bearing. A profile node carries the line a function is *defined*
on, never the line running — Node omits the per-line tick counts the protocol
allows for — so the address is a function, and naming the call inside it is
what recovers the rest. And an optimised function inlined into its caller is
not on the stack at all: a small helper called in a loop can be reported as
the function that calls it. Hence a share of samples rather than a measurement
of a function, and a hint that says where to look rather than what to delete.

The flamegraph still draws span time rather than sample time, and allocation
sampling is not in yet — its samples carry a sequence number rather than a
timestamp, so attributing them to one request needs the profile rotated in
slices instead of read by window.

Off outside local development, gated like replay and EXPLAIN. Sampling itself
is cheap — 7 µs on a request's p99 at a millisecond interval, against a budget
of 500 — but a profile names the application's own functions and files, which
is a decision somebody makes rather than a default they discover. The
published overhead numbers are unaffected: nothing here runs in production
unless asked.
