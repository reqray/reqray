# Contributing

## Setup

Node 22.5 or newer and pnpm (through `corepack enable`).

```bash
pnpm install
pnpm build      # before tests: the loader-hook e2e runs `node --import` on the built files
pnpm test
pnpm lint
pnpm typecheck
```

The demo needs nothing installed — Postgres and Redis come up embedded:

```bash
pnpm --filter @reqray/example-fastify-postgres start
# open http://127.0.0.1:3000/_reqray/
```

## What a change has to keep true

These are the promises the project makes to an application that loads it.
A pull request that breaks one is not merged, however useful the rest is.

- **The application never crashes because of us.** An instrumentation error is
  caught, warned about once, and disables that one instrumentation.
- **Nothing on the hot path.** Serialization, stack capture past the sample
  and writes to storage happen after the response.
- **No manual calls.** If a feature only works when the user calls
  `recordSomething()`, it is not ready.
- **Masking happens before the buffer**, not when the panel draws.
- **A false positive is worse than a miss.** A detector change comes with at
  least as many "does not find" tests as "finds" ones.
- **`@reqray/core` has no third-party runtime dependencies.** Drivers are peer
  or optional dependencies of instrumentations, imported as types only.

## Pull requests

- One change per pull request, with a test that fails without it.
- Add a changeset: `pnpm changeset`. It becomes the changelog entry, so write
  what changes for a user, not what you edited.
- New drivers and new detectors are discussed in an issue first. The first
  releases are deliberately narrow.
- If a change touches request handling, run `pnpm bench` and say what moved.
