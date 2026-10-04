import { describe, expect, it } from 'vitest';
import { createLogger, isLogLevel, nullLogger, type LogLevel } from './log';

function capture() {
  const lines: { level: LogLevel; line: string }[] = [];
  const log = createLogger('info', (level, line) => lines.push({ level, line }), () => 1_700_000_000_000);
  return { log, lines };
}

describe('createLogger', () => {
  it('filters below the minimum level', () => {
    const { log, lines } = capture();
    log.debug('hidden');
    log.info('shown');
    log.warn('shown too');
    log.error('and this');
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
  });

  it('formats time, level, message and JSON fields', () => {
    const { log, lines } = capture();
    log.info('listening', { port: 8080, host: '0.0.0.0' });
    expect(lines[0]?.line).toBe('2023-11-14T22:13:20.000Z INFO  listening {"port":8080,"host":"0.0.0.0"}');
  });

  it('serializes Error values and survives circular fields', () => {
    const { log, lines } = capture();
    log.error('boom', { err: new Error('kaput') });
    expect(lines[0]?.line).toContain('"err":{"name":"Error","message":"kaput"}');
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    log.warn('loop', { circ });
    expect(lines[1]?.line).toContain('[unserializable fields]');
  });

  it('exposes level validation and a silent logger', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(() => nullLogger.error('x')).not.toThrow();
  });
});
