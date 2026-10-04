import { defineConfig } from 'vitest/config';

// Single Vitest config for the whole workspace: tests live beside their sources (DESIGN D24).
// Always run from the root (`npm test` or `npx vitest run <path>`), never `npm test -w <pkg>`.
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
