import { api, ApiError, type Level, type Mode, type Violation } from "./api.js";
import { MAX_ATTEMPTS, MAX_CHARS, MAX_SCORE, MIN_WORDS, SCORES, countWords, scoreFor, type Game, type QuestionState, type Screen } from "./state.js";

const root = document.getElementById("app") as HTMLElement;
const badge = document.getElementById("mode-badge") as HTMLElement;

let screen: Screen = { name: "start" };
let chosenMode: Mode = "forward";
let chosenLevel: Level = "hard";
/** Transient per-question UI state. */
const ui = { draft: "", busy: false, error: "", violations: [] as Violation[], confirmGiveUp: false };

const MODE_LABEL: Record<Mode, string> = { forward: "口說", reverse: "聽力" };

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
/** Score ladder: 5 · 3 · 1, dimming the points already lost; the next attempt's value is highlighted. */
function ladder(used: number, done: boolean): string {
  return `<span class="ladder" aria-label="這題可得 ${done ? 0 : SCORES[used] ?? 0} 分">${SCORES.map((s, i) => `<i class="${i < used || done ? "lost" : i === used ? "now" : ""}">${s}</i>`).join("")}</span>`;
}
// ---------- speech (browser TTS, no API cost) ----------

const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en(-|_)?(US|GB|AU)?/i.test(v.lang));
  return en.find((v) => /Google|Samantha|Daniel|Natural/i.test(v.name)) ?? en[0] ?? voices[0] ?? null;
}

function speak(text: string) {
  if (!canSpeak) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/^\[MOCK[^\]]*\]\s*/, ""));
    u.lang = "en-US";
    u.rate = 0.9;
    const v = pickVoice();
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore: speech is best-effort */
  }
}
if (canSpeak) window.speechSynthesis.onvoiceschanged = () => pickVoice();

function setScreen(s: Screen) {
  screen = s;
  render();
}

// ---------- rendering ----------

