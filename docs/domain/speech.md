# 語音轉寫

## 負責什麼、不負責什麼

負責語音辨識、分窗、重疊與重複迴圈停止。不管理擷取任務或耐久的主機文件。

## 用語

用語與公開領域類別見 [glossary](../../.agents/PLANS/ddd-refactor/glossary.md)。概念 ID 與合約值映射以 `capture-vocabulary-v1.json` 為準。

## 用例

| 操作 | 程式名稱 | 說明 |
| --- | --- | --- |
| 偵測重複迴圈 | `DetectRepetitionLoop` | 對 token 尾端套用停止政策。 |
| 切分音訊串流 | `SliceAudioStream` | 依保留游標與重疊政策計算完整視窗。 |
| 轉寫完整來源 | `TranscribeAudio` | 傳入明確選項並保留模型、裝置及耗時。 |
| 轉寫視窗 | `TranscribeAudioWindow` | 辨識一個有界的音訊窗。 |

## 聚合與不變條件

`AudioWindow` 有時間與容量上限；`WindowSlicingPolicy` 依目前保留游標計算完整視窗與結尾部分視窗。`SpeechTranscript` 驗證片段時間與總長度。辨識結果以 `SpeechRecognitionResult`、`WindowTranscript`、`WindowTranscriptSegment` 傳遞。`RepetitionLoopPolicy` 決定 token 迴圈停止。

```mermaid
classDiagram
  WindowSlicingPolicy --> AudioWindow
  SpeechTranscript *-- SpeechTranscriptSegment
  SpeechTranscriptSegment *-- SpeechWord
  RepetitionLoopPolicy : is_repeating_sequence(tokens)
```

## 主要流程

```mermaid
sequenceDiagram
  participant Capture as 擷取
  participant File as TranscribeAudio
  participant Decoder as 漸進式解碼器
  participant Slice as SliceAudioStream
  participant Window as TranscribeAudioWindow
  participant Adapter as 語音 adapter
  participant Stop as DetectRepetitionLoop
  Capture->>File: 完整來源
  File->>Adapter: 轉寫與明確的選項
  Decoder->>Slice: 已解碼長度與保留游標
  Slice-->>Decoder: 可消耗的完整視窗
  Decoder->>Window: AudioWindow
  Window->>Adapter: 辨識視窗
  Adapter->>Stop: token 序列
  Adapter-->>Capture: 領域片段、模型、裝置與耗時
```

## 與其他上下文的關係

擷取使用語音的公開用例；說話者分離只讀取時間對齊結果。模型與 worker 的供應由引擎供應上下文負責。

## 規則與資料來源

保留 TEA-ASR 的裝置、模型、摘要、警告、`elapsed_ms` 與 `stage_ms`。分窗從保留的重疊游標開始；沒有完整視窗時不提前提交，結束時才沖出剩餘部分。每個工作階段只組裝一次視窗轉寫用例。

## 已安裝的內容

