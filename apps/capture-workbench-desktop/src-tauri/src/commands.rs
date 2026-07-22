use crate::{
    config::{BackendConfig, DesktopRuntimeStatus},
    state::DesktopState,
};

/// Returns an in-memory URL/token pair after the authenticated version handshake succeeds.
#[tauri::command]
pub fn backend_config(state: tauri::State<'_, DesktopState>) -> Result<BackendConfig, String> {
    state.backend_config()
}

/// Returns redacted launcher state for runtime setup and diagnostics UI.
#[tauri::command]
pub fn desktop_runtime_status(state: tauri::State<'_, DesktopState>) -> DesktopRuntimeStatus {
    state.status()
}
