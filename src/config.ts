function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type Effort = "low" | "medium" | "high";

function effortEnv(name: string, fallback: Effort): Effort | null {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "off" || raw === "0" || raw === "none") return null;
  return raw === "low" || raw === "medium" || raw === "high" ? raw : fallback;
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
  maxTokens: { guess: 400, feedback: 800, describe: 300, clueVocab: 400, define: 120 },
  /**
   * The AI's last guess of a question thinks harder: adaptive thinking at this effort level.
   * FINAL_GUESS_EFFORT=off keeps every guess at the cheap no-thinking setting.
   */
  finalGuessEffort: effortEnv("FINAL_GUESS_EFFORT", "medium"),
  /** Answer budget for the thinking guess: the thinking tokens count against max_tokens too. */
  maxTokensThinkingGuess: 3000,
} as const;
