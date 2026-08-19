import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The panel is mounted on an arbitrary path inside the host application
  // (`/_loupe` by default), so every asset reference has to be relative.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
