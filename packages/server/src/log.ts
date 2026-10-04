// Minimal leveled logger (DESIGN §11.1: LOG_LEVEL debug|info|warn|error). One line per entry:
// "<ISO time> <LEVEL> <message> <json fields>" written to stdout (debug/info) or stderr (warn/error).
// Tests pass a capturing sink or use `nullLogger`.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(s: string): s is LogLevel {
  return s === 'debug' || s === 'info' || s === 'warn' || s === 'error';
}

export type LogSink = (level: LogLevel, line: string) => void;

const stdSink: LogSink = (level, line) => {
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return '';
  try {
    return ' ' + JSON.stringify(fields, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v));
  } catch {
    return ' [unserializable fields]';
  }
}

export function createLogger(minLevel: LogLevel, sink: LogSink = stdSink, now: () => number = Date.now): Logger {
  const min = LEVEL_RANK[minLevel];
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < min) return;
    sink(level, `${new Date(now()).toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${formatFields(fields)}`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** Discards everything; the default for unit tests. */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
