import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    // The CLI has top-level await and is only ever executed, not imported —
    // ESM alone is enough.
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
  },
]);