function render() {
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
      <button class="level" data-level="easy" aria-pressed="${chosenLevel === "easy"}"><span class="icon">🌱</span><b>簡單</b><span class="small muted">單字可以用</span></button>
      <button class="level" data-level="hard" aria-pressed="${chosenLevel === "hard"}"><span class="icon">🔥</span><b>困難</b><span class="small muted">單字不能說</span></button>
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

function renderTop(game: Game): string {
  const n = game.index + 1;
  const total = game.questions.length;
  const qs = game.questions[game.index];
  return `<div class="top">
      <span class="muted">${MODE_LABEL[game.mode]}${game.mode === "forward" ? (game.level === "easy" ? " 🌱" : " 🔥") : ""}</span>
      <span class="dots">${game.questions.map((q, i) => `<i class="${i < game.index ? (q.solved ? "ok" : "no") : i === game.index ? "now" : ""}"></i>`).join("")}</span>
      <span class="muted">${n}/${total}</span>
    </div>
    <div class="row between" style="margin-top:8px">${ladder(qs.turns.length, qs.done)}<span class="muted small">${game.questions.reduce((n, q) => n + q.score, 0)} 分</span>${stars(qs.q.difficulty)}</div>`;
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
    body += `<div class="tagrow">${(q.tags ?? []).map((t) => `<span class="kind">${esc(t)}</span>`).join("")}</div>
      <div class="idiom ${sizeClass}">${esc(q.idiom ?? "")}</div>
      <div class="chips ${game.level}"><span class="chip ban">${game.level === "easy" ? "💡" : "🚫"}</span>${q.tabooWords
        .map((w, i) => {
          const zh = qs.flipped?.has(i) && w.zh;
          return `<button class="chip word ${zh ? "zh" : ""}" data-i="${i}" aria-label="${esc(w.en)}">${esc(zh ? w.zh : w.en)}</button>`;
        })
        .join("")}</div>`;
  } else {
    body += qs.clues
      .map((c, i) => {
        const shown = !canSpeak || qs.shownClue === i;
        return `<div class="clue ${shown ? "shown" : ""}">
          <button class="iconbtn speak" data-i="${i}" aria-label="播放第 ${i + 1} 句">🔊</button>
          <span class="cluetext">${shown ? esc(c) : `<span class="dotsline">${"•".repeat(Math.min(16, Math.max(6, Math.round(c.length / 6))))}</span>`}</span>
          ${canSpeak ? `<button class="iconbtn eye" data-i="${i}" aria-pressed="${shown}" aria-label="顯示文字">${shown ? "🙈" : "👁"}</button>` : ""}
        </div>`;
      })
      .join("");
    const confirmed: (string | null)[] = [];
    for (const t of qs.turns) chars(t.you).forEach((ch, i) => { if (t.positions?.[i]) confirmed[i] = ch; });
    if (!qs.done) body += slots(q.length ?? 4, confirmed, ui.draft);
  }

  if (qs.turns.length) {
    body += `<div class="history">${qs.turns
      .map((t, i) => {
        if (!forward) return `<div class="turn ${t.correct ? "hit" : "miss"}">${tiles(t.you, t.positions)}</div>`;
        const open = qs.shownTurn === i;
        return `<div class="turn ${t.correct ? "hit" : "miss"}">
          <div class="ai">${tiles(t.guess ?? "", t.positions)}
            <span class="turnbtns">
              ${canSpeak ? `<button class="iconbtn sm say" data-i="${i}" aria-label="聽理由">🔊</button>` : ""}
              <button class="iconbtn sm eye2" data-i="${i}" aria-pressed="${open}" aria-label="看理由">${open ? "🙈" : "👁"}</button>
            </span>
          </div>
          ${open ? `<div class="detail small"><div class="muted">${esc(t.reason ?? "")}</div><div class="you">“${esc(t.you)}”</div></div>` : ""}
        </div>`;
      })
      .join("")}</div>`;
  }

  if (!qs.done) {
    if (forward) {
      body += `<textarea id="draft" placeholder="Describe it in simple English…" maxlength="${MAX_CHARS + 50}" ${ui.busy ? "disabled" : ""}>${esc(ui.draft)}</textarea>
        <div class="counter">${wordDots(countWords(ui.draft))}<span class="chars"></span></div>`;
    } else {
      body += `<input id="draft" class="guess" type="text" maxlength="20" value="${esc(ui.draft)}" ${ui.busy ? "disabled" : ""} autocomplete="off" placeholder="…" />`;
    }
    if (ui.violations.length) body += `<div class="alert error">${ui.violations.map((v) => `<div>${esc(violationText(v))}</div>`).join("")}</div>`;
    if (ui.error) body += `<div class="alert warn">${esc(ui.error)}</div>`;
    body += `<div class="actions">
      <button id="submit" class="btn" ${ui.busy ? "disabled" : ""}>${ui.busy ? '<span class="spinner"></span>' : "➤"}</button>
      ${forward ? `<button class="mic" disabled title="語音輸入即將推出" aria-label="語音輸入（即將推出）">🎤</button>` : ""}
    </div>
    <button id="giveup" class="giveup ${ui.confirmGiveUp ? "confirm" : ""}" ${ui.busy ? "disabled" : ""}>${ui.confirmGiveUp ? "確定放棄？0 分" : "放棄"}</button>`;
  }

  root.innerHTML = `<section class="card">${renderTop(game)}</section><section class="card">${body}</section>${qs.done ? renderResult(game, qs) : ""}`;

  const draft = root.querySelector<HTMLTextAreaElement | HTMLInputElement>("#draft");
  if (draft) {
    draft.addEventListener("input", () => {
      ui.draft = draft.value;
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
  root.querySelectorAll<HTMLButtonElement>(".speak").forEach((b) =>
    b.addEventListener("click", () => speak(qs.clues[Number(b.dataset.i)] ?? "")),
  );
  root.querySelectorAll<HTMLButtonElement>(".chip.word").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qs.flipped ??= new Set();
      if (qs.flipped.has(i)) qs.flipped.delete(i); else qs.flipped.add(i);
      const w = q.tabooWords[i];
      const zh = qs.flipped.has(i) && w?.zh;
      b.textContent = zh ? w.zh : (w?.en ?? "");
      b.classList.toggle("zh", Boolean(zh));
    }),
  );
  root.querySelectorAll<HTMLButtonElement>(".say").forEach((b) =>
    b.addEventListener("click", () => speak(qs.turns[Number(b.dataset.i)]?.reason ?? "")),
  );
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
  root.querySelector("#submit")?.addEventListener("click", () => void submit(game));
  root.querySelector("#next")?.addEventListener("click", () => void nextQuestion(game));
  root.querySelector("#giveup")?.addEventListener("click", () => {
    if (!ui.confirmGiveUp) { ui.confirmGiveUp = true; render(); return; }
    void giveUp(game);
  });
  root.querySelector("#retry-fb")?.addEventListener("click", () => void loadFeedback(game, qs));
}

function fragment(html: string): Node {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild as Node;
}

