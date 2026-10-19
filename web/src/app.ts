import { api, ApiError, type Level, type Mode, type Violation } from "./api.js";
import { canListen, startListening, type Listener } from "./speech.js";
import { joinClips, startRecording, type Recording } from "./recorder.js";
import { MAX_ATTEMPTS, MAX_CHARS, MIN_WORDS, SCORES, SENTENCE_BONUS, countWords, maxScore, scoreFor, type Game, type QuestionState, type Screen } from "./state.js";

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

const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en(-|_)?(US|GB|AU)?/i.test(v.lang));
  return en.find((v) => /Google|Samantha|Daniel|Natural/i.test(v.name)) ?? en[0] ?? voices[0] ?? null;
}

/** Speech rate by level: easy mode speaks noticeably slower. */
const SPEECH_RATE: Record<Level, number> = { hard: 0.8, easy: 0.6 };
let speechRate = SPEECH_RATE.hard;

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
    case "summary": return renderSummary(screen.game);
  }
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
        <span class="icon">🗣️</span><b>口說</b><span class="small muted">你描述，AI 猜</span>
      </button>
      <button class="mode" data-mode="reverse" aria-pressed="${chosenMode === "reverse"}">
        <span class="icon">👂</span><b>聽力</b><span class="small muted">AI 描述，你猜</span>
      </button>
    </section>
    ${ui.error ? `<div class="alert error">${esc(ui.error)}</div>` : ""}
    <button id="start" class="btn lg block">開始</button>`;
  root.querySelectorAll<HTMLButtonElement>(".mode").forEach((b) =>
    b.addEventListener("click", () => { chosenMode = b.dataset.mode as Mode; render(); }),
  );
  root.querySelectorAll<HTMLButtonElement>(".level").forEach((b) =>
    b.addEventListener("click", () => { chosenLevel = b.dataset.level as Level; render(); }),
  );
  (root.querySelector("#start") as HTMLButtonElement).addEventListener("click", () => void startGame());
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
    body += canSpeak
      ? `<div class="speakers">${qs.clues
          .map((c, i) => `<button class="speaker" data-i="${i}" aria-label="播放第 ${i + 1} 句">🔊<small>${i + 1}</small></button>`)
          .join("")}</div>`
      : qs.clues.map((c, i) => `<div class="clue shown"><span class="cluetext">${i + 1}. ${esc(c)}</span></div>`).join("");
    const confirmed: (string | null)[] = [];
    for (const t of qs.turns) chars(t.you).forEach((ch, i) => { if (t.positions?.[i]) confirmed[i] = ch; });
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
      body += `<textarea id="draft" class="${listener ? "listening" : ""}" placeholder="${listener ? "Listening…" : "Describe it in simple English…"}" maxlength="${MAX_CHARS + 50}" ${ui.busy ? "disabled" : ""}>${esc(ui.draft)}${listener && micInterim ? esc((ui.draft && !/\s$/.test(ui.draft) ? " " : "") + micInterim) : ""}</textarea>
        <div class="counter">${wordDots(countWords(ui.draft))}<span class="chars"></span></div>`;
    } else {
      body += `<input id="draft" class="guess" type="text" maxlength="20" value="${esc(ui.draft)}" ${ui.busy ? "disabled" : ""} autocomplete="off" placeholder="…" />`;
    }
    if (ui.violations.length) body += `<div class="alert error">${ui.violations.map((v) => `<div>${esc(violationText(v))}</div>`).join("")}</div>`;
    if (ui.error) body += `<div class="alert warn">${esc(ui.error)}</div>`;
    body += `<div class="actions">
      ${forward ? `<button id="starters" class="mic hint ${qs.showStarters ? "on" : ""}" aria-pressed="${qs.showStarters ? "true" : "false"}" aria-label="不知道怎麼開口？">💡</button>` : ""}
      <button id="submit" class="btn" ${ui.busy ? "disabled" : ""}>${ui.busy ? '<span class="spinner"></span>' : "➤"}</button>
      ${forward ? (canListen
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
      if (forward) {
        const n = countWords(ui.draft);
        const c = ui.draft.trim().length;
        const counter = root.querySelector(".counter");
        if (counter) counter.innerHTML = `${wordDots(n)}<span class="chars ${c > MAX_CHARS ? "bad" : ""}">${c > MAX_CHARS - 60 ? `${c}/${MAX_CHARS}` : ""}</span>`;
      } else {
        const confirmed: (string | null)[] = [];
        for (const t of qs.turns) chars(t.you).forEach((ch, i) => { if (t.positions?.[i]) confirmed[i] = ch; });
        root.querySelector(".tiles.lg")?.replaceWith(fragment(slots(q.length ?? 4, confirmed, ui.draft)));
      }
    });
    draft.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" && (!forward || e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(game); }
    });
    if (!ui.busy) draft.focus();
  }
  root.querySelectorAll<HTMLButtonElement>(".speak, .speaker").forEach((b) =>
    b.addEventListener("click", () => speak(qs.clues[Number(b.dataset.i)] ?? "")),
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
    qs.turns.forEach((t, i) => texts.push(qs.feedback?.corrections[i]?.corrected || t.you));
    speakAll(texts);
  });
  root.querySelectorAll<HTMLButtonElement>(".eye2").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qs.shownTurn = qs.shownTurn === i ? undefined : i;
      render();
    }),
  );
  root.querySelector("#details")?.addEventListener("click", () => { qs.showDetails = !qs.showDetails; render(); });
  root.querySelectorAll<HTMLButtonElement>(".eye").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qs.shownClue = qs.shownClue === i ? undefined : i;
      render();
    }),
  );
  root.querySelector("#mic")?.addEventListener("click", () => toggleMic(game));
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
          return `<div class="corr">
            <div class="orig ${same ? "ok" : ""}">${same ? "✅" : "✏️"} ${esc(t.you)}</div>
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
  return `<section class="card result center">${head}${answer}${game.mode === "reverse" ? transcript : ""}
    <div class="row" style="justify-content:center;margin-top:8px;gap:8px">${toggle}${speakBtn}</div>
    ${qs.showDetails ? `<div class="details-body">${detailsHtml}</div>` : ""}
    <button id="next" class="btn lg block" style="margin-top:16px">${last ? "總結" : "下一題 →"}</button></section>`;
}

function renderSummary(game: Game) {
  const qs = game.questions;
  const total = qs.reduce((n, q) => n + q.score, 0);
  const solved = qs.filter((q) => q.solved).length;
  const rows = qs
    .map((q) => `<li class="${q.solved ? "ok" : "no"}"><span>${esc(q.q.idiom ?? q.answer ?? "？")}</span><span class="pts ${q.score ? "" : "zero"}">${q.gaveUp ? "🏳️ " : ""}${q.bonus ? "✅ " : ""}+${q.score}</span></li>`)
    .join("");
  root.innerHTML = `<section class="card summary center">
      <div class="big">${total}<span class="muted">/${qs.length * (maxScore(game.level) + SENTENCE_BONUS)}</span></div>
      <div class="muted">${solved}/${qs.length} 題猜中</div>
      <ul class="list">${rows}</ul>
      <button id="again" class="btn lg block" style="margin-top:16px">再玩</button>
    </section>`;
  root.querySelector("#again")?.addEventListener("click", () => { ui.error = ""; setScreen({ name: "start" }); });
}

// ---------- actions ----------

async function startGame() {
  ui.error = "";
  setScreen({ name: "loading", text: "" });
  try {
    const r = await api.round(chosenMode, chosenLevel);
    const game: Game = {
      mode: r.mode,
      level: chosenLevel,
      maxGuesses: Math.min(MAX_ATTEMPTS, r.maxGuesses),
      mock: r.mock,
      questions: r.questions.map((q) => ({ q, turns: [], clues: [], done: false, solved: false, gaveUp: false, score: 0, bonus: 0 })),
      index: 0,
    };
    speechRate = SPEECH_RATE[chosenLevel];
    modelBadge = r.mock ? "MOCK" : "Haiku";
    for (const old of game.questions) old.turns.forEach((t) => t.audioUrl && URL.revokeObjectURL(t.audioUrl));
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
  if (listener && micInterim) ui.draft = joinText(ui.draft, micInterim);
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

function toggleMic(game: Game) {
  if (listener) { stopMic(); render(); return; }
  micPrefix = ui.draft.trim();
  micInterim = "";
  ui.error = "";
  const l = startListening({
    onText(committedText, interim) {
      const joined = joinText(micPrefix, committedText);
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
      // Dictation finished (player pressed stop).
      listener = null;
      micInterim = "";
      if (screen.name === "play" && screen.game === game) render();
    },
    onError(message) {
      ui.error = message;
      listener = null;
      micInterim = "";
      render();
    },
  });
  if (!l) { ui.error = "無法啟動語音輸入。"; render(); return; }
  listener = l;
  // Capture the real voice too, so the guess row can replay it. Best effort: if the browser
  // refuses a second microphone consumer, dictation still works and playback uses TTS.
  void startRecording().then((rec) => {
    if (!rec) return;
    if (listener === l) recording = rec;
    else void rec.stop().then((blob) => { if (blob) clips.push(blob); });
  });
  render();
}

function resetUi() {
  stopMic();
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
    const r = await api.describe(qs.q.id, qs.clues.length + 1, qs.clues);
    qs.clues.push(r.description);
    qs.shownClue = undefined;
    speak(r.description);
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

async function nextQuestion(game: Game) {
  if (game.index + 1 >= game.questions.length) {
    setScreen({ name: "summary", game });
    return;
  }
  game.index += 1;
  resetUi();
  render();
  if (game.mode === "reverse") await loadClue(game, game.questions[game.index]);
}

render();
