// E2E-only Vite config (WP-L): the real client config with the /ws and /api proxy targets re-pointed to
// E2E_SERVER_PORT. packages/client/vite.config.ts (WP0) hardcodes 127.0.0.1:8080 and has no environment override;
// this file exists so devProxyCheck.ts can run a dev server against a game server on another port. It never
// replaces the real config for development.
import type { UserConfig } from 'vite';
import base from '../../packages/client/vite.config';

const port = Number(process.env.E2E_SERVER_PORT ?? 8098);

const config: UserConfig = {
  ...base,
  server: {
    ...base.server,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
      '/api': { target: `http://127.0.0.1:${port}` },
    },
  },
};

export default config;
