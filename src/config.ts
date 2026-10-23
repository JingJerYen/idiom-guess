/**
 * Runtime settings, read from an environment object. On Node that is process.env at startup; on
 * Cloudflare Workers the bindings are passed per request, so the worker calls initConfig(env)
 * before handling it. Everything else reads the mutable `config` object at call time.
 */
export type Effort = "low" | "medium" | "high";
export type Env = Record<string, string | undefined>;

function intOf(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function effortOf(env: Env, name: string, fallback: Effort): Effort | null {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "off" || raw === "0" || raw === "none") return null;
  return raw === "low" || raw === "medium" || raw === "high" ? raw : fallback;
}

export const config = {
  port: 3000,
  /** GAME_ANTHROPIC_KEY (never ANTHROPIC_API_KEY). */
  apiKey: undefined as string | undefined,
  /** MOCK when no key is configured, or when MOCK_MODE=1 overrides. */
  mockMode: true,
  mockReason: "GAME_ANTHROPIC_KEY not set" as string | null,
  maxGuesses: 3,
  /** Trust X-Forwarded-For for the per-IP rate limit (behind Render / nginx). Cloudflare sends cf-connecting-ip regardless. */
  trustProxy: false,
  model: "claude-haiku-5-5",
  /** Output caps per call type (thinking is disabled, so these are pure answer budgets). */
  maxTokens: { guess: 400, feedback: 800, describe: 300, clueVocab: 400, define: 120 },
  /**
   * The AI's last guess of a question thinks harder: adaptive thinking at this effort level.
   * FINAL_GUESS_EFFORT=off keeps every guess at the cheap no-thinking setting.
   */
  finalGuessEffort: "medium" as Effort | null,
  /** Answer budget for the thinking guess: the thinking tokens count against max_tokens too. */
  maxTokensThinkingGuess: 3000,
  /** Optional OpenAI audio (GAME_OPENAI_KEY): Whisper speech-to-text and TTS for listening clues. */
  openaiKey: undefined as string | undefined,
  stt: false,
  tts: false,
  sttModel: "gpt-4o-mini-transcribe",
  ttsModel: "tts-1",
  ttsVoice: "nova",
  openaiBase: "https://api.openai.com/v1",
  /** Per-IP limits per minute: model-backed endpoints and cheap ones. */
  rateModelPerMin: 30,
  rateLightPerMin: 120,
};

export function initConfig(env: Env): void {
  const apiKey = env.GAME_ANTHROPIC_KEY?.trim() || undefined;
  const forcedMock = env.MOCK_MODE === "1";
  const openaiKey = env.GAME_OPENAI_KEY?.trim() || undefined;
  Object.assign(config, {
    port: intOf(env, "PORT", 3000, 1, 65535),
    apiKey,
    mockMode: forcedMock || !apiKey,
    mockReason: forcedMock ? "MOCK_MODE=1" : apiKey ? null : "GAME_ANTHROPIC_KEY not set",
    maxGuesses: intOf(env, "MAX_GUESSES", 3, 1, 10),
    trustProxy: env.TRUST_PROXY === "1",
    finalGuessEffort: effortOf(env, "FINAL_GUESS_EFFORT", "medium"),
    openaiKey,
    stt: Boolean(openaiKey) && env.DISABLE_STT !== "1",
    tts: Boolean(openaiKey) && env.DISABLE_TTS !== "1",
    sttModel: env.STT_MODEL || "gpt-4o-mini-transcribe",
    ttsModel: env.TTS_MODEL || "tts-1",
    ttsVoice: env.TTS_VOICE || "nova",
    openaiBase: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    rateModelPerMin: intOf(env, "RATE_LIMIT_MODEL_PER_MIN", 30, 1, 100000),
    rateLightPerMin: intOf(env, "RATE_LIMIT_LIGHT_PER_MIN", 120, 1, 100000),
  });
}

// Node: settings come from process.env at import time. Workers re-run initConfig per request.
const proc = (globalThis as { process?: { env?: Env } }).process;
if (proc?.env) initConfig(proc.env);
