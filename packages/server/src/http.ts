// HTTP layer (DESIGN §11.1): static client build with cache headers, /healthz, /api/stats and the SPA fallback.
// WebSocket upgrades are handled separately by ws/wsTransport.ts on the server's 'upgrade' event.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Logger } from './log';

export interface StatsSnapshot {
  rooms: number;
  players: number;
  spectators: number;
}

export interface HttpDeps {
  /** Absolute client build directory, or null = static serving disabled (only /healthz and /api/stats answer). */
  publicDir: string | null;
  stats(): StatsSnapshot;
  build: string;
  log: Logger;
  /** ms since epoch when the process started; uptimeSec is derived from it. */
  startedAt: number;
  now?: () => number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Vite emits hashed files under assets/ (e.g. assets/index-B3kQ9x2a.js); a content hash also marks "immutable". */
export function cacheControlFor(relPath: string): string {
  const base = relPath.split('/').pop() ?? '';
  if (base === 'index.html') return 'no-cache';
  // Only Vite's hashed output under assets/ is immutable; unhashed files copied from public/ (icons, manifest) get a
  // short cache so a deploy can replace them.
  if (relPath.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function sendJson(res: ServerResponse, status: number, body: unknown, head: boolean): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : text);
}

function sendText(res: ServerResponse, status: number, text: string, head: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : text);
}

/**
 * Maps a URL pathname to a path inside `publicDir`, or null when it escapes the directory or is malformed.
 * Returned paths use '/' separators relative to publicDir ('' for the root).
 */
export function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..' || p.includes('\\') || p.includes(':'))) return null;
  return parts.join('/');
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function createRequestHandler(deps: HttpDeps): RequestHandler {
  const now = deps.now ?? Date.now;
  const publicRoot = deps.publicDir === null ? null : resolve(deps.publicDir);

  const serveFile = async (res: ServerResponse, relPath: string, head: boolean, status = 200): Promise<boolean> => {
    if (publicRoot === null) return false;
    const abs = normalize(join(publicRoot, ...relPath.split('/')));
    if (abs !== publicRoot && !abs.startsWith(publicRoot + sep)) return false; // defence in depth
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    res.writeHead(status, {
      'Content-Type': contentTypeFor(abs),
      'Content-Length': st.size,
      'Cache-Control': cacheControlFor(relPath),
    });
    if (head) {
      res.end();
      return true;
    }
    await new Promise<void>((done) => {
      const stream = createReadStream(abs);
      stream.on('error', (err) => {
        deps.log.warn('static read failed', { path: relPath, err });
        res.destroy();
        done();
      });
      stream.on('close', () => done());
      stream.pipe(res);
    });
    return true;
  };

  return (req, res) => {
    const method = req.method ?? 'GET';
    const head = method === 'HEAD';
    if (method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'Method Not Allowed', head);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, head);
      return;
    }
    if (pathname === '/api/stats') {
      const s = deps.stats();
      sendJson(
        res,
        200,
        { rooms: s.rooms, players: s.players, spectators: s.spectators, uptimeSec: Math.max(0, Math.floor((now() - deps.startedAt) / 1000)), build: deps.build },
        head,
      );
      return;
    }
    if (pathname === '/ws') {
      // A plain GET to the WebSocket path (no Upgrade header) is a client error, never the SPA page.
      sendText(res, 426, 'Upgrade Required', head);
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' }, head);
      return;
    }
    if (publicRoot === null) {
      sendText(res, 404, 'Not Found', head);
      return;
    }

    const rel = safeRelativePath(pathname);
    if (rel === null) {
      sendText(res, 400, 'Bad Request', head);
      return;
    }
    const wantsFile = rel !== '' && extname(rel) !== '';
    const target = rel === '' ? 'index.html' : rel;

    void (async () => {
      try {
        if (await serveFile(res, target, head)) return;
        if (!wantsFile && (await serveFile(res, 'index.html', head))) return; // SPA fallback (hash router, D26)
        sendText(res, 404, 'Not Found', head);
      } catch (err) {
        deps.log.error('request failed', { path: pathname, err });
        if (!res.headersSent) sendText(res, 500, 'Internal Server Error', head);
        else res.destroy();
      }
    })();
  };
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer(createRequestHandler(deps));
}
