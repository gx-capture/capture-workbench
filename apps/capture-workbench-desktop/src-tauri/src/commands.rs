use std::sync::Arc;

#[cfg(feature = "acceptance-app-data")]
use serde::Serialize;

use crate::{
    config::DesktopRuntimeStatus,
    contracts::{
        LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest,
        LibraryDocumentSummary, LibraryExportPayload, LibraryExportRequest,
        LibraryImportSourceRequest, LibraryListRequest, RuntimeCreateCaptureInput, RuntimeIdInput,
        RuntimeInstallationStartInput, RuntimeModelInstallationStartInput,
        RuntimeStreamingCaptureInput, RuntimeStreamingEventsInput,
    },
    library::LibraryStore,
    runtime_client,
    state::DesktopState,
};

#[cfg(feature = "model-smoke-app-data")]
use crate::model_smoke_fixtures::{ModelSmokeFixtureRegistry, ModelSmokeImportFixtureRequest};

/// Returns redacted launcher state for runtime setup and diagnostics UI.
#[tauri::command]
pub fn desktop_runtime_status(state: tauri::State<'_, DesktopState>) -> DesktopRuntimeStatus {
    state.status()
}

#[cfg(feature = "acceptance-app-data")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeProcessProbe {
    pub process_id: Option<u32>,
}

#[cfg(feature = "acceptance-app-data")]
#[tauri::command]
pub fn desktop_runtime_process_probe(
    state: tauri::State<'_, DesktopState>,
) -> DesktopRuntimeProcessProbe {
    DesktopRuntimeProcessProbe {
        process_id: state.runtime_process_id(),
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
pub async fn library_import_source(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryImportSourceRequest,
) -> Result<LibraryDocumentSummary, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.import_source(request)).await
}

#[cfg(feature = "model-smoke-app-data")]
#[tauri::command]
pub async fn model_smoke_import_fixture(
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
        })
    })
    .await
}

#[tauri::command]
pub async fn library_update_capture(
    library: tauri::State<'_, Arc<LibraryStore>>,
    update: LibraryCaptureUpdate,
) -> Result<LibraryDocumentSummary, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.update_capture(update)).await
}

#[tauri::command]
pub async fn library_list(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryListRequest,
) -> Result<Vec<LibraryDocumentSummary>, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.list(request)).await
}

#[tauri::command]
pub async fn library_get(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<LibraryDocumentDetail, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.get(request)).await
}

#[tauri::command]
pub async fn library_export(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryExportRequest,
) -> Result<LibraryExportPayload, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.export(request)).await
}

#[tauri::command]
pub async fn library_delete(
    library: tauri::State<'_, Arc<LibraryStore>>,
    request: LibraryDocumentRequest,
) -> Result<(), String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.delete(request)).await
}

#[tauri::command]
pub async fn runtime_requirements(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::requirements(&state)).await
}

#[tauri::command]
pub async fn runtime_start_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeInstallationStartInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::start_installation(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::installation(&state, input)).await
}

#[tauri::command]
pub async fn runtime_model_options(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::model_options(&state)).await
}

#[tauri::command]
pub async fn runtime_start_model_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeModelInstallationStartInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::start_model_installation(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_model_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::model_installation(&state, input)).await
}

#[tauri::command]
pub async fn runtime_create_capture(
    state: tauri::State<'_, DesktopState>,
    library: tauri::State<'_, Arc<LibraryStore>>,
    input: RuntimeCreateCaptureInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    let library = Arc::clone(library.inner());
    run_blocking(move || runtime_client::create_capture(&state, library.as_ref(), input)).await
}

#[tauri::command]
pub async fn runtime_start_streaming_capture(
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
pub async fn runtime_get_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::capture(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_capture(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_streaming_events(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeStreamingEventsInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_events(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_streaming_partial(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_partial(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_streaming_result(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_result(&state, input)).await
}

#[tauri::command]
pub async fn runtime_structure_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::streaming_structure(&state, input)).await
}

#[tauri::command]
pub async fn runtime_cancel_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::cancel_capture(&state, input)).await
}

#[tauri::command]
pub async fn runtime_cancel_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::cancel_streaming_capture(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_raw(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::raw_capture(&state, input)).await
}

#[tauri::command]
pub async fn runtime_get_result(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::capture_result(&state, input)).await
}

#[tauri::command]
pub async fn runtime_delete_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::delete_capture(&state, input)).await
}

#[tauri::command]
pub async fn runtime_delete_streaming_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::delete_streaming_capture(&state, input)).await
}
