# 結構化

## 負責什麼、不負責什麼

把原始擷取整理為擷取文件，支援 runtime 供應者及主機分批提交，並管理允許的模型安裝作業。不執行 OCR 或語音推論。

## 用語

用語與公開領域類別見 [glossary](../../.agents/PLANS/ddd-refactor/glossary.md)。概念 ID 與合約值映射以 `capture-vocabulary-v1.json` 為準。

## 用例

| 操作 | 程式名稱 | 說明 |
| --- | --- | --- |
| 取消模型安裝 | `CancelModelInstallation` | 停止任務後寫入取消 checkpoint。 |
| 取得模型安裝 | `GetModelInstallation` | 讀取安裝狀態與進度。 |
| 取得工作階段 | `GetStructuringSession` | 依擷取識別碼讀取主機工作階段。 |
| 安裝模型 | `InstallModelOption` | 建立允許的模型作業，只對新作業排程。 |
| 開啟工作階段 | `OpenStructuringSession` | 檢查來源與方言，建立批次計畫。 |
| 提交批次 | `SubmitStructuringBatch` | 先檢查重播、摘要及順序，再驗證語意與持久化。 |

## 聚合與不變條件

`StructuringSession.require_next_batch/accept_batch` 守住開放狀態與批次順序；`StructuringBatch.verify_digest/accept` 守住摘要及接受狀態。`BatchPlanningPolicy` 計算輸入、輸出與保留 token 的限制。`ModelInstallation` 管理模型安裝的執行、進度、完成、失敗與取消，終態不可覆寫。領域錯誤包含 `SessionTransitionError`、`StructuringValidationError` 與 `StructuringSessionDigestConflictError`。

```mermaid
classDiagram
  StructuringSession : accept_batch(index)
  StructuringBatch : verify_digest(digest)
  StructuringSession --> StructuringBatch
  BatchPlanningPolicy : limits(max_predict)
  ModelInstallation : mark_running(now)
  ModelInstallation : mark_completed(now)
```

## 主要流程

```mermaid
sequenceDiagram
  participant API as 主機 API
  participant UC as OpenStructuringSession / SubmitStructuringBatch
  participant Repo as SessionRepository
  participant Domain as StructuringSession / StructuringBatch
  participant Validator as 注入的驗證與組裝器
  API->>UC: 開啟或提交批次
  UC->>Repo: 檢查重播與讀取批次
  UC->>Domain: 驗證下一批次
  UC->>Validator: 驗證語意並組裝最終文件
  UC->>Repo: 提交 checkpoint
  Repo->>Domain: 鎖內重查順序與摘要
  Repo-->>UC: 先持久化再替換記憶體狀態
  UC-->>API: 工作階段結果
```

## 與其他上下文的關係

讀取擷取上下文的公開結果；Ollama adapter 負責模型及 HTTP 技術機制。模型安裝 API 經 `InstallModelOption`、`GetModelInstallation`、`CancelModelInstallation`。

## 規則與資料來源

重播先於語意驗證；順序檢查先於最後批次的文件組裝，錯序回傳 409。Repository 的鎖內檢查仍為寫入的權威。模型下載的鎖、任務 registry 與取消等待由生命週期服務持有。

隔離的 Ollama 程序在 PID 檔寫下程序識別碼，以及作業系統回報的原始建立時間（`processCreationTime`：Windows `GetProcessTimes` 的 FILETIME 整數，或 Linux `/proc/<pid>/stat` 的 starttime；該平台讀不到時不寫此欄）。下次啟動時：識別碼已結束就刪除檔案並繼續；識別碼仍在且建立時間相同就拒絕再啟動；建立時間不同表示該識別碼已交給別的程序，刪除過期檔案並繼續。舊檔沒有建立時間，或當時讀不到建立時間，仍拒絕。程序映像名稱與命令列不用來判斷。
