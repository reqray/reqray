---
'@reqray/core': minor
---

The panel stops trusting the browser.

The panel gate says who may use the panel. It said nothing about which
*page* was asking, so any site open in a developer's browser could send a
form-shaped POST to `/_reqray/api/replay` and make the application run a
recorded request again — a second charge, a second email — or run EXPLAIN,
or spawn `git`. The reply was unreadable to that page, which is no comfort:
the effect had already happened.

Every state-changing route now requires `Sec-Fetch-Site: same-origin`, the
browser's own account of where a request came from, which script cannot
set. `same-site` is refused with `cross-site`: two ports of localhost are
one site, and a dev server on another port is the case this is about. A
caller that sends neither that header nor an `Origin` is not a browser —
curl, `@reqray/cli`, a script — and passes unchanged.

Three narrower fixes ride along. Replay and the curl export take the
application's address from the socket instead of the `Host` header, so a
forged header can no longer aim a replayed request, chosen headers and all,
at an arbitrary host. `git blame` answers nothing for a file outside the
project root or a line that is not an integer. EXPLAIN refuses a record
that holds a second statement after a semicolon, skipping quotes and
comments so an ordinary `'a;b'` still plans.

Exports now carry at most a thousand requests and say in the file when they
cut one short, and a panel holds at most thirty-two live feeds open.
