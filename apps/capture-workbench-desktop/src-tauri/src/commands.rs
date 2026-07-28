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

#[tauri::command]
pub fn library_create_source(
    library: tauri::State<'_, LibraryStore>,
    input: LibrarySourceInput,
) -> Result<LibraryDocumentSummary, String> {
    library.create_source(input)
}

#[tauri::command]
pub fn library_update_capture(
    library: tauri::State<'_, LibraryStore>,
    update: LibraryCaptureUpdate,
) -> Result<LibraryDocumentSummary, String> {
    library.update_capture(update)
}

#[tauri::command]
pub fn library_list(
    library: tauri::State<'_, LibraryStore>,
    request: LibraryListRequest,
) -> Result<Vec<LibraryDocumentSummary>, String> {
    library.list(request)
}

#[tauri::command]
pub fn library_get(
    library: tauri::State<'_, LibraryStore>,
    request: LibraryDocumentRequest,
) -> Result<LibraryDocumentDetail, String> {
    library.get(request)
}

#[tauri::command]
pub fn library_export(
    library: tauri::State<'_, LibraryStore>,
    request: LibraryExportRequest,
) -> Result<LibraryExportPayload, String> {
    library.export(request)
}

#[tauri::command]
pub fn library_delete(
    library: tauri::State<'_, LibraryStore>,
    request: LibraryDocumentRequest,
) -> Result<(), String> {
    library.delete(request)
}

#[tauri::command]
pub fn runtime_requirements(
    state: tauri::State<'_, DesktopState>,
) -> Result<serde_json::Value, String> {
    runtime_client::requirements(&state)
}

#[tauri::command]
pub fn runtime_start_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeInstallationStartInput,
) -> Result<serde_json::Value, String> {
    runtime_client::start_installation(&state, input)
}

#[tauri::command]
pub fn runtime_get_installation(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    runtime_client::installation(&state, input)
}

#[tauri::command]
pub fn runtime_create_capture(
    state: tauri::State<'_, DesktopState>,
    library: tauri::State<'_, LibraryStore>,
    input: RuntimeCreateCaptureInput,
) -> Result<serde_json::Value, String> {
    runtime_client::create_capture(&state, &library, input)
}

#[tauri::command]
pub fn runtime_get_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    runtime_client::capture(&state, input)
}

#[tauri::command]
pub fn runtime_cancel_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    runtime_client::cancel_capture(&state, input)
}

#[tauri::command]
pub fn runtime_get_raw(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    runtime_client::raw_capture(&state, input)
}

#[tauri::command]
pub fn runtime_get_result(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    runtime_client::capture_result(&state, input)
}

#[tauri::command]
pub fn runtime_delete_capture(
    state: tauri::State<'_, DesktopState>,
    input: RuntimeIdInput,
) -> Result<serde_json::Value, String> {
    runtime_client::delete_capture(&state, input)
}
