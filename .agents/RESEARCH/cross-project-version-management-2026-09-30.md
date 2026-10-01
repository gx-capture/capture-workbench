# 三專案版本管理研究（2026-09-30）

本輪只研究與建議，未修改產品程式、版本宣告、lockfile 或發版流程。結論：延伸既有版本管理入口，將人工決定集中、必要副本自動生成、檢查改為具體欄位與實際產物比對。三個 repo 各自保留版本意圖與採用紀錄。

## 建議決策

建議先做「不改變既有發布與相容性行為」的集中化。每次一般版本更新，只需決定一次新版本；工具負責必要的 native manifest、程式常數、鎖檔與生成資料。模型來源變更、批准、changelog 和真實驗收證據仍有各自的維護責任。

| 專案 | 建議沿用的權威來源 | 第一階段重點 |
| --- | --- | --- |
| Capture Workbench | 既有 `release/version.json` | 收斂 `tools/release` 同步器；腳本引用來源，SDK／產品使用包內常數；移除一般測試中的當前版號複本 |
| Cert Prep | 既有 `tools/capture-runtime-version.mts` 公開入口；自身產品沿用 release 管理 | 補齊繞過入口的 Python packaging、Rust、acceptance、CI；需要跨語言序列化時才加 JSON backing source |
| LAW | 建議新增一份 repo-local Capture pin 資料；自身產品版本另管 | 讓既有 checker、stager、Maven property、Python／Rust 與 workflow 使用它，補完整性檢查 |

Capture 的 UI、runtime、client SDK 與 launcher 目前維持同一 release cohort，第一階段保留這個政策。Cert／LAW 的產品版本不必跟著 Capture 版本改變；它們各自明確記錄採用的 Capture release。API、document schema、projection schema、contract digest、模型來源 revision 也不能全部視為同一個版本變數。

## Capture 實測基線與原因

調查 HEAD：`14556693ae1fbda4ce528e96c5217246ebb8b2d4`，調查開始時 worktree 乾淨。本機 pnpm 為 `12.0.0`，Nx 專案配置已用 `pnpm nx show projects --json` 與 `pnpm nx show project capture-tools/capture-runtime --json` 分別查核。

最近版本提交 `b248a5cc29ed865f75841b0f68e202db7cd757ff`（`chore(release): prepare Capture 0.4.4`）實際變更 **136 個檔案**。其中 **115 個檔案**符合「父提交內容只做 `0.4.3` → `0.4.4` 全字串替換後，與該提交內容完全相同」。這證明大量 diff 是機械性變更，但不表示這 115 檔都能刪除或停止更新。

依主要路徑角色分類如下；測試／fixture 類優先於 manifest 類，因此 fixture 的 Cargo.toml 歸入測試。這是調查分類，並非新增 CI 規則。

| 136 檔的主要角色 | 檔數 |
| --- | ---: |
| 測試／fixture | 65 |
| 生成契約／SDK／contract hash | 13 |
| Manifest／Nx target／版本意圖 | 10 |
| Lockfile | 6 |
| 模型／engine metadata | 6 |
| 程式／工具／其他 metadata | 34 |
| 文件 | 2 |

「115 個纯替換」與上表是不同的分類維度，不能相加。以 consumer 節相同的文字邊界計數，目前 Capture 有 **134** 個 tracked 檔包含 `0.4.4`，Cert 為 **50**，LAW 為 **33**；命中數與下一次實際變更數不同。

可重現方法：用 `git diff-tree --no-commit-id --name-only -r b248a5c` 取得變更集合；對每檔以 `git show b248a5c^:<path>` 和 `git show b248a5c:<path>` 讀取內容，在記憶體做上述字串替換後比較。本輪未執行會寫入的版本同步器。

主要原因有四項：

