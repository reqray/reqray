# @reqray/cli

Reqray from the terminal: a live stream of requests, and one request in full —
waterfall, findings with the line of code, the response. A client of the same
API the web panel uses, so there is nothing to configure in the application.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

## Use

```console
$ npx @reqray/cli watch --slower-than 100
reqray 0.1.0   watching localhost:3000   pid 41822   ctrl-c to stop

   TIME         METHOD ST  PATH                               DUR    Q FLAGS
   09:41:03.077 POST   201 /api/orders                      118ms   9q
!  09:42:10.184 GET    200 /api/orders                      512ms  51q N+1
!! 09:43:02.184 POST   500 /api/orders                      2.14s  12q ERR
   └ TypeError: Cannot read properties of undefined (reading 'currency')
     services/pricing.js:61
```

```bash
reqray show --last --failed     # the last request that failed, whole
reqray show --last --path /orders
reqray show <id> --sql          # every query, wrapped rather than cut
```

## Commands

| | |
|---|---|
| `reqray watch` | Follow requests as they happen. `--slower-than <ms>`, `--status`, `--method`, `--path <s>`, `--findings-only`, `--ids` |
| `reqray show <id>` | One request. Or pick it by question: `--last`, `--last --failed`, `--last --slowest`, `--last --path <s>`. `--sql`, `--body`, `--full`, `--json` |

| Flag | |
|---|---|
| `--url <address>` | Where the panel is. Default `http://localhost:3000/_reqray`; also `REQRAY_URL` |
| `--token <token>` | For a collector started with one; also `REQRAY_TOKEN` |
| `--no-color`, `--ascii` | No escape codes; no box-drawing characters |
| `--verbose` | Print what actually failed |

Severity is a glyph in the first two columns, not a colour, so a pipe, a CI log
and `NO_COLOR` lose nothing. Exit codes: 0, 1 for a failure or a collector that
cannot be reached, 2 for bad arguments.

A collector on another machine is an ordinary URL: forward its port over ssh
and pass `--url`.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
