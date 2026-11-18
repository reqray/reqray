---
'@reqray/protocol': minor
'@reqray/cli': minor
'@reqray/core': minor
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
---

Reqray in the terminal: `reqray watch` and `reqray show`.

The panel answers "which line of code" better than anything else here, and it
answers it in a browser. Two questions do not need one: what is happening right
now, and what happened in that one request. `@reqray/cli` is a client for the
same API the panel is built on — no instrumentation of its own, nothing to
configure, and a collector on another machine is an ordinary URL over an ssh
tunnel.

```console
$ npx @reqray/cli watch --slower-than 100
reqray 0.6.0   watching localhost:3000   pid 41822   ctrl-c to stop

   TIME         METHOD ST  PATH                               DUR    Q FLAGS
   09:41:03.077 POST   201 /api/orders                      118ms   9q
!  09:42:10.184 GET    200 /api/orders                      512ms  51q N+1
!! 09:43:02.184 POST   500 /api/orders                      2.14s  12q ERR
   └ TypeError: Cannot read properties of undefined (reading 'currency')
     services/pricing.js:61                            reqray show 9012
```

**One line per request, on a grid that does not move.** Only the path column is
flexible; time, method, duration and flags keep their place, so output at 80
columns and at 200 reads the same way. Severity is a glyph in the first two
columns and colour is a second layer over it — `NO_COLOR`, a pipe, a CI log and
`--ascii` lose bytes and not a single distinction. A path is truncated by whole
segments, so what is left is still a path. `--slower-than`, `--status`,
`--method`, `--path` (a glob) and `--findings-only` narrow the stream; a
dropped connection reconnects with a doubling delay and says so in one muted
line rather than going quiet.

**A row on screen can be opened.** The stream prints no identifiers by
default — eight characters of noise on every line, in the column the eye
scans — so `show` takes the question instead: `--last`, `--last --failed`,
`--last --slowest`, and `--last --path /orders`, each answered by the store
rather than by sifting a page of results in the client. `watch --ids` adds the
column when copying one is what you want.

**`reqray show <id>` is the detail view without the browser.** The waterfall
drawn in box characters — an N+1 collapsed to a single `47× SELECT line_items`,
handlers as brackets, spans shorter than a cell as slivers rather than missing
— then the findings, each with what it costs, the line of code and the fix, and
then the response. `--last`, `--last --failed` and `--last --slowest` ask the
collector the question instead of making you find an id first. `--sql` prints
every query wrapped rather than cut, with keywords and placeholders coloured as
in the panel; `--json` hands back the raw trace; `--body` prints the body whole.

**Two additions to the panel API rather than workarounds in the client.**
`sort=slowest` on `GET /api/requests`, implemented by both stores with the
cursor keyed by the sort column — "the slowest request" over a history on disk
cannot be found by reading a page of it and comparing. And `errors=1`, which is
wider than the 5xx class on purpose: a handler that threw and still answered
200 is the failure worth finding.

**`@reqray/protocol` is the wire contract, declared once.** Types only, no
runtime code, no dependencies — safe in a browser bundle, an editor plugin or a
CLI. `@reqray/core` imports it type-only and re-exports it, so the server and
every client describe the same JSON instead of each carrying an approximation
of it. Core still loads nothing new at run time.

Exit codes are 0, 1 for a failure or a collector that cannot be reached, and 2
for arguments. Failures are addressed to a person — what happened and what to
check — with the technical cause behind `--verbose` and never a stack trace.
Ctrl+C exits immediately and quietly.
