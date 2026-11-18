# `@reqray/cli` — output specification

The terminal client prints the same data the web panel shows, reduced to
sixteen ANSI colours. Line-oriented: every line survives scrollback, `grep`,
and a log file. No full-screen frames, no menus, no fills, no emoji.

This file is the contract the snapshot tests are written against. Numbers here
are not suggestions — a change to any of them changes a snapshot, which is the
point.

## Palette: panel token → ANSI 16

The panel is built on `oklch` with four steps of grey. ANSI-16 has one muted
step, one ordinary and one bright. What was given up is written down.

| Panel token | ANSI | Carries | What it cost |
| --- | --- | --- | --- |
| `--fg` | 39 default | Row data | Not 37 white: only *default* inherits the reader's theme and stays legible on light and dark alike. |
| `--fg2` | 37 white | Cache spans | On some themes it nearly merges with default. So it carries exactly one meaning, in one place, where a label sits next to it. |
| `--fg3` + `--line` | 90 br. black | Labels, units, rules | Two panel steps collapsed into one. What separates a label from a rule is the density of the glyph, not the colour. |
| `--acc` | 36 cyan | Handler spans, commands | The panel's accent is muted steel; ANSI cyan is far more saturated. Hence the rule: cyan means handler spans and commands that can be copied and run — nothing else. |
| `--ok` | 32 green | SQL, improvements | Same meaning as the panel. But 2xx is never green: in a stream that would put a green column on every line. |
| `--warn` | 33 / 93 yellow | Slow, findings | 33 fades to unreadable on some light themes, so yellow is never the only carrier of a fact — there is always a glyph in the gutter beside it. |
| `--err` | 31 / 91 red | 5xx, regressions | Direct correspondence; the only pair that lost nothing. |
| — | 34 blue, 35 magenta | unused | Blue goes unreadable on many dark themes and magenta has no counterpart in this data model. Reserved for plugins. |

Bright here does not mean "lighter", it means "needs attention": on a light
terminal theme bright variants render darker and more saturated than the
ordinary ones. The hierarchy is built on contrast with the background, not on
lightness, which is why it survives both themes.

## Four rules everything else follows from

**Gutter instead of colour.** Two columns at the start of every line carry
severity as a glyph: empty, `!`, `!!`. Colour duplicates them, never replaces
them. So `NO_COLOR` loses no distinction and shifts the layout by not one
character.

**Two bright elements per screen.** Bright variants belong to the finding flag
and to 5xx. A calm stream has no bright glyph at all.

**The order things are dropped.** Query string, then middle path segments,
then the query-count column, then the status column — which is kept for
non-2xx. Time, method, duration and flags are never truncated: reading the
stream is built on them.

**No fills.** No element sets a background, so the output lands on any theme.
The single exception is the inverted verdict (reverse video), which takes the
terminal's own colours and is therefore correct everywhere, monochrome
included. Reverse is not used by `watch` or `show`.

## `reqray watch` — the stream

`tail -f` for requests. One line per request, a fixed column grid, severity in
the first two columns.

```
gutter(2) SP time(12) SP method(6) SP status(3) SP path(W) SP SP duration(→7) SP queries(→4) SP flags(≤4)
```

`→` means right-aligned. Everything else is left-aligned and padded. The fixed
part is 42 columns plus a flag reserve of 8, and one column is left unused at
the right edge so a full line never wraps:

    W = terminal width − 51

The head row (`TIME METHOD ST PATH DUR Q FLAGS`) uses the same grid, muted.

### The identifier

The grid has no id column, because an id is a handle rather than something to
read: a dozen characters of noise on every line, in the place the eye scans for
the path. `--ids` adds it, between the gutter and the time, painted cyan like
every other string here that can be copied into a command — and its width
comes out of the path's budget, so nothing else moves.

Without it, a row on screen is opened through the question that found it:
`show --last`, `--last --failed`, `--last --slowest`, `--last --path /orders`.
A failed request needs neither: its second line already ends in the command.

### Widths

Only the path column is flexible. Time, method, duration and flags keep their
place so that output at 80 and at 200 columns reads the same way.

| Terminal width | Dropped | Path column |
| --- | --- | --- |
| ≥ 72 | nothing | `width − 51` |
| 64…71 | queries | `width − 46` |
| 56…63 | queries, status | `width − 42` |
| < 56 | — | refuses: one line of explanation, exit 2 |

With the status column gone, a non-2xx row prints its code in the flag column
(`500`, `404`) ahead of any finding flag: the code is the more serious fact and
the flag is one click away in `show`.

