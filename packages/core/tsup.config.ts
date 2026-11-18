import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, so an instrumentation that imports `@reqray/core` does not
  // link the panel's git subprocess runner and static file server with it.
  entry: ['src/index.ts', 'src/panel/index.ts', 'src/testing.ts'],
  format: ['esm', 'cjs'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
});
