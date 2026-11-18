---
'@reqray/protocol': minor
'@reqray/core': minor
'@reqray/dashboard': minor
'@reqray/cli': minor
---

What the request moved: bytes, rows, and the response that was too large.

"Where is the memory going" is the question a Node backend cannot answer
honestly. `process.memoryUsage()` around a request, under concurrency and a
garbage collector that runs when it likes, is noise and occasionally
negative. What a request *moved* is knowable — and it is what the spike was
made of.

```
88 ms · 49 ms sql · 39 ms your code · 3.8 MB out · 48,400 rows

HEAVY  3.8 MB response from 48,400 rows                      3.8 MB · application/json
       SELECT p.id, p.title, p.price, d::date AS day FROM products p CROSS JOIN …
       src/shop.js:213
       fix   Paginate it, or return only the fields the caller uses.
```

**`weight` on every record** — bytes in, bytes out, rows across every query
that reported a count, and the largest single result. Bodies now keep their
original size, in bytes and taken before the truncation cap: `text.length`
after a cut is the size of the limit, and a panel reporting its own settings
back as a measurement is worse than one reporting nothing. Nothing is
guessed — a request neither the header nor the recorded body can size reads
as unknown, never as zero, and the Routes screen shows `—` rather than
sorting it against routes that measured theirs.

**A detector for the response that grew with the table behind it.** Above a
megabyte of structured text, with the query and the line of code that
produced the rows. It never fires on a file: a twelve-megabyte PDF is a
document and a twelve-megabyte JSON body is a forgotten `LIMIT`, and the
content type is the only thing that tells them apart. And it names a query
only when it can identify one — the one that returned the most rows, or the
only one there was. Faced with three uncounted queries it points nowhere,
rather than picking the slowest and calling it the source.

**Its cost is bytes.** `costMs` is zero, and the panel and the terminal print
the size and the rows where they print "41 ms recoverable" for an N+1. The
seconds a large response spends reaching a phone are not something this
process measured, and a plausible figure in the one field the screen treats
as measured is the thing this project does not do.

Which meant findings had to sort by severity before cost: a twelve-megabyte
response would otherwise rank below a duplicate cache read that wasted a
third of a millisecond.

The demo gained `/api/export` — the price history of every product for every
day, written for a report and left in the API. One fast query, four megabytes
back: the mistake a waterfall has nothing to show for.
