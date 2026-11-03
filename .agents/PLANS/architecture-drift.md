# 架構漂移防線

狀態：**提案**（2026-11-03）。產品負責人要求加入剩餘任務清單；順序見第 5 節。

AI coding agent 改得很快，程式會慢慢偏離原本的架構，agent 和人又會照著已經走樣的寫法繼續寫（Thoughtworks 技術雷達稱為 architecture drift）。以前的做法是「畫圖、施工、對照檢討」。這份計畫把這三步都放進 repo 和 CI：設計意圖寫成可執行的規則，實際架構從程式碼自動抽出，每個 PR 自動比對兩者。

## 1. 現在已經有的

DDD 重構的 W1（#113）已經把「誰可以引用誰」寫成規則並在 PR 的 `checks` job 執行：

| 範圍                      | 規則                                                                                     | 在哪裡跑                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Runtime（Python）         | import-linter，`packages/capture-runtime/importlinter.toml`，既有違規列在 `ignore_imports` | `capture-runtime:lint` 依賴 `lint-architecture`            |
| UI 套件與桌面 app         | Sheriff，`sheriff.config.ts`（`capture-workbench-ui`、`apps/capture-workbench`）         | 各自的 ESLint                                              |
| Nx 專案                   | `@nx/enforce-module-boundaries` 的 `type:*` 標籤（`eslint.config.mjs`）                  | ESLint                                                     |
| 打包                      | `verify_boundaries.py`、worker probe、大小預算                                           | `main` 的完整驗證                                          |
| 死碼                      | knip、vulture、Rust `allow(dead_code)` 的 ratchet                                        | `checks` 與 Claude Code Stop hook                          |

缺的是另外兩步：

- **看不到實際架構。** 規則只回答「有沒有違規」，沒有一張從程式碼產生的圖。給人讀的上下文地圖是 `.agents/PLANS/ddd-refactor/README.md` 裡手寫的 Mermaid，改程式時沒有東西提醒要更新，agent 讀到過時的圖就會照圖寫。
- **PR 不會說它改了哪些依賴。** 規則允許的範圍內新增一條跨上下文依賴，CI 一樣全綠，審查者要自己從 diff 看出來。這就是以前「檢討更改到的範圍」那一步。

## 2. 目標

1. 實際架構圖從程式碼產生，產生的檔案進版控，CI 檢查它和程式碼一致。給人和 agent 讀的圖因此不會過時。
2. 每個 PR 自動留一則留言，列出這次新增、刪除的模組依賴，附 Mermaid 圖。
3. 已知例外只能減少：import-linter `ignore_imports` 與 ESLint suppressions 的數量做成 ratchet（若 W1 還沒強制）。
4. 結構以外的語意規則（例如 AGENTS.md 的「Workbench 套件不碰原生行程與檔案」「runtime 工作不持久化」）交給 LLM 審查，結果只當建議，修正仍要通過確定性的檢查。
5. Agent 動手前讀得到架構，收工前先跑檢查。

不在範圍：改既有規則的內容（那是 DDD W2–W8 的事）；引入 Structurizr 或其他要 Java、Docker 的工具。圖用 Mermaid，與 `docs/domain/` 一致。

## 3. 設計

### 3.1 抽出實際依賴圖：`tools/architecture-graph.ts`

一個 CLI 輸出正規化的 JSON（節點、邊、層級），三個層級各用現成工具：

| 層級                     | 來源                                                                                     | 節點                                         |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Nx 專案                  | `pnpm nx graph --file=<暫存>.json`                                                       | 專案，帶 `type:*` 標籤                       |
| Runtime 上下文           | grimp（import-linter 本身用的函式庫，經同一個釘版的 `uvx --from import-linter==2.5.2`）  | `capture_runtime` 的頂層群組，依 DDD 上下文表聚合 |
| UI 與桌面 app 模組       | Sheriff 的 `export` 指令（A1 先確認 0.20 的輸出格式）                                    | `sheriff.config.ts` 的模組                   |

Rust 只到 crate 層級（`cargo metadata`），模組層級等 W8。暫存檔放在 `tools/test-temp-root.ts` 的私有暫存根目錄，結束時刪除。

### 3.2 產生的架構圖：`docs/architecture/`

