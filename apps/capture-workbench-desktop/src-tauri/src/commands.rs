use std::sync::Arc;

#[cfg(feature = "acceptance-harness")]
use serde::Serialize;

use tauri::Manager;

use crate::{
    config::DesktopRuntimeStatus,
    contracts::{
        DesktopLibraryDetail, DesktopLibrarySummary, LibraryCaptureUpdate, LibraryDocumentRequest,
        LibraryEdits, LibraryExportPayload, LibraryExportRequest, LibraryListRequest,
        LibrarySaveEditsRequest, RuntimeCancelUploadInput, RuntimeCaptureEventsInput,
        RuntimeCreateCaptureInput, RuntimeIdInput, RuntimeInstallationStartInput,
        RuntimeRecordingCaptureInput, RuntimeRequirementInput,
        StructuringModelInstallationStartInput,
    },
    host_api,
    library::LibraryStore,
    resources::RuntimeExecutablePaths,
    runtime_client::UploadCancellations,
    speech_gpu::DesktopSpeechGpuStatus,
    state::DesktopState,
};

/// Whether a CUDA driver is present and speech recognition may use the GPU.
#[tauri::command]
pub(crate) fn desktop_speech_gpu_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopSpeechGpuStatus {
    host_api::desktop_speech_gpu_status(state.inner())
}

/// Save whether speech recognition may use the GPU and relaunch the runtime,
/// which reads it at launch. A capture in progress is stopped by the relaunch.
#[tauri::command]
pub(crate) fn desktop_set_speech_prefer_gpu(
    prefer_gpu: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<DesktopSpeechGpuStatus, String> {
    let assets = app.try_state::<RuntimeExecutablePaths>();
    host_api::desktop_set_speech_prefer_gpu(
        state.inner(),
        assets.as_ref().map(|state| state.inner()),
        prefer_gpu,
    )
}

/// Returns redacted launcher state for runtime setup and diagnostics UI.
#[tauri::command]
pub(crate) fn desktop_runtime_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopRuntimeStatus {
    host_api::desktop_runtime_status(state.inner())
}

/// Returns the canonical runtime readiness payload after the native launcher
/// has authenticated the sidecar. The renderer receives the redacted payload
/// through this command; the sidecar URL and bearer token stay native-owned.
#[tauri::command]
pub(crate) async fn runtime_ready(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_ready(&state)).await
}

#[cfg(feature = "acceptance-harness")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopRuntimeProcessProbe {
    pub process_id: Option<u32>,
}

#[cfg(feature = "acceptance-harness")]
#[tauri::command]
pub(crate) fn desktop_acceptance_runtime_process_probe(
    state: tauri::State<'_, DesktopState>,
) -> DesktopRuntimeProcessProbe {
    DesktopRuntimeProcessProbe {
        process_id: state.runtime_process_id(),
    }
}

/// Requests the normal Tauri close lifecycle. The window event handler owns
/// the native runtime shutdown, including the OwnedSidecarSession Job.
#[tauri::command]
pub(crate) fn desktop_close_window(window: tauri::Window) -> Result<(), String> {
    window
        .close()
        .map_err(|error| format!("Capture Workbench window close failed: {error}"))
}

/// Injects an app-root hard termination through the current process handle.
/// This command intentionally accepts no PID: the native handle is resolved
/// by the host itself, so the acceptance harness cannot race a reused PID.
#[cfg(feature = "acceptance-harness")]
#[tauri::command]
pub(crate) fn desktop_acceptance_terminate_root() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};

        let process = unsafe { GetCurrentProcess() };
        if unsafe { TerminateProcess(process, 0xE2) } == 0 {
            return Err(format!(
                "Capture Workbench root termination failed with native code {}.",
                unsafe { GetLastError() },
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Capture Workbench root termination injection requires Windows.".into())
    }
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "Capture Workbench background operation failed.".to_string())?
}

fn picker_extensions(kind: crate::contracts::SourceSelectionKind) -> Vec<&'static str> {
    match kind {
        crate::contracts::SourceSelectionKind::Documents => vec!["pdf", "png", "jpg", "jpeg"],
        crate::contracts::SourceSelectionKind::Recordings => {
            crate::library::validation::RECORDING_EXTENSIONS.to_vec()
        }
        crate::contracts::SourceSelectionKind::All => {
            let mut extensions = vec!["pdf", "png", "jpg", "jpeg"];
            extensions.extend(crate::library::validation::RECORDING_EXTENSIONS);
            extensions
        }
    }
}

#[tauri::command]
pub(crate) async fn library_select_sources(
    window: tauri::Window,
    selections: tauri::State<'_, Arc<crate::source_selection::SourceSelections>>,
    request: crate::contracts::LibrarySelectSourcesRequest,
) -> Result<crate::contracts::LibrarySourceSelectionBatch, String> {
    use tauri_plugin_dialog::DialogExt;
    let selections = Arc::clone(selections.inner());
    let guard = selections.begin_dialog(window.label())?;
    run_blocking(move || {
        let _guard = guard;
        let extensions = picker_extensions(request.kind);
        let files = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Capture sources", &extensions)
            .blocking_pick_files()
            .unwrap_or_default();
        let mut paths = Vec::new();
        let mut rejected = Vec::new();
        for file in files {
            match file.into_path() {
                Ok(path) => paths.push(path),
                Err(_) => rejected.push(crate::contracts::SourceRejectionReason::NotLocal),
            }
        }
        let mut batch = host_api::library_inspect_selected_sources(
            &selections,
            window.label(),
            paths,
            request.kind,
        )?;
        batch.rejected.extend(rejected);
        Ok(batch)
    })
    .await
}

