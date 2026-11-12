# Capture Workbench：以 OCR 與 ASR 為核心的 UI/UX 重新設計提案

Status: approved 2026-11-02; all §6 recommendations accepted. Product decision: Workbench is a product with two primary features, **文件轉文字 (OCR)** and **錄音轉逐字稿 (ASR)**. Phases 1 (PR #139) and 2 (PR #149) are merged. Phase 3 (PR #306) adds the `/ocr` queue. The remaining phases are issues (§5), under [epic #152](https://github.com/gx-capture/capture-workbench/issues/152).

## 1. Current state

Phases 1 and 2 are in `apps/capture-workbench/src/app`:

- A shell with a left nav and the routes `/ocr` (home), `/asr`, `/history` and `/settings/engines` (`app.routes.ts`), built with Tailwind tokens and Spartan helm components in `src/app/ui` (`button`, `card`, `table`).
- Each feature has its own gate; there is no global setup state. `/settings/engines` installs, cancels and retries each unit through the `EngineCard` (`engine-card/`), with sizes from the runtime's `downloadBytes`. A first-run card on `/ocr` offers the units, and a reload re-attaches to running installs (`runtime_list_installations`).
- `/ocr` keeps the first-run card and, under it, a drop zone and a queue (檔名 · 頁數 · 狀態 · 動作). A dropped or chosen PDF or image is a native path (`droppedSources` or the existing file dialog, limited here to PDF and images). The host reads the file. The library saves it at once as 等待中, with its page-count option, whether or not `windowsml-ocr` is installed. One drag-drop subscription routes the path: `/ocr` waits, every other page starts capture as before. A missing engine shows an install prompt whose size comes from `downloadBytes`; when that install finishes, every waiting file starts by itself. A running row shows the stage, the percentage and 「第 9/12 頁」 when the job carries page counts. A document whose raw OCR text exists is 完成 and exports a `.txt` built from that text (page order, a blank line between pages), without the Ollama picker. `/asr` still shows the speech install panel; its capture flow stays a placeholder for phase 4. `/history` is still the old single-screen workspace, with Angular Material, the Ollama picker, provenance, the structured JSON and JSON export; phase 7 moves the diagnostics out and deletes it.

**Harness-only, to move to 診斷 (phase 7):** provenance digests; the raw-segment and block data attributes; the structured JSON and JSON export; `ocrEvidence` (`contracts/ocr-evidence.ts`); the acceptance `pdfPageNumbers`; the `desktop_acceptance_*`, `desktop_runtime_process_probe` and `model_smoke_import_fixture` commands (`src-tauri/src/commands.rs`); the Ollama picker.

**Code facts that shape the design:**

- Without Ollama, the runtime still stops at `awaiting_structuring` with no `result`. `/ocr` shows 完成 once raw text is stored and exports that text. `/history` still shows 等待確認 and leaves Export disabled until a structured result exists.
- On `/history`, a native-path import starts the capture at once. On `/ocr`, the same path import only saves the file; capture starts when `windowsml-ocr` is ready. The host checks size and emptiness.
- The desktop app does not send `spokenLanguage` yet (phase 4).
- PDF page ranges other than a `1..K` prefix are refused, and the runtime returns no page images.
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

- **Each feature has its own gate.** `/ocr` needs only `windowsml-ocr`, and `/asr` needs only `speech-recognition`. The global `needs-setup` state and the `ready ⇐ ocrCompute` coupling both go away; the app is usable as soon as the runtime runs.
- **Files are kept before an engine is ready.** A dropped path is saved to the library as 等待中 together with its page count. When the install finishes, the queue starts the waiting files.
- **Ask each fact once.** The first-run choice is remembered. Spoken language is a per-file default that the user changes only when needed. Devices are detected and never asked.
- **Statuses users see:** 等待中 · 處理中 · 完成 · 需要處理 · 已取消. The pipeline stage is shown only as the progress step.

### OCR journey (first run → export)

1. **First-run card** on `/ocr` (the LAW `recognition-setup-card` pattern). It offers two choices, 文字辨識 (約 144 MB) and 錄音轉文字 (約 2.8 GB) + 說話者辨識 (約 0.3 GB), plus 稍後再說. Nothing downloads until the user clicks.
2. **Drop or choose files.** If OCR is missing, the file still enters the queue and its row shows the LAW `recognition-feature-prompt`: 「需要文字辨識（約 144 MB）」[安裝]. The file starts by itself once the install finishes.
3. **Options are part of the drop step, for PDFs:** 前 K 頁. Until the `1..K` validators are relaxed and the page count is probed, that is the only range. The vertical reader is not a per-file control; the runtime uses it when `vertical-japanese-reader` is installed. A crop for images can come later (Cert Prep `source-image-crop-dialog`).
4. **Progress:** a row per file showing the stage, a percentage and a 取消 button, with 重試 after a failure. A count like 第 9/12 頁 comes from `pagesDone` and `pagesTotal` in `CaptureOperationV2` (also on SSE events). After a reload, the app re-attaches to running captures. After a full restart, unfinished files show 已中斷 with 重新開始.
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
- **While it runs:** a percentage and 取消.
- **After a failure:** 再試一次, which reuses the files already verified.
- **Resume:** after a window reload the app re-attaches to the running install (`runtime_list_installations`). The runtime resumes a partly downloaded file (Q4).
- **移除:** Settings › 辨識功能 offers removal for an installed engine ([#254](https://github.com/gx-capture/capture-workbench/issues/254)). The dialog names the engine and its size; nothing is removed until the user confirms. Documents and transcripts already saved stay on this computer.

## 3. Wireframes

**Shell + OCR first run**
```
┌──────────────┬─────────────────────────────────────────────────────┐
│ Capture      │ 文件轉文字                                          │
│              │ ┌─────────────────────────────────────────────────┐ │
│▸ 文件轉文字  │ │ 需要時再安裝辨識功能                            │ │
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
| `DesktopWorkspaceStore` | **Split**: `RecognitionFeaturesStore` (requirements, installs, per-feature readiness) is split out (phase 2); `CaptureQueueStore` (import, cancel, retry, partials) and `LibraryStore` (list, detail, delete, export, edits). Keep the facade services (`desktop-workspace-capture`, `-installation`, `desktop-library`, `desktop-runtime-client`). |
| `desktop-workspace.selectors.ts` | **Keep**. Feature gates use a feature→requirement map: `ocr: [windowsml-ocr]`, `asr: [speech-recognition]`, `asr.speakers: [speaker-diarization]` (phase 2). |
| `EngineCard` (`engine-card/`) | One unit: guide, size, action, progress; used by the ASR panel and the settings table (phase 2, replacing `SpeechPack`). |
| `CAPTURE_UNIT_GUIDES` (`capture-workbench-ui`) | **Keep** as the source of the descriptive text. Download sizes come from the runtime's `downloadBytes`, in the desktop app and the Web Component. |
| `CaptureRuntimeComputeStatusComponent` | **Keep**, moved to 設定 › 運算裝置. |
| `capture-reconciliation`, `capture-runtime-installation` (in `capture-workbench-ui`, not used by the desktop app) | **Leave** to the Web Component. The desktop app keeps its own `desktop-workspace-installation` and `-capture` services, extended with re-attach and the waiting queue. |
| `history/history-page.*` (the old workspace, with its stylesheet) | **Delete** after migration, replaced by routed pages. |
| `ocr-evidence.ts`, provenance markup, JSON export, acceptance commands | **Move** to the 診斷 page or behind an acceptance build flag. Do not delete them, because acceptance still uses them. |
| Angular Material | **Replace** with Tailwind tokens and Spartan helm components (button, card, table, tabs, dialog, progress, badge), generated by the Spartan CLI into `apps/capture-workbench/src/app/ui` and matching LAW `libs/ui`. Recorded in `.agents/DECISIONS/tailwind-spartan-ui.md` and `.agents/DECISIONS/standalone-desktop-product.md`. |

## 5. Phased delivery

Each phase is one PR, shippable on its own. Before merging, every UI PR runs `pnpm nx run capture-workbench:build:production` locally (PR CI does not, and the 10 kB component-style budget fails only there), plus `pnpm run dead-code:check`. Browser e2e uses the fake Tauri bridge in `reference-flow.spec.ts`.

| # | PR | E2E added |
| --- | --- | --- |
| 1 (PR #139) | **Foundation:** Tailwind and Spartan set up, shell with left nav and routes. The current workspace moves unchanged to `/history`. Material is removed from the shell. Updates the `Cargo.toml` description and the harness decision. | Nav and routes render in zh-TW. `reference-flow.spec.ts` (its `.mat-mdc-*` checks), the desktop smoke/acceptance selectors and the bundle verifier strings are updated in the same PR. |
| 2 (PR #149) | **Recognition features:** split out `RecognitionFeaturesStore`, per-feature gates (removing `ready ⇐ ocrCompute`), the `EngineCard`, 設定 › 辨識功能 with cancel (new Tauri `runtime_cancel_installation`, since the client already has `cancelInstallation`), the first-run card, and re-attaching after a reload (new `runtime_list_installations`). | ASR-only user: never asked for OCR. Install shows its size → progress → cancel → retry. A reload re-attaches. |
| 3 (PR #306, [#157](https://github.com/gx-capture/capture-workbench/issues/157)) | **OCR page:** native-path drop zone, queue table, files kept while waiting (import decoupled from capture), the inline per-file install prompt, auto-start after install, and OCR text exportable without Ollama (raw-based .txt). | Drop a PDF path without OCR → prompt with its size → install → the file starts → page progress → 完成 → export .txt. A waiting file survives a reload. |
| 4 ([#158](https://github.com/gx-capture/capture-workbench/issues/158)) | **ASR page:** install panel, language (wire `spokenLanguage` through Tauri) and speaker options, progress with the live partial transcript, cancel. | Drop audio → install speech → partial transcript → done. Speakers off by default. |
| 5 ([#159](https://github.com/gx-capture/capture-workbench/issues/159)) | **Result review:** `/history/:id` sub-nav, OCR page image beside editable text, transcript table with player, speaker naming. Edits stored as a separate `edits.json` layer (new host command). | Edit a line, then restore it. Click a time and the player seeks. Name a speaker once and every line shows the name. |
| 6 ([#160](https://github.com/gx-capture/capture-workbench/issues/160)) | **History and export:** history table with filters; export .txt/.md (OCR) and .txt/.srt/.vtt/.md (ASR), rendered in the host from raw + edits; relaxed PDF page ranges. | Each format downloads with the expected content (fixture). |
| 7 ([#161](https://github.com/gx-capture/capture-workbench/issues/161)) | **Diagnostics and cleanup:** the 診斷 page, provenance, JSON and the Ollama picker moved there; the old workspace (`history/history-page.*`) and Material deleted. | Diagnostics is reachable from the status dot; the main views carry no provenance. |

Upstream runtime items, shipped separately in capture-workbench as the runtime owner: `downloadBytes` and installation byte counts (PR #141), resumable downloads (PR #151), page and duration progress (PR #148), the uninstall endpoint (PR #145) and the speech split into `cuda` and `cpu` contents (Q3, [#154](https://github.com/gx-capture/capture-workbench/issues/154), PR #325) are merged. Open: native-path import of recordings over 50 MiB (Q6, [#155](https://github.com/gx-capture/capture-workbench/issues/155); plan in [large-recording-import.md](large-recording-import.md)). Each Tauri command added must have a caller in the same PR, or the dead-code gate fails.

Also open: the packaged acceptance must re-approve the new navigation's pixel baselines and run real OCR and ASR ([#163](https://github.com/gx-capture/capture-workbench/issues/163)). Desktop CDP e2e for a real OCR and ASR journey stays local and manual, per AGENTS.md.

## 6. Decisions (approved 2026-11-02; the answer is in bold)

1. **Material → Tailwind + Spartan?** This supersedes a recorded decision. **Yes, migrate shell-first (phase 1), with the helm components copied by the CLI, not shared across repositories.**
2. **What happens to Ollama structuring (「結構化結果」)?** Without it, OCR ends at 「等待確認」 with no exportable result. **Hide it from the product views in v1, finish OCR as 完成 on the raw text, and build export from raw + edits. Keep the picker in 診斷 until a user-facing use exists.**
3. **Split speech into a GPU model and a CPU-only mini unit?** **Yes, upstream. Choose by `cudaAvailable` and offer the smaller mini download on CPU machines, with the size taken from the runtime contract.**
4. **Downloads that resume after the app closes?** **Re-attach plus 再試一次, and `.part` files with HTTP `Range` resume in the runtime (done, PR #151).**
5. **How should PDF pages be shown in review?** The runtime returns boxes but no page images. **Render pages in the renderer with pdf.js from the saved source, which needs no runtime change. Until that lands, show text only for PDFs and the image for image sources.**
6. **Recordings over 50 MiB** (an hour of audio, most video; [#155](https://github.com/gx-capture/capture-workbench/issues/155))? **Must be fixed before ASR is a primary feature. Import by native path, so the renderer still never sees the path, and stream to the runtime.**
