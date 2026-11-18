---
'@reqray/core': minor
'@reqray/register': minor
'@reqray/instrumentation-pg': minor
'@reqray/instrumentation-undici': minor
'@reqray/dashboard': minor
'@reqray/express': minor
'@reqray/fastify': minor
---

Zero lines of code, a sequential-HTTP detector, and EXPLAIN from the dashboard.

**Standalone mode.** `node --import @reqray/register app.js` — and the dashboard
works without a single code change: incoming HTTP is intercepted through the
built-in `diagnostics_channel`, and the dashboard comes up on a neighboring
port (4310). Any adapter automatically turns the mode off. No request bodies
and no Replay — the limitations are stated right in the startup line.

**`sequential_http` detector.** An `await fetch` loop over a list is the same
disease as a query in a loop: the finding shows the code line and the savings
from `Promise.all`. The heuristics are the same as for N+1; different URLs in
a row are not flagged — a data dependency is invisible from timing alone.
Along the way, outgoing HTTP spans gained the code line of the call — the
`fetch` wrapper captures the stack while the user's frame is still on it.

**EXPLAIN from the dashboard.** Click an SQL span to get the plan with hints
("Seq Scan with a filter — an index may be needed"). The SQL comes from the
record, `ANALYZE` is never used, parameterized queries go through
`GENERIC_PLAN` (PostgreSQL 16+), and the plan runs on the same pool that
executed the query. Outside local development it is enabled only explicitly:
`reqray({ explain: true })`.
