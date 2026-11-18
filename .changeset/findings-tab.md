---
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
'@reqray/protocol': minor
'@reqray/dashboard': minor
'@reqray/core': minor
---

Findings: occurrences become a work list

Every detector firing was recorded somewhere — a flag on a list row, a count
in the status bar — and none of it added up to "here is what to fix". The
new Findings tab does: occurrences group by detector and code location, so
two routes both firing N+1 at the same line are one row, and eight hundred
occurrences are the handful of problems they always were. Sorted by
recoverable time, never by recency — recency is the request list's question.

Each pattern is one plain sentence, the code location as a link into the
editor, the routes it fired on, how often and how recently, and the time
that comes back if it is fixed — drawn as a bar against the loudest pattern
in view. A row expands into the hint, the three worst requests (each opens
the detail), and exports: markdown, JSON, or a GitHub-issue body, copied to
the clipboard rather than posted anywhere.

Patterns carry a state. `ack` and `muted` are the reader's own bookkeeping,
kept in the store — the SQLite history remembers them across restarts.
Muting is presentation, not detection: the detector keeps running and the
record keeps its findings, but a muted pattern stops flagging rows in the
list and the live feed. `fixed?` is computed, never stored — the pattern has
been silent since the file it points at last changed — and wears its
question mark honestly.

The tab shows a dot while unacknowledged patterns exist, and the status
bar's findings count now leads here, scoped to the window the list is
looking at. An empty tab names every detector and the thresholds it runs
with, because silence from a disabled detector is not a clean bill of
health.

Under it: `/api/findings` and a `findings()` reader beside `history()` —
stores hand over one row per occurrence, from the flagged minority only, and
the grouping happens once in the core. `/api/meta` now reports the resolved
detector settings.
