/**
 * Captures the player's own voice while they dictate, so each guess row can replay the real
 * recording. Uses MediaRecorder; when unavailable (or permission denied) the app falls back to
 * reading the sentence aloud with speech synthesis.
 */

export const canRecord =
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof (globalThis as { MediaRecorder?: unknown }).MediaRecorder === "function";

export interface Recording {
  /** Stop and return the audio captured since start(), or null if nothing usable. */
  stop(): Promise<Blob | null>;
}

function pickMimeType(): string | undefined {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MR?.isTypeSupported?.(t)) return t;
  }
  return undefined;
}

/** Start recording the microphone. Resolves to null if the browser refuses. */
export async function startRecording(): Promise<Recording | null> {
  if (!canRecord) return null;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null;
  }
  const mimeType = pickMimeType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  try {
    rec.start(250);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
  return {
    async stop() {
      if (rec.state !== "inactive") rec.stop();
      await done;
      stream.getTracks().forEach((t) => t.stop());
      if (!chunks.length) return null;
      return new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
    },
  };
}

/** Join several clips of the same type (several mic sessions for one description). */
export function joinClips(clips: Blob[]): Blob | null {
  if (!clips.length) return null;
  return new Blob(clips, { type: clips[0].type });
}
