mod commands;
mod compute;
mod config;
mod constants;
mod contracts;
mod host_api;
mod launch_policy;
mod launcher;
mod library;
mod random_id;
mod resources;
mod runtime_client;
mod source_selection;
mod state;

use std::{fs, path::PathBuf, sync::Arc};

#[cfg(feature = "acceptance-app-data")]
use std::path::Path;

use tauri::Manager;

pub use config::{BackendConfig, DesktopRuntimeStatus};
pub use state::DesktopState;

macro_rules! for_each_desktop_command {
    ($callback:ident, [$($extra:path),* $(,)?]) => {
        $callback! {
            extra: [$($extra),*],
            served: [
                desktop_runtime_status,
                desktop_compute_status,
                desktop_set_prefer_gpu,
                runtime_ready,
                library_import_selection,
                library_discard_selections,
                library_update_capture,
                library_list,
                library_get,
                library_save_edits,
                library_export,
                library_source_bytes,
                library_delete,
                runtime_requirements,
                runtime_start_installation,
                runtime_list_installations,
                runtime_get_installation,
                runtime_cancel_installation,
                runtime_uninstall_requirement,
                runtime_model_options,
                runtime_start_model_installation,
                runtime_get_model_installation,
                runtime_cancel_upload,
                runtime_create_capture,
                runtime_start_streaming_capture,
                runtime_get_capture,
                runtime_get_streaming_capture,
                runtime_get_streaming_events,
                runtime_get_streaming_partial,
                runtime_get_streaming_result,
                runtime_structure_streaming_capture,
                runtime_cancel_capture,
                runtime_cancel_streaming_capture,
                runtime_get_raw,
                runtime_get_ocr,
                runtime_get_result,
                runtime_delete_capture,
                runtime_delete_streaming_capture,
            ],
            replaced: [
                library_select_sources,
                library_watch_native_sources,
            ],
            not_served: [
                desktop_acceptance_close_window,
            ],
        }
    };
    ($callback:ident) => {
        for_each_desktop_command! { $callback, [] }
    };
}

macro_rules! build_tauri_handler {
    (
        extra: [$($extra:path),*],
        served: [$($served:ident),* $(,)?],
        replaced: [$($replaced:ident),* $(,)?],
        not_served: [$($not_served:ident),* $(,)?],
    ) => {
        tauri::generate_handler![
            $(commands::$served,)*
            $(commands::$replaced,)*
            $(commands::$not_served),*
            $(, $extra)*
        ]
    };
}

macro_rules! desktop_invoke_handler {
    ($($extra:path),* $(,)?) => {
        for_each_desktop_command!(build_tauri_handler, [$($extra),*])
    };
}

/// Feature-gated Tauri commands, one group per feature. Every configuration
/// consumes this list; `commands::` paths are expanded only under the matching
/// `#[cfg]`.
macro_rules! for_each_feature_gated_desktop_command {
    ($callback:ident) => {
        $callback! {
            acceptance_app_data: [
                desktop_runtime_process_probe,
                desktop_acceptance_terminate_root,
            ],
        }
    };
}

#[cfg(feature = "acceptance-app-data")]
macro_rules! expand_acceptance_invoke_handler {
    (
        acceptance_app_data: [$($command:ident),* $(,)?],
    ) => {
        desktop_invoke_handler!($(commands::$command),*)
    };
}

#[cfg(not(feature = "acceptance-app-data"))]
macro_rules! expand_default_invoke_handler {
    (
        acceptance_app_data: [$($_acceptance:ident),* $(,)?],
    ) => {
        desktop_invoke_handler!()
    };
}

#[cfg(feature = "dev-host")]
mod dev_host;
#[cfg(feature = "dev-host")]
pub use dev_host::run_cli;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Register first, before any other plugin or runtime/library setup. Isolated
    // QA features can share the product identifier, so they skip this lock.
    #[cfg(all(windows, not(feature = "acceptance-app-data")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    let builder = builder
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
            fs::create_dir_all(&data_dir).map_err(|error| {
                format!("Capture Workbench app data cannot be created: {error}")
            })?;

            let library = library::LibraryStore::open(&data_dir)?;
            let state = DesktopState::new(data_dir);
            app.manage(Arc::new(library));
            app.manage(Arc::new(source_selection::SourceSelections::default()));
            app.manage(Arc::new(runtime_client::UploadCancellations::default()));
            app.manage(state.clone());
            match resources::resolve_runtime_assets(app) {
                Ok(assets) => {
                    // Kept to relaunch the runtime when a setting it reads changes.
                    app.manage(assets.clone());
                    state.start(assets);
                }
                Err(error) => state.fail(error),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let Some(selections) = window.try_state::<Arc<source_selection::SourceSelections>>()
            {
                match event {
                    tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                        selections.drop_paths(window.label().into(), paths.clone())
                    }
                    tauri::WindowEvent::Destroyed => selections.destroy(window.label()),
                    _ => {}
                }
            }
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = window.try_state::<DesktopState>() {
                    state.shutdown();
                }
            }
        });

    #[cfg(feature = "acceptance-app-data")]
    let builder = builder.invoke_handler(for_each_feature_gated_desktop_command!(
        expand_acceptance_invoke_handler
    ));
    #[cfg(not(feature = "acceptance-app-data"))]
    let builder = builder.invoke_handler(for_each_feature_gated_desktop_command!(
        expand_default_invoke_handler
    ));

    builder
        .run(tauri::generate_context!())
        .expect("failed to run Capture Workbench desktop application");
}

#[cfg(not(feature = "acceptance-app-data"))]
fn app_data_dir(app: &tauri::App) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Capture Workbench app data path is unavailable: {error}"))
}

#[cfg(feature = "acceptance-app-data")]
fn app_data_dir(_app: &tauri::App) -> Result<PathBuf, String> {
    let configured = std::env::var_os("CAPTURE_ACCEPTANCE_APP_DATA_ROOT").ok_or_else(|| {
        "Capture Workbench acceptance app data root is not configured.".to_string()
    })?;
    let artifact_root = std::env::var_os("E2E_ARTIFACT_ROOT").ok_or_else(|| {
        "Capture Workbench acceptance artifact root is not configured.".to_string()
    })?;
    validate_acceptance_app_data_dir(Path::new(&configured), Path::new(&artifact_root))
}

#[cfg(feature = "acceptance-app-data")]
fn validate_acceptance_app_data_dir(
    configured: &Path,
    artifact_root: &Path,
) -> Result<PathBuf, String> {
    if !configured.is_absolute() || !artifact_root.is_absolute() {
        return Err("Capture Workbench acceptance app data paths must be absolute.".into());
    }
    let canonical_artifact_root = fs::canonicalize(artifact_root)
        .map_err(|_| "Capture Workbench acceptance artifact root is unavailable.".to_string())?;
    let canonical_configured = fs::canonicalize(configured)
        .map_err(|_| "Capture Workbench acceptance app data root is unavailable.".to_string())?;
    if canonical_configured == canonical_artifact_root
        || !canonical_configured.starts_with(&canonical_artifact_root)
    {
        return Err(
            "Capture Workbench acceptance app data root must be a strict artifact descendant."
                .into(),
        );
    }
    Ok(canonical_configured)
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
            runtime_version: env!("CARGO_PKG_VERSION").into(),
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
            let body = concat!(
                r#"{"ready":true,"runtimeVersion":""#,
                env!("CARGO_PKG_VERSION"),
                r#"","apiVersion":"2.0","captureDocumentSchemaVersion":"2","capabilities":{}}"#
            );
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
