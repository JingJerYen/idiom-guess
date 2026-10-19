/**
 * Optional OpenAI audio features: Whisper speech-to-text and TTS for listening clues.
 * Enabled only when GAME_OPENAI_KEY is set; the client falls back to browser APIs otherwise.
 * Uses plain fetch (Node 22 has fetch / FormData / Blob) to avoid another SDK dependency.
 */
import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import { log } from "../logger.js";

const apiKey = process.env.GAME_OPENAI_KEY?.trim() || undefined;
export const sttEnabled = Boolean(apiKey) && process.env.DISABLE_STT !== "1";
export const ttsEnabled = Boolean(apiKey) && process.env.DISABLE_TTS !== "1";

const STT_MODEL = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
const TTS_MODEL = process.env.TTS_MODEL || "tts-1";
const TTS_VOICE = process.env.TTS_VOICE || "nova";
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

function headers(): Record<string, string> {
  if (!apiKey) throw new AppError("UPSTREAM_ERROR", "語音服務未設定。", 503);
  return { authorization: `Bearer ${apiKey}` };
}

/** Transcribe an English audio clip. `mimeType` is what the browser recorded (webm/mp4/ogg). */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
  form.append("model", STT_MODEL);
  form.append("language", "en");
  form.append("response_format", "json");
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}/audio/transcriptions`, { method: "POST", headers: headers(), body: form, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    log.error("stt request failed", { message: (err as Error).message });
    throw new AppError("UPSTREAM_ERROR", "語音辨識服務暫時無法使用。", 502);
  }
  if (!res.ok) {
    log.error("stt error", { status: res.status, body: (await res.text()).slice(0, 300) });
    throw new AppError("UPSTREAM_ERROR", "語音辨識失敗，請再試一次。", 502);
  }
  const data = (await res.json()) as { text?: string };
  log.info("stt usage", { model: STT_MODEL, bytes: audio.length, ms: Date.now() - started, chars: data.text?.length ?? 0 });
  return (data.text ?? "").trim();
}

// Small in-memory cache so replays of the same clue cost nothing.
const ttsCache = new Map<string, Buffer>();
const TTS_CACHE_MAX = 100; // ~150 KB each -> at most ~15 MB of server memory

export async function synthesize(text: string, speed: number): Promise<Buffer> {
  const key = createHash("sha1").update(`${TTS_MODEL}|${TTS_VOICE}|${speed}|${text}`).digest("hex");
  const hit = ttsCache.get(key);
  if (hit) return hit;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}/audio/speech`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "mp3", speed }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    log.error("tts request failed", { message: (err as Error).message });
    throw new AppError("UPSTREAM_ERROR", "語音合成服務暫時無法使用。", 502);
  }
  if (!res.ok) {
    log.error("tts error", { status: res.status, body: (await res.text()).slice(0, 300) });
    throw new AppError("UPSTREAM_ERROR", "語音合成失敗。", 502);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log.info("tts usage", { model: TTS_MODEL, voice: TTS_VOICE, speed, chars: text.length, bytes: buf.length, ms: Date.now() - started });
  if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value as string);
  ttsCache.set(key, buf);
  return buf;
}
