import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Served from the Worker under `/v/` in production (VITE_BASE=/v/); defaults to
  // `/` for the dev server, the e2e static server, and standalone hosting.
  base: process.env.VITE_BASE ?? '/',
  // Distinct port from the extension (5173) and SDK demo (5273) dev servers.
  server: { port: 5373, strictPort: true },
});
