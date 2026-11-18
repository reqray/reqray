---
'@reqray/dashboard': patch
---

Waiting, emptiness, and the last coat of motion

A table now waits as a table. Placeholder rows at exactly the height the
real ones will have — on the request list, the findings tab and the
exceptions screen — so the page does not jump when the answer lands, and
never a spinner. One real flaw fell out of it: the list used to show "No
requests recorded yet" while its very first page was still in flight, which
is a claim about the store made before the store answered.

A filter that matches nothing now names the question rather than the answer.
The applied terms are listed one by one — the search box speaks tokens, and
`status:5xx` and the word typed beside it are two separate narrowings to
take back — with the way to clear them beside.

And the motion settled into one system. An arriving row slides its last few
pixels and flashes once, both at the same time rather than in sequence; above
five arrivals a second nothing animates at all, because an animation that
cannot be followed is worse than none. The detail's tabs cross-fade instead
of jumping. Every entrance runs on the shared easing, and all of it still
disappears entirely under `prefers-reduced-motion`.
