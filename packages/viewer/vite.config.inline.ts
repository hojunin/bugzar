import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Phase D — builds `main-inline.tsx` into ONE classic IIFE with React + rrweb +
// the whole viewer inlined: no ES-module imports, no dynamic imports, no network.
// `scripts/gen-viewer-asset.mjs` embeds the result as a string into the SDK's
// `@bugzar/sdk/export` entry, which wraps it in a self-contained `file://` HTML.
export default defineConfig({
  plugins: [react()],
  // React reads process.env.NODE_ENV; lib builds don't define it automatically.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: {
      entry: 'src/main-inline.tsx',
      formats: ['iife'],
      name: 'BUGZARViewerInline',
      fileName: () => 'bugzar-viewer-inline.js',
    },
    rollupOptions: {
      // Fold any dynamic import back into the single chunk (classic script).
      output: { inlineDynamicImports: true },
    },
    outDir: 'dist-inline',
    emptyOutDir: true,
    cssCodeSplit: false,
    // Everything in one file; the viewer injects its own CSS from JS.
    assetsInlineLimit: 100_000_000,
    minify: true,
  },
});
