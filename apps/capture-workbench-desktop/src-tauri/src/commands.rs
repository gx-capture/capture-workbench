use std::sync::Arc;

#[cfg(feature = "acceptance-app-data")]
use serde::Serialize;

use tauri::Manager;

use crate::{
    compute::{ComputeSettings, DesktopComputeStatus},
    config::DesktopRuntimeStatus,
    contracts::{
        LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest,
        LibraryDocumentSummary, LibraryExportPayload, LibraryExportRequest, LibraryListRequest,
        RuntimeCreateCaptureInput, RuntimeIdInput, RuntimeInstallationStartInput,
        RuntimeModelInstallationStartInput, RuntimeRequirementInput, RuntimeStreamingCaptureInput,
        RuntimeStreamingEventsInput,
    },
    library::LibraryStore,
    resources::RuntimeAssets,
    runtime_client,
    state::DesktopState,
};

#[cfg(feature = "model-smoke-app-data")]
use crate::contracts::LibraryImportSourceRequest;
#[cfg(feature = "model-smoke-app-data")]
use crate::model_smoke_fixtures::{ModelSmokeFixtureRegistry, ModelSmokeImportFixtureRequest};

/// Whether a CUDA driver is present and speech recognition may use the GPU.
#[tauri::command]
pub(crate) fn desktop_compute_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopComputeStatus {
    DesktopComputeStatus::read(state.data_dir())
}

/// Save whether speech recognition may use the GPU and relaunch the runtime,
/// which reads it at launch. A capture in progress is stopped by the relaunch.
#[tauri::command]
pub(crate) fn desktop_set_prefer_gpu(
    prefer_gpu: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<DesktopComputeStatus, String> {
    let settings = ComputeSettings { prefer_gpu };
    if settings != ComputeSettings::load(state.data_dir()) {
        settings.save(state.data_dir())?;
        let assets = app
            .try_state::<RuntimeAssets>()
            .ok_or_else(|| "Capture runtime assets are unavailable.".to_string())?;
        state.start(assets.inner().clone());
    }
    Ok(DesktopComputeStatus::read(state.data_dir()))
}

/// Returns redacted launcher state for runtime setup and diagnostics UI.
#[tauri::command]
pub(crate) fn desktop_runtime_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopRuntimeStatus {
    state.status()
}

/// Returns the canonical runtime readiness payload after the native launcher
/// has authenticated the sidecar. The renderer receives the redacted payload
/// through this command; the sidecar URL and bearer token stay native-owned.
#[tauri::command]
pub(crate) async fn runtime_ready(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::ready(&state)).await
}

#[cfg(feature = "acceptance-app-data")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopRuntimeProcessProbe {
    pub process_id: Option<u32>,
}

#[cfg(feature = "acceptance-app-data")]
#[tauri::command]
pub(crate) fn desktop_runtime_process_probe(
    state: tauri::State<'_, DesktopState>,
) -> DesktopRuntimeProcessProbe {
    DesktopRuntimeProcessProbe {
        process_id: state.runtime_process_id(),
    }
}

/// Requests the normal Tauri close lifecycle. The window event handler owns
/// the native runtime shutdown, including the OwnedRuntimeSession Job.
#[tauri::command]
pub(crate) fn desktop_acceptance_close_window(window: tauri::Window) -> Result<(), String> {
    window
        .close()
        .map_err(|error| format!("Capture Workbench window close failed: {error}"))
}

