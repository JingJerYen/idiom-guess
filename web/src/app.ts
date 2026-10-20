import { api, ApiError, transcribeClip, ttsUrl, type Level, type Mode, type Violation } from "./api.js";
import { canListen, joinOverlap, startListening, type Listener } from "./speech.js";
import { canRecord, joinClips, startRecording, type Recording } from "./recorder.js";
import { addFromFeedback, blankWord, cardCount, dateStamp, exportText, keepCard, listCards, removeCard, type Card } from "./vocab.js";
import { MAX_ATTEMPTS, MAX_CHARS, MIN_WORDS, SENTENCE_BONUS, countWords, getBest, recordScore, scoreFor, type Game, type QuestionState, type Screen } from "./state.js";

const root = document.getElementById("app") as HTMLElement;
const topbar = document.getElementById("topbar") as HTMLElement;
let modelBadge = "";

let screen: Screen = { name: "start" };
let chosenMode: Mode = "forward";
let chosenLevel: Level = "hard";
/** Transient per-question UI state. */
const ui = { draft: "", busy: false, error: "", violations: [] as Violation[], confirmGiveUp: false };
/** Active microphone session (forward mode). The text typed before recording is kept as a prefix. */
let listener: Listener | null = null;
let micPrefix = "";
let micInterim = "";
/** Voice clips captured for the current description (one per mic session). */
let recording: Recording | null = null;
let clips: Blob[] = [];
let currentAudio: HTMLAudioElement | null = null;
/**
 * Some devices (Android Chrome in particular) hand the microphone to the system speech service
 * and refuse a second consumer: holding a MediaRecorder stream starves recognition. Once that is
 * detected we stop recording on this device and replay guesses with speech synthesis instead.
 */
const RECORD_BLOCK_KEY = "idiom.recordBlocked";
// Android hands the microphone to the system speech service; a second consumer breaks dictation
// outright, so recording is off there from the start. Elsewhere it is on until a conflict is seen.
let recordBlocked = /Android/i.test(navigator.userAgent);
try { if (localStorage.getItem(RECORD_BLOCK_KEY) === "1") recordBlocked = true; } catch { /* storage unavailable */ }
let emptySessions = 0;
let micWatchdog: number | null = null;
/** True between the player pressing ⏹ and the recogniser confirming it ended. */
let micUserStopped = false;
/** Consecutive browser-ended sessions without any text; dictation stops itself after MAX_SILENT. */
let silentSessions = 0;
const MAX_SILENT = 5;
/** One-line diagnostic shown under the box while dictating (state and last error code). */
let micStatus = "";

const MODE_LABEL: Record<Mode, string> = { forward: "口說", reverse: "聽力" };

/** Sentence starters for players who do not know how to begin, chosen by the item's kind. */
const STARTERS: Record<string, string[]> = {
  成語: ["It's a saying about a person who ", "People use it when someone ", "The lesson is that "],
  日常用語: ["It's something people say when ", "You use this word when ", "It means that "],
  店家名: ["It's a shop where you can buy ", "It's a chain that is famous for ", "You go there when you want "],
  地標: ["It's a famous place in ", "It looks like ", "People go there to "],
};
const DEFAULT_STARTERS = ["It's a kind of ", "It's used for ", "It happens when "];

function startersFor(tags: string[]): string[] {
  for (const t of tags) if (STARTERS[t]) return STARTERS[t];
  return DEFAULT_STARTERS;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
function stars(d: number): string {
  return `<span class="stars" aria-label="難度 ${d}">${"★".repeat(d)}<span class="dim">${"★".repeat(3 - d)}</span></span>`;
}
function chars(text: string): string[] {
  return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, ""));
}
/** Wordle-style tiles: one box per character; green = right character, right position. */
function tiles(text: string, positions: boolean[] = [], size = ""): string {
  return `<span class="tiles ${size}" aria-label="${esc(text)}">${chars(text)
    .map((c, i) => `<span class="tile ${positions[i] ? "hit" : ""}">${esc(c)}</span>`)
    .join("")}</span>`;
}
/** Empty answer slots for reverse mode, pre-filled with characters already confirmed. */
function slots(length: number, confirmed: (string | null)[], draft: string): string {
  const d = chars(draft);
  const cells: string[] = [];
  for (let i = 0; i < Math.max(length, d.length); i++) {
    const known = confirmed[i];
    const typed = d[i];
    const cls = known ? "hit" : typed ? "typed" : "";
    const extra = i >= length ? " over" : "";
    cells.push(`<span class="tile lg ${cls}${extra}">${esc(known ?? typed ?? "")}</span>`);
  }
  return `<div class="tiles lg center" aria-label="${length} 個字">${cells.join("")}</div>`;
}

// ---------- speech (browser TTS, no API cost) ----------

const canSpeak = typeof window !== "undefined" && Boolean(window.speechSynthesis) && typeof window.speechSynthesis.speak === "function";

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en(-|_)?(US|GB|AU)?/i.test(v.lang));
  return en.find((v) => /Google|Samantha|Daniel|Natural/i.test(v.name)) ?? en[0] ?? voices[0] ?? null;
}

/** Speech rate by level: easy mode speaks noticeably slower. */
const SPEECH_RATE: Record<Level, number> = { hard: 0.8, easy: 0.6 };
let speechRate = SPEECH_RATE.hard;
/** Server TTS (OpenAI) speed by level; 1.0 is natural. */
const TTS_SPEED: Record<Level, number> = { hard: 1.0, easy: 0.8 };
let useServerTts = false;
let ttsSpeed = TTS_SPEED.hard;
/** Whisper mode: record a clip, then upload it for transcription (no live words). */
let useWhisper = false;
let whisperRec: Recording | null = null;
let whisperBusy = false;
/** Whisper is billed per second of audio, so a single clip is capped; it auto-submits at the limit. */
const WHISPER_MAX_SECONDS = 60;
let whisperTimer: number | null = null;
let whisperStartedAt = 0;

/**
 * Fetch the server voice for a clue once and keep it as an object URL on the question, so every
 * replay is local: no request to our server and no OpenAI call. Resolves to null on failure.
 */
async function fetchClueAudio(qs: QuestionState, index: number, text: string): Promise<string | null> {
  const have = qs.clueAudio?.[index];
  if (have) return have;
  try {
    const res = await fetch(ttsUrl(text.replace(/^\[MOCK[^\]]*\]\s*/, ""), ttsSpeed));
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    qs.clueAudio = { ...(qs.clueAudio ?? {}), [index]: url };
    return url;
  } catch {
    return null;
  }
}

/**
 * Louder playback for clues: an <audio> element tops out at 100%, so its output is routed through
 * a Web Audio gain node (plus a compressor against clipping). The element streams and decodes the
 * clip itself, so nothing beyond the 150 KB mp3 is kept in memory. One shared element is reused;
 * if Web Audio is unavailable the element simply plays at normal volume.
 */
const CLUE_GAIN = 1.8;
let audioCtx: AudioContext | null = null;
let clueElement: HTMLAudioElement | null = null;

