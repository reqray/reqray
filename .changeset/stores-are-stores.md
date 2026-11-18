---
'@reqray/store-memory': major
'@reqray/store-sqlite': major
'@reqray/core': minor
'@reqray/express': patch
'@reqray/fastify': patch
'@reqray/server': patch
'@reqray/register': patch
---

The stores are called stores, and a pinned request stops vanishing.

**Renamed:** `@reqray/transport-memory` → `@reqray/store-memory`,
`@reqray/transport-sqlite` → `@reqray/store-sqlite`. Fifteen of their members
serve the panel and two are transport; calling them transports described the
five percent. `@reqray/transport-file` and `@reqray/transport-http` keep the
name they earn — they are genuinely write-only.

**Fixed:** a pin is somebody deliberately setting a request aside, and it
survived a filter on a store with a `page()` of its own while disappearing on
a store without one. The panel gave two answers depending on what was behind
it. `pageFromList` in `@reqray/core/panel` is now the single rule: the
router's fallback calls it and the memory store composes it. That fallback
also pages for the first time — it used to answer `nextCursor: null`
whatever was asked, so a store without paging of its own had no second page
at all.

Muted patterns are resolved once per panel rather than rebuilt from the
store's whole state map at every call site, including once per request
delivered over the live feed.
