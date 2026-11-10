# 引擎供應

## 負責什麼、不負責什麼

引擎供應負責 runtime 所需引擎與模型的目錄、下載快取、安裝、驗證、啟用及移除，並透過 runtime API 提供需求與安裝作業資訊。它不執行 OCR、語音轉寫或說話者分離，也不保存主機應用的來源與領域資料。

## 用語

需求、安裝、引擎、引擎目錄、模型來源鎖與下載快取的定義見 [glossary 的引擎供應段落](../../.agents/PLANS/ddd-refactor/glossary.md#引擎供應)。程式、文件與公開合約沿用相同用語。

## 聚合與不變條件

引擎供應上下文依聚合分子套件（W6 定案）：
1. **安裝作業 (`installation`)**：`InstallationJob` 聚合根守住安裝狀態機（`InstallationStatus`）與不變條件。只有非終態能推進，終態不可再變更進度或下載位元組；進度介於 0.0 與 1.0；已下載位元組不大於總位元組。
2. **需求 (`requirement`)**：`RuntimeRequirement` 實體描述需求識別碼、顯示名稱與就緒狀態。
3. **引擎目錄 (`catalog`)**：`EngineCatalog` 與 `EngineRequirementDescriptor` 描述需求的檔案規格與校驗雜湊。

```mermaid
classDiagram
  class InstallationJob {
    +str installation_id
    +str requirement_id
    +InstallationStatus status
    +float progress
    +int download_bytes
    +int downloaded_bytes
    +bool is_terminal
    +mark_running(now)
    +update_progress(value, now)
    +update_download(downloaded, total, now)
    +mark_completed(now)
    +mark_failed(code, message, retryable, now)
    +mark_cancelled(now)
  }
  class RuntimeRequirement {
    +str requirement_id
    +str display_name
    +str status
    +str error
  }
  class EngineCatalog {
    +get(requirement_id)
  }
  class EngineRequirementDescriptor {
    +str requirement_id
    +str display_name
    +tuple artifacts
    +tuple model_files
  }
  EngineCatalog --> EngineRequirementDescriptor : describes
```

## 主要流程

```mermaid
sequenceDiagram
  participant Host as 主機
  participant API as Runtime API
  participant UseCase as InstallRequirement / CancelInstallation
  participant Service as InstallationService
  participant Repo as InstallationRepository
  Host->>API: 提交安裝需求
  API->>UseCase: execute
  UseCase->>Service: create / cancel
  Service->>Repo: 建立或更新 InstallationJob
  Host->>API: 查詢安裝狀態
  API->>UseCase: GetInstallation / ListInstallations
  UseCase->>Repo: 讀取 InstallationJob
```

## 用例

| 中文 | 用例（程式名稱） | 說明 |
| :--- | :--- | :--- |
| 安裝需求 | `InstallRequirement` | 建立或取回安裝作業，並非同步執行下載、驗證與啟用 |
| 取消安裝 | `CancelInstallation` | 取消進行中或等待中的安裝作業 |
| 取得安裝作業 | `GetInstallation` | 依識別碼查詢單一安裝作業狀態 |
| 列出安裝作業 | `ListInstallations` | 列出目前所有已記錄的安裝作業 |
| 卸載需求 | `UninstallRequirement` | 在無進行中擷取與安裝時，釋放暖 worker 並移除安裝之引擎 |
| 查詢需求清單 | `ListRequirements` | 查詢可用的執行環境需求與當前安裝狀態 |

桌面應用的設定 › 辨識功能在使用者確認引擎名稱與大小之後，才透過 `runtime_uninstall_requirement` 呼叫卸載需求。已經做好的文件與逐字稿留在主機，不會跟著引擎刪除。

## 與其他上下文的關係

文件 OCR、語音轉寫與說話者分離使用本上下文供應的引擎與模型；結構化使用供應的 Ollama runtime。worker 的推論與結果解析由各引擎上下文負責。

## 規則與資料來源

領域模型位於 `capture_runtime.provisioning.domain`。用例位於 `capture_runtime.provisioning.application.use_cases`。目錄載入、檔案下載、快取與安裝儲存庫位於 `capture_runtime.provisioning.infrastructure`。HTTP 路由位於 `capture_runtime.provisioning.api.runtime`。公開型別由 `capture_runtime.contracts` 定義，在 API 與 application 邊界與領域物件互轉。
