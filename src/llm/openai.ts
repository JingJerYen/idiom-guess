/**
 * Optional OpenAI audio features: Whisper speech-to-text and TTS for listening clues.
 * Enabled only when GAME_OPENAI_KEY is set; the client falls back to browser APIs otherwise.
 * Uses plain fetch / FormData / Blob, which exist on Node 22 and on Cloudflare Workers alike.
 */
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";

export const sttEnabled = () => config.stt;
export const ttsEnabled = () => config.tts;

function headers(): Record<string, string> {
  if (!config.openaiKey) throw new AppError("UPSTREAM_ERROR", "語音服務未設定。", 503);
  return { authorization: `Bearer ${config.openaiKey}` };
}

/** Transcribe an English audio clip. `mimeType` is what the browser recorded (webm/mp4/ogg). */
export async function transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio as BlobPart], { type: mimeType }), `speech.${ext}`);
  form.append("model", config.sttModel);
  form.append("language", "en");
  form.append("response_format", "json");
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${config.openaiBase}/audio/transcriptions`, { method: "POST", headers: headers(), body: form, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    log.error("stt request failed", { message: (err as Error).message });
    throw new AppError("UPSTREAM_ERROR", "語音辨識服務暫時無法使用。", 502);
  }
  if (!res.ok) {
    log.error("stt error", { status: res.status, body: (await res.text()).slice(0, 300) });
    throw new AppError("UPSTREAM_ERROR", "語音辨識失敗，請再試一次。", 502);
  }
  const data = (await res.json()) as { text?: string };
  log.info("stt usage", { model: config.sttModel, bytes: audio.byteLength, ms: Date.now() - started, chars: data.text?.length ?? 0 });
  return (data.text ?? "").trim();
}

// Small in-memory cache so replays of the same clue cost nothing (per process / per isolate).
const ttsCache = new Map<string, Uint8Array>();
const TTS_CACHE_MAX = 100; // ~150 KB each -> at most ~15 MB of memory

export async function synthesize(text: string, speed: number): Promise<Uint8Array> {
  const key = `${config.ttsModel}|${config.ttsVoice}|${speed}|${text}`;
  const hit = ttsCache.get(key);
  if (hit) return hit;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${config.openaiBase}/audio/speech`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ model: config.ttsModel, voice: config.ttsVoice, input: text, response_format: "mp3", speed }),
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
  const buf = new Uint8Array(await res.arrayBuffer());
  log.info("tts usage", { model: config.ttsModel, voice: config.ttsVoice, speed, chars: text.length, bytes: buf.byteLength, ms: Date.now() - started });
  if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value as string);
  ttsCache.set(key, buf);
  return buf;
}
