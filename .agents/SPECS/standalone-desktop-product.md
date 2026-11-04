# Capture Workbench Standalone Desktop Product

## Purpose

Promote the Windows Tauri host from a verification harness to the public
Capture Workbench application. The app owns its local library while the
authenticated Capture Runtime remains responsible for ephemeral extraction and
runtime-owned isolated Ollama structuring.

## Product boundary

- Windows 11 x64 only.
- The desktop host uses `CAPTURE_STRUCTURING_PROVIDER=ollama` with a
  runtime-owned, user-selected allowlisted model profile; the release does not
  force or bundle a fixed Qwen model, and external Ollama is not a product
  setting.
- `@gx-capture/capture-workbench-ui`, `/v2`, and `CaptureDocument` are the
  public contracts.
- The app owns saved source copies, raw diagnostics, structured results, and
  user-facing export. The runtime job is deleted after terminal data is copied.

## Desktop library contract

The host stores a versioned `library-index-v1.json` below its AppData directory
and per-document files beneath `library/items/<opaque-id>/`. Renderer IPC
accepts opaque IDs and bounded initial source bytes only. A native runtime
proxy reloads saved sources itself for processing and retry, so the renderer
never receives a local source path or the sidecar bearer token.

## Runtime requirement simplification

The WindowsML OCR bundle remains a checksum-pinned, user-consented core
requirement, but its versioned descriptor is owned by capture-runtime source.
Release builds, Tauri manifests, native launch commands, and renderer IPC do
not carry `CAPTURE_WINDOWSML_BUNDLE_*` environment variables or duplicate the
descriptor. This lets the real product development lane build from a clean
environment while retaining an explicit manual-repair state if the download or
post-install probe fails.

The OCR engine is neither bundled nor required to start the app. If its
download or post-install probe fails, the setup flow reports an actionable
installation error rather than fake readiness or deterministic OCR.

## Acceptance criteria

- `pnpm run dev` follows the real release-runtime product lane. Deterministic
  development and smoke paths are explicitly named.
- A user can prepare requirements, upload, see OCR/Ollama processing, inspect
  a result, export it, reopen it from history, retry it, and delete it.
- The product UI is Traditional Chinese, keyboard accessible, and reports
  actionable setup/runtime errors.
- The desktop shell uses Tailwind tokens and Spartan helm components
  (`.agents/DECISIONS/tailwind-spartan-ui.md`): a fixed left navigation with
  文件轉文字 (`/ocr`, the home page), 錄音轉逐字稿 (`/asr`), 紀錄 (`/history`)
  and 設定 (`/settings`), and the runtime status at its foot. The document
  workspace on 紀錄 keeps its Material controls until the plan in
  `.agents/PLANS/workbench-ocr-asr-ux.md` replaces it.
- Product builds contain only verified release runtime assets; deterministic
  assets remain test-only.
- `pnpm run dev` and the opt-in real Ollama smoke require no WindowsML bundle
  environment variables.
