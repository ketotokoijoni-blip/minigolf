// Bundles the server from TypeScript source into dist/index.js (DESIGN §4.4, D8): @puttipeli/shared and the course
// JSON files are inlined, `ws` stays external and is loaded from node_modules at runtime (the only runtime dependency).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), // paths below are relative to this file, whatever the cwd
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['ws'],
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { 'process.env.BUILD_ID': JSON.stringify(process.env.BUILD_ID ?? 'dev') },
});
