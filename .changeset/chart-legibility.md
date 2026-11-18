---
'@reqray/dashboard': minor
---

The strip and the charts answer without being aimed at.

**The timeline strip has a shape and an axis.** It was thirty pixels of ticks
with no time reference on it at all: it could say that something happened and
not what shape it had, or when. It is twice as tall now, with five timestamps
under it, and hovering a column reads out what is in it —
`02:21 · 269 requests · 7 failed` — beside the window label rather than
instead of it.

**A drag across a route's charts zooms into it.** A window of an hour drawn
in forty-eight columns cannot be read by aiming at one of them, and "aim
better" is not an answer. Dragging narrows all three charts to the stretch
under the pointer; one click goes back to the whole window. A click is still
a click — anything under a hundredth of the plot's width picks the column
rather than zooming to a sliver of it.

**And they open smoothly.** The panel used to arrive one line tall and jump
to full size when the history came back; it reserves its height now and
settles in over the shared slow duration, which people who ask for less
motion do not get at all.

Two states that were one: a route's series and a moment's activity both used
`null` for "still reading" and for "nothing to show", so a zoom into a quiet
minute left the panel saying "reading this route's history…" for ever. Both
say which it is now, and the panel's header — with the way back out of the
zoom — stays on screen whichever it is.

Also fixed: the requests screen pinned its strip to a fifty-two pixel grid
row, so the axis added under it was simply cropped. The row sizes itself.