#[tauri::command]
pub(crate) async fn library_watch_native_sources(
    window: tauri::Window,
    selections: tauri::State<'_, Arc<crate::source_selection::SourceSelections>>,
    on_event: tauri::ipc::Channel<crate::contracts::LibrarySourceSelectionBatch>,
) -> Result<(), String> {
    selections.watch(window.label(), on_event)
}

#[tauri::command]
pub(crate) async fn library_import_selection(
    window: tauri::Window,
    selections: tauri::State<'_, Arc<crate::source_selection::SourceSelections>>,
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: crate::contracts::LibraryImportSelectionRequest,
) -> Result<DesktopLibrarySummary, String> {
    let owner = window.label().to_owned();
    let selections = Arc::clone(selections.inner());
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_import_selection(&owner, &selections, &library, request))
        .await
}

#[tauri::command]
pub(crate) async fn library_discard_selections(
    window: tauri::Window,
    selections: tauri::State<'_, Arc<crate::source_selection::SourceSelections>>,
    request: crate::contracts::LibraryDiscardSelectionsRequest,
) -> Result<(), String> {
    host_api::library_discard_selections(window.label(), selections.inner(), request)
}

#[tauri::command]
pub(crate) async fn library_update_capture(
    library: tauri::State<'_, Arc<LibraryStore>>,
    update: LibraryCaptureUpdate,
) -> Result<DesktopLibrarySummary, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_update_capture(&library, update)).await
}

#[tauri::command]
pub(crate) async fn library_list(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryListRequest,
) -> Result<Vec<DesktopLibrarySummary>, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_list(&library, request)).await
}

#[tauri::command]
pub(crate) async fn library_get(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<DesktopLibraryDetail, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_get(&library, request)).await
}

#[tauri::command]
pub(crate) async fn library_save_edits(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibrarySaveEditsRequest,
) -> Result<LibraryEdits, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_save_edits(&library, request)).await
}

#[tauri::command]
pub(crate) async fn library_export(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryExportRequest,
) -> Result<LibraryExportPayload, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_export(&library, request)).await
}

#[tauri::command]
pub(crate) async fn library_source_bytes(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<tauri::ipc::Response, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_source_bytes(&library, request))
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub(crate) async fn library_delete(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<(), String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || host_api::library_delete(&library, request)).await
}

#[tauri::command]
pub(crate) async fn runtime_requirements(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_requirements(&state)).await
}

#[tauri::command]
pub(crate) async fn runtime_start_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeInstallationStartInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_start_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_list_installations(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_list_installations(&state)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_cancel_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_cancel_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_uninstall_requirement(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeRequirementInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_uninstall_requirement(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_structuring_model_options(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_structuring_model_options(&state)).await
}

#[tauri::command]
pub(crate) async fn runtime_start_structuring_model_installation(
    state: tauri::State<'_, DesktopState>,
    input: StructuringModelInstallationStartInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_start_structuring_model_installation(&state, input))
        .await
}

#[tauri::command]
pub(crate) async fn runtime_get_structuring_model_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_structuring_model_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_cancel_upload(
    uploads: tauri::State<'_, Arc<UploadCancellations>>,
    input: RuntimeCancelUploadInput,
) -> Result<(), String> {
    host_api::runtime_cancel_upload(uploads.inner().as_ref(), input)
}

#[tauri::command]
pub(crate) async fn runtime_create_capture(
    state: tauri::State<'_, DesktopState>,
    library: tauri::State<'_, Arc<LibraryStore>>,
    uploads: tauri::State<'_, Arc<UploadCancellations>>,
    input: RuntimeCreateCaptureInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    let library = Arc::clone(library.inner());
    let uploads = Arc::clone(uploads.inner());
    run_blocking(move || host_api::runtime_create_capture(&state, &library, &uploads, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_start_recording_capture(
    state: tauri::State<'_, DesktopState>,
    library: tauri::State<'_, Arc<LibraryStore>>,
    uploads: tauri::State<'_, Arc<UploadCancellations>>,
    input: RuntimeRecordingCaptureInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    let library = Arc::clone(library.inner());
    let uploads = Arc::clone(uploads.inner());
    run_blocking(move || {
        host_api::runtime_start_recording_capture(&state, &library, &uploads, input)
    })
    .await
}

#[tauri::command]
pub(crate) async fn runtime_get_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_capture_events(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeCaptureEventsInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_capture_events(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_partial(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_partial(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_structure_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_structure_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_cancel_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_cancel_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_raw(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_raw(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_ocr(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_ocr(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_result(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_get_result(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_delete_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || host_api::runtime_delete_capture(&state, input)).await
}
