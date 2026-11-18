---
'@reqray/core': patch
'@reqray/dashboard': patch
---

The timeline strip opens on the traffic, not on the silence.

A store that keeps a week and an application that ran for an hour drew a
strip with sixty-two empty columns and everything squeezed into the last one.
True, and useless: the shape of what is happening now was one mark wide.

The strip is now drawn over the newest run of traffic — the stretch at the
end, with silences shorter than a tenth of the strip treated as pauses inside
it rather than as gaps between sessions — and says which stretch that is:
`last 2h 23m · drag to zoom`. One click switches to `5d 6h kept`, and back.
It changes only what is *drawn*: the list is not filtered by it, so nothing
disappears without being asked for.

It only fires where it helps. A store whose traffic already fills its range
has nothing to crop, and neither has a session shorter than ten minutes — a
dev sitting has pauses in it for a coffee, a restart, a test run, and none of
them separate one session from another.

`GET /api/timeline` takes an optional `from` and `to` for this, which is also
how a panel can ask for any stretch it wants to draw.
