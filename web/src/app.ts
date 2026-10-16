import { api, ApiError, type Mode, type Violation } from "./api.js";
import { MAX_CHARS, MIN_WORDS, countWords, type Game, type QuestionState, type Screen } from "./state.js";

const root = document.getElementById("app") as HTMLElement;
const badge = document.getElementById("mode-badge") as HTMLElement;

let screen: Screen = { name: "start" };
let chosenMode: Mode = "forward";
let chosenGuesses = 3;
let serverMaxGuesses = 3;
/** Per-question transient UI state (draft text, in-flight flags, errors). */
const ui = { draft: "", busy: false, error: "", violations: [] as Violation[] };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
/** Wordle-style tiles: one box per character, green when right character in right position. */
function tiles(text: string, positions: boolean[] = []): string {
  const chars = Array.from(text.replace(/[\s\p{P}\p{S}]/gu, ""));
  return `<span class="tiles" aria-label="${esc(text)}">${chars
    .map((c, i) => `<span class="tile ${positions[i] ? "hit" : ""}">${esc(c)}</span>`)
    .join("")}</span>`;
}
function stars(d: number): string {
  return "★".repeat(d) + "☆".repeat(3 - d);
}
function setScreen(s: Screen) {
  screen = s;
  render();
}

// ---------- rendering ----------

function render() {
  switch (screen.name) {
    case "start": return renderStart();
    case "loading": root.innerHTML = `<section class="card center"><span class="spinner"></span>${esc(screen.text)}</section>`; return;
    case "play": return renderPlay(screen.game);
    case "summary": return renderSummary(screen.game);
  }
}