/// Injects an app-root hard termination through the current process handle.
/// This command intentionally accepts no PID: the native handle is resolved
/// by the host itself, so the acceptance harness cannot race a reused PID.
#[cfg(feature = "acceptance-app-data")]
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
        let mut extensions = vec!["pdf", "png", "jpg", "jpeg"];
        if matches!(request.kind, crate::contracts::SourceSelectionKind::All) {
            extensions.extend(crate::library::validation::RECORDING_EXTENSIONS);
        }
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
        let mut batch = selections.inspect_batch(window.label(), paths, request.kind)?;
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
) -> Result<LibraryDocumentSummary, String> {
    let owner = window.label().to_owned();
    let selections = Arc::clone(selections.inner());
    let library = Arc::clone(library.inner());
    run_blocking(move || selections.import(&owner, request, &library)).await
}
#[tauri::command]
pub(crate) async fn library_discard_selections(
    window: tauri::Window,
    selections: tauri::State<'_, Arc<crate::source_selection::SourceSelections>>,
    request: crate::contracts::LibraryDiscardSelectionsRequest,
) -> Result<(), String> {
    selections.discard(window.label(), &request.selection_tokens)
}

#[cfg(feature = "model-smoke-app-data")]
#[tauri::command]
pub(crate) async fn model_smoke_import_fixture(
    library: tauri::State<'_, Arc<LibraryStore>>,
    fixtures: tauri::State<'_, ModelSmokeFixtureRegistry>,
    request: ModelSmokeImportFixtureRequest,
) -> Result<LibraryDocumentSummary, String> {
    let library = Arc::clone(library.inner());
    let fixtures = fixtures.inner().clone();
    run_blocking(move || {
        let source = fixtures.resolve(&request.fixture_key)?;
        library.import_source(LibraryImportSourceRequest {
            source_path: source.to_string_lossy().into_owned(),
            ..Default::default()
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn library_update_capture(
    library: tauri::State<'_, Arc<LibraryStore>>,
    update: LibraryCaptureUpdate,
) -> Result<LibraryDocumentSummary, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.update_capture(update)).await
}

#[tauri::command]
pub(crate) async fn library_list(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryListRequest,
) -> Result<Vec<LibraryDocumentSummary>, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.list(request)).await
}

#[tauri::command]
pub(crate) async fn library_get(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<LibraryDocumentDetail, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.get(request)).await
}

#[tauri::command]
pub(crate) async fn library_export(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryExportRequest,
) -> Result<LibraryExportPayload, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.export(request)).await
}

#[tauri::command]
pub(crate) async fn library_source_bytes(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<tauri::ipc::Response, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.source_bytes(request))
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub(crate) async fn library_delete(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<(), String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.delete(request)).await
}

#[tauri::command]
pub(crate) async fn runtime_requirements(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::requirements(&state)).await
}

#[tauri::command]
pub(crate) async fn runtime_start_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeInstallationStartInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::start_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_list_installations(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::list_installations(&state)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_cancel_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::cancel_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_uninstall_requirement(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeRequirementInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::uninstall_requirement(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_model_options(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::model_options(&state)).await
}

#[tauri::command]
pub(crate) async fn runtime_start_model_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeModelInstallationStartInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::start_model_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_model_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::model_installation(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_create_capture(
    state: tauri::State<'_, DesktopState>,
    library: tauri::State<'_, Arc<LibraryStore>>,
    input: RuntimeCreateCaptureInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    let library = Arc::clone(library.inner());
    run_blocking(move || runtime_client::create_capture(&state, library.as_ref(), input)).await
}

#[tauri::command]
pub(crate) async fn runtime_start_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    library: tauri::State<'_, Arc<LibraryStore>>,
    input: RuntimeStreamingCaptureInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    let library = Arc::clone(library.inner());
    run_blocking(move || runtime_client::start_streaming_capture(&state, library.as_ref(), input))
        .await
}

#[tauri::command]
pub(crate) async fn runtime_get_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_streaming_events(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeStreamingEventsInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_events(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_streaming_partial(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_partial(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_streaming_result(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_result(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_structure_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_structure(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_cancel_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::cancel_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_cancel_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::cancel_streaming_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_raw(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::raw_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_ocr(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::capture_ocr(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_get_result(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::capture_result(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_delete_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::delete_capture(&state, input)).await
}

#[tauri::command]
pub(crate) async fn runtime_delete_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::delete_streaming_capture(&state, input)).await
}
