---
'@loupe/instrumentation-undici': minor
'@loupe/instrumentation-prisma': minor
'@loupe/transport-memory': minor
'@loupe/instrumentation-pg': minor
'@loupe/dashboard': minor
'@loupe/register': minor
'@loupe/fastify': minor
'@loupe/express': minor
'@loupe/core': minor
---

First release, aimed at local development.

Automatic instrumentation via `node --import @loupe/register`: Fastify
and Express, the `pg` driver (and therefore Prisma 7, which goes through
node-postgres), outgoing HTTP via `diagnostics_channel`.

The N+1 detector shows the file, the line, and the time saved. The dashboard:
a list with filters and a live feed, waterfall, SQL with highlighting, bodies
and headers after masking, request replay with metric comparison, exception
groups.
