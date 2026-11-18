---
'@reqray/core': minor
'@reqray/dashboard': minor
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
---

Filter by time — and a strip that spans the whole history.

With requests kept on disk, "what happened yesterday between two and three"
became a reasonable question and there was nothing to ask it with. `from` and
`to` are part of the filter now, applied by the store like everything else, so
narrowing to an hour searches the history rather than the page in hand.

**One selected stretch, however it was picked.** Dragging across the strip
above the list, clicking days in a calendar and typing exact minutes all set
the same thing, and all of it goes to the server. The new `time · …` pill
holds the named answers — last 15 minutes, last hour, last 24 hours, today,
yesterday — a month calendar where one click is a day and two are a stretch,
and a pair of fields for the minutes a calendar cannot express. Either end may
be left empty: "everything since Monday" is a question people ask. Days the
store has nothing for are dimmed, so how far back the history goes is visible
rather than guessed at.

**The strip is drawn by the store, not by the rows on screen.** It used to be
bucketed from whatever was loaded, which with a history means the last page —
a few minutes — and a strip covering a few minutes cannot be dragged back to
yesterday. Stores now offer three numbers per request (when, how long, whether
it failed) through `timeSeries()`, and `GET /api/timeline` buckets them for the
whole range. The bucketing lives in the core, so the strip and the list can
never disagree about which column a request falls in.

Fixed on the way: a filter that matched nothing replaced the entire screen with
the "no requests recorded yet" welcome — including the filter bar that caused
it, leaving no way back. An empty result now says "nothing matches — 87
recorded" inside the list, with the filters where they were and a button to
clear them. The welcome screen is for an empty store, which is the only thing
it was ever true about.