function renderStart() {
  const options = Array.from({ length: serverMaxGuesses }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${n === chosenGuesses ? "selected" : ""}>${n} 次</option>`)
    .join("");
  root.innerHTML = `
    <section class="card hero">
      <h1>用英文把成語「繞著說」</h1>
      <p class="muted">不知道那個字怎麼講？用簡單的英文把意思說清楚，讓 AI 猜出是哪個成語。一輪 10 題，由易到難。</p>
      <div class="seg" role="group" aria-label="模式">
        <button data-mode="forward" aria-pressed="${chosenMode === "forward"}"><b>我描述，AI 猜</b><span class="small muted">練英文口說表達</span></button>
        <button data-mode="reverse" aria-pressed="${chosenMode === "reverse"}"><b>AI 描述，我猜</b><span class="small muted">練英文理解與成語</span></button>
      </div>
      <div class="row between" style="margin-top:14px">
        <label class="inline">每題最多猜 <select id="guesses">${options}</select></label>
        <span class="small muted">描述需 ≥ ${MIN_WORDS} 個英文字、≤ ${MAX_CHARS} 字元</span>
      </div>
      ${ui.error ? `<div class="alert error">${esc(ui.error)}</div>` : ""}
      <button id="start" class="btn lg block" style="margin-top:16px">開始遊戲</button>
    </section>
    <section class="card small muted">
      <b>規則</b>：描述中不能出現中文字、該成語的拼音，或畫面上列出的禁用詞（直譯關鍵字）。違規時只需改寫，不扣次數。每題結束會給你英文說法的回饋。
    </section>`;
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { chosenMode = b.dataset.mode as Mode; render(); }),
  );
  (root.querySelector("#guesses") as HTMLSelectElement).addEventListener("change", (e) => {
    chosenGuesses = Number((e.target as HTMLSelectElement).value);
  });
  (root.querySelector("#start") as HTMLButtonElement).addEventListener("click", () => void startGame());
}

function renderProgress(game: Game): string {
  const n = game.index + 1;
  const total = game.questions.length;
  return `<div class="progress"><span>第 ${n} / ${total} 題</span><span class="muted">${game.mode === "forward" ? "我描述，AI 猜" : "AI 描述，我猜"}</span></div>
    <div class="bar"><i style="width:${(game.index / total) * 100}%"></i></div>`;
}

function renderLives(used: number, max: number): string {
  return `<span class="lives" aria-label="剩餘 ${max - used} 次">${Array.from({ length: max }, (_, i) => `<i class="${i < max - used ? "" : "off"}"></i>`).join("")}</span>`;
}

function violationText(v: Violation): string {
  switch (v.type) {
    case "chinese": return `不能出現中文字：${v.chars.join("、")}`;
    case "pinyin": return "不能寫出這個成語的拼音";
    case "taboo": return `用到禁用詞：${v.words.join(", ")}`;
    case "too_short": return `至少要 ${v.min} 個英文單字（目前 ${v.words} 個）`;
    case "too_long": return `最多 ${v.max} 字元（目前 ${v.chars}）`;
    case "empty": return "請先輸入描述";
  }
}

function renderPlay(game: Game) {
  const qs = game.questions[game.index];
  const q = qs.q;
  const used = qs.turns.length;
  const max = game.maxGuesses;

  let body = "";
  if (game.mode === "forward") {
    body += `<div class="idiom">${esc(q.idiom ?? "")}</div><div class="stars">${stars(q.difficulty)}</div>
      <div class="small muted" style="margin-top:10px">⛔ 禁用詞（含變化形）</div>
      <div class="chips">${q.tabooWords.map((w) => `<span class="chip">${esc(w)}</span>`).join("")}</div>`;
  } else {
    body += `<div class="stars">${stars(q.difficulty)}</div>
      <div class="small muted" style="margin-top:6px">AI 的描述</div>
      ${qs.clues.map((c, i) => `<div class="clue">${i > 0 ? `<span class="small muted">提示 ${i + 1}：</span>` : ""}${esc(c)}</div>`).join("")}`;
  }

  body += `<div class="row between" style="margin-top:12px"><span class="small">剩餘次數 ${renderLives(used, max)}</span><span class="small muted">${used} / ${max} 已用</span></div>`;

  if (qs.turns.length) {
    body += `<div class="history">${qs.turns
      .map((t, i) => game.mode === "forward"
        ? `<div class="turn ${t.correct ? "hit" : "miss"}"><div class="you small muted">#${i + 1} 你說：${esc(t.you)}</div>
             <div class="ai">AI 猜：${tiles(t.guess ?? "", t.positions)}<span class="tag ${t.correct ? "hit" : "miss"}">${t.correct ? "猜中" : "猜錯"}</span><div class="small muted">${esc(t.reason ?? "")}</div></div></div>`
        : `<div class="turn ${t.correct ? "hit" : "miss"}"><div>#${i + 1} 你猜：${tiles(t.you, t.positions)}<span class="tag ${t.correct ? "hit" : "miss"}">${t.correct ? "答對" : "不是這個"}</span></div></div>`)
      .join("")}</div>
      ${qs.turns.some((t) => !t.correct) ? `<div class="small muted" style="margin-top:6px"><span class="tile hit mini">字</span> 綠色 = 這個字對、位置也對</div>` : ""}`;
  }

  if (!qs.done) {
    if (game.mode === "forward") {
      const words = countWords(ui.draft);
      const chars = ui.draft.trim().length;
      body += `<textarea id="draft" placeholder="${used === 0 ? "Describe the meaning in simple English…" : "Add more detail so the AI can guess again…"}" maxlength="${MAX_CHARS + 50}" ${ui.busy ? "disabled" : ""}>${esc(ui.draft)}</textarea>
        <div class="counter"><span class="${words < MIN_WORDS ? "bad" : ""}">${words} / ${MIN_WORDS}+ words</span><span class="${chars > MAX_CHARS ? "bad" : ""}">${chars} / ${MAX_CHARS}</span></div>`;
    } else {
      body += `<input id="draft" class="guess" type="text" placeholder="輸入四字成語" maxlength="20" value="${esc(ui.draft)}" ${ui.busy ? "disabled" : ""} autocomplete="off" />`;
    }
    if (ui.violations.length) {
      body += `<div class="alert error">請改寫後再送出（不扣次數）：<ul>${ui.violations.map((v) => `<li>${esc(violationText(v))}</li>`).join("")}</ul></div>`;
    }
    if (ui.error) body += `<div class="alert warn">${esc(ui.error)}</div>`;
    body += `<div class="actions">
      <button id="submit" class="btn" ${ui.busy ? "disabled" : ""}>${ui.busy ? '<span class="spinner"></span>AI 思考中…' : game.mode === "forward" ? "送出描述" : "送出答案"}</button>
      ${game.mode === "forward" ? `<button class="mic" disabled title="語音輸入即將推出" aria-label="語音輸入（即將推出）">🎤<small>coming soon</small></button>` : ""}
    </div>`;
  }

  let result = "";
  if (qs.done) result = renderResult(game, qs);

  root.innerHTML = `<section class="card">${renderProgress(game)}</section><section class="card">${body}</section>${result}`;

  const draft = root.querySelector<HTMLTextAreaElement | HTMLInputElement>("#draft");
  if (draft) {
    draft.addEventListener("input", () => {
      ui.draft = draft.value;
      if (game.mode === "forward") {
        const words = countWords(ui.draft);
        const chars = ui.draft.trim().length;
        const counter = root.querySelector(".counter");
        if (counter) counter.innerHTML = `<span class="${words < MIN_WORDS ? "bad" : ""}">${words} / ${MIN_WORDS}+ words</span><span class="${chars > MAX_CHARS ? "bad" : ""}">${chars} / ${MAX_CHARS}</span>`;
      }
    });
    draft.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" && (game.mode === "reverse" || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit(game);
      }
    });
    if (!ui.busy) draft.focus();
  }
  root.querySelector("#submit")?.addEventListener("click", () => void submit(game));
  root.querySelector("#next")?.addEventListener("click", () => void nextQuestion(game));
  root.querySelector("#retry-fb")?.addEventListener("click", () => void loadFeedback(game, qs));
}

function renderResult(game: Game, qs: QuestionState): string {
  const attempts = qs.turns.length;
  const head = qs.solved
    ? `<h2>🎉 ${game.mode === "forward" ? "AI 猜中了" : "答對了"}！用了 ${attempts} 次</h2>`
    : `<h2>😅 ${game.mode === "forward" ? "AI 沒猜中" : "沒答對"}</h2>`;
  const answer = game.mode === "reverse" ? `<div>答案：<b style="font-size:26px;letter-spacing:4px">${esc(qs.answer ?? "")}</b></div>` : "";
  const ref = qs.referenceEnglish ?? qs.feedback?.reference_english;
  const refHtml = ref ? `<div class="ref"><div class="small muted">參考說法</div>${esc(ref)}</div>` : "";

  let fb = "";
  if (game.mode === "forward") {
    if (qs.feedback === undefined) fb = `<div class="muted" style="margin-top:12px"><span class="spinner"></span>正在產生英文回饋…</div>`;
    else if (qs.feedback === null) fb = `<div class="alert warn">${esc(qs.feedbackError ?? "回饋載入失敗")} <button id="retry-fb" class="btn ghost" style="padding:6px 10px;margin-left:8px">重試</button></div>`;
    else {
      const f = qs.feedback;
      fb = `<div class="fb">
        <h3>更自然的說法</h3><ul>${f.better_phrases.map((p) => `<li>${esc(p)}</li>`).join("") || "<li class='muted'>（無）</li>"}</ul>
        <h3>文法／用字</h3><ul>${f.issues.length ? f.issues.map((p) => `<li>${esc(p)}</li>`).join("") : "<li class='muted'>沒有明顯問題 👍</li>"}</ul>
        <h3>小技巧</h3><div>${esc(f.tip)}</div></div>`;
    }
  }
  const last = game.index + 1 >= game.questions.length;
  return `<section class="card result">${head}${answer}${refHtml}${fb}
    <button id="next" class="btn lg block" style="margin-top:16px">${last ? "看總結" : "下一題 →"}</button></section>`;
}

function renderSummary(game: Game) {
  const qs = game.questions;
  const solved = qs.filter((q) => q.solved).length;
  const avgAll = qs.reduce((n, q) => n + q.turns.length, 0) / qs.length;
  const solvedList = qs.filter((q) => q.solved);
  const avgSolved = solvedList.length ? solvedList.reduce((n, q) => n + q.turns.length, 0) / solvedList.length : 0;
  const rows = qs
    .map((q) => `<tr><td>${esc(q.q.idiom ?? q.answer ?? "？")} <span class="small muted">${stars(q.q.difficulty)}</span></td><td>${q.solved ? `✅ ${q.turns.length} 次` : "❌"}</td></tr>`)
    .join("");
  root.innerHTML = `<section class="card summary center">
      <div class="small muted">本輪結果</div>
      <div class="big">${solved} / ${qs.length}</div>
      <div class="muted">${game.mode === "forward" ? "AI 猜中題數" : "答對題數"}</div>
      <div class="row" style="justify-content:center;gap:24px;margin-top:10px">
        <div><div class="small muted">平均次數（全部）</div><b>${avgAll.toFixed(1)}</b></div>
        <div><div class="small muted">平均次數（猜中的）</div><b>${solvedList.length ? avgSolved.toFixed(1) : "–"}</b></div>
      </div>
      <table>${rows}</table>
      <button id="again" class="btn lg block" style="margin-top:16px">再玩一輪</button>
    </section>`;
  root.querySelector("#again")?.addEventListener("click", () => { ui.error = ""; setScreen({ name: "start" }); });
}

// ---------- actions ----------

async function startGame() {
  ui.error = "";
  setScreen({ name: "loading", text: "出題中…" });
  try {
    const r = await api.round(chosenMode);
    serverMaxGuesses = r.maxGuesses;
    const game: Game = {
      mode: r.mode,
      maxGuesses: Math.min(chosenGuesses, r.maxGuesses),
      mock: r.mock,
      questions: r.questions.map((q) => ({ q, turns: [], clues: [], done: false, solved: false })),
      index: 0,
    };
    badge.hidden = false;
    badge.textContent = r.mock ? "MOCK 模式" : "Claude Haiku";
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
}

async function loadClue(game: Game, qs: QuestionState) {
  ui.busy = true;
  ui.error = "";
  render();
  try {
    const r = await api.describe(qs.q.id, qs.clues.length + 1, qs.clues);
    qs.clues.push(r.description);
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
    // Cheap local pre-check; the server re-validates everything.
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
      const r = await api.guess(qs.q.id, descriptions, previousGuesses);
      if (!r.ok) {
        ui.violations = r.violations;
      } else {
        qs.turns.push({ you: text, guess: r.guess, reason: r.reason, correct: r.correct, positions: r.positions });
        ui.draft = "";
        if (r.correct || qs.turns.length >= game.maxGuesses) {
          qs.done = true;
          qs.solved = r.correct;
          qs.feedback = undefined;
          ui.busy = false;
          render();
          void loadFeedback(game, qs);
          return;
        }
      }
    } catch (e) {
      ui.error = e instanceof ApiError ? `${e.message}（${e.code}）` : "送出失敗，請再試一次。";
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
        qs.answer = r.answer;
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
      ui.error = e instanceof ApiError ? `${e.message}（${e.code}）` : "送出失敗，請再試一次。";
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
    qs.feedbackError = e instanceof ApiError ? `${e.message}（${e.code}）` : "回饋載入失敗";
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
