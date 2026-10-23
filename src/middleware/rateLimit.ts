/**
 * Fixed-window per-client rate limit kept in memory. Good enough to stop a script from burning
 * the API budget; on Workers each isolate counts separately, which still bounds abuse per edge.
 */
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { AppError } from "../errors.js";

interface Bucket { count: number; resetAt: number }
const WINDOW_MS = 60_000;

function clientKey(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  if (config.trustProxy) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return "local";
}

export function rateLimit(name: string, limitPerMinute: () => number) {
  const buckets = new Map<string, Bucket>();
  return async (c: Context, next: Next) => {
    const now = Date.now();
    const key = clientKey(c);
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + WINDOW_MS };
      buckets.set(key, b);
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    b.count += 1;
    const limit = limitPerMinute();
    c.header("RateLimit-Limit", String(limit));
    c.header("RateLimit-Remaining", String(Math.max(0, limit - b.count)));
    if (b.count > limit) {
      c.header("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      throw new AppError("RATE_LIMITED", "請求太頻繁，請稍後再試。", 429, { bucket: name });
    }
    await next();
  };
}

/** Model-backed endpoints: default 30 requests per minute per client (RATE_LIMIT_MODEL_PER_MIN). */
export const modelLimiter = rateLimit("model", () => config.rateModelPerMin);
/** Cheap endpoints (round fetch, give up): default 120 per minute (RATE_LIMIT_LIGHT_PER_MIN). */
export const lightLimiter = rateLimit("light", () => config.rateLightPerMin);