function getClueElement(): HTMLAudioElement {
  if (clueElement) return clueElement;
  const el = new Audio();
  el.preload = "auto";
  clueElement = el;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      audioCtx ??= new Ctx();
      const src = audioCtx.createMediaElementSource(el); // an element can be connected only once
      const gain = audioCtx.createGain();
      gain.gain.value = CLUE_GAIN;
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 6;
      src.connect(gain).connect(comp).connect(audioCtx.destination);
    }
  } catch {
    /* no Web Audio: the element still plays, just not boosted */
  }
  return el;
}

async function playBoosted(url: string): Promise<boolean> {
  try {
    const el = getClueElement();
    if (audioCtx?.state === "suspended") await audioCtx.resume().catch(() => undefined);
    el.pause();
    el.src = url;
    el.currentTime = 0;
    currentAudio = el;
    await el.play();
    return true;
  } catch {
    return false;
  }
}

/** Play a clue: cached server audio when available (boosted), otherwise the browser voice. */
async function playClue(qs: QuestionState, index: number) {
  const text = qs.clues[index] ?? "";
  if (!text) return;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  const url = useServerTts ? await fetchClueAudio(qs, index, text) : null;
  if (url) {
    if (await playBoosted(url)) return;
    // Routed element refused (e.g. iOS quirk): plain, unboosted playback, then browser voice.
    const a = new Audio(url);
    currentAudio = a;
    a.onerror = () => { currentAudio = null; speak(text); };
    void a.play().catch(() => speak(text));
    return;
  }
  speak(text);
}

function speak(text: string) {
  if (!canSpeak) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/^\[MOCK[^\]]*\]\s*/, ""));
    u.lang = "en-US";
    u.rate = speechRate;
    const v = pickVoice();
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore: speech is best-effort */
  }
}
if (canSpeak) window.speechSynthesis.onvoiceschanged = () => pickVoice();

/** Read several English texts one after another (used by the feedback speaker). */
function speakAll(texts: string[]) {
  if (!canSpeak) return;
  try {
    window.speechSynthesis.cancel();
    for (const t of texts.filter((x) => x.trim())) {
      const u = new SpeechSynthesisUtterance(t.replace(/^\[MOCK[^\]]*\]\s*/, ""));
      u.lang = "en-US";
      u.rate = speechRate;
      const v = pickVoice();
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    }
  } catch { /* best effort */ }
}

/** Play the player's own recording when there is one, otherwise read the text aloud. */
function playTurn(audioUrl: string | undefined, text: string) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (audioUrl) {
    try {
      window.speechSynthesis?.cancel();
      currentAudio = new Audio(audioUrl);
      void currentAudio.play();
      return;
    } catch { /* fall through to TTS */ }
  }
  speak(text);
}

function setScreen(s: Screen) {
  screen = s;
  render();
}

// ---------- rendering ----------

function renderHeader() {
  const badge = modelBadge ? `<span class="badge ${modelBadge === "MOCK" ? "" : "live"}">${modelBadge}</span>` : "";
  if (screen.name !== "play") {
    topbar.innerHTML = `<a class="brand" href="./">繞著<span>說</span></a>${badge}`;
    return;
  }
  const game = screen.game;
  const done = game.questions.slice(0, game.index + 1).filter((q) => q.done);
  const ok = done.filter((q) => q.solved).length;
  const no = done.length - ok;
  const total = game.questions.reduce((n, q) => n + q.score, 0);
  topbar.innerHTML = `
    <a class="brand" href="./">繞著<span>說</span><small>${game.level === "easy" ? "🌱" : "🔥"}</small></a>
    <div class="mid"><span class="num ok" aria-label="答對">${ok}</span><span class="num no" aria-label="答錯">${no}</span><span class="muted small">${game.index + 1}/${game.questions.length}</span></div>
    <span class="score">${total}<small>分</small></span>`;
}

function render() {
  renderHeader();
  switch (screen.name) {
    case "start": return renderStart();
    case "loading": root.innerHTML = `<section class="card center pad"><span class="spinner"></span>${esc(screen.text)}</section>`; return;
    case "play": return renderPlay(screen.game);
    case "summary": return renderSummary(screen.game, screen.record);
    case "vocab": return renderVocab();
  }
}

/** 🏆 best score for a mode at the currently selected level; "—" when never played. */
function bestBadge(mode: Mode): string {
  const b = getBest(mode, chosenLevel);
  return `<span class="best ${b === null ? "none" : ""}" aria-label="最高分">🏆 ${b === null ? "—" : b}</span>`;
}

function renderStart() {
  root.innerHTML = `
    <section class="hero">
      <h1>用英文<em>繞著說</em></h1>
      <p class="muted">不知道那個字怎麼講？把意思說清楚就好。</p>
    </section>
    <section class="levels" role="group" aria-label="難度">
      <button class="level" data-level="easy" aria-pressed="${chosenLevel === "easy"}"><span class="icon">🌱</span><b>簡單</b><span class="small muted">${chosenMode === "forward" ? "有提示單字" : "語速較慢"}</span></button>
      <button class="level" data-level="hard" aria-pressed="${chosenLevel === "hard"}"><span class="icon">🔥</span><b>困難</b><span class="small muted">${chosenMode === "forward" ? "2 個禁用詞" : "正常語速"}</span></button>
    </section>
    <section class="modes" role="group" aria-label="模式">
      <button class="mode" data-mode="forward" aria-pressed="${chosenMode === "forward"}">
        <span class="icon">🗣️</span><b>口說</b><span class="small muted">你描述，AI 猜</span>${bestBadge("forward")}
      </button>
      <button class="mode" data-mode="reverse" aria-pressed="${chosenMode === "reverse"}">
        <span class="icon">👂</span><b>聽力</b><span class="small muted">AI 描述，你猜</span>${bestBadge("reverse")}
      </button>
    </section>
    ${ui.error ? `<div class="alert error">${esc(ui.error)}</div>` : ""}
    <button id="start" class="btn lg block">開始</button>
    <button id="book" class="card bookcard"><span class="l"><span class="icon">📒</span><span><b>詞本</b><span class="small muted">左右滑動複習，記住的就消失</span></span></span><span class="cnt ${cardCount() ? "" : "zero"}">${cardCount()}</span></button>`;
  root.querySelectorAll<HTMLButtonElement>(".mode").forEach((b) =>
    b.addEventListener("click", () => { chosenMode = b.dataset.mode as Mode; render(); }),
  );
  root.querySelectorAll<HTMLButtonElement>(".level").forEach((b) =>
    b.addEventListener("click", () => { chosenLevel = b.dataset.level as Level; render(); }),
  );
  (root.querySelector("#start") as HTMLButtonElement).addEventListener("click", () => void startGame());
  root.querySelector("#book")?.addEventListener("click", () => setScreen({ name: "vocab" }));
}

function violationText(v: Violation): string {
  switch (v.type) {
    case "chinese": return `🚫 中文：${v.chars.join(" ")}`;
    case "pinyin": return "🚫 拼音";
    case "taboo": return `🚫 ${v.words.join(", ")}`;
    case "too_short": return `✍️ 再多寫一點（${v.words}/${v.min} 字）`;
    case "too_long": return `✂️ 太長了（${v.chars}/${v.max}）`;
    case "empty": return "✍️ 先寫點什麼";
  }
}

