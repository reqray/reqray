---
'@reqray/core': minor
'@reqray/instrumentation-pg': minor
'@reqray/dashboard': minor
---

Main-screen quality and collaboration.

**Request log.** `console.*` lines written during handling land in the record
of that exact request — terminal output is unchanged. Capped at
200 lines, lines containing sensitive words are replaced with a marker,
`logs: false` turns it off.

**Permalink.** `#/req/<id>` — the URL of a specific trace can be shared in chat
and opens the same detail view; a "copy link" button in the header.

**Comparing two requests.** `#/compare/<a>/<b>` — two waterfalls on a single
timeline plus a diff by work group: you can see exactly where they diverged.

**"Copy for AI".** A button assembles the request breakdown as markdown —
findings with the code line, waterfall, SQL, EXPLAIN plans — and puts it on
the clipboard. No keys and no network: the data never leaves the machine.

**SQL parameter values** — only via an explicit `collectSqlValues: true`; the
default is `false` in every mode; values are never substituted into EXPLAIN.
