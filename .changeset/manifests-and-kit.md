---
'@reqray/core': minor
'@reqray/instrumentation-pg': patch
'@reqray/instrumentation-ioredis': patch
'@reqray/instrumentation-undici': patch
'@reqray/register': patch
'@reqray/express': patch
'@reqray/fastify': patch
'@reqray/server': patch
---

Manifests that tell the truth, and one place for the patching rules.

A Nest application on Fastify installed `@reqray/express` through
`@reqray/nestjs` and got an unmet peer dependency for Express, a framework it
does not use — and the reverse on Express. Both adapter peers are optional
now, which is what every instrumentation already did.

`@reqray/server` declared Node >= 20 while hard-depending on
`@reqray/store-sqlite`, which needs 22.5: `EBADENGINE` on every Node 20
install. Its floor matches the store it ships with.
`@reqray/instrumentation-ioredis` claimed `>=5 <7`, promising an ioredis 6
that does not exist and would have been patched untested; it says `>=5 <6`.
`@reqray/instrumentation-prisma` is no longer published — it was an empty
module that installed core and asked for a Prisma peer it never patched. Its
reasoning stays in the repo, and README already says what it said.

`@reqray/core` gains `patchMethod`, `unpatchMethod`, `isPatched`, `settle`,
`settleCallback` and `guarded`: the plumbing all three instrumentations kept
a copy of. Idempotence is keyed per method name, so two patches on one
prototype can no longer share a flag — `Pool.prototype` needed a second
symbol pair to work around exactly that. Driver knowledge stays in each
instrumentation; only the mechanics moved.
