/**
 * Cloudflare Workers entry point. Settings arrive as bindings on every request (vars + secrets),
 * so the config is refreshed before the shared app handles it. Static files never reach this
 * code: wrangler's `assets` block serves ./public and only /api/* runs the worker first.
 */
import { createApp } from "./app.js";
import { initConfig, type Env } from "./config.js";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> {
    initConfig(env);
    return app.fetch(request, env, ctx as never);
  },
};
