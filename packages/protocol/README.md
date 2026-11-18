# @reqray/protocol

The contract of Reqray's panel API: the types a client sees on the wire. Types
only — the package emits no runtime code.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

Install it to build your own client for a Reqray panel or collector — a
script, an editor extension, a bot. The web panel and
[`@reqray/cli`](https://www.npmjs.com/package/@reqray/cli) are both written
against it.

```bash
npm install -D @reqray/protocol
```

```ts
import type { RequestDetail, RequestsResponse } from '@reqray/protocol';

const base = 'http://localhost:3000/_reqray';
const list = (await (await fetch(`${base}/api/requests`)).json()) as RequestsResponse;
const slowest = list.requests.toSorted((a, b) => b.durationMs - a.durationMs)[0];
const detail = (await (await fetch(`${base}/api/requests/${slowest.id}`)).json()) as RequestDetail;

for (const finding of detail.findings) console.log(finding.title, finding.callsite);
```

What it describes: request summaries and details, spans (`DbSpan`, `HttpSpan`,
`CacheSpan`), findings and their evidence, exception groups, per-route
statistics, time series, and the project report.

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
