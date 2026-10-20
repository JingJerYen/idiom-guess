import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { config, type Effort } from "../config.js";
import { log } from "../logger.js";
import { AppError } from "../errors.js";
import { getClient } from "./client.js";

export interface JsonCallOptions<S extends z.ZodTypeAny> {
  /** Short label for logs, e.g. "guess". */
  kind: "guess" | "feedback" | "describe";
  system: string;
  user: string;
  maxTokens: number;
  /**
   * Think before answering, at this effort level. Default: no thinking, effort "low",
   * which keeps max_tokens a pure answer budget. Used for the AI's final guess.
   */
  thinkingEffort?: Effort | null;
  schema: S;
  /**
   * Last resort when the reply is not valid JSON (e.g. cut off by max_tokens): build a
   * partial object from the raw text. Return null if nothing usable can be recovered.
   */
  salvage?: (raw: string) => unknown | null;
}

/** Pull "guess": "..." out of a broken JSON reply so the player at least sees the AI's answer. */
export function salvageGuess(raw: string): unknown | null {
  const m = raw.match(/"guess"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  let guess: string;
  try {
    guess = JSON.parse(`"${m[1]}"`);
  } catch {
    guess = m[1];
  }
  if (!guess.trim()) return null;
  // The reason may be the field that got cut off, so do not require its closing quote.
  const reason = raw.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1] ?? "";
  const perfect = /"perfect_sentence"\s*:\s*true/.test(raw);
  return { guess, reason, perfect_sentence: perfect, grammar_note: "" };
}

/** Pull the first {...} object out of a text reply, tolerating code fences and chatter. */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new SyntaxError("no JSON object found in model output");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function parseWithSchema<S extends z.ZodTypeAny>(text: string, schema: S): z.infer<S> {
  const obj = extractJsonObject(text);
  const result = schema.safeParse(obj);
  if (!result.success) {
    throw new SyntaxError(`model output failed schema: ${result.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  }
  return result.data;
}

async function requestOnce(opts: { system: string; user: string; maxTokens: number; thinkingEffort?: Effort | null }, attempt: number) {
  const client = getClient();
  const started = Date.now();
  const response = await client.messages.create({
    model: config.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    ...(opts.thinkingEffort
      // Adaptive thinking: the model decides how much to think within max_tokens.
      ? { thinking: { type: "adaptive" }, output_config: { effort: opts.thinkingEffort } }
      // Lowest effort and no thinking: max_tokens is then a pure answer budget.
      : { thinking: { type: "disabled" }, output_config: { effort: "low" } }),
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { response, text, ms: Date.now() - started, attempt };
}

/**
 * Call the model once, validate the JSON reply, and retry a single time if the
 * reply does not parse. API/network failures are surfaced as UPSTREAM_ERROR,
 * never silently downgraded to MOCK.
 */
export async function callJson<S extends z.ZodTypeAny>(opts: JsonCallOptions<S>): Promise<z.infer<S>> {
  let lastParseError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r: Awaited<ReturnType<typeof requestOnce>>;
    try {
      r = await requestOnce(opts, attempt);
    } catch (err) {
      const info = describeApiError(err);
      log.error("model call failed", { kind: opts.kind, attempt, ...info });
      throw new AppError("UPSTREAM_ERROR", "AI 服務暫時無法使用，請稍後再試。", 502, info);
    }

    const u = r.response.usage;
    log.info("model usage", {
      kind: opts.kind,
      attempt,
      model: r.response.model,
      effort: opts.thinkingEffort ?? "low",
      thinking: Boolean(opts.thinkingEffort),
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      stop_reason: r.response.stop_reason,
      ms: r.ms,
    });

    if (r.response.stop_reason === "refusal") {
      log.error("model refused", { kind: opts.kind, stop_details: r.response.stop_details ?? null });
      throw new AppError("UPSTREAM_ERROR", "AI 拒絕回應這段內容，請換個說法。", 502);
    }

    try {
      return parseWithSchema(r.text, opts.schema);
    } catch (err) {
      lastParseError = err instanceof Error ? err.message : String(err);
      const truncated = r.response.stop_reason === "max_tokens";
      if (opts.salvage) {
        const partial = opts.salvage(r.text);
        const ok = partial !== null ? opts.schema.safeParse(partial) : null;
        if (ok?.success) {
          log.warn("model output salvaged", { kind: opts.kind, attempt, error: lastParseError, stop_reason: r.response.stop_reason, sample: r.text.slice(0, 300) });
          return ok.data;
        }
      }
      log.warn(truncated ? "model output truncated by max_tokens" : "model output invalid", {
        kind: opts.kind,
        attempt,
        error: lastParseError,
        stop_reason: r.response.stop_reason,
        max_tokens: opts.maxTokens,
        output_tokens: u.output_tokens,
        sample: r.text.slice(0, 300),
      });
    }
  }
  throw new AppError("MODEL_OUTPUT_INVALID", "AI 回覆的格式不正確，請再試一次。", 502, { error: lastParseError });
}

function describeApiError(err: unknown): Record<string, unknown> {
  if (err instanceof Anthropic.APIError) {
    return { name: err.name, status: err.status, message: err.message };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
