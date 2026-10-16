import rateLimit from "express-rate-limit";

const message = { ok: false, error: { code: "RATE_LIMITED", message: "請求太頻繁，請稍後再試。" } };

/** Model-backed endpoints: 30 requests per minute per IP. */
export const modelLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message,
});

/** Cheap endpoints (round fetch): 120 per minute per IP. */
export const lightLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message,
});
