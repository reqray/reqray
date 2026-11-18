---
'@reqray/protocol': minor
'@reqray/dashboard': minor
'@reqray/core': minor
'@reqray/cli': minor
'@reqray/store-memory': patch
'@reqray/store-sqlite': patch
'@reqray/transport-file': patch
'@reqray/transport-http': patch
---

One wire contract.

`@reqray/protocol` now holds every panel response type, not the half that
happened to be extracted first: exceptions, routes and their charts, the
timeline and the activity behind one of its columns, EXPLAIN, replay and
blame, and the project report down to diagnostics, pools and retention.
Core imports them back and re-exports them, so nothing downstream changes.

The dashboard imports that contract instead of transcribing it — `api.ts`
falls from 1 041 lines to 529 — which fixes two bugs the hand-copy had
already produced. A truncated response body reported the capture limit as
its own size, because the copy lacked the `bytes` field recorded for
exactly that reason. And `isRunEvidence` narrowed to a merged evidence
type that still admitted the `duplicate` kind it had just excluded; a new
detector kind is now a compile error rather than a hole in the waterfall.

`@reqray/cli` moves `@reqray/protocol` into its dependencies: its published
types import it, so `import { ReqrayClient } from '@reqray/cli'` failed to
compile. The transports name the contract in their own manifests rather
than reaching it through core.

`@reqray/core` describes itself accurately — "no third-party runtime
dependencies", since its one dependency is types that emit nothing — and a
test now reads the built bundle to keep that true.
