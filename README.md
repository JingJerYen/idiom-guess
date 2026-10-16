# 繞著說 (idiom-charades)

練習英文「換句話說」(circumlocution) 的網頁小遊戲。
看到一個中文詞（成語、日常用語、店家名、地標……），用簡單的英文把意思說清楚，讓 AI 猜出是哪個詞；
也有反向模式：AI 用英文描述，你猜中文。介面上兩種模式分別叫「口說」(forward) 與「聽力」(reverse)。

- 一輪 10 題，由易到難；每題最多 3 次猜測，第 1、2、3 次猜中分別得 5、3、1 分（簡單模式 3、2、1），沒猜中 0 分，可按「放棄」直接 0 分看答案。
  讓 AI 猜中的那句描述若被判定為「完整且沒有文法錯誤的句子」，再加 5 分（兩種難度都適用）。一輪滿分 100（簡單 80）。
- 描述中不能出現中文字、該詞的拼音；畫面上列出的直譯單字在「困難」模式禁用、在「簡單」模式可以使用（給程度較初階的玩家看著單字造句）。
  違規由伺服器端程式檢查，不呼叫 AI、不扣次數。單字牌點一下翻成中文、再點翻回英文（翻譯來自 `data/glossary.json`）。
- 每題結束給你英文說法的回饋（更自然的說法、文法／用字、小技巧，繁體中文說明）。
- 後端 Node.js + TypeScript + Express；前端純 HTML/CSS/TypeScript；模型 `claude-haiku-5-5`。

## 本機執行

需要 Node.js 20 以上（建議 22）。

```bash
npm install
cp .env.example .env        # 視需要填入 GAME_ANTHROPIC_KEY
npm run dev                 # 打包前端並以 tsx 啟動後端（自動重載），http://localhost:3000
```

沒有金鑰也能玩：未設定 `GAME_ANTHROPIC_KEY` 或設定 `MOCK_MODE=1` 時會進入 MOCK 模式，
用簡單的關鍵字規則回傳假猜測與假回饋，右上角會顯示「MOCK 模式」標籤。

```bash
npm run mock                # 強制 MOCK 模式
npm test                    # node:test 測試
npm run typecheck           # 前後端型別檢查
npm run build && npm start  # 正式版建置與啟動（dist/ 與 public/）
```

## 金鑰設定（GAME_ANTHROPIC_KEY）

- 後端只讀 `GAME_ANTHROPIC_KEY`，建立 client 時明確傳入 `apiKey`。
  **不會**使用 `ANTHROPIC_API_KEY`，避免影響 Claude Code 自身的驗證與計費。
- 建議在 Anthropic Console 開一個獨立 workspace、設定消費上限，再在該 workspace 建金鑰。
- 金鑰只存在伺服器環境變數，絕不送到前端、不寫進程式、不 commit（`.gitignore` 已含 `.env`）。
- 有金鑰但 API 呼叫失敗時，**不會**退回 MOCK，而是回傳 `UPSTREAM_ERROR` 並寫入日誌。

### 其他環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | 3000 | 監聽埠（Render/Fly/Docker 會自動提供） |
| `GAME_ANTHROPIC_KEY` | 無 | 遊戲專用金鑰；留空則 MOCK |
| `MOCK_MODE` | 無 | 設 `1` 強制 MOCK |
| `MAX_GUESSES` | 3 | 伺服器接受的每題最多描述數（1~10）。前端固定 3 次並以 5/3/1 計分，調低此值會限制前端 |
| `TRUST_PROXY` | 無 | 在反向代理後設 `1`，限流才能看到真實 IP |
| `RATE_LIMIT_MODEL_PER_MIN` | 30 | 會呼叫模型的端點每 IP 每分鐘上限 |
| `RATE_LIMIT_LIGHT_PER_MIN` | 120 | 其他端點每 IP 每分鐘上限 |

## 部署

### Render（push 即部署，推薦）

