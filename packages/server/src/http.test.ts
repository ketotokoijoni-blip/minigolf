import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { cacheControlFor, contentTypeFor, createHttpServer, safeRelativePath } from './http';
import { nullLogger } from './log';

let dir: string;
let server: Server;
let base: string;
let noStatic: Server;
let noStaticBase: string;

function listen(s: Server): Promise<string> {
  return new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'puttipeli-http-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Puttipeli</title>');
  writeFileSync(join(dir, 'assets', 'index-B3kQ9x2a.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  let t = 1000;
  server = createHttpServer({ publicDir: dir, stats: () => ({ rooms: 2, players: 5, spectators: 1 }), build: 'test-build', log: nullLogger, startedAt: 0, now: () => (t += 1000) });
  base = await listen(server);
  noStatic = createHttpServer({ publicDir: null, stats: () => ({ rooms: 0, players: 0, spectators: 0 }), build: 'x', log: nullLogger, startedAt: 0 });
  noStaticBase = await listen(noStatic);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await new Promise((done) => noStatic.close(done));
  rmSync(dir, { recursive: true, force: true });
});

describe('http endpoints', () => {
  it('GET /healthz -> 200 {"ok":true}', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /api/stats -> counts, uptime and build', async () => {
    const r = await fetch(`${base}/api/stats`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ rooms: 2, players: 5, spectators: 1, build: 'test-build' });
    expect(typeof body.uptimeSec).toBe('number');
    expect(body.uptimeSec).toBeGreaterThan(0);
  });

  it('unknown /api/* is a JSON 404, never the SPA page', async () => {
    const r = await fetch(`${base}/api/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  it('serves index.html with no-cache at / and as SPA fallback', async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('Puttipeli');
    const deep = await fetch(`${base}/room/K7PQ2`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('cache-control')).toBe('no-cache');
    expect(await deep.text()).toContain('Puttipeli');
  });

  it('serves hashed assets as immutable and other files with a short cache', async () => {
    const js = await fetch(`${base}/assets/index-B3kQ9x2a.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toBe('console.log(1)');
    const svg = await fetch(`${base}/favicon.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('404s a missing path that has a file extension (no SPA fallback for files)', async () => {
    const r = await fetch(`${base}/assets/missing.js`);
    expect(r.status).toBe(404);
  });

  it('rejects path traversal and bad encodings', async () => {
    expect((await fetch(`${base}/..%2f..%2fetc/passwd`)).status).toBe(400);
    expect((await fetch(`${base}/%zz`)).status).toBe(400);
  });

  it('answers HEAD without a body and 405 for other methods', async () => {
    const h = await fetch(`${base}/healthz`, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
    const p = await fetch(`${base}/healthz`, { method: 'POST' });
    expect(p.status).toBe(405);
    expect(p.headers.get('allow')).toBe('GET, HEAD');
  });

  it('plain GET /ws is 426', async () => {
    expect((await fetch(`${base}/ws`)).status).toBe(426);
  });

  it('with static disabled only the API answers', async () => {
    expect((await fetch(`${noStaticBase}/healthz`)).status).toBe(200);
    expect((await fetch(`${noStaticBase}/`)).status).toBe(404);
    expect((await fetch(`${noStaticBase}/room/ABCDE`)).status).toBe(404);
  });
});

describe('helpers', () => {
  it('safeRelativePath', () => {
    expect(safeRelativePath('/')).toBe('');
    expect(safeRelativePath('/a/b.js')).toBe('a/b.js');
    expect(safeRelativePath('//a///b')).toBe('a/b');
    expect(safeRelativePath('/a/../b')).toBeNull();
    expect(safeRelativePath('/a%00')).toBeNull();
    expect(safeRelativePath('/c:/x')).toBeNull();
    expect(safeRelativePath('/a\\b')).toBeNull();
  });
  it('cacheControlFor / contentTypeFor', () => {
    expect(cacheControlFor('index.html')).toBe('no-cache');
    expect(cacheControlFor('assets/x.css')).toContain('immutable');
    expect(cacheControlFor('assets/index-B3kQ9x2a.js')).toContain('immutable');
    // unhashed root files (copied from public/) must not be cached for a year
    expect(cacheControlFor('vendor.abcdef1234.js')).toBe('public, max-age=3600');
    expect(cacheControlFor('apple-touch-icon.png')).toBe('public, max-age=3600');
    expect(cacheControlFor('service-worker.js')).toBe('public, max-age=3600');
    expect(cacheControlFor('robots.txt')).toBe('public, max-age=3600');
    expect(contentTypeFor('x.unknownext')).toBe('application/octet-stream');
    expect(contentTypeFor('x.WOFF2')).toBe('font/woff2');
  });
});
