/**
 * The HTTP app, shared by the Node server (src/server.ts) and the Cloudflare Worker (src/worker.ts).
 * Static files are served by whichever host runs it: the Node server mounts ./public, the Worker
 * lets Cloudflare's static assets serve everything outside /api.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "./config.js";
import { AppError } from "./errors.js";
import { log } from "./logger.js";
import { api } from "./routes/api.js";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ ok: false, error: { code: "NOT_FOUND", message: "找不到這個端點。" } }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.status >= 500) log.error("request failed", { code: err.code, message: err.message, details: err.details });
      return c.json({ ok: false, error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
    }
    log.error("unhandled error", { message: err.message });
    return c.json({ ok: false, error: { code: "INTERNAL", message: "伺服器發生錯誤。" } }, 500);
  });
  return app;
}
