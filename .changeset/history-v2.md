---
'@reqray/protocol': minor
'@reqray/dashboard': minor
'@reqray/core': minor
---

History: the period before, what changed in this one, and two columns compared

The figures above the chart already claimed "+21% from the last hour". Now
the chart says it too: the period immediately before is drawn behind the
line as a ghost, cut into the same columns and sharing the line's own scale,
so worse-than-last-week is a shape rather than a percentage. It is the
primary metric only — a ghost behind each of two lines is four lines on one
chart — and the new `against` control turns it off. The companion-metric
control is now called `with`, which is what it always meant.

The chart carries annotations at the moments the panel actually witnessed: a
detector pattern seen here for the first time, and this process starting. No
inferred deploys and no guessed incidents — an annotation is a claim that
something happened, and a wrong one sends somebody looking for a change
nobody made. They are thinned to a handful, because eight rules inside one
second are a hatch pattern rather than an annotation.

Beside the plot, the rail now answers what changed in the window: the
patterns first seen inside it, the routes that strayed from their usual, and
a way into the findings tab scoped to exactly this stretch.

And two columns can be held side by side: pin one, shift-click another, and
both bands sit on the chart while the rail states each one's calls and the
drawn metric's value. A plain click is a fresh question and drops the
comparison with it.
