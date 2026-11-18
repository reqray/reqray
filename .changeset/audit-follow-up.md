---
'@reqray/core': minor
'@reqray/server': minor
'@reqray/transport-http': minor
'@reqray/dashboard': patch
'@reqray/register': patch
---

Follow-ups to the audit.

- `apiKey`, `signature` and `cvv` join the default mask list for bodies and
  query strings.
- The startup report says when the panel has no gate and so answers its own
  machine only, and how to open it.
- `@reqray/transport-http` caps its queue by size (`maxQueueBytes`, 8 MB) as
  well as by count, and honours `Retry-After`.
- The collector answers 429 with `Retry-After` once eight batches are on
  their way in.
- A live feed whose reader has stopped reading is dropped past 1 MB of
  backlog instead of growing in the application's memory.
- Dashboard: an EXPLAIN answer no longer lands on a different request; the
  list re-reads itself after a pause or a visit to another screen; pinned
  requests stay out of time-scoped lists; the compare verdict's percentage
  reads the same in both directions.