`pnpm run architecture:update` 由 3.1 的 JSON 產生 `docs/architecture/projects.md`、`runtime-contexts.md`、`ui-modules.md`（Mermaid），檔頭註明「由工具產生，勿手改」。`pnpm run architecture:check` 重新產生並比對，不同就失敗，提示執行 update；放進 `checks` job。這和 contract snapshot 一樣是比對產生物，不是檢查說明文字。

`.agents/PLANS/ddd-refactor/README.md` 的手寫上下文地圖保留為「目標」；產生的圖是「現況」。兩者的差異就是 DDD 剩下要搬的部分。

### 3.3 PR 依賴差異留言

新的 workflow `architecture-diff.yml`，在 `pull_request` 觸發，`permissions: pull-requests: write`：

1. 分別在 base 與 head 執行 3.1（只在相關路徑有變動時跑）。
2. 比對邊：新增、刪除、跨上下文或跨 `type:*` 的邊另外標出。
3. 更新同一則 sticky 留言（以隱藏標記找到舊留言），內容是表格加只含變動邊的 Mermaid 圖；沒有依賴變動就寫一行「無依賴變動」。

這個 job 只提供資訊、不擋合併，擋合併仍是 3.1 以前就有的規則。它不改 `main` 的完整驗證，也不弱化 `checks`。

### 3.4 例外 ratchet

`ignore_imports` 條目與 ESLint suppressions 的數量記在基準檔（沿用 `tools/quality/` 的做法），新增就失敗，減少後要執行 update；`--ci` 下基準多出已消失的條目也失敗，和 dead-code gate 同一套語意。若 W1 已經強制，這一步只補測試。

### 3.5 LLM 語意審查

在 `.agents/skills/code-review/SKILL.md` 加一段「架構審查」：讀 diff、`.agents/DECISIONS/` 中相關的決策、AGENTS.md 的邊界規則與 3.2 的現況圖，只回報違反已記錄決策的地方，每一條附決策出處。修正要小而聚焦，修完重跑 3.1–3.4。先在本機由 Claude 執行，不放進 CI（需要金鑰與費用）；跑過幾輪、誤報率可接受後，再決定要不要做成 CI 的非阻擋留言。

### 3.6 給 agent 的入口

- AGENTS.md 加一節「Architecture」：現況圖在 `docs/architecture/`，規則檔的位置，改依賴後執行 `architecture:update`。
- Claude Code Stop hook 在改過程式碼的回合結束前，加跑 `architecture:check` 與受影響專案的 `lint-architecture`（只跑有變動的專案，維持在 hook 的逾時內）。

## 4. 步驟

每一步一個 PR。

| 步驟 | 內容                                                     | 驗證                                                                     |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| A1   | `architecture-graph.ts`：Nx、runtime、UI 三個層級的 JSON | 單元測試用小型假圖；在 main 上輸出的邊與 import-linter、Sheriff 的結果一致 |
| A2   | `docs/architecture/` 產生與 `architecture:check`，加入 `checks` | 故意加一條依賴，check 失敗；update 後通過                                |
| A3   | `architecture-diff.yml` sticky 留言                      | 開一個加了跨上下文依賴的測試 PR，留言列出那條邊；再推一次，留言被更新而不是新增 |
| A4   | 例外 ratchet（若尚未強制）                               | 加一條 `ignore_imports` 失敗；刪一條後 `--ci` 要求 update                 |
| A5   | code-review skill 的架構審查段落                         | 用一個違反 AGENTS.md 邊界規則的範例 diff 試跑，能指出決策出處             |
| A6   | AGENTS.md 一節與 Stop hook                               | hook 在改過程式碼的回合執行，未改程式碼時不跑                              |

估計 A1–A3 共 2–3 天，A4–A6 共 1–2 天。做完後同一套工具可以搬到 Cert Prep 與 LAW（DDD 決策 D5 已定三個 repo 用同一組規則工具）。

## 5. 在剩餘任務中的位置

建議排在 runtime 項目（可續傳下載、CUDA/CPU 拆分、頁數與時長進度、解除安裝、原生路徑匯入）之後、UI 重設計 Phase 2 之前：Phase 2–7 是大量由 agent 寫的前端程式，先有依賴差異留言與現況圖，每個 UI PR 都能看到它動了哪些模組。
