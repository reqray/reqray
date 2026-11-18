# syntax=docker/dockerfile:1

# Image for the demo application from examples/fastify-postgres.
#
# Single stage on purpose: this is a demo, and every extra stage is another
# way for it to break in someone else's environment. The image is bigger than
# a production one would be — it keeps the build toolchain — and that is the
# trade being made.

FROM node:24-slim

WORKDIR /app
RUN corepack enable

# Manifests first: the dependency layer survives edits to the sources.
# Every workspace manifest has to be here, otherwise --frozen-lockfile fails.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json                    packages/core/
COPY packages/protocol/package.json                packages/protocol/
COPY packages/waterfall/package.json                packages/waterfall/
COPY packages/cli/package.json                     packages/cli/
COPY packages/register/package.json                packages/register/
COPY packages/express/package.json                 packages/express/
COPY packages/fastify/package.json                 packages/fastify/
COPY packages/nestjs/package.json                  packages/nestjs/
COPY packages/dashboard/package.json               packages/dashboard/
COPY packages/server/package.json                  packages/server/
COPY packages/store-memory/package.json        packages/store-memory/
COPY packages/transport-http/package.json          packages/transport-http/
COPY packages/store-sqlite/package.json        packages/store-sqlite/
COPY packages/transport-file/package.json          packages/transport-file/
COPY packages/instrumentation-ioredis/package.json packages/instrumentation-ioredis/
COPY packages/instrumentation-pg/package.json      packages/instrumentation-pg/
COPY packages/instrumentation-prisma/package.json  packages/instrumentation-prisma/
COPY packages/instrumentation-undici/package.json  packages/instrumentation-undici/
COPY examples/fastify-postgres/package.json        examples/fastify-postgres/
COPY bench/package.json                            bench/

# The trailing `...` means "this package and everything it depends on", which
# leaves out the benchmark and the Postgres binaries it would download. The
# collector is included so the same image serves docker-compose.staging.yml.
RUN pnpm install --frozen-lockfile \
      --filter "@reqray/example-fastify-postgres..." \
      --filter "@reqray/server..."

COPY . .

# `node --import @reqray/register` loads the built entry, not the sources, so
# the build is not optional here.
RUN pnpm --filter "@reqray/example-fastify-postgres..." --filter "@reqray/server..." build

WORKDIR /app/examples/fastify-postgres

# NODE_ENV stays unset: the panel mounts without a gate only in local
# development, and this image is exactly that. An ungated panel answers only
# to its own machine, though, and a published port is not that — so with
# HOST=0.0.0.0 the demo sets `gate: 'open'` itself.
ENV HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/order').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "@reqray/register", "src/index.js"]
