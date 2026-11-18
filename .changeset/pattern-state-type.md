---
'@reqray/protocol': minor
'@reqray/core': patch
'@reqray/store-memory': patch
'@reqray/store-sqlite': patch
'@reqray/dashboard': patch
---

A pattern's state is one type, not fourteen copies of it.

`StoredPatternState` has been in the protocol since the findings tab shipped,
and nothing used it: `'new' | 'ack' | 'muted'` was retyped by hand in seven
places across the core panel, both stores and the dashboard, and its filed
subset `'ack' | 'muted'` in seven more. The subset now has a name too —
`FiledPatternState`, derived from the settable one, since `new` is the absence
of a stored row rather than a value.

The endpoint that accepts a state had the list three times in one function:
the check, the refusal message and a comment. It is one array now, and the
message is built from it, so a state added to the contract cannot be accepted
while the error still names the old three.

The dashboard names the two facts it reads off a state rather than spelling
them at each site: what the Findings dot counts, and what "open only" keeps.
They were written out in three places, and the two that count had to agree or
the dot would lie.

The same everywhere else a closed set was spelled out rather than named: the
operating mode (`ReqrayMode`, which the config sets and the panel reports, so
the two must agree), the spans an adapter opens itself (`LabelSpanKind`), the
list's sort order (`RequestSort`, which the protocol already had), the request
list's sort direction, the timeline's scope, the alignment of a tick's label,
and the accents the stylesheet reads off `data-tone` — a swatch and a duration
bar both speak that vocabulary, and only one of them had it written down.

The rail's title and its `data-scope` were two spellings of one decision, made
twice from the same three conditions. One function decides now, and both read
off it.

No behaviour changed, and nothing on the wire moved: these strings are stored
in SQLite and sent as JSON, so the values are contract, not internal names.
