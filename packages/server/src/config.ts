// Server configuration from environment variables with defaults (DESIGN §11.1, §14.5). All optional, no secrets.
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CONNECTIONS_DEFAULT,
  MAX_ROOMS_DEFAULT,
  ROOM_EMPTY_TTL_SEC_DEFAULT,
  ROOM_IDLE_TTL_MIN_DEFAULT,
} from '@puttipeli/shared/protocol/limits';
import { isLogLevel, type LogLevel } from './log';

export interface Config {
  port: number;
  host: string;
  /** Absolute path of the client build, or null when static serving is disabled (missing dir or PUBLIC_DIR=''). */
  publicDir: string | null;
  /** Allowed `Origin` header values for WebSocket upgrades; null = allow any (development). */
  allowedOrigins: string[] | null;
  maxRooms: number;
  maxConnections: number;
  roomIdleTtlMin: number;
  roomEmptyTtlSec: number;
  logLevel: LogLevel;
  /** true => client IP taken from X-Forwarded-For (logging only). */
  trustProxy: boolean;
  /** Baked into the bundle by build.mjs (process.env.BUILD_ID), 'dev' under tsx. */
  buildId: string;
}

export type Env = Record<string, string | undefined>;

/**
 * packages/client/dist relative to this file: works both from the bundle (packages/server/dist/index.js, into
 * which this module is inlined) and from the source under tsx (packages/server/src/config.ts).
 */
export function defaultPublicDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
}

function intEnv(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}="${raw}": expected an integer in [${min}, ${max}]`);
  }
  return n;
}

function boolEnv(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`Invalid ${key}="${raw}": expected true or false`);
}

export interface LoadConfigOptions {
  /** Directory existence probe (injected by tests). Default: fs.statSync(...).isDirectory(). */
  dirExists?: (path: string) => boolean;
}

function fsDirExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Reads the configuration. Throws on malformed values so a typo fails fast at boot instead of silently defaulting. */
export function loadConfig(env: Env = process.env, opts: LoadConfigOptions = {}): Config {
  const dirExists = opts.dirExists ?? fsDirExists;

  let publicDir: string | null;
  const rawPublic = env.PUBLIC_DIR;
  if (rawPublic !== undefined && rawPublic.trim() === '') publicDir = null; // explicit empty string disables static serving
  else publicDir = resolve(rawPublic ?? defaultPublicDir());
  if (publicDir !== null && !dirExists(publicDir)) publicDir = null; // normal dev situation; index.ts logs one info line

  const rawOrigins = env.PUBLIC_ORIGIN;
  const allowedOrigins =
    rawOrigins === undefined || rawOrigins.trim() === ''
      ? null
      : rawOrigins.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => s.length > 0);

  const rawLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!isLogLevel(rawLevel)) throw new Error(`Invalid LOG_LEVEL="${env.LOG_LEVEL}": expected debug|info|warn|error`);

  return {
    port: intEnv(env, 'PORT', 8080, 0, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    publicDir,
    allowedOrigins: allowedOrigins !== null && allowedOrigins.length === 0 ? null : allowedOrigins,
    maxRooms: intEnv(env, 'MAX_ROOMS', MAX_ROOMS_DEFAULT, 1, 1_000_000),
    maxConnections: intEnv(env, 'MAX_CONNECTIONS', MAX_CONNECTIONS_DEFAULT, 1, 1_000_000),
    roomIdleTtlMin: intEnv(env, 'ROOM_IDLE_TTL_MIN', ROOM_IDLE_TTL_MIN_DEFAULT, 1, 100_000),
    roomEmptyTtlSec: intEnv(env, 'ROOM_EMPTY_TTL_SEC', ROOM_EMPTY_TTL_SEC_DEFAULT, 0, 10_000_000),
    logLevel: rawLevel,
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    buildId: env.BUILD_ID?.trim() || 'dev',
  };
}