Below 72 columns the path floor is 21 characters, which is what the table
above is derived from.

### Truncating a path

Whole segments, never characters: a truncated path stays a valid path and can
still be recognised. `/api/v2/organizat…` tells the reader nothing.

1. The query string goes first, replaced by `?…`.
2. Then middle segments, replaced by a single `…` segment. The first segment
   says which service, the last says which handler; the identifiers in the
   middle are given up first.
3. If the leaf alone does not fit, it is cut with a trailing `…`.

Both `…` and the `?…` marker are muted: they are metadata the client added,
not something that was in the request.

The first segment is kept as long as the leaf still fits beside it, and the
tail grows greedily from the right: the leaf says which handler, the first
says which service, and what goes is the run of identifiers between them.

| Path column | Result |
| --- | --- |
| 49 | `/api/…/checkout-service/deployments/latest/logs?…` |
| 29 | `/api/…/latest/logs?…` |
| 18 | `/api/…/logs?…` |
| 10 | `/…/logs` |

### Flags

One flag per row, from the detector behind the costliest finding, in the
panel's own words: `N+1`, `SEQ`, `DUP`, `SLOW`. `ERR` for a request that
failed, `TEST` for one a test issued. `ERR` wins over a finding flag.

### Continuation line

The one exception to "one line per request": a request with an exception gets
a second line with the exception type, the message, the callsite, and the
`reqray show <id>` that opens it. An exception with neither type nor file would
send the reader to `show` immediately — cheaper to print it right away.

```
   └ TypeError: Cannot read properties of undefined (reading 'currency')
     services/pricing.js:61                                   reqray show 9012
```

### Reconnecting

A dropped stream prints one muted line — not silence, and not a stack trace.
Backoff doubles from 500 ms to a 10 s ceiling; a restored connection says so.

```
   … connection lost, reconnecting in 2 s (attempt 3)
   … reconnected
```

## `reqray show <id>` — one request

Waterfall first, then findings, then the response. The order is not arbitrary:
first where the time went, then what to do about it.

```
  GET /api/orders   200   275ms   09:41:02.184   #8974   from orders.spec.ts:42

  WATERFALL                    15 spans, 2 of them duplicated
                                     0ms      69ms       138ms      206ms    275ms
                                     ├──────────┼──────────┼──────────┼──────────┤
  mw     cors                        ▏                                     0.4ms
  fn     orders.list                 ├────────────────────────────────┤    268ms
  sql      47× SELECT line_items          ███████                          41.2ms  N+1
```

```
SP SP kind(6) label(28, indented 2 per level) SP bar(cells) SP SP duration(→7) SP badge
```

The scale and the ruler start at column 37 (`2 + 6 + 28 + 1`). The bar is the
only flexible column:

    cells = clamp(width − 55, 12, 60)

which gives the 45 cells of the reference mockup at 100 columns. The ruler is
five ticks with even segments between them; the scale above it prints five
times — the first left-aligned at the first tick, the last right-aligned at
the last, the rest centred on theirs. The scale line carries nothing else, so
it may run past the ruler up to the edge of the terminal; where five times
would not fit even then it prints three, then two, then the total alone.

A span shorter than one cell is drawn as `▏` in its own cell rather than
disappearing. Losing a span is worse than showing it imprecisely. A handler
span is drawn as a bracket `├──┤`, not a filled bar: it is a container, not
work, and must not weigh as much as its contents.

Spans belonging to one N+1 finding collapse into a single `47× SELECT …` row,
exactly as they do in the panel.

| Kind | Colour |
| --- | --- |
| `mw` middleware | 90 muted, label included |
| `fn` handler | 36 cyan, bracket |
| `sql` | 32 green |
| `http` | 33 yellow |
| `cache` | 37 white |

### Findings

```
  FINDINGS                     3

  ! N+1   47 identical queries in a loop                41.2ms   15% of total
        SELECT * FROM line_items WHERE order_id = $1
        services/orders.js:118, inside the serializer loop
        fix   eager-load line_items with a single IN (…) query

    dup   2 identical cache reads for one key                    0.4ms
        cache.get feature-flags:checkout-v3   middleware/flags.js:14
```

Two levels. Findings are ordered by cost; **at most the two costliest**, and
only those costing at least 1 ms, get the loud form: `!` in the gutter, the
tag in bright yellow, the sample, the callsite, and the fix. Everything else
gets the quiet form: no gutter, a muted lowercase tag, one line of context.
Three loud findings on one screen would break the two-bright rule and turn a
report into an alarm.

