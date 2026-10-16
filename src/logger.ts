type Level = "info" | "warn" | "error";

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = { ts: new Date().toISOString(), level, msg, ...(fields ?? {}) };
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else console.log(out);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
