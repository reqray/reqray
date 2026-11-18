---
'@reqray/dashboard': minor
---

The request list reads by magnitude

855 ms and 0.5 ms used to render identically — a number is a number. Now the
list carries its magnitudes: a 4px severity gutter at the frame edge (red
for errors and blown budgets, amber for any other finding — and quiet for a
muted pattern, because the gutter follows the flag), a duration bar on a
square-root scale against the slowest request in view (linear hides
everything under 50 ms behind the one slow request), the usual 2xx status
dimmed so a deviation stands out, and a SQL count that goes amber when it
reads as a loop rather than a lookup.

Identical simultaneous calls collapse into one row: same route answering the
same way, fired together — the signature of a client fanning out in
parallel. The row carries a `N×` tag and the average, expands in place, and
collapses back from a strip above its members. Sequential repeats stay
separate rows (they are what the duplicate detectors are about), pinned rows
never join a group, and the grouping is a setting, persisted and toggled
from the status bar.

The status bar's numbers became doors: slow and errors apply the filter they
count and take it off on a second click, findings still leads to its tab.