1. 到 <https://dashboard.render.com/blueprints>，New Blueprint Instance，選這個 repo 與分支。
   `render.yaml` 已定義 build/start 指令、健康檢查與 `TRUST_PROXY=1`。
2. 匯入時會要求填 `GAME_ANTHROPIC_KEY`（標示為 `sync: false`，不會寫進 repo）。
3. 之後每次 push 到該分支都會自動重新部署。免費方案閒置 15 分鐘後休眠，喚醒約需 30~60 秒。

GitHub Pages 只能放靜態檔，無法保護金鑰也跑不了後端，因此不適用。

### Docker

```bash
docker build -t idiom-charades .
docker run -p 3000:3000 -e GAME_ANTHROPIC_KEY=sk-ant-... -e TRUST_PROXY=1 idiom-charades
```

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/health` | 模式（mock/live）與模型名稱 |
| `GET /api/round?mode=forward\|reverse` | 10 題：`id`、`difficulty`、`tabooWords`，forward 模式另含 `idiom`。不含拼音與參考說法 |
| `POST /api/guess` | `{ idiomId, level: "easy"\|"hard", descriptions[], previousGuesses[] }` → 程式檢查違規回 422 `{ violations }`；通過則回 `{ guess, reason, correct, positions[], perfectSentence, grammarNote, attempt, remaining }` |
| `POST /api/feedback` | `{ idiomId, descriptions[], guessedCorrectly, attempts }` → `{ better_phrases, issues, tip, reference_english }` |
| `POST /api/give-up` | `{ idiomId }` → `{ answer, tags, reference_english }`（放棄：0 分並揭露答案） |
| `POST /api/describe` | 反向模式：`{ idiomId, attempt, previousClues[] }` → `{ description }` |
| `POST /api/reverse-guess` | 反向模式：`{ idiomId, guess, attempt }` → `{ correct, positions[], remaining, answer? }`（答案只在猜中或用完次數時揭露） |

`positions` 是 Wordle 式的逐字結果：每個字一個布林值，`true` 代表「字對、位置也對」，前端顯示為綠格。
正向模式下，前端把 AI 先前的猜測一併送回（`previousGuesses`），伺服器重新比對後，
只把「已確認位置的字」告訴模型，要求新猜測保留這些字；完整答案仍然不會進入 prompt。

API 無狀態：前端持有這一輪的題目與每題的描述歷史，伺服器每次重新驗證所有描述。
錯誤格式統一為 `{ ok:false, error:{ code, message } }`，code 包含
`BAD_REQUEST`、`NOT_FOUND`、`RATE_LIMITED`、`MODEL_OUTPUT_INVALID`、`UPSTREAM_ERROR`、`INTERNAL`。

## 防作弊設計

- `/api/guess` 的 prompt 只包含玩家描述（含同題先前描述），**不含答案、不含題庫**；
  是否猜中由伺服器比對（簡繁、空白、標點正規化，支援 `aliases`）。
- 玩家描述包在 `<description>` 標籤內，prompt 明示為資料而非指令。
- 只有 `/api/feedback` 與 `/api/describe`（該題結束後或反向模式）才把答案交給模型。
- 猜測呼叫同時做文法判斷：`perfect_sentence` 只看最新一句描述，需為完整句子、無拼字／文法錯誤、大寫開頭、句號結尾，有疑慮即 false 並在 `grammar_note` 指出第一個問題。
- 模型輸出固定 JSON，zod 驗證；解析失敗重試一次，再失敗回 `MODEL_OUTPUT_INVALID`。
- 猜謎 prompt 集中在 `src/prompts/guess.ts`，想調整 AI 的「猜題強度」改這一個檔案即可。
- `tests/prompt-no-answer.test.ts` 會檢查 prompt 不含任何題庫成語、別名、拼音與參考說法。

## 模型呼叫與成本

- 模型 `claude-haiku-5-5`，`thinking: { type: "disabled" }`、`output_config.effort: "low"`；
  不傳 temperature 等取樣參數，不用 assistant prefill。
- `max_tokens`：猜測 400、回饋 800、反向描述 300（thinking 關閉，所以是純輸出預算；上限只是保險，實際輸出通常遠低於此）。
- 每次呼叫把 `input_tokens`／`output_tokens`、`stop_reason`、耗時寫到伺服器日誌（JSON 一行）。
- 價格（≤100K 輸入）：輸入 US$0.10 / 百萬 token，輸出 US$0.50 / 百萬 token。
  一輪 10 題約 20 次猜測加 10 次回饋，估計 **約 US$0.003～0.005**。
  限流主要是防濫用，不是省錢。
- 日後可選：改用 structured outputs（`output_config.format`）讓 API 直接保證 JSON 結構，省掉重試。

## 題庫

`data/idioms.json`。`idiom` 欄位是答案詞，不限四個字，也不限成語。欄位：

```json
{
  "id": "hua-she-tian-zu",
  "idiom": "畫蛇添足",
  "aliases": ["画蛇添足"],
  "tags": ["成語"],
  "pinyin": "hua she tian zu",
  "taboo": ["snake", "foot", "feet", "leg", "draw", "paint"],
  "difficulty": 1,
  "reference_english": "Ruining something that was already fine by adding something unnecessary."
}
```

- `tags`：這題的類型，可自由新增（目前有 成語、日常用語、店家名、地標）。
  正向模式玩家看得到；AI 的 prompt 只會拿到「題庫中所有出現過的 tag」當作可能範圍，
  不知道這題是哪一類，要靠玩家的描述讓它推理。反向模式玩家也看不到，題目結束才揭露。
- 非成語的例子：`五十嵐`（aliases `50嵐`）、`整人節目`、`台北101`。數字與英文字母會保留比對。
- `data/glossary.json`：每個 taboo 單字的中文翻譯，測試會檢查題庫裡每個單字都有翻譯；新增題目時記得補。
- `taboo` 只需列原形：比對時自動涵蓋規則變化（s、es、ed、d、ing、去 e 加 ing、y 變 ies/ied、重複子音），不規則形要另外列（如 `feet`、`lost`、`shot`）。多字詞（如 `old man`）以片語比對，數字（如 `50`、`101`）也可以。
- `pinyin` 只擋**整句**拼音（有無空格、有無聲調皆算），不逐音節擋，以免誤殺 `she`、`he` 這類英文字。

## 專案結構

```
src/
  server.ts            Express 啟動、靜態檔、錯誤處理
  config.ts            環境變數
  routes/api.ts        所有 /api 端點
  routes/schemas.ts    請求 body 驗證
  game/idioms.ts       題庫載入、抽題、對前端裁切
  game/validate.ts     中文字／拼音／禁用詞／長度檢查
  game/match.ts        猜測比對與正規化
  llm/client.ts        Anthropic client（GAME_ANTHROPIC_KEY）
  llm/callJson.ts      呼叫、JSON 驗證、重試、token 日誌
  llm/mock.ts          MOCK 規則
  llm/index.ts         real / mock 分派
  prompts/             guess.ts（猜謎）、feedback.ts、describe.ts
  middleware/          限流
web/                   前端原始碼（esbuild 打包到 public/）
data/idioms.json       題庫
tests/                 node:test
```

## 聽力模式的語音

AI 的描述用瀏覽器內建的 Web Speech API（`speechSynthesis`）朗讀，不經過伺服器、不花 API 費用。
文字預設隱藏，每句線索有 🔊 可重播、👁 可顯示該句文字（一次只顯示一句）；題目結束後列出全部線索文字。
瀏覽器不支援語音合成時會直接顯示文字。描述 prompt 要求 A2～B1 程度的常用字、30 字以內、適合朗讀。

## 尚未實作

- 口說模式的語音輸入（介面上保留停用的按鈕，標示 coming soon）。
