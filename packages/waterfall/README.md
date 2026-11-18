# @reqray/waterfall

The waterfall model of Reqray, shared by every client that draws one: which
spans collapse into a run, where the uninstrumented time is, how deep each bar
sits. It decides structure and never draws.

Part of [Reqray](https://github.com/reqray/reqray) — a dev panel and request inspector for Node.js. It
instruments HTTP, SQL, outgoing calls and cache on its own, shows every
request as a waterfall, and finds N+1 down to the file and the line.

The web panel and [`@reqray/cli`](https://www.npmjs.com/package/@reqray/cli)
both build their waterfalls with it, which is why they agree. Install it to
draw a Reqray request somewhere else.

```bash
npm install @reqray/waterfall
```

```ts
import { buildWaterfall, uninstrumentedMs } from '@reqray/waterfall';

const bars = buildWaterfall(request); // spans, findings and durationMs of one request
console.log(`${uninstrumentedMs(bars)} ms no span accounts for`);
```

| | |
|---|---|
| `buildWaterfall(request)` | The bars, in drawing order: 150 identical queries folded into one, gaps made explicit |
| `findGaps(request)` | Stretches of the request no span covers |
| `uninstrumentedMs(bars)` | Their total |
| `parallelSpans(spans)` | Which spans overlapped in time |
| `depthOf(span, byId)` | How deep a span is nested |

Types come from [`@reqray/protocol`](https://www.npmjs.com/package/@reqray/protocol).

## More

Everything else — the detectors, security defaults, measured overhead and a
demo that runs with one command — is in the
[main README](https://github.com/reqray/reqray#readme).

## License

[MIT](https://github.com/reqray/reqray/blob/main/LICENSE)