1. **已有版本來源，使用端仍重複宣告。** [release/version.json:2](C:/software-dev/capture-workbench/release/version.json:2) 已宣告 release/API/schema；但 [version-sources.ts:10](C:/software-dev/capture-workbench/tools/release/version-sources.ts:10) 另有 `EXPECTED_RELEASE_VERSION`。此外包驗證器、Python wheel metadata 路徑與 TS codec 都寫死當前版本：[verify-packed-package.ts:98](C:/software-dev/capture-workbench/tools/verify-packed-package.ts:98)、[python-candidate-index.ts:631](C:/software-dev/capture-workbench/tools/python-candidate-index.ts:631)、[codec.ts:118](C:/software-dev/capture-workbench/packages/capture-runtime-client/src/codec.ts:118)。
2. **同步範圍大於語意上的版本欄位。** [sync-versions.ts:115](C:/software-dev/capture-workbench/tools/release/sync-versions.ts:115) 遞迴處理 packages/apps/tools 的多種文字檔；[replaceReleaseVersion:1735](C:/software-dev/capture-workbench/tools/release/version-sources.ts:1735) 只排除相鄰數字，不能辨識歷史證據或第三方套件。同字串的來源 URL、fixture、文件都可能被更新。Cargo.lock 雖另有較窄規則，仍需依 crate 身份而非只有版本值管理。
3. **檢查與寫入清單沒有一致的語意。** `collectReleaseVersionEntries()` 本輪讀出 49 個欄位，其中 runtime project engine archive 字串有 14 項；部分 Rust 檔案仍擷取整檔所有 SemVer 字串。同步器則掃整棵樹，且在寫完後才做驗證。[inventory:626](C:/software-dev/capture-workbench/tools/release/version-sources.ts:626)、[Rust 擷取:797](C:/software-dev/capture-workbench/tools/release/version-sources.ts:797)、[寫後驗證:145](C:/software-dev/capture-workbench/tools/release/sync-versions.ts:145)。
4. **部分版本字串是契約內容。** Pydantic readiness/preflight 有 `Literal["0.4.4"]`；canonical schemas 從這些模型產出並參與 hash；生成 SDK 又帶 runtime 常數和 package/runtime metadata。單純升 patch 也會影響契約 bytes。不能透過共用變數讓真正改變的 bytes 保持原 hash。[contracts:1003](C:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/contracts/__init__.py:1003)、[contract_set.py:267](C:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/contract_set.py:267)、[generator:1254](C:/software-dev/capture-workbench/packages/capture-runtime/scripts/generate_contracts.py:1254)、[generator:1561](C:/software-dev/capture-workbench/packages/capture-runtime/scripts/generate_contracts.py:1561)。

## 第一階段的具體設計

Change mode：**mixed，以 edit/delete 為主**。既有 owner 是 Capture `tools/release`、Cert version facade／inventory，以及 LAW checker／stager。刪除目標是全樹替換與分散的當前版號複本；新增僅限 LAW 必要的 pin 資料及缺少的語言適配，不建立通用跨 repo 發版框架。Token posture：compact quality；verification floor 見下節。

**A. 區分輸入、衍生值與歷史。**

- 一般升版的人工輸入：Capture 的 release intent；每個 consumer 的採用 pin；各產品自己的發行版本。
- 可引用的衍生值：release tag、下載基底 URL、預期包版本、資源檔名。優先從已驗證 manifest/catalog 取資源名稱；有既定命名契約才由版本格式化。
- 必須落地的衍生值：package.json、Cargo.toml、pyproject.toml、POM、lockfiles、包內生成常數、目前嚴格契約的生成檔與 digest。用工具產生並正常提交，不能在 metadata 中塞入工具不支援的任意變數。
- 固定資料：過去 release／候選證據、歷史 goldens、舊版相容性樣本、故意錯版的負例、第三方套件版本。不納入一般 bump。

**B. 把現有同步器改為欄位映射。**

沿用版本 inventory，將每個 release-managed entry 明確定義為「檔案＋欄位／符號＋來源＋處理方式」。manifest 使用格式適配器，簡單常數若需改寫則鎖定唯一符號並檢查重複／缺失，不再掃描所有相同數字。唯讀 `plan` 列出所有預期修改及生成工作，`check` 對未同步項回報失敗，`apply` 先檢查所有前置条件再寫入。涉及多步 package manager／generator 時，先在隔離工作區準備並驗證，再帶回明確 diff；中途失敗要可診斷、可重跑，不能宣稱跨多檔天然原子性。這些是建議介面，不是目前已存在的 CLI 選項。

保留 `pnpm nx` 作為專案驗證與封裝入口；可為版本 plan/check/apply 增加或整合 Nx targets。更新順序應由實際相依 DAG 決定：版本欄位先落地，接著既有契約／SDK 與 metadata generator、對應鎖檔更新、內容 digest 重算，最後核對完整候選 identity。不要把這些工作簡化成單一 replace pass。

**C. 共用發生在正確的邊界。**

Node 發版／staging 腳本可直接讀 repo-local intent；Python、Rust、Java 與發布 SDK 在安裝後要使用包內常數、資源或原生 metadata。產物不得因取版號而依賴 checkout 根目錄、另一個 repo 或開發機 Node 工具。Capture 已有 `env!("CARGO_PKG_VERSION")` 範例可沿用，但 consumer 的 app version 不等於 Capture runtime version，不能在 consumer 誤用該值。[現有 Rust 常數:1](C:/software-dev/capture-workbench/apps/capture-workbench-desktop/src-tauri/src/constants/versions.rs:1)。

