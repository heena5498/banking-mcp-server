import type { LogLevel } from "./config.js";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /token|password|authorization|secret/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Replaces values of secret-looking keys so tokens and passwords never reach the logs. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Structured JSON logger that writes to stderr. stdout is reserved for MCP protocol messages,
 * so writing anything else there would corrupt the stdio transport.
 */
export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const log = (lvl: LogLevel) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...redact(fields) }));
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
