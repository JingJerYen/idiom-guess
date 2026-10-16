function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const apiKey = process.env.GAME_ANTHROPIC_KEY?.trim() || undefined;
const forcedMock = process.env.MOCK_MODE === "1";

export const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  apiKey,
  /** MOCK when no key is configured, or when MOCK_MODE=1 overrides. */
  mockMode: forcedMock || !apiKey,
  mockReason: forcedMock ? "MOCK_MODE=1" : apiKey ? null : "GAME_ANTHROPIC_KEY not set",
  maxGuesses: intEnv("MAX_GUESSES", 3, 1, 10),
  trustProxy: process.env.TRUST_PROXY === "1",
  model: "claude-haiku-5-5",
  /** Output caps per call type (thinking is disabled, so these are pure answer budgets). */
  maxTokens: { guess: 160, feedback: 500, describe: 200 },
} as const;
