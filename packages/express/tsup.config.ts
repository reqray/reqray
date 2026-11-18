import { defineConfig } from 'tsup';

export default defineConfig({
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
});