### Response

```
  RESPONSE                     200   application/json   4.1 KB   etag W/"105b-7Yl1dK+8"
        server-timing   db;dur=52.1   cache;dur=0.8   ext;dur=214.0
        body   {"data":[{"id":8812,"reference":"ORD-2026-8812",…}],"meta":{…}}

  reqray show 8974 --body        the whole response body
  reqray show 8974 --sql         all 51 queries with their callsites
```

The body is one line, cut at the column budget. The trailing commands are
cyan: truncation without a way out is a dead end, so the escape hatch is
printed next to what was cut.

### `--sql`

```
  q2   8.6ms   25 rows   services/orders.js:96

       SELECT o.id, o.reference, o.status, o.total_cents, o.currency, o.created_at,
       u.email, u.display_name, a.line1, a.city, a.country_code, COUNT(li.id) AS
       item_count FROM orders o INNER JOIN users u ON u.id = o.user_id LEFT JOIN
       … 4 more lines                       reqray show 8974 --sql q2 --full

  ! q3   41.2ms  47 calls  services/orders.js:118                          N+1
       SELECT * FROM line_items WHERE order_id = $1
```

SQL is wrapped, not truncated: a path can be recognised from a fragment, a
query cannot. Wrapping is at the window width with a hanging indent of 7,
capped at 3 lines; the rest is behind `--sql <ref> --full`. Keywords are cyan
and literals and placeholders green — the only place in the client where
colour is applied inside a line rather than to a column.

### Finding one without an id

```
reqray show --last                    the one that just finished
reqray show --last --failed           the last one that failed
reqray show --last --slowest          the slowest one recorded
reqray show --last --path /orders     the last one to a path
```

`--path` here is a substring, not a glob, and the store is what searches: the
question "the last request whose path contains this" has one true answer,
where matching a glob in the client would mean "the last one among however
many rows happened to come back". A `*` typed out of habit is stripped rather
than refused.

## Empty and unreachable

Both states must end in an action rather than a statement.

```
reqray 0.6.0   watching localhost:3000   pid 41822   ctrl-c to stop

  collector attached — no requests recorded yet

  try   curl -s localhost:3000/api/orders
        or just reload the application in a browser

  waiting                                             buffer 500, empty
```

Empty is not an error: nothing is red, the header is the one a working stream
prints, and the only coloured element is a command that can be copied. The
status line mirrors the panel's status bar so the two read as one product.

```
reqray: cannot reach the collector

  the panel is served by your app. check that
    1  reqray is attached      reqray({ panel: true }) before the routes
    2  the app is running     and that NODE_ENV is not production
    3  the address matches    REQRAY_URL=http://localhost:3000/_reqray

  reqray --verbose   prints what actually failed
```

Only the headline is bright. Three numbered hypotheses in order of likelihood
rather than one hint, with the concrete values on the right in ordinary colour
— those get copied.

The system cause (`fetch failed — connect ECONNREFUSED 127.0.0.1:3000`) is
printed under `--verbose`, muted, above the hypotheses. It belongs in a bug
report rather than in the reading, and putting it first would bury the three
things actually worth checking.

## Degradation

**Colour off** when `NO_COLOR` is set, `TERM=dumb`, stdout is not a TTY, or
`--no-color` is given. Symmetrically `--color=always` for piping into
`less -R`. One check, in one place; every renderer asks it rather than
deciding for itself.

Without colour the layout is identical, character for character. A 500 is
carried by five signals with no colour among them: the `!!` gutter, the word
`ERR`, the code `500`, the magnitude `2.14s`, and the continuation line with
the exception type.

**Unicode off** with `--ascii`, `REQRAY_ASCII=1`, or a locale that is not
UTF-8. Every substitution is one character wide, so no column moves; the
ellipsis is three characters and is accounted for in the truncation budget.

| Unicode | ASCII | Where |
| --- | --- | --- |
| `├─┼─┤` | `+--+--+` | waterfall ruler |
| `█` | `#` | span bar |
| `▏` | `\|` | span shorter than one cell |
| `├──┤` | `[--]` | handler span |
| `…` | `...` | truncation |
| `└` | `\_` | continuation line |
| `×` | `x` | multiplier |

No emoji in either mode: their width differs between terminals and breaks the
columns.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | execution failed, or the collector could not be reached |
| 2 | bad arguments, or a terminal too narrow to print in |

Errors are addressed to a person: what happened, and what to do about it. The
technical cause is printed under `--verbose` only. Ctrl+C exits cleanly with
no stack trace.
