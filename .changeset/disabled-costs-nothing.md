---
'@reqray/fastify': patch
'@reqray/express': patch
---

A disabled Reqray now registers nothing at all.

`enabled: false` used to build the runtime and add the request hooks anyway,
and check the flag from inside them: the hooks ran on every request, split the
URL and allocated the object they were checked from before returning early.
Not recording is not the same as costing nothing, and the published "disabled
Reqray costs zero" only holds if there is no hook. Both adapters now decide once
at registration — Fastify adds no hooks, Express hands back pass-throughs — and
both have a test that says so.

Found by re-running the overhead benchmark rather than by reading the code,
which is what the benchmark is for. The published numbers were re-measured on
the same hardware and now show the spread across three runs instead of one
lucky number.

The demo application also drives itself now: it calls its own routes on a loop
covering every surface the panel has, so the panel is full the moment it is
opened. `DEMO_TRAFFIC=off` stops it.