版本一致性應由 intent／明確的 release request 與包內 metadata 比對；不再維護第二個永遠等於當前 release 的硬編碼常數。API/schema policy 與預期 contract digest 的獨立檢查仍保留。CI 的 tag、候選 source commit、candidate manifest 與發布物身份也繼續互相核對。

**D. 測試按意圖重整。**

一般成功情境用 fixture factory 接收目前預期版本；負例保留明確錯版並斷言它與預期不同；固定歷史／hash golden 保留原 bytes。測試不能只讓 production 與 expected 共用同一個錯誤來源：要另外驗證 intent A／封裝產物 B 被拒絕、錯 contract／receipt digest 被拒絕，以及所有正式套件的實際 metadata 符合 release request。65 個測試／fixture 檔是優先分類與減少升版 diff 的候選，不代表可無條件全部改成動態。

**E. 模型來源維持獨立身份。**

Release intent 與 model source identity 是兩份不同的受版控輸入。source lock 包含批准、來源 revision、授權、bytes/hash；releaseVersion／artifactVersion 變動會影響 sourceLockSha256／manifestSha256，相依 catalog 必須重產並驗證。更新器不得修改 approvedBy、approvedAt、來源證據或自行清除 blockers。正式實作前記錄「只變 release label 是否仍在原模型批准範圍」；若來源 bytes／批准對象變動，依既有模型流程處理。[source lock:1](C:/software-dev/capture-workbench/packages/capture-runtime/model-sources/release-model-source-lock.json:1)、[模型 lock 驗證:284](C:/software-dev/capture-workbench/packages/capture-runtime/scripts/model_source_lock.py:284)、[來源 revision 驗證:397](C:/software-dev/capture-workbench/packages/capture-runtime/scripts/model_source_lock.py:397)。

## 工具原生支援與取捨

已查核下列官方文件；它們提供局部去重能力，無法單獨涵蓋目前三 repo 的多語言發布契約。

