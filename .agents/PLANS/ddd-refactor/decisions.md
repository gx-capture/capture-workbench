# DDD 重構：提議的決策

狀態：**已核可**（2026-10-26）。產品題（P）已由產品負責人核可（P1 取代 capture-large-file-refactor.md 第 3 條）；設計題（D）照本表實作，實作中若要推翻其中一條，先在這裡改，並寫明理由。

## 產品決策（產品負責人）

| 編號 | 提議                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 取代 [capture-large-file-refactor.md](../../DECISIONS/capture-large-file-refactor.md) 第 3 條（不採用四層 DDD 結構），改依本計畫的上下文與分層。該決策的其餘各條照舊，包括拒絕「只為了 DDD 資料夾名稱加薄包裝層」：只建有內容的層。 |
| P2   | 不暫停新功能。搬移的 PR 小而快，功能分支在每次搬移合併後 rebase；某個上下文在 W5 搬移時，那個上下文的新功能先暫停。                                                                                                                 |
| P3   | 公開合約、worker 協定、持久化格式、環境變數名稱與畫面這次都不改；重構可以跟著一般的 patch 版本發布，不需要 consumer 遷移。                                                                                                          |
| P4   | Cert Prep 與 LAW 換到 0.7.2 之後才開始 W2；W1（只加檢查）可以先做。                                                                                                                                                                 |

## 設計決策（計畫作者提議）

| 編號 | 提議                                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | Runtime 上下文：擷取（核心）、文件 OCR、語音轉寫、說話者分離、結構化、引擎供應；另有公開的執行環境合約、主機的工作台主機，以及不是上下文的 `worker_kernel` 與 `platform`。                                                                                                                           |
| D2   | 上下文內分 `domain`、`application`、`infrastructure`、`api`，只建有內容的層。`api` 與 `infrastructure` 依賴 `application` 與 `domain`，`application` 只依賴 `domain`；`domain` 只依賴標準函式庫、`platform` 與 `contracts` 的值型別。組裝集中在 `app.py`、`dependencies.py` 與 `workers/*_main.py`。 |
| D3   | `capture_runtime.contracts` 留在原地，不新增、不移出任何 `BaseModel`（contract set 由它的內容算出）；各上下文自己的模型不放進這個模組。每個 PR 以 `check-contracts` 確認雜湊不變。                                                                                                                   |
| D4   | `workers/*_main.py` 是 worker 的組裝入口：路徑不變，內容只剩組裝與啟動，實作移到各上下文的 `infrastructure`。PyInstaller spec 的 excludes 與 data files 隨搬移同一個 PR 更新。                                                                                                                       |
| D5   | 工具：import-linter（runtime）、Sheriff（UI 與殼層）、`@nx/enforce-module-boundaries` 的實際標籤規則（專案層級）、Rust 模組可見性。既有違規以 import-linter `ignore_imports` 與 ESLint bulk suppressions 列為已知例外，每個 PR 只能減少。與 LAW A31、Cert Prep D4 用同一組工具。                     |
| D6   | 重量級函式庫只在 `infrastructure`，維持在函式內延遲 import；`domain` 與 `application` 不 import torch、transformers、onnxruntime、paddle、av、PIL、httpx、FastAPI。`verify_boundaries.py` 的打包檢查照舊作為最後防線。                                                                               |
| D7   | 跨模組不 import 底線開頭的私有名稱（現有 13 處在 W2–W4 改成公開介面）；規則上線後新增的私有 import 讓 CI 失敗。                                                                                                                                                                                      |
| D8   | 測試替身（確定性 extractor、假結構化供應者、假安裝程式）移到 `capture_runtime.testing`，由 `dependencies.py` 依設定組裝；它們仍隨 runtime 打包，因為桌面的確定性模式與 e2e 會用到。                                                                                                                  |
| D9   | 程式裡殘留的 `Whisper` 名稱在 W5 搬語音時改成 `speech`；環境變數（`CAPTURE_WHISPER_*`）與合約名稱不改。                                                                                                                                                                                              |
| D10  | 文件：說明用繁體中文，程式名稱用英文；每個上下文一份 `docs/domain/<上下文>.md`，圖用 Mermaid，改程式時同一個 PR 更新。                                                                                                                                                                               |
