---
'@reqray/core': major
'@reqray/express': patch
'@reqray/fastify': patch
'@reqray/server': patch
'@reqray/register': patch
'@reqray/store-memory': patch
'@reqray/store-sqlite': patch
---

`@reqray/core` splits into three entry points.

Importing `@reqray/core` to time a query used to link the panel with it: the
`git blame` subprocess runner, the dashboard's static file server, replay's
call back into the application. The recording core and the panel-reading
core were one module graph joined by nothing but a barrel file — nothing on
the recording path ever imported `panel/`.

- `@reqray/core` — recording. Its CJS bundle no longer contains
  `require("child_process")` or `createReadStream` at all.
- `@reqray/core/panel` — the router, the aggregates, the exports, EXPLAIN,
  replay, blame. Everything that reads back what was recorded.
- `@reqray/core/testing` — the twelve `reset*`/`clear*` hooks a suite needs
  to scrub the process between files. They are not part of what the library
  does and no longer appear on its public surface.

**Breaking:** panel symbols move to the `/panel` subpath and the reset hooks
to `/testing`. `REPLAY_HEADER` stays on the main entry — it is read off an
incoming request by the adapter, on the recording path.

Three smaller changes ride along. The detector list lives in one registry
object instead of three places nothing kept in agreement, and the option
types are derived from it, so a new detector is one line; an option a
detector does not have is now refused with a warning naming the ones it
does. `NODE_ENV` is read once: an explicit `mode: 'production'` switches
recording off, where before `enabled` consulted the environment separately
and could disagree with the mode decided from it. And a `RequestScope`
carries only the recording settings, so an instrumentation wrapper cannot
reach the panel's gate or the retention policy's file handles.
