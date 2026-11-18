import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, so an instrumentation that imports `@reqray/core` does not
  // link the panel's git subprocess runner and static file server with it.
  entry: ['src/index.ts', 'src/panel/index.ts', 'src/testing.ts'],
  format: ['esm', 'cjs'],
  // `import.meta.url` is empty in a CommonJS build without this, and
  // `createRequire(import.meta.url)` then throws.
  shims: true,
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
});
