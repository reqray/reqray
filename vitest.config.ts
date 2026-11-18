import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Longest first: vite matches string aliases by prefix, so the bare
      // name would otherwise swallow the subpath.
      '@reqray/core/testing': fileURLToPath(
        new URL('./packages/core/src/testing.ts', import.meta.url),
      ),
      '@reqray/core/panel': fileURLToPath(
        new URL('./packages/core/src/panel/index.ts', import.meta.url),
      ),
      '@reqray/core': pkg('core'),
      '@reqray/protocol': pkg('protocol'),
      '@reqray/waterfall': pkg('waterfall'),
      '@reqray/cli': pkg('cli'),
      '@reqray/register': pkg('register'),
      '@reqray/express': pkg('express'),
      '@reqray/fastify': pkg('fastify'),
      '@reqray/store-memory': pkg('store-memory'),
      '@reqray/store-sqlite': pkg('store-sqlite'),
      '@reqray/transport-file': pkg('transport-file'),
      '@reqray/transport-http': pkg('transport-http'),
      '@reqray/server': pkg('server'),
      '@reqray/nestjs': pkg('nestjs'),
      '@reqray/instrumentation-ioredis': pkg('instrumentation-ioredis'),
      '@reqray/instrumentation-pg': pkg('instrumentation-pg'),
      '@reqray/instrumentation-prisma': pkg('instrumentation-prisma'),
      '@reqray/instrumentation-undici': pkg('instrumentation-undici'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    /**
     * Five seconds is plenty for a unit test and not for a browser.
     *
     * The panel's end-to-end suite drives a real Chrome against a real
     * application while the rest of the suite competes for the same cores;
     * every wait in it is a wait on a render that is behind a dozen worker
     * processes. It passes on its own and used to time out in the full run,
     * which is a fact about the machine rather than about the panel.
     */
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
    },
  },
});
