---
'@reqray/dashboard': minor
'@reqray/core': minor
---

Routes: what fired on each endpoint, and the shape of its traffic

The routes table ranked endpoints by cost and said nothing about why any of
them cost that. It does now: a FINDINGS column carries the detectors that
fired on each route — the reason to open this screen — and sorts by what
those findings cost rather than by how many kinds there are, because one N+1
worth a second outranks three cheap duplicates. Muted patterns are left out:
muting is presentation, and a badge is a shout.

A TREND sparkline cuts every route into the same ten columns of the same
window, so two rows are comparable by eye: steady, bursty, or called twice
and never since. It reddens when something failed in the window, and sorting
by it puts the routes that are busy now above the ones that went quiet.

TIME SHARE went neutral except for the single worst route. A bar that
reddens with its own figure calls a quiet screen's biggest share a problem.

Opening a route now says what the charts cannot. One sentence when the shape
deserves one — every call costing the same is a constant in the code rather
than load; a tail many times the median is where the story is — and silence
otherwise, because a tool that says something about everything says nothing.
Under it, the route's top finding with its call site as a link into the
editor: the charts say when it was slow, this says whether anybody already
knows why.
