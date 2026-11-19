# Capture Workbench：以 OCR 與 ASR 為核心的 UI/UX 重新設計提案

Status: approved 2026-11-02; all §6 recommendations accepted. Product decision: Workbench is a product with two primary features, **文件轉文字 (OCR)** and **錄音轉逐字稿 (ASR)**. Phases 1 (PR #139) and 2 (PR #149) are merged. Phase 3 (PR #306) adds the `/ocr` queue; the approved visual design from artboards Main.dc.html and OcrFirstRun.dc.html was applied on 2026-11-13. The remaining phases are issues (§5), under [epic #152](https://github.com/gx-capture/capture-workbench/issues/152).

## 1. Current state

Phases 1 and 2 are in `apps/capture-workbench/src/app`:

- A shell with a left nav and the routes `/ocr` (home), `/asr`, `/history` and `/settings/engines` (`app.routes.ts`), built with Tailwind tokens and Spartan helm components in `src/app/ui` (`button`, `card`, `table`).
- Each feature has its own gate; there is no global setup state. `/settings/engines` installs, cancels and retries each unit through the `EngineCard` (`engine-card/`), with sizes from the runtime's `downloadBytes`. A first-run card on `/ocr` offers the units, and a reload re-attaches to running installs (`runtime_list_installations`).
- `/ocr` keeps the first-run card and, under it, a drop zone and a queue (檔名 · 頁數 · 狀態 · 動作). A dropped or chosen PDF or image is a native path (`droppedSources` or the existing file dialog, limited here to PDF and images). The host reads the file. The library saves it at once as 等待中, with its page-count option, whether or not `text-recognition` is installed. One drag-drop subscription routes the path: `/ocr` and `/asr` wait in that page's queue, and every other page imports the batch and starts capture. A missing engine shows an install prompt whose size comes from `downloadBytes`; when that install finishes, every waiting file starts by itself. A running row shows the stage, the percentage and 「第 9/12 頁」 when the job carries page counts. A document whose raw OCR text exists is 完成 and exports a `.txt` built from that text (page order, a blank line between pages), without the Ollama picker. `/asr` has its install panel, drop zone and queue. A finished row's 「檢視」 opens `/history/:id`. `/history` is the history table. Provenance, the structured JSON, JSON export and the model picker live on 診斷. There is no `/workspace` route: a request for it follows the wildcard redirect to `/ocr`. Angular Material is gone.

**On 診斷:** provenance, the structured JSON, JSON export and the model picker. Acceptance still uses `ocrEvidence` (`contracts/ocr-evidence.ts`), `pdfPageNumbers`, and the `desktop_acceptance_*` and `desktop_acceptance_runtime_process_probe` commands (`src-tauri/src/commands.rs`).

**Code facts that shape the design:**

- Without Ollama, the runtime still stops at `awaiting_structuring` with no `result`. `/ocr` shows 完成 once raw text is stored and exports that text. `/history` uses the same status text as the queue pages, so an OCR document with stored raw text is 完成.
- On `/history`, a native-path import starts the capture at once. On `/ocr`, the same path import only saves the file; capture starts when `text-recognition` is ready. The host checks size and emptiness.
- The desktop app does not send `spokenLanguage` yet (phase 4).
- The runtime returns no page images.
- A full restart loses runtime jobs.
- Verified downloads are cached by SHA-256 (`_engine_download_cache.py`), and an interrupted download resumes.

**E2E today:** `apps/capture-workbench-e2e/src/reference-flow.spec.ts` (browser tests with a fake Tauri bridge: shell, first-run card, ASR-only install, engines, and the OCR queue driven by a `tauri://drag-drop` path) and `apps/capture-workbench-desktop/scripts/real-desktop-ocr-acceptance.spec.ts` (manual real OCR). There is no ASR journey test.

## 2. Target information architecture

```
左側導覽（固定）
  文件轉文字      /ocr            ← 預設首頁
  錄音轉逐字稿    /asr
  紀錄            /history        表格，可篩選類型/狀態
    └ 單筆結果    /history/:id    子導覽：內容 · 說話者(ASR) · 匯出 · 詳細資訊
  設定            /settings
    ├ 辨識功能    /settings/engines   安裝、大小、進度、取消、移除
    ├ 運算裝置    /settings/compute   文字辨識 DirectML、語音 CUDA（偵測，不詢問）
    ├ 一般        /settings/general   語言
    └ 診斷        /settings/diagnostics  runtime 版本、合約雜湊、出處、JSON、OCR evidence
底部：runtime 狀態點（點一下 → 診斷）
```

**Rules:**

- **Each feature has its own gate.** `/ocr` needs only `text-recognition`, and `/asr` needs only `speech-recognition`. The global `needs-setup` state and the `ready ⇐ ocrCompute` coupling both go away; the app is usable as soon as the runtime runs.
- **Files are kept before an engine is ready.** A dropped path is saved to the library as 等待中 together with its page count. When the install finishes, the queue starts the waiting files.
- **Ask each fact once.** The first-run choice is remembered. Spoken language is a per-file default that the user changes only when needed. Devices are detected and never asked.
- **Statuses users see:** 等待中 · 處理中 · 完成 · 需要處理 · 已取消. The pipeline stage is shown only as the progress step.

### OCR journey (first run → export)

1. **First-run card** on `/ocr` (the LAW `recognition-setup-card` pattern). It offers two choices, 文字辨識 (約 144 MB) and 錄音轉文字 (約 2.8 GB) + 說話者辨識 (約 0.3 GB), plus 稍後再說. Nothing downloads until the user clicks.
2. **Drop or choose files.** If OCR is missing, the file still enters the queue and its row shows the LAW `recognition-feature-prompt`: 「需要文字辨識（約 144 MB）」[安裝]. The file starts by itself once the install finishes.
3. **Options are part of the drop step, for PDFs:** 頁碼, a list such as `1-5, 8, 10-12`; empty means all pages. The page count is not probed before recognition, so a page beyond the end of the file is reported when the capture starts. The vertical reader is not a per-file control; the runtime uses it when `vertical-japanese-reader` is installed. A crop for images can come later (Cert Prep `source-image-crop-dialog`).
4. **Progress:** a row per file showing the stage, a percentage and a 取消 button, with 重試 after a failure. Rows are in import order, oldest first, and waiting files start in that order ([#348](https://github.com/gx-capture/capture-workbench/issues/348)); the history list stays newest first. A count like 第 9/12 頁 comes from `pagesDone` and `pagesTotal` in `CaptureOperationV2` (also on SSE events). After a reload, the app re-attaches to running captures. After a full restart, unfinished files show 已中斷 with 重新開始.
5. **Review:** source page on the left, editable text on the right, synced by page. Images are shown as they are; PDF pages need a rasteriser (Q5). Edits are a separate layer; the recognized text is kept, and 還原 restores it.
6. **Export:** .txt and .md (with page headings), plus 複製全部. Both are built from the raw text plus the edits layer, so export works without Ollama. JSON moves to 診斷.

### ASR journey

1. **Install panel.** Without the engine, `/asr` shows this panel in place of the drop zone. It lists 語音轉文字 (required) and 說話者辨識 (optional), each with its size and the facts from `CAPTURE_UNIT_GUIDES` (台灣華語、中英夾雜；不支援台語、客語；錄音不會離開這台電腦). The rest of the app stays usable while it downloads.
2. **Drop a recording.** Before starting, a compact options row offers 語言 (default 中文; needs `spokenLanguage` wired through Tauri) and 分辨說話者 (only if diarization is installed; otherwise 「安裝說話者辨識（約 0.3 GB）」). It notes that turning on speakers removes the live partial transcript, as the contract says.
3. **Progress:** 已聽到 mm:ss / total (`coveredUntilMs` and `durationMs` in `CaptureOperationV2`; absent with speaker identification), the live partial transcript (`streaming-partial`) and 取消. Formats that WebView2 cannot play still get a transcript; the player shows 「這種格式無法在這裡播放」.
4. **Review:** a player stays fixed at the top, and below it is a table of timed lines (時間 · 說話者 · 文字). Clicking a time seeks the player; double-clicking the text edits it. 說話者 is a sub-page with a sample clip and a name field for each speaker, so a name is entered once and applied to every line.
5. **Export:** .txt (with times and names), .srt and .vtt subtitles, .md, and 複製全部.

### Install semantics (both features)

- **Size and consent:** the button label always shows the size, for example 安裝（約 2.8 GB）. Nothing downloads in the background.
- **Before the download:** free disk space is checked first, using LAW's `diskShort` text (needs a Tauri command).
- **While it runs:** a progress bar, a label and 取消, the same in the three places an installation is watched (the first-run card on `/ocr`, the row on 設定 › 辨識功能, the engine card on `/asr`). The progress appears with the click as 正在準備安裝…, before the runtime has answered the start request; then 正在下載 N%, a figure that never goes down; when every byte has arrived the label is 下載完成，正在安裝… (not 100%, which reads as stuck). The preview tests prove this with a start answer held back (`startDelay`).
- **After a failure:** 再試一次, which reuses the files already verified.
- **Resume:** after a window reload the app re-attaches to the running install (`runtime_list_installations`). The runtime resumes a partly downloaded file (Q4).
- **移除:** Settings › 辨識功能 offers removal for an installed engine ([#254](https://github.com/gx-capture/capture-workbench/issues/254)). The dialog names the engine and its size; nothing is removed until the user confirms. Documents and transcripts already saved stay on this computer.

## 3. Wireframes

**Shell + OCR first run**
```
┌──────────────┬─────────────────────────────────────────────────────┐
│ Capture      │ 文件轉文字                                          │
│              │ ┌─────────────────────────────────────────────────┐ │
│▸ 文件轉文字  │ │ 要安裝哪些辨識功能？                            │ │
│  錄音轉逐字稿│ │ ○ 文字辨識   讀出掃描檔與照片的文字   約 144 MB │ │
│  紀錄        │ │ ○ 錄音轉文字 把錄音轉成逐字稿        約 2.8 GB  │ │
│  設定        │ │   └ ○ 說話者辨識                     約 0.3 GB  │ │
│              │ │            [安裝所選（約 144 MB）]  [稍後再說]  │ │
│              │ └─────────────────────────────────────────────────┘ │
│              │ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐ │
│              │   拖曳 PDF 或圖片到這裡      [選擇檔案]            │
│ ● 已就緒     │ └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘ │
└──────────────┴─────────────────────────────────────────────────────┘
```

**OCR queue (same page, after drop)**
```
│ 檔名            頁數   狀態                          動作         │
│ 起訴狀.pdf      12    ████████░░ 辨識中 75%         [取消]       │
│ 收據.jpg         1    需要文字辨識（約 144 MB）     [安裝]       │
│ 合約.pdf         4    完成                          [檢視]       │
```

**OCR review `/history/:id`**
```
┌ 內容 ─┬───────────────────────────────┬──────────────────────────┐
│ 匯出  │  [第 3 頁影像]                │ 第 3 頁   [還原] 已編輯 ● │
│ 詳細  │                               │ 可編輯的辨識文字……       │
│       │  ◀ 2 / 3 / 4 ▶                │                          │
└───────┴───────────────────────────────┴──────────────────────────┘
```

**ASR page, engine missing**
```
│ 錄音轉逐字稿                                                      │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 台灣語音轉文字      台灣華語、中英夾雜；不支援台語、客語        │ │
│ │                     錄音不會離開這台電腦   [安裝（約 2.8 GB）] │ │
│ │ 說話者辨識（選用）  最多 8 位說話者        [安裝（約 0.3 GB）] │ │
│ │ ████████████░░░░░░  正在下載 58%                      [取消] │ │
│ └──────────────────────────────────────────────────────────────┘ │
```

**Transcript review**
```
┌ 內容   ┬ ▶ ━━━━━━━●━━━━━━━━━━  12:04 / 41:30 ─────────────────────┐
│ 說話者 │ 時間    說話者    文字                                    │
│ 匯出   │ 00:12   王律師    請您說明當天的經過。                    │
│ 詳細   │ 00:18   證人      那天下午我在……  ✎                      │
└────────┴──────────────────────────────────────────────────────────┘
```

**History `/history`**: a table with the columns 類型 (OCR/ASR icon) · 檔名 · 長度/頁數 · 狀態 · 更新時間, plus a filter by type and status (5 user-facing values) and search. Clicking a row opens the result.

**設定 › 辨識功能**: a table with the columns 功能 · 狀態 · 大小 · 用途 · 動作 (安裝/取消/再試一次), and one expandable row per unit with the guide facts.

## 4. Component reuse plan

| Item | Decision |
| --- | --- |
| Runtime status and native drops | **Done**: `RuntimeStatusStore` owns shared readiness, messages and reload; `App` owns native drop routing. `RecognitionFeaturesStore` owns requirements and installs, `LibraryStore` owns the shared library cache and item operations, and `OcrQueueStore` and `AsrQueueStore` own their page queues. The desktop adapters (`desktop-capture`, `desktop-installation`, `desktop-library`, `desktop-runtime-client`) stay. |
| Selectors (`services/`) | **Done**: pure functions live beside their users: `recognition-requirements.ts` (feature gates use a feature→requirement map: `ocr: [text-recognition]`, `asr: [speech-recognition]`, `asr.speakers: [speaker-diarization]`), `installation-progress.ts`, `capture-media-types.ts`, `recording-transcript.ts`, `capture-operation-status.ts`, `desktop-errors.ts`, and `formatApproximateBytes` in `desktop-formatting.service.ts`. |
| `EngineCard` (`engine-card/`) | One unit: guide, size, action, progress; used by the ASR panel and the settings table (phase 2, replacing `SpeechPack`). |
| `CAPTURE_UNIT_GUIDES` (`capture-workbench-ui`) | **Keep** as the source of the descriptive text. Download sizes come from the runtime's `downloadBytes`, in the desktop app and the Web Component. |
| `CaptureRuntimeComputeStatusComponent` | **Keep**, moved to 設定 › 運算裝置. |
| `capture-reconciliation`, `capture-runtime-installation` (in `capture-workbench-ui`, not used by the desktop app) | **Leave** to the Web Component. The desktop app keeps its own `desktop-installation` and `desktop-capture` services, extended with re-attach and the waiting queue. |
| `history/history-page.*` (the single-screen workspace, with its stylesheet) | Removed. OCR, ASR, history and settings are the routed pages. There is no `/workspace` route. |
| `ocr-evidence.ts`, provenance markup, JSON export, acceptance commands | **Move** to the 診斷 page or behind an acceptance build flag. Do not delete them, because acceptance still uses them. |
| Angular Material | Removed. The app uses Tailwind tokens and Spartan helm components (button, card, table, tabs, dialog, progress, badge) in `apps/capture-workbench/src/app/ui`. Recorded in `.agents/DECISIONS/tailwind-spartan-ui.md` and `.agents/DECISIONS/standalone-desktop-product.md`. |

## 5. Phased delivery

Each phase is one PR, shippable on its own. Before merging, every UI PR runs `pnpm nx run capture-workbench:build:production` locally (PR CI does not, and the 10 kB component-style budget fails only there), plus `pnpm run dead-code:check`. Browser e2e uses the fake Tauri bridge in `reference-flow.spec.ts`.

| # | PR | E2E added |
| --- | --- | --- |
| 1 (PR #139) | **Foundation:** Tailwind and Spartan set up, shell with left nav and routes. The current workspace moves unchanged to `/history`. Material is removed from the shell. Updates the `Cargo.toml` description and the harness decision. | Nav and routes render in zh-TW. `reference-flow.spec.ts` (its `.mat-mdc-*` checks), the desktop smoke/acceptance selectors and the bundle verifier strings are updated in the same PR. |
| 2 (PR #149) | **Recognition features:** split out `RecognitionFeaturesStore`, per-feature gates (removing `ready ⇐ ocrCompute`), the `EngineCard`, 設定 › 辨識功能 with cancel (new Tauri `runtime_cancel_installation`, since the client already has `cancelInstallation`), the first-run card, and re-attaching after a reload (new `runtime_list_installations`). | ASR-only user: never asked for OCR. Install shows its size → progress → cancel → retry. A reload re-attaches. |
| 3 (PR #306, [#157](https://github.com/gx-capture/capture-workbench/issues/157)) | **OCR page:** native-path drop zone, queue table, files kept while waiting (import decoupled from capture), the inline per-file install prompt, auto-start after install, and OCR text exportable without Ollama (raw-based .txt). | Drop a PDF path without OCR → prompt with its size → install → the file starts → page progress → 完成 → export .txt. A waiting file survives a reload. |
| 4 (implemented, [#158](https://github.com/gx-capture/capture-workbench/issues/158)) | **ASR page:** install panel, language (`spokenLanguage` stored in `LibraryCaptureOptions` & forwarded via Tauri) and speaker options (`AsrQueueStore`, oldest-first #348), drop zone (`recordings` selection kind, `/asr` drop routing), live progress (`coveredUntilMs`/`durationMs`) with partial transcript lines, queue actions (cancel/retry/restart/view/export). | Install prompt → ready → drop/pick recordings → oldest-first waiting queue → live partial transcript → done. Speakers off by default. |
| 5 ([#159](https://github.com/gx-capture/capture-workbench/issues/159)) | **Result review**, in slices. Slice 1 (done): the routed, read-only page `/history/:id` with the sub-pages 內容, 說話者 (recordings only) and 詳細資訊; OCR text by page beside the source image, the transcript table with the player and click-to-seek; 「檢視」 on `/ocr` and `/asr` opens it. State and behaviour are in `ResultReviewStore` and `services/result-review.ts`; the components only bind. Slice 3 (done): PDF page images, rendered in the renderer with pdf.js (`pdfjs-dist`, loaded lazily; worker, CMaps, standard fonts and the JavaScript image decoders are copied to `assets/pdfjs/`; WebAssembly is off because the desktop CSP has no `wasm-unsafe-eval`). `PdfPageRenderer` is the only file that touches pdf.js. Slice 2 (done): the edits layer. The host stores `library/items/<id>/edits.json` (`schemaVersion` 1; OCR text keyed by page number, transcript text by `segmentId`, speaker names by `speakerId`; decided 2026-11-16) through the command `library_save_edits`; an entry that is present is an edit and removing it restores the recognized text. The recognized result is never overwritten, the index is not touched, an unreadable file never hides the document (`editsUnreadable`), and a re-run that stores a different raw result clears the edits in the same transaction. Slice 4 (done): editing. The OCR page text is edited in place, a transcript line by double-click or its edit button (Enter or leaving the field commits, Esc cancels), a speaker is named once on 說話者; an edited page or line shows 「已編輯」 and 還原. `ResultReviewStore` holds a working copy of the edits and the rules are pure functions (`applyResultEdit`, `sameResultEdits`): text equal to the recognized text is not an edit, the host's limits are checked before a change is applied, and a rejected value is never saved. Saving is automatic, 600 ms after the last change, with the whole working copy; one request at a time across documents, a change made during a save is saved when it returns, and leaving the page or the document sends the pending save at once. The shell shows 儲存中 / 已儲存 / 儲存失敗 with 重試. Not covered: closing the window within the 600 ms quiet period (installed acceptance, #163). Slice 5 (done): the visual pass, reviewed apart from function. The owner approved eighteen items on 2026-11-16 from screenshots of every new page: 紀錄, the result pages and 設定 use the page layout, status badges, row buttons and table style of `/ocr`; the document result has one stepper row above two equal columns; the transcript shows edit and restore as icon buttons and keeps the player in view; 匯出 is a list of formats with a line of purpose each; 診斷 has copyable digests. The transcript renders a text field only for the line being edited. A design audit with Hallmark followed (icons instead of glyphs, an accessible name for the page image, overflow and long-heading guards, tabular numerals, progress animated by transform with a reduced-motion fallback). | 「檢視」 opens `/history/:id`, the page text and the PDF page image step together, 詳細資訊 shows the file. Edit a page, reload and see the correction, then restore it; edit a line, then restore it; click a time and the player seeks; name a speaker once and every line shows the name (browser e2e, both Playwright projects). |
| 6 ([#160](https://github.com/gx-capture/capture-workbench/issues/160)) | **History and export:** history table with filters; export .txt/.md (OCR) and .txt/.srt/.vtt/.md (ASR), rendered in the host from raw + edits; relaxed PDF page ranges. Slice 1 (done): export. The host command `library_export` takes `{ documentId, format, pageLabel? }` and renders `text`, `markdown`, `srt` and `vtt` in `library/export.rs` from the recognized result with the edits applied (`json` is unchanged and stays for diagnostics); `pageLabel` is the UI's page-heading template, so the host needs no locale. Subtitle lines without a usable time range or without text are skipped and cues are numbered consecutively. The result page has the sub-page 匯出 (`/history/:id/export`): downloads per format (字幕 formats for recordings only) and 複製全部. `LibraryExportService` is the one caller of the command and owns the download or clipboard effect and the per-document busy guard; `ResultExportStore` holds the page state. An export first sends the pending corrections through the autosave writer (`ResultReviewStore.saveBeforeExport`) and is not requested when that save fails, so a file never contains stale text. The 匯出 buttons of `/ocr` and `/asr` use the same service; the renderer no longer builds export text. Slice 2 (done): the summary returned by `library_list` carries `pageCount` and `durationMs`, derived from the recognized result and stored in the index with it (`library/extent.rs`; an older index is filled in memory on the first list and persisted by the next write), so a table needs no per-document fetch; `/asr` no longer fetches every finished recording for its duration. Slice 3 (done): PDF page lists. The request validators and the OCR evidence checks of the renderer and the host accept any strictly ascending page list, as the runtime contract already did, and completed evidence must be for exactly the requested pages. The `/ocr` field 頁碼 is parsed by `parsePdfPageList` (`services/ocr-queue.ts`) and stored as `captureOptions.pdfPageNumbers`; `pdfPageCount` stays valid for documents stored earlier. The result page shows the source page number and the position when the recognized pages are not `1..N`. History table (done): `/history` lists every document (類型, 檔名, 長度/頁數, 狀態, 更新時間; newest first) with filters by type and by the five user-facing statuses and a search by file name; a row has 檢視 and 刪除 (confirmation dialog; the same documents can be deleted as before). The rules are pure functions in `services/history-list.ts` (the status text is the one the queue pages show), the state is in `HistoryListStore`. A result opened from 紀錄 carries `?from=history` and returns there. The status dot opens 診斷. There is no `/workspace` route. | Each format downloads with the expected content (fixture). A corrected page exports the corrected text; a recording exports `.srt` (browser e2e). |
| 7 ([#161](https://github.com/gx-capture/capture-workbench/issues/161)) | **Diagnostics and cleanup:** the 診斷 page, provenance, JSON and the Ollama picker moved there; the single-screen workspace and Angular Material are gone: there is no `/workspace` route, and a request for it follows the wildcard redirect to `/ocr`. Slice 1a (done): 設定 is a routed layout with a sub-navigation (辨識功能, 運算裝置, 一般). 運算裝置 shows the OCR GPU check and the speech GPU preference (`SpeechGpuSettingsStore`); 一般 has the language choice. Slice 1b (done): 診斷 (`/settings/diagnostics`), the fourth settings entry and the target of the status dot. It shows the runtime state with 重新連線, the runtime, API and contract versions the renderer knows, and the Ollama model picker; with `?document=<id>`, reached from the 「診斷資訊」 link of a result's 詳細資訊, it also shows that document's extraction and structuring provenance (the provenance data attributes), its OCR evidence summary and 匯出 JSON (the structured result, or the recognized result when the document was never structured). `DiagnosticsStore` and the pure functions of `services/diagnostics.ts` hold the logic; Diagnostics uses the provenance function in `services/diagnostics.ts`. Slice 2a (done): the installed deterministic smoke and the browser e2e drive `/ocr`, `/asr`, the result page and 診斷. The UI comes first and the smokes follow it (decided 2026-11-16): the check of the optional model's structured result is removed from the UI-driven smokes for now and will be verified another way; everything else is still proved (first run, import through the native dialog, recognized text shown for a PDF, an image, a recording and a large recording, no source bytes through the renderer, the IPC boundary, redacted evidence). Still to do: running the manual real smokes for the routed pages on a desktop. | Diagnostics is reachable from the status dot; the main views carry no provenance. |

Upstream runtime items, shipped separately in capture-workbench as the runtime owner: `downloadBytes` and installation byte counts (PR #141), resumable downloads (PR #151), page and duration progress (PR #148), the uninstall endpoint (PR #145) and the speech split into `cuda` and `cpu` contents (Q3, [#154](https://github.com/gx-capture/capture-workbench/issues/154), PR #325) are merged. Open: native-path import of recordings over 50 MiB (Q6, [#155](https://github.com/gx-capture/capture-workbench/issues/155); plan in [large-recording-import.md](large-recording-import.md)). Each Tauri command added must have a caller in the same PR, or the dead-code gate fails.

Also open: the packaged acceptance must re-approve the new navigation's pixel baselines and run real OCR and ASR ([#163](https://github.com/gx-capture/capture-workbench/issues/163)). Desktop CDP e2e for a real OCR and ASR journey stays local and manual, per AGENTS.md.

## 6. Decisions (approved 2026-11-02; the answer is in bold)

1. **Material → Tailwind + Spartan?** This supersedes a recorded decision. **Yes, migrate shell-first (phase 1), with the helm components copied by the CLI, not shared across repositories.**
2. **What happens to Ollama structuring (「結構化結果」)?** Without it, OCR ends at 「等待確認」 with no exportable result. **Hide it from the product views in v1, finish OCR as 完成 on the raw text, and build export from raw + edits. Keep the picker in 診斷 until a user-facing use exists.**
3. **Split speech into a GPU model and a CPU-only mini unit?** **Yes, upstream. Choose by `cudaAvailable` and offer the smaller mini download on CPU machines, with the size taken from the runtime contract.**
4. **Downloads that resume after the app closes?** **Re-attach plus 再試一次, and `.part` files with HTTP `Range` resume in the runtime (done, PR #151).**
5. **How should PDF pages be shown in review?** The runtime returns boxes but no page images. **Render pages in the renderer with pdf.js from the saved source, which needs no runtime change. Until that lands, show text only for PDFs and the image for image sources.**
6. **Recordings over 50 MiB** (an hour of audio, most video; [#155](https://github.com/gx-capture/capture-workbench/issues/155))? **Must be fixed before ASR is a primary feature. Import by native path, so the renderer still never sees the path, and stream to the runtime.** Done (issue #155 closed 2026-11-14).

Decided 2026-11-16:

7. **What does a recording's .txt export contain?** **Each line is `[HH:MM:SS] name: text`** (the time form of the Markdown export); a line without a speaker has no name.
8. **Which PDF pages can be recognized?** **Any list: the /ocr field 「頁碼」 accepts `1-5, 8, 10-12`; empty means all pages; a reversed range or a page given twice is an input error. The result page shows the source page number and the position, 「第 7 頁（2 / 3）」.** The runtime contract already accepts any ascending list, so only the desktop app changes.
9. **What can a row of the history table do?** **檢視 and 刪除 (with a confirmation dialog). Export stays on the result's 匯出 sub-page. A result opened from 紀錄 returns to 紀錄; one opened from /ocr or /asr returns there.**
10. **Where are a document's provenance and JSON export?** **Behind a 「診斷資訊」 link at the bottom of the result's 詳細資訊, which opens the diagnostics page for that document. The diagnostics page itself, reached from the status dot, shows the runtime state, the GPU check and the Ollama model picker, and has no document list.**
