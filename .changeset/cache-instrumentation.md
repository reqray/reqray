---
'@reqray/instrumentation-ioredis': minor
'@reqray/core': minor
'@reqray/register': minor
'@reqray/dashboard': minor
---

Redis, for real: `@reqray/instrumentation-ioredis`.

The panel has had a Cache tab and a duplicate-read detector for a while, and
nothing to fill them with. Now `ioredis` 5 and 6 are instrumented — standalone
clients, cluster clients and pipelines alike — with no configuration beyond the
`node --import @reqray/register` that was already required.

**What a cache span holds.** The command as the driver sent it (`GET`,
`HGETALL`, `EXPIRE`), the key, how long it took, whether it hit, and the line
of application code that made the call. Cache **values are never recorded** —
in any mode, with no opt-in to change that: `SET session:9 <jwt>` is recorded
as `SET session:9`. Which arguments are a key is decided per command, and a
command Reqray does not recognise records its name and nothing else, which is
what keeps `AUTH` and custom commands from leaking through.

**The duplicate-read detector now has teeth.** `dup_cache` groups by the whole
call rather than the key alone, so two reads of different fields of one hash
are two reads, not a false positive; a command that reads *and* removes
(`LPOP`, `SPOP`) is never called a duplicate, and neither is one whose member
argument cannot be recorded. When it does fire, the finding names both the
line it fired on and the other line that read the same thing.

**Why patching and not `diagnostics_channel`.** ioredis publishes a tracing
channel since 5.11, and its arguments arrive sanitized: `HGET`, `HGETALL` and
`MGET` come through with the key replaced by `?`. A key-level cache view cannot
be built on that, and a detector grouping by `?` would report every hash read
in a request as one duplicate. So `sendCommand` is wrapped instead, and the
value positions are dropped here — deliberately, per command.

The demo application gained `GET /api/profile/1`: a cache in front of the
database, with one read of the same key too many. It runs against an
in-process Redis-compatible server by default, so it still needs no Docker;
set `REDIS_URL` to point it at a real one.
