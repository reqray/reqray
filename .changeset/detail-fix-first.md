---
'@reqray/protocol': minor
'@reqray/dashboard': minor
'@reqray/core': minor
---

The detail answers "what do I change" before it explains itself

The costliest finding now leads the request detail as THE FIX: what fired,
what it costs this request, the statement, the line of code as a link into
the editor — and the ways out. A fix prompt scoped to this one finding for
whatever assistant is at hand, "show the N calls" landing the SQL tab on
exactly that statement, and mute, which files the pattern away through the
findings tab's own state.

Where a template is confident, the card carries a suggested diff. The first
template is N+1 on pg: the trailing equality folded into `ANY($n)` — one
query instead of a hundred and fifty — with the arithmetic in the footer and
"replay & verify" wired into the replay that fills the Compare screen. The
diff is over the statement the panel captured, never over code it did not
see: an ORDER BY tail, a LIMIT, an unknown placeholder, and there is no
diff, because a wrong fix is worse than none.

The time line became the TIME SPLIT bar: one 16px stack in the waterfall's
own colours, each layer's share visible before any number is read.

And the detail grew its context rail — the request seen from outside
itself: the route's distribution as a strip with this call as the marker
(the baseline now reports p50/p99/max alongside avg and p95), who issued it
when a test did, and NEARBY IN TIME — the requests that ran around it, each
one click away. On a narrow window the rail folds into a `context` toggle.
