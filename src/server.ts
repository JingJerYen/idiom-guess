import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { AppError } from "./errors.js";
import { api } from "./routes/api.js";
import { loadIdioms } from "./game/idioms.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(express.json({ limit: "10kb" }));
  app.use("/api", api);

  app.use(express.static(publicDir, { index: "index.html", maxAge: "1h" }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "找不到這個端點。" } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) log.error("request failed", { code: err.code, message: err.message, details: err.details });
      res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.too.large") {
      res.status(413).json({ ok: false, error: { code: "BAD_REQUEST", message: "請求內容太大。" } });
      return;
    }
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ ok: false, error: { code: "BAD_REQUEST", message: "JSON 格式錯誤。" } });
      return;
    }
    log.error("unhandled error", { message: e?.message ?? String(err) });
    res.status(500).json({ ok: false, error: { code: "INTERNAL", message: "伺服器發生錯誤。" } });
  });

  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const count = loadIdioms().length;
  const app = createApp();
  app.listen(config.port, () => {
    log.info("server started", {
      port: config.port,
      mode: config.mockMode ? "MOCK" : "LIVE",
      mockReason: config.mockReason,
      model: config.model,
      idioms: count,
      maxGuesses: config.maxGuesses,
    });
  });
}
