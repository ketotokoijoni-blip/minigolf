// Process entry (DESIGN §11.1): config -> logger -> RoomManager -> Gateway -> HTTP server (+ static, /healthz,
// /api/stats) -> WebSocket transport on /ws -> room sweeper; graceful shutdown on SIGTERM/SIGINT.
import { systemClock } from './clock';
import { loadConfig } from './config';
import { createHttpServer } from './http';
import { createLogger } from './log';
import { RoomManager } from './rooms/roomManager';
import { Gateway } from './ws/gateway';
import { WsTransport } from './ws/wsTransport';

const startedAt = Date.now();
const config = loadConfig();
const log = createLogger(config.logLevel);

const rooms = new RoomManager(systemClock, config, log);
const gateway = new Gateway({ rooms, clock: systemClock, log, build: config.buildId });
const server = createHttpServer({ publicDir: config.publicDir, stats: () => rooms.stats(), build: config.buildId, log, startedAt });
const transport = new WsTransport({
  server,
  log,
  allowedOrigins: config.allowedOrigins,
  maxConnections: config.maxConnections,
  trustProxy: config.trustProxy,
});

if (config.publicDir === null) log.info('static serving disabled (PUBLIC_DIR missing or empty); only /healthz, /api/stats and /ws are served');
else log.info('serving static files', { dir: config.publicDir });

transport.start(gateway);
rooms.startSweeper();

server.on('error', (err: NodeJS.ErrnoException) => {
  log.error('http server error', { code: err.code, message: err.message });
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  log.info('listening', { host: config.host, port: config.port, build: config.buildId, origins: config.allowedOrigins ?? 'any', maxRooms: config.maxRooms, maxConnections: config.maxConnections });
});

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal, ...rooms.stats(), connections: transport.connectionCount() });
  const hardExit = setTimeout(() => {
    log.warn('shutdown timed out; exiting');
    process.exit(1);
  }, 5000);
  hardExit.unref();
  try {
    server.close();              // stop accepting new HTTP connections (and upgrades)
    rooms.closeAll();            // roomLeft{roomClosed} to everyone
    await transport.stop();      // close sockets with 1001
    await new Promise<void>((done) => server.closeAllConnections?.() ?? done());
    log.info('shutdown complete', { exitCode });
    process.exit(exitCode);
  } catch (err) {
    log.error('shutdown failed', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  void shutdown('uncaughtException', 1); // a crash must not look like a clean stop to restart policies
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: reason instanceof Error ? reason : String(reason) });
});
