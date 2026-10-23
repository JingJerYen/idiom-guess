/** Node entry point (local dev, Docker, Render): the shared app plus static files from ./public. */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { createApp } from "./app.js";
import { loadIdioms } from "./game/idioms.js";

export function createNodeApp() {
  const app = createApp();
  app.use(
    "/*",
    serveStatic({
      root: "./public",
      onFound: (path, c) => {
        // index.html must always be revalidated so a new deploy is picked up at once;
        // app.js / styles.css are referenced with a ?v=<build> query, so they can be cached.
        c.header("Cache-Control", path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable");
      },
    }),
  );
  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const count = loadIdioms().length;
  serve({ fetch: createNodeApp().fetch, port: config.port }, () => {
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
