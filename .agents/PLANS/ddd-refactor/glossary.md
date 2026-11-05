# 通用語言（Ubiquitous Language）

狀態：**草案**（2026-10-26）。這張表是命名的依據：畫面、文件、程式、合約用同一個詞。新增或改名時，同一個 PR 更新這張表。合約裡的名稱（`*V2`、`*V3`）不改。

## 擷取

| 中文     | 程式名稱                          | 意思                                                       |
| -------- | --------------------------------- | ---------------------------------------------------------- |
| 來源     | `CaptureSource`                   | 送進 runtime 的一份 PDF、圖片或錄音，以 SHA-256 識別       |
| 匯入     | `Ingestion`、`IngestionChunk`、`IngestionV2`                     | 分塊上傳來源的過程，完成後才能開始擷取                     |
| 擷取作業 | `CaptureOperation`、`CaptureCompleted`、`PageLocator`、`TimeRange`、`CaptureOperationV2` | 對一份來源的一次擷取；狀態依 `StreamingCaptureStatus` 前進 |
| 擷取事件 | `CaptureEventV2`                  | 擷取作業的進度、片段、結束等事件，經 SSE 送給主機          |
| 原始擷取 | `RawCapture`                      | 引擎讀出的片段與出處，尚未結構化                           |
| 片段     | `RawCaptureSegment`               | 一段文字，帶頁碼或時間位置，語音的片段可帶說話者           |
| 擷取文件 | `CaptureDocument`、`CaptureBlock` | 結構化後交給主機的文件與它的區塊                           |

## 文件 OCR

| 中文       | 程式名稱                 | 意思                                                             |
| ---------- | ------------------------ | ---------------------------------------------------------------- |
| 運算計畫   | `compute plan`、`ComputePlanSelection`、`ComputePlanPolicy`      | 預檢後選定的 GPU（DirectML）或 CPU 執行方式                      |
| 執行證據   | `execution evidence`、`DirectMlExecutionEvidence`、`SessionDeviceProof` | DirectML 實際執行了模型節點的證據；不在合約裡                    |
| OCR 設定檔 | OCR profile              | 模型、字典、前處理與版本的組合，id 由 `pipeline.json` 的雜湊產生 |
| OCR 投影   | `CaptureOcrProjectionV3` | 每頁的文字、區塊、信心值與出處                                   |
| 閱讀順序   | `reading order`、`PageReadingOrder`、`PageRegion`、`BoundingBox`、`OcrPage` | 依版面決定區塊的先後，含直書與多欄                               |
| 直書閱讀器 | vertical reader          | 讀直書日文頁面的選用元件（NDLOCR-Lite）                          |

## 語音轉寫與說話者分離

| 中文       | 程式名稱                 | 意思                                                                                                   |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| 逐字稿     | `transcript`、`SpeechTranscript`、`SpeechTranscriptSegment`、`SpeechWord`、`RepetitionLoopPolicy` | 語音轉成的文字與時間                                                                                   |
| 分窗       | `window`、`AudioWindow`、`WindowSlicingPolicy`                                                     | 串流語音時每次送給模型的 120 秒音訊，前後重疊 30 秒                                                    |
| 暖 worker  | warm worker              | 擷取結束後保留模型、供下一次擷取使用的 worker 行程                                                     |
| 語音模型   | speech recognition model | 轉寫用的 TEA-ASR 模型（`CAPTURE_SPEECH_RECOGNITION_MODEL`）：`auto` 在兩種裝置用完整模型，或指定一個在兩種裝置都用 |
| 說話者片段 | `SpeakerTurn`、`SpeakerAssignment`、`SpeakerSegment`、`TimedWord`、`TurnTimeline` | 一位說話者連續發言的時間範圍、對齊結果與時間軸聚合                                                     |
| 說話者     | `CaptureSpeaker`、`SpeakerSample`                                                 | 擷取文件裡的一位說話者與試聽片段                                                                       |

## 結構化

| 中文           | 程式名稱                                                                                                                   | 意思                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 結構化         | structuring                                                                                                                | 把原始擷取整理成擷取文件；可由 runtime 或主機負責 |
| 結構化工作階段 | `StructuringSession`、`StructuringBatch`、`StructuringSemanticBlock`、`BatchPlanningPolicy`、`StructuringSessionV2`、`StructuringBatchV2` | 主機負責結構化時，分批提交的過程與語意區塊聚合    |

## 引擎供應

| 中文       | 程式名稱                                                      | 意思                                                               |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| 需求       | `RuntimeRequirement`、`RuntimeRequirementV2`                  | runtime 需要的一個元件，例如 `windowsml-ocr`、`speech-recognition` |
| 安裝       | `InstallationJob`、`RuntimeInstallationV2`、`InstallationStatus` | 下載、驗證、啟用一個需求的過程與作業狀態機                         |
| 引擎       | engine、worker                                                | 另外打包、以 JSON-lines 協定與 runtime 溝通的程式                  |
| 引擎目錄   | `EngineCatalog`、`EngineRequirementDescriptor`                | 每個需求的 worker、模型檔、版本與雜湊                              |
| 模型來源鎖 | model source lock                                             | 發布時核可的模型來源、版本與雜湊                                   |
| 下載快取   | engine cache                                                  | 本機共用、以 SHA-256 為鍵的下載內容                                |

## 執行環境合約

| 中文     | 程式名稱     | 意思                                                         |
| -------- | ------------ | ------------------------------------------------------------ |
| 合約集   | contract set | 所有公開型別、操作與問題代碼；雜湊相同的 runtime 與 SDK 相容 |
| 問題代碼 | problem      | 對外回報的錯誤種類（`problem_registry`）                     |

## W6 補正的引擎結果物件

| 中文 | 程式名稱 | 意義 |
| --- | --- | --- |
| 語音辨識結果 | `SpeechRecognitionResult` | Adapter 交回的逐字稿、裝置、模型與耗時；由轉寫用例轉成聚合。 |
| 分窗逐字稿 | `WindowTranscript` | 單一音訊窗的辨識片段、引擎與警告。 |
| 分窗逐字稿片段 | `WindowTranscriptSegment` | 音訊窗內的文字與時間範圍。 |
| 說話者分離結果 | `DiarizationResult` | Worker 解碼後的說話者片段、裝置、模型與耗時。 |
