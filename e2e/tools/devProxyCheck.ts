// One-off check of the Vite dev-server proxy path (DESIGN §14.1): the client served by Vite on 127.0.0.1:5177 must
// reach the game server through Vite's /api (HTTP) and /ws (WebSocket) proxies. Not part of `npm run e2e`.
//
//   npm run build                                       # the server bundle (packages/server/dist/index.js) is used
//   npx tsx e2e/tools/devProxyCheck.ts                  # server on 8098 (PUBLIC_DIR empty) + Vite with the e2e override
//   SERVER_PORT=8080 npx tsx e2e/tools/devProxyCheck.ts # server on 8080 + the REAL packages/client/vite.config.ts
//
// packages/client/vite.config.ts (WP0) targets 127.0.0.1:8080 and offers no environment override, so for any other
// server port Vite is started with e2e/tools/vite.proxy.config.ts, which re-exports the real config with only the
// two proxy targets re-pointed. Checks: (1) GET /api/stats through the proxy, (2) a raw WebSocket upgrade through
// the proxy, (3) the real client in Chromium: the menu caption goes online and "Luo huone" produces a lobby code.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8098);
const VITE_PORT = Number(process.env.VITE_PORT ?? 5177);
const SERVER_ENTRY = resolve(ROOT, 'packages/server/dist/index.js');
const VITE_BIN = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const CLIENT_DIR = resolve(ROOT, 'packages/client');
const OVERRIDE_CONFIG = resolve(ROOT, 'e2e/tools/vite.proxy.config.ts');
const SCREENSHOT_DIR = resolve(ROOT, 'e2e/screenshots');
const SCREENSHOT = resolve(SCREENSHOT_DIR, `99-dev-proxy-lobby-${SERVER_PORT}.png`);

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function start(name: string, args: string[], opts: { cwd?: string; env?: Record<string, string> }): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (chunk: Buffer): string =>
    chunk.toString().split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => `  [${name}] ${l}`).join('\n') + '\n';
  child.stdout?.on('data', (c: Buffer) => process.stdout.write(tag(c)));
  child.stderr?.on('data', (c: Buffer) => process.stdout.write(tag(c)));
  return child;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}: ${last instanceof Error ? last.message : String(last)}`);
}

function stop(child: ChildProcess | null): Promise<void> {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      done();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.kill();
  });
}

function wsUpgradeThroughProxy(url: string): Promise<void> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => fail(new Error(`ws upgrade through the proxy timed out (${url})`)), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      done();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      fail(new Error(`ws upgrade through the proxy failed (${url})`));
    };
  });
}

async function main(): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) throw new Error(`${SERVER_ENTRY} is missing: run npm run build first`);
  const useOverride = SERVER_PORT !== 8080;
  console.log(
    `dev proxy check: server :${SERVER_PORT} (PUBLIC_DIR='' => API + WS only) · vite :${VITE_PORT} · ` +
      `config ${useOverride ? 'e2e/tools/vite.proxy.config.ts (proxy targets -> :' + SERVER_PORT + ')' : 'packages/client/vite.config.ts (real, targets :8080)'}`,
  );
  const results: string[] = [];
  let server: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  try {
    server = start('server', [SERVER_ENTRY], { env: { PORT: String(SERVER_PORT), PUBLIC_DIR: '', LOG_LEVEL: 'info' } });
    await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`, 20_000);

    const viteArgs = [VITE_BIN, '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'];
    if (useOverride) viteArgs.push('--config', OVERRIDE_CONFIG);
    vite = start('vite', viteArgs, { cwd: CLIENT_DIR, env: { E2E_SERVER_PORT: String(SERVER_PORT) } });
    await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 60_000);

    // (1) /api through the proxy
    const statsRes = await fetch(`http://127.0.0.1:${VITE_PORT}/api/stats`);
    const stats = (await statsRes.json()) as { rooms?: unknown; players?: unknown; build?: unknown };
    if (!statsRes.ok || typeof stats.rooms !== 'number') {
      throw new Error(`/api/stats through the proxy: HTTP ${statsRes.status} ${JSON.stringify(stats)}`);
    }
    results.push(`GET http://127.0.0.1:${VITE_PORT}/api/stats -> ${statsRes.status} rooms=${stats.rooms} players=${String(stats.players)} build=${String(stats.build)}`);

    // (2) /ws upgrade through the proxy (raw WebSocket from Node)
    await wsUpgradeThroughProxy(`ws://127.0.0.1:${VITE_PORT}/ws`);
    results.push(`WebSocket ws://127.0.0.1:${VITE_PORT}/ws -> upgrade accepted (open event)`);

    // (3) the real client in Chromium through the dev server
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${VITE_PORT}/#/`);
      const caption = page.locator('.menu-btn .btn__caption.is-online');
      await caption.waitFor({ timeout: 30_000 });
      results.push(`menu caption through Vite: "${(await caption.textContent())?.trim() ?? ''}"`);
      await page.goto(`http://127.0.0.1:${VITE_PORT}/#/mp`);
      // field() labels are not associated with their inputs (WP-E, see helpers/app.ts), hence the structural selector.
      await page.locator('.field').filter({ hasText: /^Nimimerkki/ }).locator('input').first().fill('Proxy-testaaja');
      await page.getByRole('button', { name: 'Luo huone' }).click();
      const code = page.locator('.room-code').first();
      await code.waitFor({ timeout: 30_000 });
      results.push(`room created through the Vite /ws proxy: code ${(await code.textContent())?.trim() ?? ''}`);
      await page.screenshot({ path: SCREENSHOT, fullPage: true });
      results.push(`screenshot ${SCREENSHOT}`);
      if (errors.length > 0) throw new Error(`browser console errors: ${JSON.stringify(errors)}`);
      results.push('browser console: no errors');
    } finally {
      await browser.close();
    }
  } finally {
    await stop(vite);
    await stop(server);
  }
  console.log('\nDEV PROXY CHECK OK');
  for (const r of results) console.log(` - ${r}`);
}

main().catch((err: unknown) => {
  console.error('\nDEV PROXY CHECK FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
