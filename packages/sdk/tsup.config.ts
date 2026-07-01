import { defineConfig } from 'tsup';

export default defineConfig({
  // Separate entry so the heavy inlined viewer (~478 KB) stays OUT of the core
  // bundle — `@bugzar/sdk/export` is its own chunk. Core index.ts must NOT import
  // it; consumers reach it by subpath.
  entry: ['src/index.ts', 'src/export.ts'],
  format: ['cjs', 'esm'],
  // The public type surface is self-contained in src/public-types.ts, so the
  // emitted .d.ts references only `react` (a peer dep) — never the private
  // @bugzar/* packages. That lets us keep dts external (no fragile source
  // resolution of workspace .ts).
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Only react/react-dom are peer deps — everything else (capture-core, shared,
  // rrweb, uuid) is bundled into dist so `npm install @bugzar/sdk` works with no
  // extra installs. agentation does the same (zero runtime deps beyond React).
  // `@bugzar/sdk/export` is its own entry/chunk — keep Bugzar's lazy
  // `import('@bugzar/sdk/export')` external so the ~478 KB viewer never inlines
  // into the core index bundle (resolved at runtime via the exports map).
  external: ['react', 'react-dom', '@bugzar/sdk/export'],
  noExternal: ['@bugzar/capture-core', '@bugzar/shared', 'rrweb', '@rrweb/types', 'uuid'],
  // Next.js App Router marks the bundle as a Client Component.
  banner: { js: '"use client";' },
});
