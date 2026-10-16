/**
 * Speech-to-text via the browser's Web Speech API (SpeechRecognition).
 * No server round-trip and no API cost; Chrome, Edge and Safari support it, Firefox does not.
 *
 * Design: we deliberately avoid `continuous` mode. On Android Chrome it re-reports earlier
 * results and duplicates words. Instead each recognition session handles one utterance (it
 * ends at a pause and yields exactly one final transcript); we commit that text and start a
 * new session right away, until the player presses stop. Interim words are still shown live.
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
  /** Called with everything committed so far plus the interim text of the current utterance. */
  onText(committedText: string, interimText: string): void;
  onEnd(): void;
  onError(message: string): void;
}

export interface Listener {
  stop(): void;
}

/** Errors that end the whole dictation; anything else (no-speech, aborted) just starts a new session. */
const FATAL: Record<string, string> = {
  "not-allowed": "麥克風權限被拒絕，請在瀏覽器網址列允許麥克風。",
  "service-not-allowed": "這個瀏覽器不允許語音辨識。",
  "audio-capture": "找不到麥克風。",
  network: "語音辨識需要網路連線。",
};

function join(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(" ");
}

/** Start recognising English speech; runs one utterance per session until stop(). */
export function startListening(h: ListenHandlers): Listener | null {
  if (!Ctor) return null;
  let committed = "";
  let stopped = false;
  let current: SpeechRecognitionLike | null = null;
  let fatal = false;

  const runSession = () => {
    const rec = new Ctor();
    current = rec;
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let sessionFinal = "";
    rec.onresult = (ev) => {
      // One session = one utterance, so the final transcript is the whole thing. Some engines
      // list the same final entry more than once: take the last one, never concatenate.
      let fin = "";
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) fin = t;
        else interim = t;
      }
      if (fin.trim()) sessionFinal = fin.trim();
      h.onText(join(committed, sessionFinal), sessionFinal ? "" : interim.trim());
    };
    rec.onerror = (ev) => {
      const msg = FATAL[ev.error];
      if (msg) {
        fatal = true;
        stopped = true;
        h.onError(msg);
      }
      // no-speech / aborted: the session ends and onend decides whether to continue.
    };
    rec.onend = () => {
      if (sessionFinal) committed = join(committed, sessionFinal);
      if (stopped) {
        if (!fatal) h.onEnd();
        return;
      }
      runSession(); // keep listening until the player stops
    };
    try {
      rec.start();
    } catch {
      stopped = true;
      h.onError("無法啟動語音輸入。");
    }
  };

  runSession();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { current?.stop(); } catch { /* already stopped */ }
    },
  };
}
