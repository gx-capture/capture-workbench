mod commands;
mod config;
mod constants;
mod contracts;
mod health;
mod launch_policy;
mod launcher;
mod library;
mod manifest;
mod process;
mod resources;
mod runtime_client;
mod state;

use std::fs;

use tauri::Manager;

pub use config::{BackendConfig, DesktopRuntimeStatus};
pub use state::DesktopState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|error| {
                format!("Capture Workbench app data path is unavailable: {error}")
            })?;
            fs::create_dir_all(&data_dir).map_err(|error| {
                format!("Capture Workbench app data cannot be created: {error}")
            })?;

            let library = library::LibraryStore::open(&data_dir)?;
            let state = DesktopState::new(data_dir);
            app.manage(library);
            app.manage(state.clone());
            match resources::resolve_runtime_assets(app) {
                Ok(assets) => state.start(assets),
                Err(error) => state.fail(error),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = window.try_state::<DesktopState>() {
                    state.shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_runtime_status,
            commands::library_create_source,
            commands::library_update_capture,
            commands::library_list,
            commands::library_get,
            commands::library_export,
            commands::library_delete,
            commands::runtime_requirements,
            commands::runtime_start_installation,
            commands::runtime_get_installation,
            commands::runtime_create_capture,
            commands::runtime_get_capture,
            commands::runtime_cancel_capture,
            commands::runtime_get_raw,
            commands::runtime_get_result,
            commands::runtime_delete_capture
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Capture Workbench desktop application");
}
