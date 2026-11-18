import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    // `import.meta.url` is empty in a CommonJS build without this, and
    // `createRequire(import.meta.url)` then throws.
    shims: true,
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
