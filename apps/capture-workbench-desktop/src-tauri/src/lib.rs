mod commands;
mod config;
mod constants;
mod health;
mod launcher;
mod manifest;
mod process;
mod resources;
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

            let state = DesktopState::new(data_dir);
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
            commands::backend_config,
            commands::desktop_runtime_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Capture Workbench desktop verification harness");
}
