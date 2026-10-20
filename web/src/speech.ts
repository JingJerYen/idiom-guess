/**
 * Speech-to-text via the browser's Web Speech API (SpeechRecognition).
 * No server round-trip and no API cost; Chrome, Edge and Safari support it, Firefox does not.
 */

type RecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechResultEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

const Ctor: RecognitionCtor | undefined =
  (globalThis as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export const canListen = typeof Ctor === "function";

export interface ListenHandlers {
  /** Called with the text recognised so far: finalised part + interim part. */
  onText(finalText: string, interimText: string): void;
  onEnd(): void;
  onError(message: string): void;
  /** Diagnostics when the browser ends the recognition: whether it produced text and the last error. */
  onSessionEnd?(info: { hadResult: boolean; error: string | null }): void;
}

export interface Listener {
  stop(): void;
}

const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "麥克風權限被拒絕，請在瀏覽器網址列允許麥克風。",
  "service-not-allowed": "這個瀏覽器不允許語音辨識。",
  "no-speech": "沒有聽到聲音，再試一次。",
  "audio-capture": "找不到麥克風。",
  network: "語音辨識需要網路連線。",
  aborted: "",
};

/**
 * Join two transcript pieces, dropping the words at the start of `next` that repeat the end of
 * `prev`. Engines (Android Chrome in particular) often finalise "play" and then send an interim
 * "play piano" for the same utterance; naive concatenation yields "play play piano".
 */
export function joinOverlap(prev: string, next: string): string {
  const a = prev.trim().split(/\s+/).filter(Boolean);
  const b = next.trim().split(/\s+/).filter(Boolean);
  if (!a.length) return b.join(" ");
  if (!b.length) return a.join(" ");
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const max = Math.min(a.length, b.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (norm(a[a.length - k + i]) !== norm(b[i])) { match = false; break; }
    }
    if (match) return [...a, ...b.slice(k)].join(" ");
  }
  return [...a, ...b].join(" ");
}

/** Some engines emit the same segment twice in a row; keep one copy. */
function dedupeAdjacent(parts: string[]): string[] {
  return parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase());
}

/** Start recognising English speech; keeps listening until stop() or the browser ends the session. */
export function startListening(h: ListenHandlers): Listener | null {
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = "";
  let stopped = false;
  let hadResult = false;
  let lastError: string | null = null;

  rec.onresult = (ev) => {
    hadResult = true;
    // Rebuild from the full result list every time instead of accumulating: Chrome (notably on
    // Android) re-reports earlier results and resultIndex is unreliable, which duplicates words.
    const finals: string[] = [];
    const interims: string[] = [];
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      const t = (r[0]?.transcript ?? "").trim();
      if (!t) continue;
      (r.isFinal ? finals : interims).push(t);
    }
    finalText = dedupeAdjacent(finals).reduce((acc, p) => joinOverlap(acc, p), "");
    const interim = dedupeAdjacent(interims).reduce((acc, p) => joinOverlap(acc, p), "");
    // Hand back only the part of the interim text that is not already in finalText.
    const merged = joinOverlap(finalText, interim);
    h.onText(finalText, merged.slice(finalText.length).trim());
  };
  rec.onerror = (ev) => {
    lastError = ev.error;
    // no-speech / aborted just end the session; onend decides whether to keep listening.
    if (ev.error === "no-speech" || ev.error === "aborted") return;
    const msg = ERROR_TEXT[ev.error] ?? `語音辨識錯誤（${ev.error}）`;
    if (msg) h.onError(msg);
  };
  rec.onend = () => {
    h.onSessionEnd?.({ hadResult, error: lastError });
    if (!stopped) h.onEnd();
    stopped = true;
  };
  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { rec.stop(); } catch { /* already stopped */ }
      h.onEnd();
    },
  };
}
