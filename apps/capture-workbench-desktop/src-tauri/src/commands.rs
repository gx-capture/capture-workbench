use std::sync::Arc;

use crate::{
    config::DesktopRuntimeStatus,
    contracts::{
        LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest,
        LibraryDocumentSummary, LibraryExportPayload, LibraryExportRequest, LibraryListRequest,
        LibrarySourceInput, RuntimeCreateCaptureInput, RuntimeIdInput,
        RuntimeInstallationStartInput,
    },
    library::LibraryStore,
    runtime_client,
    state::DesktopState,
};

/// Returns redacted launcher state for runtime setup and diagnostics UI.
#[tauri::command]
pub fn desktop_runtime_status(state: tauri::State<'_, DesktopState>) -> DesktopRuntimeStatus {
    state.status()
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
pub async fn library_create_source(
    library: tauri::State<'_, Arc<LibraryStore>>,
    input: LibrarySourceInput,
) -> Result<LibraryDocumentSummary, String> {
    let library = Arc::clone(library.inner());
    run_blocking(move || library.create_source(input)).await
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
pub async fn runtime_get_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    run_blocking(move || runtime_client::capture(&state, input)).await
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
