import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@loupe/core': pkg('core'),
      '@loupe/register': pkg('register'),
      '@loupe/express': pkg('express'),
      '@loupe/fastify': pkg('fastify'),
      '@loupe/transport-memory': pkg('transport-memory'),
      '@loupe/transport-http': pkg('transport-http'),
      '@loupe/server': pkg('server'),
      '@loupe/nestjs': pkg('nestjs'),
      '@loupe/instrumentation-pg': pkg('instrumentation-pg'),
      '@loupe/instrumentation-prisma': pkg('instrumentation-prisma'),
      '@loupe/instrumentation-undici': pkg('instrumentation-undici'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
    },
  },
});
