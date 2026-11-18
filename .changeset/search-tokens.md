---
'@reqray/store-memory': minor
'@reqray/store-sqlite': minor
'@reqray/dashboard': minor
'@reqray/core': minor
---

The search speaks tokens, views keep the question, and ⌘K runs it all

The filter box now reads tokens: `status:5xx` or `status:404`, `method:post`,
`path:/api/orders`, `has:n+1` (and seq, dup, slow, wait, tx, heavy, findings,
error), `test:` bare or with a name, `>100ms` in either unit, `sql>10`. A
word that is not a token stays free text — `localhost:3000` still matches
paths — and tokens compose with the chips, both narrowing the same filter.
The server learned the same words: path, exact status, SQL count, the flag,
and the issuing test are now filter fields in both stores, answered
identically and held together by the parity suite, so a token means the same
thing over a ring of five hundred and a history of half a million. The
history chart and its rail unfold tokens too, instead of matching them as
substrings of nobody's path.

A filter worth coming back to can be saved under a name: the whole question
— tokens, chips, route — minus the time range, which a view deliberately
never keeps. Saved views live in the `views` pill, apply in one click, and
update when saved under the same name again.

⌘K (or Ctrl+K) opens the palette from anywhere, typing included: the tabs,
the saved views, the token vocabulary (picked entries drop into the search
field), and the routes of the requests in hand. Substring match, arrows and
Enter, Esc closes. A launcher, not a second query language — the query
language is the search field it leads into.