發行目錄把語音需求分成 `cuda` 與 `cpu` 兩種內容。有 NVIDIA 驅動的機器安裝 `cuda`，沒有的安裝 `cpu`；選擇規則見[引擎供應](provisioning.md#一個需求的多個內容)。0.9.0 以前的發行目錄只有單一交付，沒有 `contents`；那種舊安裝與 `cuda` 內容使用同一套模型與裝置規則。

狀態 `"2"` 的安裝把 `contentId` 交給語音 worker：一次擷取的執行選項是 `content`，串流工作階段的環境變數是 `CAPTURE_SESSION_SPEECH_CONTENT`。沒有內容 id 的引擎不送這兩項，行為與今日相同。這個 id 是安裝當下記下的值，啟動時不重新偵測顯示卡，也不依磁碟上有哪些模型資料夾來猜測。未知的內容 id 直接失敗，不會當成 `cuda`。

`cuda` 與舊安裝：`auto` 與 `tea-asr-1.1` 載入 `primary`，回報模型 `tea-asr-1.1`。偏好 GPU 且 CUDA 可用時使用 CUDA；被歸類的 CUDA 失敗以同一個檢查點在 CPU 重試。明確的 `tea-asr-1.1-mini` 維持 mini。`probe` 要求 primary、mini、兩邊的架構目錄與 aligner。

`cpu` 內容沒有 GPU 路徑，一律在 CPU 上執行。`preferGpu` 與 `allowCpuFallback` 不改變裝置，也不會因為不允許 CPU 後援而回報 CUDA 裝置不存在。`auto` 載入 TEA-ASR-1.1-mini，回報模型 `tea-asr-1.1-mini`、裝置 `cpu`。明確的 `tea-asr-1.1-mini` 同樣載入 mini。明確的 `tea-asr-1.1` 在任何 worker 啟動或沿用之前失敗，不會改載 mini。擷取以既有的 `requirement_unavailable` 失敗，階段是 `extraction`，`retryable` 為 false。訊息說明這個模型不在已安裝的 `cpu` 內容，並請把 `CAPTURE_SPEECH_RECOGNITION_MODEL` 設成 `auto` 或 `tea-asr-1.1-mini`，或是解除安裝 `speech-recognition` 後以 `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda` 重新安裝。`GET /v2/runtime/requirements` 仍是 `ready`（`auto` 與 mini 仍可執行），`detail` 是同一句話。worker 內部仍以 `model not installed` 拒絕，留作第二道檢查。`probe` 在 mini、它的架構目錄與 aligner 都存在時就緒，不要求 primary。

## Finalized recording decoding

Without speaker identification, `PyAVFileDecoder.windows()` opens the finalized
ingestion directly once, probes duration on that container, and decodes its audio
track forward. It resamples to mono signed 16-bit PCM at 16 kHz and flushes the
resampler at EOF. Windows span 120 seconds with 30 seconds of overlap and a
4 MiB payload ceiling, including a final partial window. The iterator waits for
each worker input acknowledgement before advancing; there is no compressed
spool copy. Exact decoded sample counts enforce `max_audio_duration_ms`
independently of metadata. Overflow fails with `worker_failed`, stage
`extraction`, retryable `true`, as for whole-recording speech. Cancellation
signals the decoder, joins the active decode thread despite repeated task
cancellation, then closes the iterator/container and worker exactly once.
Probed duration remains a progress estimate. Window boundaries use cumulative
decoded sample counts, never summed rounded frame durations. PCM slices use
absolute sample positions; the final window includes every remaining sample,
with its integer-millisecond end truncated by less than 1 ms. Transcript offsets
are relative to each window's true start. Pulling waits for the preceding worker
acknowledgement, which bounds backpressure without a push input buffer.

Startup also removes `progressive-*.spool` left by crashed older runtimes.
Retain this migration cleanup until no supported upgrade path starts from a
runtime that wrote spools (versions up to 0.9.x); unrelated staging files remain.

## Recording path and memory

Speaker identification passes the finalized ingestion path directly to the speech and
diarization workers. The runtime sniffs only the first 200 bytes and probes timeout
duration from that path; it neither buffers the compressed recording nor writes
worker-source copies. Active captures protect the ingestion from deletion and expiry.
Both recording workers accept nonempty sources up to 2 GiB; PDF/image remain at 50 MiB.
Diarization consumes decoded frames lazily into one mono 16 kHz int16 PCM buffer,
stopping at the configured duration budget (default 90 minutes). Float32 conversion
normalizes in place and releases PCM before inference. Waveform and model memory
still grow with duration; this is not a fixed-memory inference path.

Capture deletion waits for the task and its worker cleanup before removing the
capture record or its last-reference ingestion. Cancellation is requested once;
worker cleanup remains joined even if cancellation is repeated. Deleting a
terminal capture's ingestion also waits for cleanup, while deleting an ingestion
used by a non-terminal capture retains the existing rejection. Disconnecting a
waiting DELETE request cancels only that wait and does not schedule deletion.
Pruning skips live tasks, including tasks whose capture is already cancelled.
