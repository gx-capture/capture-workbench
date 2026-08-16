mod commands;
mod config;
mod constants;
mod contracts;
mod launch_policy;
mod launcher;
mod library;
#[cfg(feature = "model-smoke-app-data")]
mod model_smoke_fixtures;
mod resources;
mod runtime_client;
mod state;

use std::{fs, path::PathBuf, sync::Arc};

#[cfg(feature = "model-smoke-app-data")]
use std::path::Path;

use tauri::Manager;

pub use config::{BackendConfig, DesktopRuntimeStatus};
pub use state::DesktopState;

macro_rules! desktop_invoke_handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            commands::desktop_runtime_status,
            commands::library_import_source,
            commands::library_update_capture,
            commands::library_list,
            commands::library_get,
            commands::library_export,
            commands::library_delete,
            commands::runtime_requirements,
            commands::runtime_start_installation,
            commands::runtime_get_installation,
            commands::runtime_model_options,
            commands::runtime_start_model_installation,
            commands::runtime_get_model_installation,
            commands::runtime_create_capture,
            commands::runtime_start_streaming_capture,
            commands::runtime_get_capture,
            commands::runtime_get_streaming_capture,
            commands::runtime_get_streaming_events,
            commands::runtime_get_streaming_partial,
            commands::runtime_get_streaming_result,
            commands::runtime_structure_streaming_capture,
            commands::runtime_cancel_capture,
            commands::runtime_cancel_streaming_capture,
            commands::runtime_get_raw,
            commands::runtime_get_result,
            commands::runtime_delete_capture,
            commands::runtime_delete_streaming_capture
            $(, $extra)*
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Tauri creates configured windows before running `setup`, which does not
            // allow the installed smoke harness to provide its reserved WebView2 CDP
            // port. Create the configured window here instead so the opt-in QA
            // environment can be passed through Wry's explicit browser-argument API.
            // Production launches do not set this environment variable and retain
            // Wry's normal defaults.
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "Capture Workbench main window is not configured.",
                    )
                })?;
            let mut window_builder =
                tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?;
            if let Ok(arguments) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
                let arguments = arguments.trim();
                if !arguments.is_empty() {
                    window_builder = window_builder.additional_browser_args(arguments);
                }
            }
            window_builder.build()?;

            let data_dir = app_data_dir(app)?;
            #[cfg(feature = "model-smoke-app-data")]
            let model_smoke_fixtures =
                model_smoke_fixtures::ModelSmokeFixtureRegistry::from_environment(
                    &data_dir,
                    &std::env::temp_dir(),
                )?;
            fs::create_dir_all(&data_dir).map_err(|error| {
                format!("Capture Workbench app data cannot be created: {error}")
            })?;

            let library = library::LibraryStore::open(&data_dir)?;
            let state = DesktopState::new(data_dir);
            app.manage(Arc::new(library));
            app.manage(state.clone());
            #[cfg(feature = "model-smoke-app-data")]
            app.manage(model_smoke_fixtures);
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
        });

    #[cfg(feature = "model-smoke-app-data")]
    let builder = builder.invoke_handler(desktop_invoke_handler!(
        commands::model_smoke_import_fixture
    ));
    #[cfg(not(feature = "model-smoke-app-data"))]
    let builder = builder.invoke_handler(desktop_invoke_handler!());

    builder
        .run(tauri::generate_context!())
        .expect("failed to run Capture Workbench desktop application");
}

#[cfg(not(feature = "model-smoke-app-data"))]
fn app_data_dir(app: &tauri::App) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Capture Workbench app data path is unavailable: {error}"))
}

#[cfg(feature = "model-smoke-app-data")]
fn app_data_dir(_app: &tauri::App) -> Result<PathBuf, String> {
    let configured = std::env::var_os("CAPTURE_SMOKE_APP_DATA_ROOT")
        .ok_or_else(|| "Capture Workbench smoke app data root is not configured.".to_string())?;
    validate_model_smoke_app_data_dir(Path::new(&configured), &std::env::temp_dir())
}

#[cfg(feature = "model-smoke-app-data")]
fn validate_model_smoke_app_data_dir(
    configured: &Path,
    temp_root: &Path,
) -> Result<PathBuf, String> {
    if !configured.is_absolute() {
        return Err("Capture Workbench smoke app data root must be absolute.".into());
    }

    let canonical_temp_root = fs::canonicalize(temp_root)
        .map_err(|_| "Capture Workbench smoke TEMP root is unavailable.".to_string())?;
    let canonical_configured = fs::canonicalize(configured)
        .map_err(|_| "Capture Workbench smoke app data root is unavailable.".to_string())?;

    if canonical_configured == canonical_temp_root
        || !canonical_configured.starts_with(&canonical_temp_root)
    {
        return Err(
            "Capture Workbench smoke app data root must be a strict TEMP descendant.".into(),
        );
    }

    Ok(canonical_configured)
}

#[cfg(all(test, feature = "model-smoke-app-data"))]
mod model_smoke_app_data_tests {
    use std::fs;

    use tempfile::tempdir;

    use super::validate_model_smoke_app_data_dir;

    #[test]
    fn requires_existing_strict_temp_descendant() {
        let temp_root = tempdir().expect("temporary root");
        let app_data = temp_root.path().join("appdata");
        fs::create_dir(&app_data).expect("app data root");

        assert!(validate_model_smoke_app_data_dir(&app_data, temp_root.path()).is_ok());
        assert!(validate_model_smoke_app_data_dir(temp_root.path(), temp_root.path()).is_err());
        assert!(validate_model_smoke_app_data_dir(
            &temp_root.path().join("missing"),
            temp_root.path()
        )
        .is_err());
    }

    #[test]
    fn rejects_path_outside_temp_root() {
        let temp_root = tempdir().expect("temporary root");
        let outside_root = tempdir().expect("outside root");

        assert!(validate_model_smoke_app_data_dir(outside_root.path(), temp_root.path()).is_err());
    }
}

#[cfg(test)]
mod shared_sidecar_contract_tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    use capture_sidecar_launcher::{probe_ready_once, ProbeResult, SidecarManifest};

    fn manifest() -> SidecarManifest {
        SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.1".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime-x86_64-pc-windows-msvc.exe".into(),
            bytes: 1,
            sha256: "0".repeat(64),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        }
    }

    #[test]
    fn shared_authenticated_readiness_contract_is_consumer_green() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            sender
                .send(request[..count].to_vec())
                .expect("request bytes");
            let body = r#"{"ready":true,"runtimeVersion":"0.4.1","apiVersion":"2.0","captureDocumentSchemaVersion":"2","capabilities":{}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });

        let result = probe_ready_once(port, "capture-workbench-test-token", &manifest())
            .expect("readiness probe");
        assert!(matches!(result, ProbeResult::Ready(_)));
        let request = String::from_utf8(receiver.recv().expect("request")).expect("utf8");
        assert!(request.contains("Authorization: Bearer capture-workbench-test-token"));
        server.join().expect("server");
    }
}
