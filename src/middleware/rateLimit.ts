import rateLimit from "express-rate-limit";

const message = { ok: false, error: { code: "RATE_LIMITED", message: "請求太頻繁，請稍後再試。" } };

function perMinute(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Model-backed endpoints: default 30 requests per minute per IP (RATE_LIMIT_MODEL_PER_MIN). */
export const modelLimiter = rateLimit({
  windowMs: 60_000,
  limit: perMinute("RATE_LIMIT_MODEL_PER_MIN", 30),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message,
});

/** Cheap endpoints (round fetch): default 120 per minute per IP (RATE_LIMIT_LIGHT_PER_MIN). */
export const lightLimiter = rateLimit({
  windowMs: 60_000,
  limit: perMinute("RATE_LIMIT_LIGHT_PER_MIN", 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message,
});