| 工具 | 可用能力 | 此輪建議 |
| --- | --- | --- |
| [Tauri version](https://v2.tauri.app/reference/config/#version) | 可指向帶 version 的 package.json，省略則讀 Cargo.toml | 可選擇讓 desktop 版本繼承已同步的 Cargo；要調整現有 verifier 並核对安裝包版本。Capture 根 package.json 是 `0.0.0`，不能直接拿來用 |
| [Cargo 環境變數](https://doc.rust-lang.org/cargo/reference/environment-variables.html)／[workspace inheritance](https://doc.rust-lang.org/cargo/reference/workspaces.html) | 程式可用 CARGO_PKG_VERSION；workspace 可共享 package version | 前者可局部採用；不為少數重複值就合併現有多個 crate／lockfile 的 workspace |
| [Hatch version source](https://hatch.pypa.io/latest/version/) | 可從指定來源檔取得動態版本 | 先保留可獨立建置的原生 metadata；若後續採用，版本來源須包含於 sdist/wheel，且 frozen runtime 也能取得 |
| [Maven CI-friendly versions](https://maven.apache.org/guides/mini/guide-maven-ci-friendly.html) | 支援 revision 等屬性；Maven 3 install/deploy 需處理 flatten POM | LAW 已有 dependency property 可延伸；不為版本集中化一併改寫 producer POM 發布方式 |
| [pnpm catalogs](https://pnpm.io/catalogs) | 在 workspace 中共用 dependency ranges，pack/publish 展開 catalog references | 只能處理 npm dependency 欄位，不能取代本身 package version、Python/Cargo/Maven、SDK 契約或歷史 evidence。當前 12.0.0 不應照抄文件標示 12.2+/12.6+ 才有的擴充 |
| [Nx Release manifest 更新](https://nx.dev/docs/guides/nx-release/updating-version-references)／[Nx inputs](https://nx.dev/docs/reference/inputs) | 支援 manifest version 更新；輸入影響 cache key | 第一階段保留目前候選／promotion 流程與工具。中央 version/pin 必須納入相關 target inputs，不要新增第二套 bump owner |

特別注意：目前 [nx.json:5](C:/software-dev/capture-workbench/nx.json:5) 的 default 以 projectRoot 為主，sharedGlobals 為空。當程式開始讀 root release intent，必須給真正受影響的生成／建置／封裝 target 加上該檔及 reader/generator 的 inputs，並確認 outputs 與跨專案依賴完整。

## 實施順序與成功標準

1. **Capture 集中化**：以相同 `0.4.4` 先完成可觀察行為不變的 reader／欄位映射／測試分類。既有 native declarations、strict schema、SDK 與 hash 仍一致。先證明 refactor 本身不改發布內容。
2. **Consumer 接軌**：Cert 延伸現有入口；LAW 新增必要 pin 資料，保留既有 target/generator。把來源、override、下載檔名、封裝與 receipt identities 串成完整鏈。
3. **隔離升版演練**：選測試用版本，在 temporary checkout/copy 執行 plan/apply/check；package manager 操作僅在隔離環境，不發布。正式實作還需各 repo 適當的 fresh review/full CI。
4. **另案評估契約解耦**：把穩定 schema shape 與 release identity 分開才可能進一步減少生成契約 diff。需要明確設計 discovery、SDK/launcher checks、compatibility、receipt／持久化資料的讀取規則及遷移；本次不建議順便將 runtime Literal 改成任意字串，也不假設同 schema 就能任意互換 release。

驗收至少包括：

- 只改中央版本即可列出完整 diff；日常程式與一般測試不再需要手工逐檔找版號。`check` 不寫檔；再次 `apply` 零變更；缺欄位／重複欄位／混合版本／中斷狀態可安全拒絕或恢復。
- 非 Capture 的同值依賴、歷史 fixture、批准紀錄、舊版 URL／release notes 不被 bump。hash fixtures 若需新增當前版本案例，應新增或由生成器產生，不能改寫過去證據。
- npm tarball、Python wheel/sdist、Maven artifact/POM、crate、desktop/runtime 的實際身份與指定 release 相同，且離開原 repo 後可用；每個 lockfile 通過相應的鎖定模式一致性檢查。
- Contract bytes 依既有 source 生成，再核對獨立受版控／受驗證 release identity 與 digest；不能只把同一份 bundle 自算 hash 後互相比較當作全部證據。Model source lock/catalog/manifest 的 digest 鏈同步重建。
- 只改中央來源就使必要 Nx cache 失效；候選與 published consumer 路徑都採用正確 pin；保留原本 full CI、候選來源 commit 綁定、發布後 readback 與真實 OCR 驗收責任。

第一階段的預期改善是「每 repo 每個版本軸只有一處人工決定」，以及日常程式／測試不再大量改號。Native metadata、lockfiles、strict contracts 和 release records 仍會產生多檔 diff。此輪沒有實作模擬器，因此不承諾能由 136 檔降到特定數字；後續以人工維護點、非生成 diff、完整 diff、漏同步攔截率分別量測。

## 本輪檢查與獨立覆核

已执行 `pnpm nx run capture-tools:release-version-test`：**34 passed，0 failed，未用 cache**。另外唯讀呼叫 `verifyGeneratedVersions()` 確認 release `0.4.4`／API `2.0`／document schema `2` 一致。本輪未建置候選、未改版、未執行新的包安裝／OCR 驗收，也未發布或提交。

AGY MCP 因預設模型不可用，DeepSeek／GLM MCP 因設定中的 profile 目錄不存在，無法完成 reviewer 呼叫；改由獨立 explorer 執行唯讀覆核，未使用 shell CLI fallback。

- **publicReasoningSummary**：支持延伸既有 owner、移除全樹替換；生成資料仍可能有多檔 diff。
- **evidenceChecked**：Capture sync-versions.ts、version-sources.ts:1358、version-sources.test.ts:403、model_source_lock.py:574、nx.json；Cert version facade；LAW checker/stager；release-runbook。
- **findings**：先 plan／驗證再 apply；hash 信任來源不能退化為自我比對；保留 model identity；測試意圖 A／產物 B 與 digest 不符；consumer 下載與封裝身份要全程一致。
- **blockers**：沒有阻擋本輪研究建議的問題；這不等於已完成實作驗收。
- **risks**：Nx cache 漏依賴；錯把變數共用當成放寬 runtime/schema/hash 相容性；模型 metadata 更新後衍生 digest 遺漏。
- **missingDecisions**：正式實作需界定模型來源批准對純 release label 變更的適用範圍；工具不得自行批准。
- **suggestedMarkdownSection**：以人工修改點、漏同步攔截、重跑一致性、實際封裝身份衡量成效。
- **writeRecommendation**：可寫入研究建議；將上述條件列入未來實作範圍與驗收。

## Consumer 調查範圍與計數

調查時 Cert Prep HEAD 為 `1f493ca4873bdee48e07bb59c60359a3ceaf697a`；LAW HEAD 為 `2339f44e5a7bd482f289e2ea9949ea9398e8dfa9`。兩個 worktree 的 `git status --short` 均為空。已讀取各 repo 的 `AGENTS.md`，並用 `pnpm nx show projects --json` 與 `pnpm nx show project <name> --json` 確認實際 target；兩者本機 pnpm 均為 12.0.0。未執行安裝、build、test、generator 或 release，因此這份研究不構成發版或安裝驗收證據。

統計命令（在各 repo 根目錄執行）：

```powershell
git grep -l -I -P '(?<![0-9])0\.4\.4(?![0-9])'
```

統計已追蹤文字檔，不含 ignored build output、node_modules 或未追蹤檔；左右排除數字，避免把 `0.4.40` 算成 `0.4.4`，但保留 wheel 的 `0.4.4.dist-info` 路徑。這是文字 inventory，並非完整 SemVer parser。以下按檔案主要用途互斥分類；generated 優先於 test（LAW 有 generated spec）。同一程式檔內的測試或註解仍計入程式檔。數量是「出現版本字串的檔案數」，不是「下一次必須手改的檔案數」。

| 主要用途 | Cert Prep | LAW |
| --- | ---: | ---: |
| 程式、工具、workflow（包含僅註解提到版本的檔案） | 23 | 7 |
| 套件宣告、workspace 設定、Nx target | 5 | 5 |
| Lockfile | 3 | 3 |
| 已產生程式碼 | 1 | 3 |
| 測試與 golden fixture | 14 | 10 |
| 手寫 contract source | 0 | 1 |
| 文件 | 4 | 4 |
| **合計** | **50** | **33** |

文件另列，不能隨升版全面改寫：例如 LAW README 自稱 declaration snapshot，並明確說不代表正式穩定版已發布（[README.md:82](C:/software-dev/gx.law-prep/README.md:82)）。Cert 的 `phase1-final-identity.mts` 是固定候選的身分與 hash 證據，也不是普通 latest pin（[phase1-final-identity.mts:13](C:/software-dev/cert-prep/apps/cert-prep-desktop/scripts/phase1-final-identity.mts:13)）。

此外，字串計數會漏掉內容衍生變更：LAW 的 Python generated runtime 將 contract 編成 base64，另保存來源 hash，沒有明文 `0.4.4` 仍可能需要重產（[_law_contract_runtime.py:283](C:/software-dev/gx.law-prep/apps/law-prep-ai-service/src/app/common/contract/generated/_law_contract_runtime.py:283)、[來源 hash 驗證:624](C:/software-dev/gx.law-prep/apps/law-prep-ai-service/src/app/common/contract/generated/_law_contract_runtime.py:624)）。

## Cert Prep：既有共用來源已成立，但尚未涵蓋整條流程

### 版本領域與目前 owner

| 領域 | 現況與來源 |
| --- | --- |
| Cert 自身產品版本 | Tauri、Cargo、Python backend 是 `0.1.0-alpha.1`；root npm manifest 是私有 workspace `0.0.0`。Capture 升版不應順便升這些版本。[Tauri:4](C:/software-dev/cert-prep/apps/cert-prep-desktop/src-tauri/tauri.conf.json:4)、[Cargo:3](C:/software-dev/cert-prep/apps/cert-prep-desktop/src-tauri/Cargo.toml:3)、[backend:3](C:/software-dev/cert-prep/apps/cert-prep-backend/pyproject.toml:3)、[root:3](C:/software-dev/cert-prep/package.json:3) |
| Capture 版本的 TS owner | `tools/capture-runtime-version.mts` 宣告 runtime `0.4.4`、launcher `0.4.4`，同時衍生 release URL/model 名称；另分開保存 API `2.0`、document schema `2`、歷史 core-only `0.3.8`。[owner:12](C:/software-dev/cert-prep/tools/capture-runtime-version.mts:12)、[launcher 與 legacy:22](C:/software-dev/cert-prep/tools/capture-runtime-version.mts:22) |
| npm 宣告 | `package.json` pin UI；`pnpm-workspace.yaml` 對 UI/client 的 `minimumReleaseAgeExclude` 也帶精確版本。這兩行是發布年齡例外，不是 catalog。[package:31](C:/software-dev/cert-prep/package.json:31)、[workspace:11](C:/software-dev/cert-prep/pnpm-workspace.yaml:11) |
| Python/Cargo 宣告 | Python client 由 pyproject/uv.lock pin；launcher 由 Cargo.toml/Cargo.lock 宣告。Cargo TOML 目前使用 `"0.4.4"`，與 LAW 的 `"=0.4.4"` 不同；本輪應保留既有解決策略，若要統一精確 pin，另做決策與驗證。[Python:9](C:/software-dev/cert-prep/apps/cert-prep-backend/pyproject.toml:9)、[Cargo:20](C:/software-dev/cert-prep/apps/cert-prep-desktop/src-tauri/Cargo.toml:20) |
| 已共用的實際入口 | install script、package QA 已 import TS owner；Python `runtime_policy.py` 直接使用已安裝 SDK 匯出的 `CAPTURE_RUNTIME_VERSION`。[installer:20](C:/software-dev/cert-prep/tools/install-capture-runtime.mts:20)、[QA:8](C:/software-dev/cert-prep/apps/cert-prep-desktop/scripts/package-qa/constants.mts:8)、[runtime policy:3](C:/software-dev/cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_policy.py:3) |

`tools/capture-runtime-version-check.mts` 已有 consumer inventory，不只是單一 regex：它列出 npm、workspace、lockfile、Python、Rust、generated readiness/preflight 等 logical owner；physical source registry 也支援 source HEAD、逐檔 hash 及 aggregate hash（[inventory:57](C:/software-dev/cert-prep/tools/capture-runtime-version-check.mts:57)、[registry:9](C:/software-dev/cert-prep/tools/capture-runtime-consumer-source.mts:9)、[snapshot:54](C:/software-dev/cert-prep/tools/capture-runtime-consumer-source.mts:54)）。應延伸此處，避免另外造一套互不一致的版本檢查。

Cert 自身產品發版也已有 `assertWorkspaceVersions()`，檢查 Tauri/Cargo、backend/contracts/ollama Python、backend `__version__`、QA 與 build target；它是 consistency check，尚非自動同步工具（[release-lib.ts:286](C:/software-dev/cert-prep/tools/release/release-lib.ts:286)）。這是第二個版本領域，不能把 Capture `0.4.4` 當成 Cert 全產品版本。

### 真正可降低維護成本的重複點

- **包裝與 provenance 繞過 owner。** Python build script 直接對 runtime manifest、engine catalog、wheel metadata 寫死 `0.4.4`；runtime provenance 也重複相同字串（[build_backend_runtime.py:131](C:/software-dev/cert-prep/apps/cert-prep-backend/scripts/build_backend_runtime.py:131)、[wheel 檢查:219](C:/software-dev/cert-prep/apps/cert-prep-backend/scripts/build_backend_runtime.py:219)、[runtime_provenance.py:94](C:/software-dev/cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_provenance.py:94)）。
- **同語言腳本尚未 import。** acceptance options、wheel acceptance、flow smoke、candidate install binding 仍有文字 pin；一般「目前採用版」應走 owner，只有命名明確的固定候選證據保留版本（[acceptance-real-options.mts:612](C:/software-dev/cert-prep/apps/cert-prep-desktop/scripts/acceptance-real-options.mts:612)、[acceptance-real.mts:307](C:/software-dev/cert-prep/apps/cert-prep-desktop/scripts/acceptance-real.mts:307)、[binding:32](C:/software-dev/cert-prep/tools/capture-candidate-install-binding.mts:32)）。
- **Rust 衍生字串重複。** `CAPTURE_RUNTIME_VERSION` 與 `CAPTURE_RUNTIME_MODEL` 各自含版本；candidate probe path 又有文字判斷。可將編譯所需常數生成並放入產品 artifact，或在 build.rs 讀 repo-local machine-readable owner；不能讓安裝後產品去找 sibling repo 或 Node 工具（[constants.rs:9](C:/software-dev/cert-prep/apps/cert-prep-desktop/src-tauri/src/constants.rs:9)、[capture_manifest.rs:66](C:/software-dev/cert-prep/apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs:66)）。
- **CI/Nx/PowerShell 另有 pin。** CI Python probe 的安裝要求與 assert、Nx install output 路徑、clean-install 驗證都可以從同一個 expected version 產生或取得（[ci.yml:173](C:/software-dev/cert-prep/.github/workflows/ci.yml:173)、[project.json:61](C:/software-dev/cert-prep/apps/cert-prep-desktop/project.json:61)、[clean-install.ps1:247](C:/software-dev/cert-prep/tools/release/clean-install.ps1:247)）。Nx output 若改無版本父目錄或 options 插值，需同時確認 cache/output 契約，不能只為少一行而弱化隔離。
- **SDK contract 衍生型別仍應重產。** generated TS 中的 preflight runtime 是 literal `0.4.4`；已存在 `cert-prep-backend:generate-openapi-client`，應由新版 SDK/OpenAPI 重新生成，不能對 generated 檔單獨替換（[cert-prep-api.generated.ts:65](C:/software-dev/cert-prep/libs/cert-prep-api/src/lib/cert-prep-api.generated.ts:65)）。

### Cert 的建議起點

保留 `tools/capture-runtime-version.mts` 的公開匯出作相容 facade，先把同語言腳本直接引回此來源；只有 Python/Rust/PowerShell/CI 都需要穩定讀取時，再給它一個 repo-local JSON backing owner。使用欄位級同步器更新 native manifest、workspace release-age 例外及必要的生成常數，並延伸現有 consumer inventory；lockfile 仍由各生態工具解析、驗證。讓產品自己的 alpha 版本另有 owner 或採用既有主要 product manifest，並由 `assertWorkspaceVersions()` 維持一致，不與 Capture pin 合併。

對固定候選版本、historical compatibility fixture、`LEGACY_CORE_ONLY_RUNTIME_VERSION`、Phase 1 hash evidence 採明確命名與豁免清單；不要把它們一律替換成最新 owner。一般成功路徑測試可用 fixture factory 接收版本；拒絕 stale/mixed version 的測試必須保留獨立不相等值。

## LAW：已有檢查器與 Maven property，但缺少跨語言共同 owner

### 版本領域與散落位置

LAW desktop/Python 自身是 `0.1.0`，Java engine 是 `0.1.0-SNAPSHOT`，root npm workspace 是 `0.0.0`；這些是不同領域，不能跟 Capture pin 一起做全域取代（[Tauri:4](C:/software-dev/gx.law-prep/apps/tauri/src-tauri/tauri.conf.json:4)、[Python:3](C:/software-dev/gx.law-prep/apps/law-prep-ai-service/pyproject.toml:3)、[Java:16](C:/software-dev/gx.law-prep/apps/law-prep-engine/pom.xml:16)、[root:3](C:/software-dev/gx.law-prep/package.json:3)）。

Capture 的 npm package、release-age exceptions、Python dependency、Cargo launcher、Maven SDK property 各自有版本宣告。Maven 在單一 POM 裡已用 `${capture-runtime-client.version}` 引用，不需要把同一個 dependency 再硬寫一次（[pom.xml:24](C:/software-dev/gx.law-prep/apps/law-prep-engine/pom.xml:24)、[property 引用:33](C:/software-dev/gx.law-prep/apps/law-prep-engine/pom.xml:33)）。

程式內另有五條維護路徑：

1. `check-capture-contract-consistency.mts` 同時宣告 `DEFAULT_VERSION` 和 `PYTHON_CAPTURE_RUNTIME_VERSION`；環境 override 只進入其中一條路徑。其 main 主要檢查 Python published dependency、Java POM 以及退休 package，不是目前所有 npm/Rust/workflow/runtime 常數的完整 inventory（[checker:5](C:/software-dev/gx.law-prep/tools/check-capture-contract-consistency.mts:5)、[Python check:217](C:/software-dev/gx.law-prep/tools/check-capture-contract-consistency.mts:217)、[其餘來源:240](C:/software-dev/gx.law-prep/tools/check-capture-contract-consistency.mts:240)）。
2. Python service 的 readiness/preflight 驗證與 receipt payload 各自寫 `0.4.4`（[service.py:27](C:/software-dev/gx.law-prep/apps/law-prep-ai-service/src/app/ocr/service.py:27)、[receipt_payload.py:48](C:/software-dev/gx.law-prep/apps/law-prep-ai-service/src/app/ocr/receipt_payload.py:48)）。
3. Rust `EXPECTED_RUNTIME_VERSION` 與 staging script 又各一份；stager 還把四個 OCR/Whisper resource 檔名手寫出完整版本（[capture.rs:34](C:/software-dev/gx.law-prep/apps/tauri/src-tauri/src/runtime/capture.rs:34)、[stage resources:36](C:/software-dev/gx.law-prep/tools/scripts/stage-capture-runtime/stage-capture-runtime.ts:36)、[stage version:64](C:/software-dev/gx.law-prep/tools/scripts/stage-capture-runtime/stage-capture-runtime.ts:64)）。現有 stager 有 override expectedVersion，但檔名仍為 `0.4.4`，顯示僅引入環境變數不足以完整共用版本。
4. CI Python probe 與 release workflow environment 再重複宣告（[ci.yml:78](C:/software-dev/gx.law-prep/.github/workflows/ci.yml:78)、[release-desktop.yml:95](C:/software-dev/gx.law-prep/.github/workflows/release-desktop.yml:95)）。
5. LAW 自己的 result envelope contract 也以 `const` pin producer runtime；golden fixture 與 generated TS validator/cases 因而隨動（[contract:128](C:/software-dev/gx.law-prep/contracts/ocr-projection-result-envelope-v1.contract.json:128)、[另一處 const:292](C:/software-dev/gx.law-prep/contracts/ocr-projection-result-envelope-v1.contract.json:292)、[generated validator:126](C:/software-dev/gx.law-prep/apps/law-prep-web/src/app/core/engine/contracts/generated/ocr-projection-result-envelope-v1.validator.ts:126)）。

### LAW 的建議起點

新增一個小型 repo-local machine-readable Capture adoption owner（例如 `release/capture-version.json`，名稱為建議，非已存在檔案），讓現有 checker/stager 共用；不要把 checker 的 private `DEFAULT_VERSION` 升格成別的語言必須解析的 source code。保留 Maven property 作 native adapter，由同步器填入；Python/Rust 的 installed runtime 常數則由生成或 native package API 提供，保留對 expected adoption version 的獨立 consistency check。

將 stage resource 檔名從明確的 release metadata 衍生。若只是命名規約穩定的檔名，可用 owner 插值；若 producer 的 catalog 已持有檔名、hash 與 profile，較完整的方向是讀取已驗證 manifest/catalog，而非維護另一本檔名清單。採用哪條路需跟 producer 的 package boundary 一起確認；任何路徑仍保留檔案、版本、hash 與型別驗證。

延伸既有 `law-prep-engine:capture-contract-consistency` target，涵蓋 npm/pnpm exceptions、Python/Poetry、Maven、Cargo、Rust/Python packaging 常數和 workflow reader。沿用已存在的 target 比新增平行 gate 更容易保持 CI 一致。

LAW contract source 的 runtime const 若仍代表「只接受此 release」，就由欄位同步器更新 canonical source，再執行既有 `@org/scripts:law-contracts-generate`；這個 generator 會對 canonical source/golden vector 作 hash、生成 Python/TS 與 source-hash manifest（[generator:370](C:/software-dev/gx.law-prep/tools/scripts/generate-law-contracts/generate-law-contracts.mts:370)、[golden hash:442](C:/software-dev/gx.law-prep/tools/scripts/generate-law-contracts/generate-law-contracts.mts:442)、[Python runtime hash guard:1280](C:/software-dev/gx.law-prep/tools/scripts/generate-law-contracts/generate-law-contracts.mts:1280)）。不能只讓 TypeScript validator 讀動態變數，就宣稱來源 contract、Python bytes 與 hash 已同步。

是否將 contract 相容性與 patch release identity 分離，屬於後續契約設計：需保留版本與 digest 的實際 artifact identity 檢查，並驗證舊 receipt 的讀取、跨版本拒絕及歷史證據。不能把 `const` 直接放寬成任意字串來達成少改檔案。

## Consumer 層共同建議與驗收方向

- 三 repo 各自擁有可獨立重現的 pin。Producer 發版不會自動代表兩個 consumer 已接受；升級更新 consumer-local owner，從明確 release/candidate metadata 驗證後建立可審閱 diff。不要在 build 或 installed runtime 讀 sibling checkout，也不要使用 floating latest。
- 自動同步器用明確欄位／允許清單分辨「目前 pin」「衍生資訊」「native manifest」「generated output」「歷史 fixture／證據」。相同字串不代表相同 owner。
- Lockfile、generated contract/validator、digest 等衍生資料仍然可能造成多檔 diff；目標是縮小人工決策與手改表面，而不是保證 Git 只剩一個檔案改變。
- pnpm 的 `minimumReleaseAgeExclude` 是目前精確版本的例外。由同步器精確更新；不要僅為省事改成整個 scope 或任意版本 wildcard。
- 驗收應證明：改一次 owner 後產生完整、可重現 diff；再次同步無變更；任一 native declaration 或 packaged constant 被故意改錯時現有一致性 gate 失敗；下一版仍可通過 install/package/runtime identity 檢查；歷史 golden、candidate hash evidence 與不相容版本拒絕測試保留其原本語意。
- 本輪未實作，因此未宣稱節省百分比或新的更新檔案數；50／33 只是基線 inventory。可在實作前後量測「需要人工輸入的版本位置」「升版命令數」「非 generated 檔案 diff」「整體 generated diff」四個指標。