function wordDots(n: number): string {
  return `<span class="wdots ${n >= MIN_WORDS ? "ok" : ""}" aria-label="${n} 個字">${Array.from({ length: MIN_WORDS }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderPlay(game: Game) {
  const qs = game.questions[game.index];
  const q = qs.q;
  const forward = game.mode === "forward";

  let body = "";
  if (forward) {
    const len = Array.from(q.idiom ?? "").length;
    const sizeClass = len <= 4 ? "" : len <= 6 ? "md" : "sm";
    const cards = game.level === "easy" ? q.hintWords : q.forbiddenWords;
    body += `<div class="tagrow">${q.tags.map((t) => `<span class="kind">${esc(t)}</span>`).join("")}${stars(q.difficulty)}</div>
      <div class="idiom ${sizeClass}">${esc(q.idiom ?? "")}</div>
      ${cards.length ? `<div class="chips ${game.level}"><span class="chip ban">${game.level === "easy" ? "💡" : "🚫"}</span>${cards
        .map((w, i) => {
          const zh = qs.flipped?.has(i) && w.zh;
          return `<button class="chip word ${zh ? "zh" : ""}" data-i="${i}" aria-label="${esc(w.en)}">${esc(zh ? w.zh : w.en)}</button>`;
        })
        .join("")}</div>` : ""}`;
  } else {
    body += `<div class="tagrow">${q.tags.map((t) => `<span class="kind">${esc(t)}</span>`).join("")}${stars(q.difficulty)}</div>`;
    // While guessing, a clue is only something you can replay. Text appears after the question ends.
    body += canSpeak || useServerTts
      ? `<div class="speakers">${qs.clues
          .map((c, i) => `<button class="speaker" data-i="${i}" aria-label="播放第 ${i + 1} 句">🔊<small>${i + 1}</small></button>`)
          .join("")}</div>`
      : `<div class="alert warn small">這個瀏覽器不支援語音播放，改以文字顯示。用 Chrome 或 Safari 開啟才有聲音。</div>` +
        qs.clues.map((c, i) => `<div class="clue plain">${i + 1}. ${esc(c)}</div>`).join("");
    const confirmed = knownChars(qs);
    if (!qs.done) body += slots(q.length ?? 4, confirmed, ui.draft);
  }

  if (qs.turns.length) {
    body += `<div class="history">${qs.turns
      .map((t, i) => {
        if (!forward) return `<div class="turn ${t.correct ? "hit" : "miss"}">${tiles(t.you, t.positions)}</div>`;
        const open = qs.shownTurn === i;
        const dice = t.fallback ? `<span class="gbadge" title="AI 回覆無法解析，這是盲猜">🎲</span>` : "";
        return `<div class="turn ${t.correct ? "hit" : "miss"}">
          <div class="ai">${tiles(t.guess ?? "", t.positions)}${dice}
            <span class="turnbtns">
              ${canSpeak || t.audioUrl ? `<button class="iconbtn sm say" data-i="${i}" aria-label="${t.audioUrl ? "播放我的錄音" : "聽我的句子"}">🔊</button>` : ""}
              <button class="iconbtn sm eye2" data-i="${i}" aria-pressed="${open}" aria-label="看我的句子">${open ? "🙈" : "👁"}</button>
            </span>
          </div>
          ${open ? `<div class="detail small"><div class="you">“${esc(t.you)}”</div></div>` : ""}
        </div>`;
      })
      .join("")}</div>`;
  }

  if (!qs.done) {
    if (forward) {
      if (qs.showStarters) {
        body += `<div class="starters">
          <div class="small muted">先說它是什麼 → 用來做什麼／什麼情況 → 結果或感覺</div>
          ${startersFor(q.tags).map((s) => `<button class="starter" data-s="${esc(s)}">${esc(s.trim())}…</button>`).join("")}
        </div>`;
      }
      body += `<div class="draftwrap"><textarea id="draft" class="${listener ? "listening" : ""}" placeholder="${listener ? "Listening…" : "Describe it in simple English…"}" maxlength="${MAX_CHARS + 50}" ${ui.busy ? "disabled" : ""}>${esc(ui.draft)}${listener && micInterim ? esc((ui.draft && !/\s$/.test(ui.draft) ? " " : "") + micInterim) : ""}</textarea>
        ${ui.draft || micInterim ? `<button id="clear" class="clearbtn" aria-label="清除全部" ${ui.busy ? "disabled" : ""}>✕</button>` : ""}</div>
        <div class="counter">${wordDots(countWords(ui.draft))}<span class="chars"></span></div>
        ${listener || whisperRec || whisperBusy ? `<div id="micstatus" class="small muted micstatus">${esc(micStatus)}</div>` : ""}`;
    } else {
      body += `<input id="draft" class="guess" type="text" maxlength="20" value="${esc(ui.draft)}" ${ui.busy ? "disabled" : ""} autocomplete="off" placeholder="…" />`;
    }
    if (ui.violations.length) body += `<div class="alert error">${ui.violations.map((v) => `<div>${esc(violationText(v))}</div>`).join("")}</div>`;
    if (ui.error) body += `<div class="alert warn">${esc(ui.error)}</div>`;
    body += `<div class="actions">
      ${forward ? `<button id="starters" class="mic hint ${qs.showStarters ? "on" : ""}" aria-pressed="${qs.showStarters ? "true" : "false"}" aria-label="不知道怎麼開口？">💡</button>` : ""}
      <button id="submit" class="btn" ${ui.busy ? "disabled" : ""}>${ui.busy ? '<span class="spinner"></span>' : "➤"}</button>
      ${forward ? (useWhisper
        ? `<button id="mic" class="mic ${whisperRec ? "on" : ""}" ${ui.busy || whisperBusy ? "disabled" : ""} aria-pressed="${whisperRec ? "true" : "false"}" aria-label="${whisperRec ? "停止錄音並辨識" : "語音輸入"}">${whisperBusy ? '<span class="spinner"></span>' : whisperRec ? "⏹" : "🎤"}</button>`
        : canListen
        ? `<button id="mic" class="mic ${listener ? "on" : ""}" ${ui.busy ? "disabled" : ""} aria-pressed="${listener ? "true" : "false"}" aria-label="${listener ? "停止錄音" : "語音輸入"}">${listener ? "⏹" : "🎤"}</button>`
        : `<button class="mic off" disabled title="這個瀏覽器不支援語音輸入" aria-label="語音輸入（不支援）">🎤</button>`) : ""}
    </div>
    <button id="giveup" class="giveup ${ui.confirmGiveUp ? "confirm" : ""}" ${ui.busy ? "disabled" : ""}>${ui.confirmGiveUp ? "確定放棄？0 分" : "放棄"}</button>`;
  }

  root.innerHTML = `<section class="card">${body}</section>${qs.done ? renderResult(game, qs) : ""}`;

  const draft = root.querySelector<HTMLTextAreaElement | HTMLInputElement>("#draft");
  if (draft) {
    draft.addEventListener("input", () => {
      // While listening, interim words are shown in the box but are not yet part of the draft.
      if (!(listener && micInterim && draft.value.endsWith(micInterim))) ui.draft = draft.value;
      const wrap = draft.parentElement;
      if (wrap && forward) {
        const has = draft.value.trim().length > 0;
        const btn = wrap.querySelector("#clear");
        if (has && !btn) {
          const b = document.createElement("button");
          b.id = "clear"; b.className = "clearbtn"; b.setAttribute("aria-label", "清除全部"); b.textContent = "✕";
          b.addEventListener("click", () => clearDraft(game));
          wrap.appendChild(b);
        } else if (!has && btn) btn.remove();
      }
      if (forward) {
        const n = countWords(ui.draft);
        const c = ui.draft.trim().length;
        const counter = root.querySelector(".counter");
        if (counter) counter.innerHTML = `${wordDots(n)}<span class="chars ${c > MAX_CHARS ? "bad" : ""}">${c > MAX_CHARS - 60 ? `${c}/${MAX_CHARS}` : ""}</span>`;
      } else {
        root.querySelector(".tiles.lg")?.replaceWith(fragment(slots(q.length ?? 4, knownChars(qs), ui.draft)));
      }
    });
    draft.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" && (!forward || e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(game); }
    });
    if (!ui.busy) {
      draft.focus();
      const end = draft.value.length;
      try { draft.setSelectionRange(end, end); } catch { /* inputs of some types refuse */ }
    }
  }
  root.querySelectorAll<HTMLButtonElement>(".speak, .speaker").forEach((b) =>
    b.addEventListener("click", () => void playClue(qs, Number(b.dataset.i))),
  );
  root.querySelectorAll<HTMLButtonElement>(".chip.word").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qs.flipped ??= new Set();
      if (qs.flipped.has(i)) qs.flipped.delete(i); else qs.flipped.add(i);
      const w = (game.level === "easy" ? q.hintWords : q.forbiddenWords)[i];
      const zh = qs.flipped.has(i) && w?.zh;
      b.textContent = zh ? w.zh : (w?.en ?? "");
      b.classList.toggle("zh", Boolean(zh));
    }),
  );
  root.querySelectorAll<HTMLButtonElement>(".say").forEach((b) =>
    b.addEventListener("click", () => {
      const t = qs.turns[Number(b.dataset.i)];
      if (t) playTurn(t.audioUrl, t.you);
    }),
  );
  root.querySelector("#fb-speak")?.addEventListener("click", () => {
    const texts: string[] = [];
    const ref = qs.referenceEnglish ?? qs.feedback?.reference_english;
    if (ref) texts.push(ref);
    // Only forward mode has English sentences from the player; in listening mode the turns are
    // Chinese guesses and must not be fed to the English voice.
    if (game.mode === "forward") qs.turns.forEach((t, i) => texts.push(qs.feedback?.corrections[i]?.corrected || t.you));
    speakAll(texts); // feedback stays on the browser voice; only clues use server TTS
  });
  root.querySelectorAll<HTMLButtonElement>(".eye2").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qs.shownTurn = qs.shownTurn === i ? undefined : i;
      render();
    }),
  );
  root.querySelector("#details")?.addEventListener("click", () => { qs.showDetails = !qs.showDetails; render(); });
  root.querySelector("#addbook")?.addEventListener("click", () => {
    const f = qs.feedback;
    if (!f) return;
    // Saved silently: the player sees what was kept only when they open the word book later.
    addFromFeedback(q.idiom ?? "", f.vocab, f.grammar);
    qs.addedToBook = true;
    render();
  });
  root.querySelectorAll<HTMLButtonElement>(".eye").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qs.shownClue = qs.shownClue === i ? undefined : i;
      render();
    }),
  );
  root.querySelector("#mic")?.addEventListener("click", () => (useWhisper ? void toggleWhisper(game) : toggleMic(game)));
  root.querySelector("#clear")?.addEventListener("click", () => clearDraft(game));
  root.querySelector("#starters")?.addEventListener("click", () => { qs.showStarters = !qs.showStarters; render(); });
  root.querySelectorAll<HTMLButtonElement>(".starter").forEach((b) =>
    b.addEventListener("click", () => {
      const s = b.dataset.s ?? "";
      ui.draft = ui.draft.trim() ? `${ui.draft.trim()} ${s}` : s;
      qs.showStarters = false;
      render();
      const ta = root.querySelector<HTMLTextAreaElement>("#draft");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }),
  );
  root.querySelector("#submit")?.addEventListener("click", () => void submit(game));
  root.querySelector("#next")?.addEventListener("click", () => void nextQuestion(game));
  root.querySelector("#giveup")?.addEventListener("click", () => {
    if (!ui.confirmGiveUp) { ui.confirmGiveUp = true; render(); return; }
    void giveUp(game);
  });
  root.querySelector("#retry-fb")?.addEventListener("click", () => void loadFeedback(game, qs));
}

function normalizeForDiff(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Render `after` with the words that differ from `before` highlighted (word-level LCS diff). */
function diffWords(before: string, after: string): string {
  const a = normalizeForDiff(before).split(" ");
  const b = normalizeForDiff(after).split(" ");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(esc(b[j])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { out.push(`<mark>${esc(b[j])}</mark>`); j++; }
  }
  while (j < m) out.push(`<mark>${esc(b[j++])}</mark>`);
  return out.join(" ");
}

/** Characters the player already has in place: green from earlier guesses, plus any revealed by the last clue. */
function knownChars(qs: QuestionState): (string | null)[] {
  const confirmed: (string | null)[] = [];
  for (const t of qs.turns) chars(t.you).forEach((ch, i) => { if (t.positions?.[i]) confirmed[i] = ch; });
  for (const [i, ch] of Object.entries(qs.revealed ?? {})) confirmed[Number(i)] = ch;
  return confirmed;
}

function fragment(html: string): Node {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild as Node;
}

function renderResult(game: Game, qs: QuestionState): string {
  const head = qs.solved
    ? `<div class="big-emoji">🎉</div><h2 class="points">+${qs.score}</h2>${qs.bonus ? `<div class="bonus">✅ 完整句子 +${qs.bonus}</div>` : ""}`
    : `<div class="big-emoji">${qs.gaveUp ? "🏳️" : "😅"}</div><h2 class="points zero">+0</h2>`;
  const answer = game.mode === "reverse"
    ? `<div class="answer">${tiles(qs.answer ?? "", chars(qs.answer ?? "").map(() => qs.solved), "lg")}<div class="tagrow">${(qs.answerTags ?? []).map((t) => `<span class="kind">${esc(t)}</span>`).join("")}</div></div>`
    : "";
  const ref = qs.referenceEnglish ?? qs.feedback?.reference_english;
  const refHtml = ref ? `<div class="ref"><div class="lbl">📖 參考答案</div>${esc(ref)}</div>` : "";
  const transcript = game.mode === "reverse" && qs.clues.length
    ? `<div class="transcript">${qs.clues.map((c, i) => `<div class="small"><button class="iconbtn speak sm" data-i="${i}" aria-label="播放">🔊</button> ${esc(c)}</div>`).join("")}</div>`
    : "";

  let fb = "";
  if (game.mode === "forward") {
    if (qs.feedback === undefined) fb = qs.turns.length ? `<div class="muted center" style="margin-top:12px"><span class="spinner"></span></div>` : "";
    else if (qs.feedback === null && qs.feedbackError) fb = `<div class="alert warn">${esc(qs.feedbackError)} <button id="retry-fb" class="btn ghost sm">重試</button></div>`;
    else if (qs.feedback) {
      const f = qs.feedback;
      fb = `<div class="corrections">${qs.turns
        .map((t, i) => {
          const c = f.corrections[i] ?? { corrected: t.you, note: "" };
          const same = normalizeForDiff(c.corrected) === normalizeForDiff(t.you);
          // Each row is one of the player's own descriptions, in order; a tag says whether grammar needed fixing.
          return `<div class="corr">
            <div class="orig ${same ? "ok" : ""}"><span class="n">#${i + 1}</span> ${same ? "" : "✏️ "}${esc(t.you)}${same ? ` <span class="oktag">文法 OK</span>` : ""}</div>
            ${same ? "" : `<div class="fixed">${diffWords(t.you, c.corrected)}</div>`}
            ${c.note ? `<div class="note small">${esc(c.note)}</div>` : ""}
          </div>`;
        })
        .join("")}</div>`;
    }
  }
  const last = game.index + 1 >= game.questions.length;
  const loading = game.mode === "forward" && qs.feedback === undefined && qs.turns.length > 0;
  const detailsHtml = game.mode === "reverse" ? refHtml : refHtml + fb;
  const toggle = detailsHtml
    ? `<button id="details" class="btn ghost sm details ${qs.showDetails ? "open" : ""}" aria-expanded="${qs.showDetails ? "true" : "false"}">${loading ? '<span class="spinner"></span>' : qs.showDetails ? "收起 ▴" : "📖 回饋 ▾"}</button>`
    : "";
  const speakBtn = qs.showDetails && canSpeak && !loading
    ? `<button id="fb-speak" class="iconbtn fbspeak" aria-label="朗讀回饋">🔊</button>`
    : "";
  const canAdd = game.mode === "forward" && qs.feedback && (qs.feedback.vocab.length > 0 || qs.feedback.grammar);
  const addBtn = qs.showDetails && canAdd
    ? `<button id="addbook" class="addbook ${qs.addedToBook ? "done" : ""}" ${qs.addedToBook ? "disabled" : ""}>${qs.addedToBook ? "✓ 已加入" : "＋ 詞本"}</button>`
    : "";
  return `<section class="card result center">${head}${answer}${game.mode === "reverse" ? transcript : ""}
    <div class="row" style="justify-content:center;margin-top:8px;gap:8px">${toggle}${speakBtn}${addBtn}</div>
    ${qs.showDetails ? `<div class="details-body">${detailsHtml}</div>` : ""}
    <button id="next" class="btn lg block" style="margin-top:16px">${last ? "總結" : "下一題 →"}</button></section>`;
}

/** Wordle-style share text: score, one square per question, link. */
function shareText(game: Game, record: { previous: number | null; isNew: boolean }): string {
  const total = game.questions.reduce((n, q) => n + q.score, 0);
  const squares = game.questions
    .map((q) => (q.gaveUp ? "🏳️" : !q.solved ? "⬛" : q.turns.length === 1 ? "🟩" : q.turns.length === 2 ? "🟨" : "🟧"))
    .join("");
  const mode = `${game.mode === "forward" ? "🗣️ 口說" : "👂 聽力"} ${game.level === "easy" ? "🌱" : "🔥"}`;
  const solved = game.questions.filter((q) => q.solved).length;
  const rec = record.isNew && record.previous !== null ? " 🏆 新紀錄" : "";
  return `繞著說 ${mode}\n${total} 分${rec}　${solved}/${game.questions.length} 題\n${squares}\n${location.origin}${location.pathname}`;
}

async function share(text: string): Promise<"shared" | "copied" | "failed"> {
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return "shared";
    }
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return "shared"; // user closed the sheet
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

// ---------- word book ----------

/** Recall within this many seconds (from showing the card to flipping it) counts as known. */
const RECALL_LIMIT_MS = 10_000;
const review = { flipped: false, shownAt: 0, flippedAt: 0, done: 0, dragX: 0 };

/**
 * Export the word book as a .txt file. On phones the share sheet is used (it offers Google Drive,
 * Files, LINE, …); elsewhere the file is downloaded. Nothing leaves the device through our server.
 */
async function exportVocab(): Promise<void> {
  const cards = listCards();
  if (!cards.length) return;
  // ASCII file name: some browsers drop a non-ASCII download name and save the file as "download".
  const name = `vocab-${dateStamp(new Date())}.txt`;
  const text = exportText(cards);
  const file = new File([text], name, { type: "text/plain" });
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "繞著說 詞本" });
      return;
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return; // user closed the sheet
      // fall through to a plain download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function renderVocab() {
  const cards = listCards();
  const card = cards[0];
  if (!card) {
    root.innerHTML = `<section class="card center pad"><div class="big-emoji">📒</div><h2>${review.done ? "今天複習完了" : "詞本是空的"}</h2>
      <p class="muted">${review.done ? `記住了 ${review.done} 張` : "玩口說模式，在回饋區按「＋ 詞本」就會加進來。"}</p>
      <button id="home" class="btn lg block" style="margin-top:12px">回首頁</button></section>`;
    root.querySelector("#home")?.addEventListener("click", () => { review.done = 0; setScreen({ name: "start" }); });
    return;
  }
  if (!review.shownAt) { review.shownAt = Date.now(); review.flipped = false; review.flippedAt = 0; }
  const seconds = Math.round(((review.flippedAt || Date.now()) - review.shownAt) / 1000);
  const front = card.type === "word"
    ? `${review.flipped ? `<div class="en">${esc(card.word)}</div>` : `<div class="zh">${esc(card.zh || "？")}</div>`}
       <div class="ex">${review.flipped ? esc(card.example).replace(new RegExp(`\\b(${card.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z']*)`, "i"), "<b>$1</b>") : esc(blankWord(card.example, card.word))}</div>`
    : `<div class="zh gtitle">${esc(card.title)}</div>
       ${review.flipped ? `<div class="ex fixed">${diffWords(card.wrong, card.fixed)}</div>` : `<div class="ex wrong">${esc(card.wrong)}</div>`}`;
  root.innerHTML = `<section>
      <div class="bookhead"><span class="muted small">卡片 ${review.done + 1} / ${review.done + cards.length}</span>
        <span class="row" style="gap:6px"><button id="say" class="btn ghost sm" ${review.flipped ? "" : "disabled"}>🔊</button><button id="export" class="btn ghost sm" title="匯出成 txt">⬇</button><button id="home" class="btn ghost sm">✕</button></span></div>
      <div class="stack">
        ${cards[2] ? `<div class="fc back2"></div>` : ""}${cards[1] ? `<div class="fc back1"></div>` : ""}
        <div id="fc" class="fc live ${card.type}"><span class="timer">⏱ ${seconds} 秒</span><span class="from">${esc(card.source)}</span>${front}</div>
      </div>
      <div class="swipe"><button id="no" class="l">← 不記得</button><button id="yes" class="r">記得 →</button></div>
    </section>`;
  const fc = root.querySelector<HTMLElement>("#fc")!;
  const flip = () => {
    if (!review.flipped && !review.flippedAt) review.flippedAt = Date.now(); // first reveal sets the recall time
    review.flipped = !review.flipped;
    render();
  };
  const settle = (known: boolean) => {
    const recallMs = (review.flippedAt || Date.now()) - review.shownAt;
    if (known && recallMs <= RECALL_LIMIT_MS) { removeCard(card.id); review.done += 1; }
    else keepCard(card.id);
    review.shownAt = 0; review.flipped = false; review.flippedAt = 0; review.dragX = 0;
    render();
  };
  root.querySelector("#home")?.addEventListener("click", () => { review.done = 0; review.shownAt = 0; review.flipped = false; review.flippedAt = 0; setScreen({ name: "start" }); });
  root.querySelector("#say")?.addEventListener("click", () => speak(card.type === "word" ? `${card.word}. ${card.example}` : card.fixed));
  root.querySelector("#export")?.addEventListener("click", () => { void exportVocab(); });
  root.querySelector("#yes")?.addEventListener("click", () => settle(true));
  root.querySelector("#no")?.addEventListener("click", () => settle(false));
  // Tap flips; a horizontal drag of 80px+ swipes.
  let startX = 0, dragging = false, moved = false;
  fc.addEventListener("pointerdown", (e) => { startX = e.clientX; dragging = true; moved = false; fc.setPointerCapture(e.pointerId); });
  fc.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 6) moved = true;
    review.dragX = dx;
    fc.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
    fc.classList.toggle("swiping-right", dx > 40);
    fc.classList.toggle("swiping-left", dx < -40);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const dx = review.dragX;
    fc.style.transform = "";
    fc.classList.remove("swiping-right", "swiping-left");
    if (dx > 80) settle(true);
    else if (dx < -80) settle(false);
    else if (!moved) flip();
    review.dragX = 0;
  };
  fc.addEventListener("pointerup", end);
  fc.addEventListener("pointercancel", end);
  if (!review.flippedAt) window.setTimeout(() => { if (screen.name === "vocab" && !review.flippedAt) { const t = root.querySelector(".timer"); if (t) t.textContent = `⏱ ${Math.round((Date.now() - review.shownAt) / 1000)} 秒`; } }, 1000);
}

function renderSummary(game: Game, record: { previous: number | null; isNew: boolean }) {
  const qs = game.questions;
  const total = qs.reduce((n, q) => n + q.score, 0);
  const solved = qs.filter((q) => q.solved).length;
  const recordHtml = record.isNew
    ? `<div class="record">🏆 ${record.previous === null ? "首次紀錄" : `新紀錄！上次 ${record.previous}`}</div>`
    : `<div class="record prev">🏆 最高 ${record.previous}</div>`;
  const rows = qs
    .map((q) => `<li class="${q.solved ? "ok" : "no"}"><span>${esc(q.q.idiom ?? q.answer ?? "？")}</span><span class="pts ${q.score ? "" : "zero"}">${q.gaveUp ? "🏳️ " : ""}${q.bonus ? "✅ " : ""}+${q.score}</span></li>`)
    .join("");
  root.innerHTML = `<section class="card summary center">
      <div class="small muted">${game.mode === "forward" ? "🗣️ 口說" : "👂 聽力"} ${game.level === "easy" ? "🌱" : "🔥"}</div>
      <div class="big">${total}<small>分</small></div>
      ${recordHtml}
      <div class="stats"><span class="num ok" aria-label="答對">${solved}</span><span class="num no" aria-label="答錯">${qs.length - solved}</span></div>
      <ul class="list">${rows}</ul>
      <button id="again" class="btn lg block" style="margin-top:16px">再玩</button>
      <button id="share" class="btn ghost block" style="margin-top:10px">分享成績</button>
      <div id="sharemsg" class="small muted" style="min-height:18px;margin-top:6px"></div>
    </section>`;
  root.querySelector("#again")?.addEventListener("click", () => { ui.error = ""; setScreen({ name: "start" }); });
  root.querySelector("#share")?.addEventListener("click", async () => {
    const msg = root.querySelector("#sharemsg");
    const outcome = await share(shareText(game, record));
    if (msg) msg.textContent = outcome === "copied" ? "已複製到剪貼簿，貼到想分享的地方吧" : outcome === "failed" ? "無法分享，請截圖" : "";
  });
}

// ---------- actions ----------

async function startGame() {
  ui.error = "";
  setScreen({ name: "loading", text: "" });
  try {
    const r = await api.round(chosenMode, chosenLevel);
    const features = r.features ?? { stt: false, tts: false };
    const game: Game = {
      mode: r.mode,
      level: chosenLevel,
      features,
      maxGuesses: Math.min(MAX_ATTEMPTS, r.maxGuesses),
      mock: r.mock,
      questions: r.questions.map((q) => ({ q, turns: [], clues: [], done: false, solved: false, gaveUp: false, score: 0, bonus: 0 })),
      index: 0,
    };
    speechRate = SPEECH_RATE[chosenLevel];
    ttsSpeed = TTS_SPEED[chosenLevel];
    useServerTts = features.tts;
    // Whisper needs a recorder; devices without MediaRecorder keep the browser recogniser.
    useWhisper = features.stt && canRecord;
    modelBadge = r.mock ? "MOCK" : "Haiku";
    for (const old of game.questions) releaseQuestionAudio(old);
    resetUi();
    setScreen({ name: "play", game });
    if (game.mode === "reverse") await loadClue(game, game.questions[0]);
  } catch (e) {
    ui.error = e instanceof Error ? e.message : "無法開始遊戲";
    setScreen({ name: "start" });
  }
}

function joinText(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(" ");
}

function stopMic() {
  // Keep whatever was still interim when the player stops: it is usually the last word or two.
  if (listener && micInterim) ui.draft = joinOverlap(ui.draft.trim(), micInterim);
  micUserStopped = true;
  if (listener) listener.stop();
  listener = null;
  micInterim = "";
  const rec = recording;
  recording = null;
  if (rec) void rec.stop().then((blob) => { if (blob) clips.push(blob); });
}

/** Called when a description is submitted: hand over the clips captured for it. */
async function takeRecording(): Promise<string | undefined> {
  const rec = recording;
  recording = null;
  if (rec) {
    const blob = await rec.stop();
    if (blob) clips.push(blob);
  }
  const all = joinClips(clips);
  clips = [];
  return all ? URL.createObjectURL(all) : undefined;
}

/** Give up on recording for this device; resolves once the microphone stream is released. */
async function blockRecording(reason: string): Promise<string> {
  const notice = `這台裝置無法在辨識時同時錄音（${reason}），已改為用語音念出你的句子。`;
  recordBlocked = true;
  try { localStorage.setItem(RECORD_BLOCK_KEY, "1"); } catch { /* ignore */ }
  const rec = recording;
  recording = null;
  clips = [];
  if (rec) await rec.stop();
  return notice;
}

function clearWatchdog() {
  if (micWatchdog !== null) { clearTimeout(micWatchdog); micWatchdog = null; }
}

function setMicStatus(text: string) {
  micStatus = text;
  const el = root.querySelector("#micstatus");
  if (el) el.textContent = text;
}

/** Whisper flow: tap to record, tap again to stop; the clip is uploaded and the text appended. */
async function toggleWhisper(game: Game) {
  if (whisperBusy) return;
  if (whisperRec) {
    if (whisperTimer !== null) { clearTimeout(whisperTimer); whisperTimer = null; }
    const rec = whisperRec;
    whisperRec = null;
    whisperBusy = true;
    setMicStatus("辨識中…");
    render();
    try {
      const blob = await rec.stop();
      if (!blob || blob.size < 1000) { ui.error = "沒有錄到聲音，再試一次。"; }
      else {
        const text = await transcribeClip(blob);
        if (text) {
          ui.draft = joinText(ui.draft, text);
          clips.push(blob); // keep the real voice for the guess row
        } else ui.error = "沒有辨識到英文，請再說一次。";
      }
    } catch (e) {
      ui.error = e instanceof ApiError ? e.message : "語音辨識失敗。";
    }
    whisperBusy = false;
    micStatus = "";
    render();
    return;
  }
  ui.error = "";
  const rec = await startRecording();
  if (!rec) { ui.error = "無法使用麥克風，請允許權限後再試。"; render(); return; }
  whisperRec = rec;
  whisperStartedAt = Date.now();
  const tick = () => {
    if (!whisperRec) return;
    const left = WHISPER_MAX_SECONDS - Math.floor((Date.now() - whisperStartedAt) / 1000);
    if (left <= 0) { whisperTimer = null; void toggleWhisper(game); return; } // auto-stop and transcribe
    setMicStatus(`錄音中，說完再按一次 ⏹（剩 ${left} 秒）`);
    whisperTimer = window.setTimeout(tick, 1000);
  };
  tick();
  render();
}

function toggleMic(game: Game) {
  if (listener) { stopMic(); render(); return; }
  ui.error = "";
  emptySessions = 0;
  silentSessions = 0;
  micUserStopped = false;
  startMicSession(game);
  render();
}

/**
 * One browser recognition session. The browser ends a session after a few seconds of silence;
 * unless the player pressed ⏹ we start the next one at once, carrying the text so far as prefix.
 */
function startMicSession(game: Game) {
  micPrefix = ui.draft.trim();
  micInterim = "";
  let l: Listener | null = null;
  let sessionHadText = false;
  const restartWithoutRecording = async (reason: string) => {
    if (listener) { listener.stop(); listener = null; }
    clearWatchdog();
    const notice = await blockRecording(reason); // wait until the mic is actually free
    if (screen.name !== "play" || screen.game !== game) return;
    toggleMic(game);
    ui.error = notice;
    render();
  };
  // Watchdog, re-armed at the start of every session while recording: a session that produces
  // nothing (no result, no end) within 6 s means the recorder is starving recognition.
  const armWatchdog = () => {
    clearWatchdog();
    if (recordBlocked) return;
    micWatchdog = window.setTimeout(() => {
      micWatchdog = null;
      if (listener === l && listener) void restartWithoutRecording("6 秒內沒有辨識結果");
    }, 6000);
  };
  l = startListening({
    onSessionEnd({ hadResult, error }) {
      setMicStatus(error ? `辨識段落結束（${error}）` : hadResult ? "辨識段落結束，繼續聆聽…" : "沒聽到聲音，繼續聆聽…");
      armWatchdog();
      if (!recording) return;
      // Microphone-related failures while we hold the stream mean the two consumers conflict.
      const micError = error === "audio-capture" || error === "aborted" || error === "network";
      emptySessions = hadResult ? 0 : emptySessions + 1;
      if (micError || emptySessions >= 2) void restartWithoutRecording(micError ? `錯誤 ${error}` : "沒有辨識到聲音");
    },
    onText(committedText, interim) {
      emptySessions = 0;
      silentSessions = 0;
      sessionHadText = true;
      clearWatchdog();
      setMicStatus("辨識中…");
      const joined = joinOverlap(micPrefix, committedText);
      ui.draft = joined;
      micInterim = interim;
      const ta = root.querySelector<HTMLTextAreaElement>("#draft");
      if (ta) {
        ta.value = joined + (interim ? (joined ? " " : "") + interim : "");
        ta.dispatchEvent(new Event("input"));
        ta.scrollTop = ta.scrollHeight;
      }
    },
    onEnd() {
      clearWatchdog();
      // Never lose the last interim words, whoever ended the session.
      if (micInterim) ui.draft = joinOverlap(ui.draft.trim(), micInterim);
      micInterim = "";
      const stillHere = screen.name === "play" && screen.game === game && !game.questions[game.index].done;
      if (!micUserStopped && stillHere && listener === l) {
        // Browser timed out on silence: keep going until the player presses ⏹.
        silentSessions = sessionHadText ? 0 : silentSessions + 1;
        if (silentSessions < MAX_SILENT) {
          listener = null;
          startMicSession(game);
          if (listener) { setMicStatus("繼續聆聽…"); syncDraftBox(); return; }
        }
        setMicStatus("太久沒有聲音，已停止");
      }
      listener = null;
      if (stillHere) render();
    },
    onError(message) {
      clearWatchdog();
      ui.error = message;
      listener = null;
      micInterim = "";
      render();
    },
  });
  if (!l) { ui.error = "無法啟動語音輸入。"; render(); return; }
  listener = l;
  setMicStatus(recordBlocked ? "聆聽中…" : "聆聽中（含錄音）…");
  armWatchdog();
  // Capture the real voice too, so the guess row can replay it. Skipped on devices where this
  // was seen to starve recognition (see recordBlocked); otherwise best effort.
  if (!recordBlocked) {
    void startRecording().then((rec) => {
      if (!rec) return;
      if (listener === l && !recordBlocked) recording = rec;
      else void rec.stop().then((blob) => { if (blob && !recordBlocked) clips.push(blob); });
    });
  }
}

/** Push ui.draft into the textarea without re-rendering (keeps focus and caret at the end). */
function syncDraftBox() {
  const ta = root.querySelector<HTMLTextAreaElement>("#draft");
  if (!ta) return;
  ta.value = ui.draft;
  ta.scrollTop = ta.scrollHeight;
}

function clearDraft(game: Game) {
  if (whisperTimer !== null) { clearTimeout(whisperTimer); whisperTimer = null; }
  if (whisperRec) { const r = whisperRec; whisperRec = null; void r.stop(); }
  const wasListening = Boolean(listener);
  if (wasListening) { micUserStopped = true; listener?.stop(); listener = null; }
  ui.draft = "";
  micInterim = "";
  micPrefix = "";
  clips = [];
  const rec = recording; recording = null; if (rec) void rec.stop();
  ui.violations = [];
  if (wasListening) { micUserStopped = false; silentSessions = 0; startMicSession(game); }
  render();
}

function resetUi() {
  stopMic();
  if (whisperTimer !== null) { clearTimeout(whisperTimer); whisperTimer = null; }
  if (whisperRec) { const r = whisperRec; whisperRec = null; void r.stop(); }
  whisperBusy = false;
  clips = [];
  ui.draft = "";
  ui.busy = false;
  ui.error = "";
  ui.violations = [];
  ui.confirmGiveUp = false;
}

async function giveUp(game: Game) {
  const qs = game.questions[game.index];
  if (qs.done || ui.busy) return;
  ui.busy = true;
  ui.confirmGiveUp = false;
  render();
  try {
    if (game.mode === "reverse") {
      const r = await api.giveUp(qs.q.id);
      qs.answer = r.answer;
      qs.answerTags = r.tags;
      qs.referenceEnglish = r.reference_english;
    }
    qs.done = true;
    qs.solved = false;
    qs.gaveUp = true;
    qs.score = 0;
    ui.busy = false;
    render();
    if (game.mode === "forward") {
      if (qs.turns.length) void loadFeedback(game, qs);
      else {
        // Nothing to review; fetch the reference phrasing via the give-up endpoint.
        const r = await api.giveUp(qs.q.id);
        qs.referenceEnglish = r.reference_english;
        qs.feedback = null;
        qs.feedbackError = "";
        render();
      }
    }
  } catch (e) {
    ui.busy = false;
    ui.error = e instanceof ApiError ? e.message : "操作失敗，請再試一次。";
    render();
  }
}

async function loadClue(game: Game, qs: QuestionState) {
  ui.busy = true;
  ui.error = "";
  render();
  try {
    const known = knownChars(qs).map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    const r = await api.describe(qs.q.id, qs.clues.length + 1, qs.clues, known);
    qs.clues.push(r.description);
    if (r.reveal) qs.revealed = { ...(qs.revealed ?? {}), [r.reveal.index]: r.reveal.char };
    qs.shownClue = undefined;
    void playClue(qs, qs.clues.length - 1);
  } catch (e) {
    ui.error = e instanceof Error ? e.message : "無法取得描述";
  }
  ui.busy = false;
  render();
}

async function submit(game: Game) {
  if (ui.busy) return;
  const qs = game.questions[game.index];
  const q = qs.q;
  if (qs.done) return;
  if (listener) stopMic(); // keeps interim words too
  const text = ui.draft.trim();
  ui.violations = [];
  ui.error = "";

  if (game.mode === "forward") {
    const local: Violation[] = [];
    if (!text) local.push({ type: "empty" });
    else {
      const w = countWords(text);
      if (w < MIN_WORDS) local.push({ type: "too_short", words: w, min: MIN_WORDS });
      if (text.length > MAX_CHARS) local.push({ type: "too_long", chars: text.length, max: MAX_CHARS });
      const han = Array.from(new Set(text.match(/\p{Script=Han}/gu) ?? []));
      if (han.length) local.push({ type: "chinese", chars: han });
      if (game.level === "hard") {
        const hits = q.forbiddenWords.filter((w) => new RegExp(`(?<![a-z0-9])${w.en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es|ed|d|ing)?(?![a-z0-9])`, "i").test(text)).map((w) => w.en);
        if (hits.length) local.push({ type: "taboo", words: hits });
      }
    }
    if (local.length) { ui.violations = local; render(); return; }

    ui.busy = true;
    render();
    const descriptions = [...qs.turns.map((t) => t.you), text];
    const audioUrl = await takeRecording();
    try {
      const previousGuesses = qs.turns.map((t) => t.guess ?? "").filter(Boolean);
      const r = await api.guess(qs.q.id, game.level, q.forbiddenWords.map((w) => w.en), descriptions, previousGuesses);
      if (!r.ok) {
        ui.violations = r.violations;
        if (audioUrl) URL.revokeObjectURL(audioUrl);
      } else {
        qs.turns.push({ you: text, guess: r.guess, reason: r.reason, correct: r.correct, positions: r.positions, perfect: r.perfectSentence, grammarNote: r.grammarNote, fallback: r.fallback, audioUrl });
        ui.draft = "";
        if (r.correct || qs.turns.length >= game.maxGuesses) {
          qs.done = true;
          qs.solved = r.correct;
          // Rule 1: the bonus looks only at the description that produced the correct guess.
          qs.bonus = r.correct && r.perfectSentence ? SENTENCE_BONUS : 0;
          qs.score = scoreFor(game.level, r.correct, qs.turns.length) + qs.bonus;
          qs.feedback = undefined;
          ui.busy = false;
          render();
          void loadFeedback(game, qs);
          return;
        }
      }
    } catch (e) {
      ui.error = e instanceof ApiError ? e.message : "送出失敗，請再試一次。";
    }
    ui.busy = false;
    render();
  } else {
    if (!text) { ui.violations = [{ type: "empty" }]; render(); return; }
    ui.busy = true;
    render();
    try {
      const attempt = qs.turns.length + 1;
      const r = await api.reverseGuess(qs.q.id, text, attempt);
      qs.turns.push({ you: text, correct: r.correct, positions: r.positions });
      ui.draft = "";
      if (r.correct || attempt >= game.maxGuesses) {
        qs.done = true;
        qs.solved = r.correct;
        qs.score = scoreFor(game.level, r.correct, attempt);
        qs.answer = r.answer;
        qs.answerTags = r.tags;
        qs.referenceEnglish = r.reference_english;
        ui.busy = false;
        render();
        return;
      }
      ui.busy = false;
      render();
      await loadClue(game, qs);
      return;
    } catch (e) {
      ui.error = e instanceof ApiError ? e.message : "送出失敗，請再試一次。";
    }
    ui.busy = false;
    render();
  }
}

async function loadFeedback(game: Game, qs: QuestionState) {
  qs.feedback = undefined;
  qs.feedbackError = undefined;
  render();
  try {
    qs.feedback = await api.feedback(qs.q.id, qs.turns.map((t) => t.you), qs.solved, qs.turns.length);
  } catch (e) {
    qs.feedback = null;
    qs.feedbackError = e instanceof ApiError ? e.message : "回饋載入失敗";
  }
  if (screen.name === "play" && screen.game === game && game.questions[game.index] === qs) render();
}

/** Free every audio resource of a question: clue clips, their decoded PCM, and the player's recordings. */
function releaseQuestionAudio(qs: QuestionState) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (clueElement) { clueElement.pause(); clueElement.removeAttribute("src"); clueElement.load(); }
  for (const u of Object.values(qs.clueAudio ?? {})) URL.revokeObjectURL(u);
  qs.clueAudio = undefined;
  for (const t of qs.turns) { if (t.audioUrl) { URL.revokeObjectURL(t.audioUrl); t.audioUrl = undefined; } }
}

async function nextQuestion(game: Game) {
  // The finished question's audio is never played again: drop it before moving on.
  releaseQuestionAudio(game.questions[game.index]);
  if (game.index + 1 >= game.questions.length) {
    const total = game.questions.reduce((n, q) => n + q.score, 0);
    setScreen({ name: "summary", game, record: recordScore(game.mode, game.level, total) });
    return;
  }
  game.index += 1;
  resetUi();
  render();
  if (game.mode === "reverse") await loadClue(game, game.questions[game.index]);
}

render();
