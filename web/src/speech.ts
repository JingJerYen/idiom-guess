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

  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const t = r[0]?.transcript ?? "";
      if (r.isFinal) finalText += (finalText && !/\s$/.test(finalText) ? " " : "") + t.trim();
      else interim += t;
    }
    h.onText(finalText, interim.trim());
  };
  rec.onerror = (ev) => {
    const msg = ERROR_TEXT[ev.error] ?? `語音辨識錯誤（${ev.error}）`;
    if (msg) h.onError(msg);
  };
  rec.onend = () => {
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
