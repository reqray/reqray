---
'@reqray/core': minor
'@reqray/dashboard': minor
---

A Project tab: what is instrumented, and what the settings actually are.

The startup report has always been printed once, at boot, into a terminal —
which is the wrong place for it. "Why do I not see my SQL" is a question asked
hours later, by which point the line has scrolled away, and in a container it
was never on screen at all. `GET /api/project` serves the same report, and the
panel has a screen for it, with the ✘ lines carrying the same hints the
terminal gave.

Beside it, the settings in force rather than the ones you think you passed:
the sampling share, the store and how full it is, the per-request limits, which
of replay / EXPLAIN / blame / SQL values are on, the detectors with their
thresholds, and the exact list of header and body fields masked before anything
is written — the list to check when a custom entry was added and something
still looks unmasked.

And the application itself: name and version from its manifest, the directory
Reqray treats as project code, and the branch, commit and dirty state it is
running — the first question anyone asks of a staging panel.

Nothing secret goes on the screen. Environment variables are not read, and the
panel's gate is reported as present or absent, never by value; both have tests
that say so.