function renderResult(game: Game, qs: QuestionState): string {
  const head = qs.solved
    ? `<div class="big-emoji">🎉</div><h2 class="points">+${qs.score}</h2>`
    : `<div class="big-emoji">${qs.gaveUp ? "🏳️" : "😅"}</div><h2 class="points zero">+0</h2>`;
  const answer = game.mode === "reverse"
    ? `<div class="answer">${tiles(qs.answer ?? "", chars(qs.answer ?? "").map(() => qs.solved), "lg")}<div class="tagrow">${(qs.answerTags ?? []).map((t) => `<span class="kind">${esc(t)}</span>`).join("")}</div></div>`
    : "";
  const ref = qs.referenceEnglish ?? qs.feedback?.reference_english;
  const refHtml = ref ? `<div class="ref">📖 ${esc(ref)}</div>` : "";
  const transcript = game.mode === "reverse" && qs.clues.length
    ? `<div class="transcript">${qs.clues.map((c, i) => `<div class="small"><button class="iconbtn speak sm" data-i="${i}" aria-label="播放">🔊</button> ${esc(c)}</div>`).join("")}</div>`
    : "";

  let fb = "";
  if (game.mode === "forward") {
    if (qs.feedback === undefined) fb = qs.turns.length ? `<div class="muted center" style="margin-top:12px"><span class="spinner"></span></div>` : "";
    else if (qs.feedback === null && qs.feedbackError) fb = `<div class="alert warn">${esc(qs.feedbackError)} <button id="retry-fb" class="btn ghost sm">重試</button></div>`;
    else if (qs.feedback) {
      const f = qs.feedback;
      const section = (icon: string, items: string[]) => items.length ? `<ul class="fb">${items.map((p, i) => `<li>${i === 0 ? `<span class="fi">${icon}</span>` : `<span class="fi"></span>`}<span>${esc(p)}</span></li>`).join("")}</ul>` : "";
      fb = section("✨", f.better_phrases) + section("✏️", f.issues) + section("💡", [f.tip]);
    }
  }
  const last = game.index + 1 >= game.questions.length;
  const loading = game.mode === "forward" && qs.feedback === undefined && qs.turns.length > 0;
  const detailsHtml = refHtml + transcript + fb;
  const toggle = detailsHtml
    ? `<button id="details" class="btn ghost sm details ${qs.showDetails ? "open" : ""}" aria-expanded="${qs.showDetails ? "true" : "false"}">${loading ? '<span class="spinner"></span>' : qs.showDetails ? "收起 ▴" : "📖 回饋 ▾"}</button>`
    : "";
  return `<section class="card result center">${head}${answer}
    <div class="row" style="justify-content:center;margin-top:8px">${toggle}</div>
    ${qs.showDetails ? `<div class="details-body">${detailsHtml}</div>` : ""}
    <button id="next" class="btn lg block" style="margin-top:16px">${last ? "總結" : "下一題 →"}</button></section>`;
}

function renderSummary(game: Game) {
  const qs = game.questions;
  const total = qs.reduce((n, q) => n + q.score, 0);
  const solved = qs.filter((q) => q.solved).length;
  const rows = qs
    .map((q) => `<li class="${q.solved ? "ok" : "no"}"><span>${esc(q.q.idiom ?? q.answer ?? "？")}</span><span class="pts ${q.score ? "" : "zero"}">${q.gaveUp ? "🏳️ " : ""}+${q.score}</span></li>`)
    .join("");
  root.innerHTML = `<section class="card summary center">
      <div class="big">${total}<span class="muted">/${qs.length * MAX_SCORE}</span></div>
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
    const r = await api.round(chosenMode);
    const game: Game = {
      mode: r.mode,
      level: chosenLevel,
      maxGuesses: Math.min(MAX_ATTEMPTS, r.maxGuesses),
      mock: r.mock,
      questions: r.questions.map((q) => ({ q, turns: [], clues: [], done: false, solved: false, gaveUp: false, score: 0 })),
      index: 0,
    };
    badge.hidden = false;
    badge.textContent = r.mock ? "MOCK" : "Haiku";
    badge.className = r.mock ? "badge" : "badge live";
    resetUi();
    setScreen({ name: "play", game });
    if (game.mode === "reverse") await loadClue(game, game.questions[0]);
  } catch (e) {
    ui.error = e instanceof Error ? e.message : "無法開始遊戲";
    setScreen({ name: "start" });
  }
}

function resetUi() {
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
  if (qs.done) return;
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
    }
    if (local.length) { ui.violations = local; render(); return; }

    ui.busy = true;
    render();
    const descriptions = [...qs.turns.map((t) => t.you), text];
    try {
      const previousGuesses = qs.turns.map((t) => t.guess ?? "").filter(Boolean);
      const r = await api.guess(qs.q.id, game.level, descriptions, previousGuesses);
      if (!r.ok) {
        ui.violations = r.violations;
      } else {
        qs.turns.push({ you: text, guess: r.guess, reason: r.reason, correct: r.correct, positions: r.positions });
        ui.draft = "";
        if (r.correct || qs.turns.length >= game.maxGuesses) {
          qs.done = true;
          qs.solved = r.correct;
          qs.score = scoreFor(r.correct, qs.turns.length);
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
        qs.score = scoreFor(r.correct, attempt);
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
