import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const timestamp = (): string => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

/** Build identifier compiled into the client (`__BUILD__`, sent in hello.clientBuild): BUILD_ID env, else git short sha, else a timestamp. */
function buildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return sha || timestamp();
  } catch {
    return timestamp(); // no git or no commits yet
  }
}

// Rollup inputs: the app, plus the WP-D render harness once it exists (dev/render.html is owned by WP-D).
const input: Record<string, string> = { main: resolve(root, 'index.html') };
const devRender = resolve(root, 'dev/render.html');
if (existsSync(devRender)) input.devRender = devRender;

// Client dev server on 5173; /ws (WebSocket) and /api are proxied to the game server on 8080.
export default defineConfig({
  root,
  base: './',
  define: { __BUILD__: JSON.stringify(buildId()) },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { input },
  },
});
