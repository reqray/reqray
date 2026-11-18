---
'@reqray/core': minor
---

Process state gets owners, and three real bugs go with it.

`state.ts` used to declare one record of sixteen unrelated fields — the
request context, two SQL caches, a log sink, a boolean, two counters, a
callback map — whose only shared property was "must not be duplicated", and
every module that needed one field imported the whole thing. It now hands
out named, typed slots, and eleven modules declare the state they own.

**A memory leak.** The map of learned callsite origins had no ceiling, while
every cache beside it had one from the start with a comment about
applications that build SQL dynamically. Such an application leaked a record
per distinct statement, for the life of the process.

**Two split brains.** The outgoing-HTTP fingerprint cache lived in a module
variable, so a dual ESM/CJS load gave two caches with one ceiling and half
the hits each. `explain-targets` kept its pool→id map module-locally while
the id counter was global, so one pool could take two ids and EXPLAIN could
resolve an id to the wrong pool.

**A cap that did not apply.** `shouldCaptureStack()` called with no
fingerprint looked its count up under the empty string — a key nothing ever
writes — and so answered "capture" every time.

All four caches now turn over two generations instead of clearing at the
ceiling: an application sitting just past the limit used to discard its
hottest statement with its coldest and re-scan everything until the cache
refilled.

`Reqray` gains `close()`: it stops the host monitor and flushes the transport
before closing it. `Transport` declared `flush` and `close` and nothing could
reach either. The panel gate is now checked before any of that is started.
`registerPool` is one `WeakMap` lookup rather than the linear scan its own
docstring denied, and `addSpan` builds each span once instead of allocating a
shared object and spreading it.
