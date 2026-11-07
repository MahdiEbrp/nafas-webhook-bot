/**
 * Tiny structured logger. On Vercel every line ends up as one JSON log entry,
 * which makes it queryable. No request payloads / secrets are ever logged.
 */

type Level = "info" | "warn" | "error";

const REDACT_KEYS = /pass|secret|token|key|authorization|cookie/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEYS.test(key) ? "[redacted]" : sanitize(val, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(fields ? (sanitize(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (event: string, fields?: Record<string, unknown>) => emit("info", event, fields);
export const logWarn = (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields);
export const logError = (event: string, fields?: Record<string, unknown>) => emit("error", event, fields);
