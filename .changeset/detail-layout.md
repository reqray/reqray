---
'@reqray/dashboard': patch
---

The request detail stacks its strips again.

The layout pinned three grid rows — a header, one optional strip, and the
body that takes the rest. That quietly meant "the third child fills the
screen", and the third child stopped being the body the moment a strip was
added above it: the breakdown line and the host-pressure card pushed the test
strip into that row, and one line of text ended up floating in the middle of
four hundred empty pixels.

It is a flex column now, which has no opinion about how many optional strips
there are, and a browser test asserts that a strip is the height of the line
in it whatever else is on the page.
