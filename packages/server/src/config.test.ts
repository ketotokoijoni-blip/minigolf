import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { defaultPublicDir, loadConfig } from './config';

const exists = () => true;
const missing = () => false;

describe('loadConfig', () => {
  it('applies the documented defaults (§14.5)', () => {
    const c = loadConfig({}, { dirExists: exists });
    expect(c.port).toBe(8080);
    expect(c.host).toBe('0.0.0.0');
    expect(c.publicDir).toBe(defaultPublicDir());
    expect(c.publicDir?.replace(/\\/g, '/')).toMatch(/packages\/client\/dist$/);
    expect(c.allowedOrigins).toBeNull();
    expect(c.maxRooms).toBe(200);
    expect(c.maxConnections).toBe(1000);
    expect(c.roomIdleTtlMin).toBe(90);
    expect(c.roomEmptyTtlSec).toBe(120);
    expect(c.logLevel).toBe('info');
    expect(c.trustProxy).toBe(false);
    expect(c.buildId).toBe('dev');
  });

  it('disables static serving when the directory is missing or PUBLIC_DIR is empty', () => {
    expect(loadConfig({}, { dirExists: missing }).publicDir).toBeNull();
    expect(loadConfig({ PUBLIC_DIR: '' }, { dirExists: exists }).publicDir).toBeNull();
    expect(loadConfig({ PUBLIC_DIR: '   ' }, { dirExists: exists }).publicDir).toBeNull();
  });

  it('resolves an explicit PUBLIC_DIR to an absolute path', () => {
    const c = loadConfig({ PUBLIC_DIR: 'some/dir' }, { dirExists: exists });
    expect(c.publicDir).toBe(resolve('some/dir'));
  });

  it('reads every variable', () => {
    const c = loadConfig(
      {
        PORT: '3000',
        HOST: '127.0.0.1',
        PUBLIC_ORIGIN: 'https://peli.example, http://localhost:5173/ ,',
        MAX_ROOMS: '5',
        MAX_CONNECTIONS: '7',
        ROOM_IDLE_TTL_MIN: '10',
        ROOM_EMPTY_TTL_SEC: '0',
        LOG_LEVEL: 'DEBUG',
        TRUST_PROXY: 'true',
        BUILD_ID: 'abc123',
      },
      { dirExists: exists },
    );
    expect(c.port).toBe(3000);
    expect(c.host).toBe('127.0.0.1');
    expect(c.allowedOrigins).toEqual(['https://peli.example', 'http://localhost:5173']);
    expect(c.maxRooms).toBe(5);
    expect(c.maxConnections).toBe(7);
    expect(c.roomIdleTtlMin).toBe(10);
    expect(c.roomEmptyTtlSec).toBe(0);
    expect(c.logLevel).toBe('debug');
    expect(c.trustProxy).toBe(true);
    expect(c.buildId).toBe('abc123');
  });

  it('treats an empty PUBLIC_ORIGIN as "allow any"', () => {
    expect(loadConfig({ PUBLIC_ORIGIN: '' }, { dirExists: exists }).allowedOrigins).toBeNull();
    expect(loadConfig({ PUBLIC_ORIGIN: ' , ' }, { dirExists: exists }).allowedOrigins).toBeNull();
  });

  it('fails fast on malformed values', () => {
    expect(() => loadConfig({ PORT: 'eighty' }, { dirExists: exists })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' }, { dirExists: exists })).toThrow(/PORT/);
    expect(() => loadConfig({ MAX_ROOMS: '0' }, { dirExists: exists })).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ MAX_ROOMS: '1.5' }, { dirExists: exists })).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' }, { dirExists: exists })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ TRUST_PROXY: 'maybe' }, { dirExists: exists })).toThrow(/TRUST_PROXY/);
  });
});
