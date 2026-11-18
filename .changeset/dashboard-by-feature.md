---
'@reqray/dashboard': minor
---

The dashboard is organised by feature.

Everything lived in one place: eighteen loose modules at the root, a flat
`components/` bag, and two screens of 1 256 and 1 420 lines holding their own
sub-components, hooks, helpers and pure functions inline. The import graph
disagreed with that layout — eleven of sixteen components had exactly one
consumer.

Each screen is now a directory that owns its parts, its helpers and its
stylesheet, under a rule with no exceptions: the screen and its stylesheet at
the root, components in `parts/`, everything else in `lib/`. `app/` holds the shell, `api/` the client, and `shared/` what
genuinely crosses screens — the chart peek, the waterfall labelling, the
formatters, and `shared/list/`: the request list with the filter, tokens,
saved views and sort that narrow it.

Both monoliths came apart. The detail screen is 287 lines over eleven files —
its boundaries were already drawn, they were simply all in one file. The
history screen is 836: its head, rail, metric tables, plot geometry and wheel
gesture are their own modules, and what remains is the plot with the pointer
state machine that drives it.

The plot's pointer state machine — sixty lines of hover, click, shift-click
and drag-to-zoom written inline in a JSX prop — is a hook in `shared/chart/`,
shared by the history plot and the route charts. Extracting it fixed two
things the copy hid: the route charts held the drag origin in state rather
than a ref, so a click could be lost under load, and the click threshold was
a share of the width, which is a different gesture on a chart that spans the
screen than on one of three side by side. It is five pixels on both now.

Every component declares its props as a named `interface`, rather than as an
object type written after the colon: fifty-nine of them did the latter, which
puts the shape of a component's contract behind its destructuring.

Sixteen nested ternary chains of three branches and more are named functions
with early returns. Eleven picked a value — the deepest one of four strings
across seven lines of JSX. The other five picked what to render, and the
worst was the panel's own body: eight branches over sixty lines, so the
question "what does the routes screen get" was answered five conditions deep
and the fallback was a paren at the bottom of the file. It is a `switch` on
the screen now, one case each, and the two that need a subject say so.
A chain that has to be read from the inside out is a chain nobody checks.

Handlers with a body are named functions the prop is handed, not arrows
written inside the JSX: thirty-eight props held one — a drag's three
pointer phases, the row click that means pin, compare or open depending on
what was hit, the metric select that has to drop a companion it no longer
shares a story with. A prop is where a handler is used; it is not where one
should have to be read. The Requests tab's own condition was written as a
list of exclusions, so any screen added to the union would have lit it by
default; it names the three screens it stands for now.

The nav is a component over one list of the panel's destinations, shared with
the command palette — which had its own copy of the same six screens, and a
screen only one of them knows about is a screen half the panel cannot reach.

An iteration that computes is a component. Twelve `.map` bodies worked out
values before rendering — a share of the total, a blame line, a column index,
a plan, before-and-after readings — inside the JSX of the screen that held
them. Each is a component now, taking the item and what it needs to render
it: the frame of a stack, a statement, a route, a self-time row, a detector, a
comparison line, a finding, a group of rows. Two of them were casting their
way out of a tuple array — `[['A', pinned], ['B', against]].map(...)` with an
`as` inside — where two calls of one component say the same thing and the
compiler checks them.

A question the UI asks is a named one, and so is the data it asks about.
The rail's "is there anything to show" was three clauses and a null check
written into the JSX, next to a `.slice(0, 4)` whose 4 was nowhere explained;
the peek asked its three-clause question twice, once for the rows and once
for the hint under them. The cache tab looked the same key up twice per row to
decide whether to mark it, and the routes charts spelled out "traffic rose
across the board" as `(rateRatio ?? 1) >= 1.5` in two places that have to
agree. Two screens had their own copy of "a detector's thresholds as one
line".

The API client is split by endpoint group the way `@reqray/protocol` is —
`client`, `requests`, `findings`, `routes`, `history`, `project`, `tools` —
behind one barrel, so a reader after "how does the panel fetch routes" opens
forty lines rather than scrolling five hundred.

The chart language — every `.chart-*` and `.peek-*` rule — used to sit in
whichever screen happened to need it first, so the history screen was styled
by `routes.css`. It has a sheet of its own now.

The shell is composition, not accumulation. `App.tsx` had grown into the
place where everything homeless lived — six effects, the topbar's ninety
lines of JSX, the palette's feed. The topbar is a component; the hash⇄state
round trip, the theme stamp, the global shortcuts and the findings dot are
hooks under `app/`, each owning its one subscription; the meta read goes
through `useLiveQuery` like every other read. What remains in `App.tsx` is
what a shell is: the state that belongs to no screen, the wiring between
screens, and the switch that says which one is up.

One module, one component. Nineteen files each held two to seven components
with their helpers and sometimes a hook between them; every component now
lives in its own file under its feature's `parts/`, hooks and pure helpers
under `lib/` or `shared/` — `usePeek`, the peek's request list, the
waterfall's bar and badge, the charts' geometry, the burst grouping, a
pattern's wording. The one deliberate exception is the context module, where
a provider and its two accessors are a single pattern. What a file is named
is now what it contains.

Server state is one hook rather than eight hand-rolled copies of it.
`useLiveQuery` owns the shape every screen was writing out — ask, abort on
unmount, re-ask on a cadence while live, and decide what a failure leaves on
screen — and the fetcher's identity is the question: wrapped in `useCallback`
with the inputs that define it, a new fetcher resets the answer while the
same one re-asked swaps the fresh answer in without blanking. Routes,
findings, exceptions, project, the detail's baseline and its rail now say in
one line what each used to say in twenty, and a screen's failure policy —
keep the page through a blip, or show the apology — is a named option
instead of a subtly different `catch` per file.

What the topbar decides stopped being hand-delivered. `live` and the toast
travelled as props through every screen's interface to whoever finally used
them; they are two contexts now, read where they matter, and a component
deep inside a feature no longer widens three interfaces to say one line at
the bottom of the screen.

The list's row is memoised — with the measurement that justifies it. At a
hundred rows and seven arrivals a second the live feed cost about a thousand
row renders a second, every arrival repainting every row; every prop was
already a primitive or a stable callback, so `memo` alone took the same
traffic to eighteen a second — only the rows that changed.

The overlays trap the keyboard. Tab walked out of the command palette into
the page behind it; both dialogs now cycle within themselves and hand focus
back to where it was taken from. The `copied ✓` confirmations share one
`useFlash` that survives double clicks and unmounting, instead of three bare
`setTimeout`s that did neither.

Each screen now renders inside an error boundary. A throw during render used
to unmount the entire panel — a blank page, from the tool whose job is
explaining other software's failures. Now the crash stays on the screen it
happened on: the message names the error, the tabs above keep working, and
coming back to the screen retries. The axis ticks under the two timelines
also stop colliding when the store holds a single request — five labels at
one instant shared one key.

Beyond the two fixes above, no behaviour changed. Nothing is exported from
this package, so nothing downstream moves.
