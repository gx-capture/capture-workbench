use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::PathBuf,
    sync::Arc,
    thread::{self, JoinHandle},
};

use serde_json::{json, Value};
use tempfile::tempdir;

use super::{
    app_data::{validate_app_data_dir, validate_app_data_dir_against},
    cli::{parse_args, validate_token, CliConfig},
    dispatch::{dispatch, HostContext, HostError, COMMAND_GROUPS},
    server::{DevHostServer, ServerShutdownHandle},
};
use crate::{config::BackendConfig, library::LibraryStore, state::DesktopState};

const DEV_HOST_TEST_TOKEN: &str = "dev-host-test-token-0123456789abcdef";
const RUNTIME_TEST_TOKEN: &str = "runtime-bearer-secret-token-for-test";

struct TestServer {
    port: u16,
    shutdown: ServerShutdownHandle,
    thread: Option<JoinHandle<Result<(), String>>>,
}

impl TestServer {
    fn start(state: DesktopState, library: Arc<LibraryStore>) -> Self {
        let context = Arc::new(HostContext::new(state, library, None));
        let server =
            DevHostServer::bind(0, DEV_HOST_TEST_TOKEN.into(), context, None).expect("bind server");
        let port = server.port();
        let shutdown = server.shutdown_handle();
        let thread = thread::spawn(move || server.run());
        Self {
            port,
            shutdown,
            thread: Some(thread),
        }
    }

    fn port(&self) -> u16 {
        self.port
    }

    fn finish(mut self) -> Result<(), String> {
        self.thread
            .take()
            .expect("server thread")
            .join()
            .expect("join server")
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.shutdown.shutdown();
            let _ = thread.join();
        }
    }
}

fn send_raw_http(port: u16, raw: &[u8]) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect dev host");
    stream.write_all(raw).expect("write request");
    stream.flush().expect("flush request");

    let mut response = Vec::new();
    stream.read_to_end(&mut response).expect("read response");

    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("response header separator");
    let headers = std::str::from_utf8(&response[..header_end])
        .expect("utf8 headers")
        .to_owned();
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code");
    let body = response[header_end + 4..].to_vec();
    (status, headers, body)
}

fn send_request(
    port: u16,
    method: &str,
    path: &str,
    host: Option<&str>,
    auth: Option<&str>,
    body: &[u8],
) -> (u16, String, Vec<u8>) {
    let mut raw = format!("{method} {path} HTTP/1.1\r\n");
    if let Some(host) = host {
        raw.push_str(&format!("Host: {host}\r\n"));
    }
    if let Some(auth) = auth {
        raw.push_str(&format!("Authorization: {auth}\r\n"));
    }
    raw.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    let mut bytes = raw.into_bytes();
    bytes.extend_from_slice(body);
    send_raw_http(port, &bytes)
}

fn invoke_json(port: u16, command: &str, args: &Value) -> (u16, String, Value) {
    let host = format!("127.0.0.1:{port}");
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");
    let payload = serde_json::to_vec(args).expect("serialize args");
    let (status, headers, body) = send_request(
        port,
        "POST",
        &format!("/invoke/{command}"),
        Some(&host),
        Some(&auth),
        &payload,
    );
    let value = serde_json::from_slice(&body).expect("json response");
    (status, headers, value)
}

#[test]
fn auth_and_host_checks_enforce_401_403_and_omit_token_and_cors() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);
    let valid_host = format!("127.0.0.1:{}", server.port());
    let valid_auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");

    let (status, headers, body) = send_request(
        server.port(),
        "GET",
        "/__dev/health",
        Some(&valid_host),
        None,
        b"",
    );
    assert_eq!(status, 401);
    assert!(!String::from_utf8_lossy(&body).contains(DEV_HOST_TEST_TOKEN));
    assert!(!headers.contains(DEV_HOST_TEST_TOKEN));

    let (status, headers, body) = send_request(
        server.port(),
        "GET",
        "/__dev/health",
        Some(&valid_host),
        Some("Bearer wrong-token-0123456789abcdef012345"),
        b"",
    );
    assert_eq!(status, 401);
    assert!(!String::from_utf8_lossy(&body).contains(DEV_HOST_TEST_TOKEN));
    assert!(!headers.contains(DEV_HOST_TEST_TOKEN));

    for bad_host in [
        None,
        Some("localhost:1234"),
        Some("evil.example"),
        Some("127.0.0.1:1"),
    ] {
        let (status, headers, body) = send_request(
            server.port(),
            "GET",
            "/__dev/health",
            bad_host,
            Some(&valid_auth),
            b"",
        );
        assert_eq!(status, 403);
        assert!(!String::from_utf8_lossy(&body).contains(DEV_HOST_TEST_TOKEN));
        assert!(!headers.contains(DEV_HOST_TEST_TOKEN));
    }

    let (status, headers, body) = send_request(
        server.port(),
        "GET",
        "/__dev/health",
        Some(&valid_host),
        Some(&valid_auth),
        b"",
    );
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("health json"),
        json!({ "ok": true })
    );
    assert!(!headers
        .to_ascii_lowercase()
        .contains("access-control-allow-"));
}

#[test]
fn malformed_requests_unknown_commands_bad_args_and_oversized_bodies() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);
    let host = format!("127.0.0.1:{}", server.port());
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");

    let (status, _, _) = invoke_json(server.port(), "unknown_command", &json!({}));
    assert_eq!(status, 404);

    let (status, _, _) = invoke_json(server.port(), "desktop_acceptance_close_window", &json!({}));
    assert_eq!(status, 404);

    let (status, _, _) = invoke_json(
        server.port(),
        "library_list",
        &json!({ "request": { "query": 123 } }),
    );
    assert_eq!(status, 400);

    let (status, _, _) = invoke_json(
        server.port(),
        "desktop_set_prefer_gpu",
        &json!({ "preferGpu": "yes" }),
    );
    assert_eq!(status, 400);

    let (status, _, _) = send_request(
        server.port(),
        "POST",
        "/invoke/library_list",
        Some(&host),
        Some(&auth),
        b"{not valid json",
    );
    assert_eq!(status, 400);

    let oversized_head = format!(
        "POST /invoke/library_list HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        1024 * 1024 + 1
    );
    let (status, _, _) = send_raw_http(server.port(), oversized_head.as_bytes());
    assert_eq!(status, 413);

    let (status, _, _) = send_raw_http(server.port(), b"NOT_VALID_HTTP\r\n\r\n");
    assert_eq!(status, 400);

    let (status, _, _) = send_raw_http(server.port(), b"\xff\xfe\r\n\r\n");
    assert_eq!(status, 400);

    let (status, _, _) = send_request(
        server.port(),
        "GET",
        "/__dev/health",
        Some(&host),
        Some(&auth),
        b"",
    );
    assert_eq!(status, 200);
}

#[test]
fn library_selection_import_list_bytes_and_delete_round_trip() {
    let dir = tempdir().expect("tempdir");
    let source_dir = tempdir().expect("source dir");
    let pdf_path = source_dir.path().join("sample.pdf");
    let png_path = source_dir.path().join("sample.png");
    let pdf_bytes = b"%PDF-1.7\ndev host pdf bytes";
    let png_bytes = b"\x89PNG\r\n\x1a\ndev host png bytes";
    fs::write(&pdf_path, pdf_bytes).expect("write pdf");
    fs::write(&png_path, png_bytes).expect("write png");

    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);
    let host = format!("127.0.0.1:{}", server.port());
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");

    let (status, _, list_value) =
        invoke_json(server.port(), "library_list", &json!({ "request": {} }));
    assert_eq!(status, 200);
    assert_eq!(list_value, json!([]));

    let (status, _, empty_batch) = invoke_json(
        server.port(),
        "library_select_sources",
        &json!({ "request": { "kind": "documents" } }),
    );
    assert_eq!(status, 200);
    assert_eq!(empty_batch, json!({ "selections": [], "rejected": [] }));

    let queue_body = serde_json::to_vec(&json!({
        "paths": [pdf_path, png_path],
    }))
    .expect("queue payload");
    let (status, _, _) = send_request(
        server.port(),
        "POST",
        "/__dev/selection",
        Some(&host),
        Some(&auth),
        &queue_body,
    );
    assert_eq!(status, 200);

    let (status, _, batch) = invoke_json(
        server.port(),
        "library_select_sources",
        &json!({ "request": { "kind": "documents" } }),
    );
    assert_eq!(status, 200);
    let selections = batch["selections"].as_array().expect("selections array");
    assert_eq!(selections.len(), 2);
    assert_eq!(batch["rejected"], json!([]));

    let pdf_token = selections[0]["selectionToken"]
        .as_str()
        .expect("pdf token")
        .to_owned();
    let png_token = selections[1]["selectionToken"]
        .as_str()
        .expect("png token")
        .to_owned();

    let (status, _, _) = invoke_json(
        server.port(),
        "library_discard_selections",
        &json!({ "request": { "selectionTokens": [png_token] } }),
    );
    assert_eq!(status, 200);

    let (status, _, imported) = invoke_json(
        server.port(),
        "library_import_selection",
        &json!({
            "request": {
                "selectionToken": pdf_token,
                "captureOptions": null,
            }
        }),
    );
    assert_eq!(status, 200);
    let document_id = imported["documentId"]
        .as_str()
        .expect("documentId")
        .to_owned();

    let (status, _, listed) = invoke_json(server.port(), "library_list", &json!({ "request": {} }));
    assert_eq!(status, 200);
    let items = listed.as_array().expect("list array");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["documentId"], document_id);

    let bytes_args = serde_json::to_vec(&json!({
        "request": { "documentId": document_id }
    }))
    .expect("bytes args");
    let (status, headers, raw_bytes) = send_request(
        server.port(),
        "POST",
        "/invoke/library_source_bytes",
        Some(&host),
        Some(&auth),
        &bytes_args,
    );
    assert_eq!(status, 200);
    assert!(headers
        .to_ascii_lowercase()
        .contains("content-type: application/octet-stream"));
    assert_eq!(raw_bytes, pdf_bytes);

    let (status, _, deleted) = invoke_json(
        server.port(),
        "library_delete",
        &json!({ "request": { "documentId": document_id } }),
    );
    assert_eq!(status, 200);
    assert_eq!(deleted, Value::Null);

    let (status, _, listed_after) =
        invoke_json(server.port(), "library_list", &json!({ "request": {} }));
    assert_eq!(status, 200);
    assert_eq!(listed_after, json!([]));
}

#[test]
fn command_error_arrives_as_400_with_error_string() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);

    let (status, _, payload) = invoke_json(
        server.port(),
        "library_get",
        &json!({ "request": { "documentId": "invalid" } }),
    );
    assert_eq!(status, 400);
    assert_eq!(
        payload,
        json!({ "error": "Capture library document identifier is invalid." })
    );
}

#[test]
fn runtime_command_reaches_fake_runtime_with_runtime_bearer_token() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));

    let runtime_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("runtime listener");
    let runtime_port = runtime_listener
        .local_addr()
        .expect("runtime address")
        .port();
    let (tx, rx) = std::sync::mpsc::channel();
    let fake_runtime = thread::spawn(move || {
        let (mut stream, _) = runtime_listener.accept().expect("accept runtime request");
        let mut request = [0_u8; 4096];
        let count = stream.read(&mut request).expect("read runtime request");
        tx.send(String::from_utf8_lossy(&request[..count]).into_owned())
            .expect("send captured request");
        let body = format!(r#"{{"requirements":[],"note":"{RUNTIME_TEST_TOKEN}"}}"#);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("write runtime response");
    });

    let state = DesktopState::with_backend_config_for_test(BackendConfig {
        base_url: format!("http://127.0.0.1:{runtime_port}"),
        token: RUNTIME_TEST_TOKEN.into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        api_version: "2.0".into(),
        capture_document_schema_version: "2".into(),
    });
    let server = TestServer::start(state, library);

    let (status, _, payload) = invoke_json(server.port(), "runtime_requirements", &json!({}));
    assert_eq!(status, 200);
    assert_eq!(payload["requirements"], json!([]));
    assert_eq!(payload["note"], "[REDACTED]");
    let serialized = serde_json::to_string(&payload).expect("serialize");
    assert!(!serialized.contains(RUNTIME_TEST_TOKEN));
    assert!(!serialized.contains(DEV_HOST_TEST_TOKEN));

    let captured_request = rx.recv().expect("captured runtime request");
    assert!(captured_request.starts_with("GET /v2/runtime/requirements HTTP/1.1"));
    assert!(captured_request.contains(&format!("Authorization: Bearer {RUNTIME_TEST_TOKEN}")));
    assert!(!captured_request.contains(DEV_HOST_TEST_TOKEN));
    fake_runtime.join().expect("join fake runtime");
}

#[test]
fn app_data_guard_rejects_relative_and_product_directories() {
    let root = tempdir().expect("tempdir");
    let product_dir = root.path().join("io.github.gx-capture.capture-workbench");
    let nested_missing = product_dir.join("nested").join("child");
    let sibling = root
        .path()
        .join("io.github.gx-capture.capture-workbench-dev");
    let forbidden = vec![product_dir.clone()];

    assert!(
        validate_app_data_dir_against(PathBuf::from("relative/dir").as_path(), &forbidden).is_err()
    );
    assert!(validate_app_data_dir_against(&product_dir, &forbidden).is_err());
    assert!(validate_app_data_dir_against(&nested_missing, &forbidden).is_err());
    if cfg!(windows) {
        let upper_variant = root
            .path()
            .join("IO.GITHUB.GX-CAPTURE.CAPTURE-WORKBENCH")
            .join("sub");
        assert!(validate_app_data_dir_against(&upper_variant, &forbidden).is_err());
    }
    assert!(validate_app_data_dir_against(&sibling, &forbidden).is_ok());

    for env_name in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(env_name) {
            let base_path = PathBuf::from(base);
            if base_path.is_absolute() {
                let real_product = base_path.join("io.github.gx-capture.capture-workbench");
                assert!(validate_app_data_dir(&real_product).is_err());
                assert!(validate_app_data_dir(&real_product.join("sub")).is_err());
            }
        }
    }
}

#[test]
fn command_list_cannot_drift() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let context = HostContext::new(state, library, None);

    // Commands replaced by dev-host transport semantics (never native dialogs or drag/drop channels).
    assert_eq!(
        COMMAND_GROUPS.replaced,
        &["library_select_sources", "library_watch_native_sources"]
    );
    // Commands registered with Tauri that the dev host intentionally does not serve.
    assert_eq!(
        COMMAND_GROUPS.not_served,
        &["desktop_acceptance_close_window"]
    );
    // Default Tauri command count matches the decision record (38 shared + 2 replaced + 1 not served = 41).
    assert_eq!(
        COMMAND_GROUPS.served.len()
            + COMMAND_GROUPS.replaced.len()
            + COMMAND_GROUPS.not_served.len(),
        41
    );

    let mut seen = HashSet::new();
    for command in COMMAND_GROUPS
        .served
        .iter()
        .chain(COMMAND_GROUPS.replaced.iter())
        .chain(COMMAND_GROUPS.not_served.iter())
    {
        assert!(
            seen.insert(*command),
            "duplicate command in list: {command}"
        );
    }

    for command in COMMAND_GROUPS
        .served
        .iter()
        .chain(COMMAND_GROUPS.replaced.iter())
    {
        assert!(
            !matches!(
                dispatch(command, json!({}), &context),
                Err(HostError::UnknownCommand)
            ),
            "command {command} must be served by dev-host dispatch"
        );
    }

    // Feature-gated QA commands registered with Tauri under acceptance-app-data / model-smoke-app-data.
    const FEATURE_GATED_NOT_SERVED: &[&str] = &[
        "desktop_runtime_process_probe",
        "desktop_acceptance_terminate_root",
        "model_smoke_import_fixture",
    ];
    for command in COMMAND_GROUPS
        .not_served
        .iter()
        .chain(FEATURE_GATED_NOT_SERVED.iter())
    {
        assert_eq!(
            dispatch(command, json!({}), &context).unwrap_err(),
            HostError::UnknownCommand,
            "not-served command {command} must return UnknownCommand"
        );
    }
}

#[test]
fn shutdown_endpoint_stops_runtime_and_server() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state.clone(), library);
    let host = format!("127.0.0.1:{}", server.port());
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");

    let (status, _, payload) = send_request(
        server.port(),
        "POST",
        "/__dev/shutdown",
        Some(&host),
        Some(&auth),
        b"",
    );
    assert_eq!(status, 200);
    assert_eq!(payload, br#"{"ok":true}"#);
    server.finish().expect("clean server exit");
    assert_eq!(state.status().status, "stopped");
}

#[test]
fn watch_native_sources_is_accepted_and_cli_parses_required_args() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);

    let (status, _, payload) = invoke_json(
        server.port(),
        "library_watch_native_sources",
        &json!({ "onEvent": "channel-placeholder" }),
    );
    assert_eq!(status, 200);
    assert_eq!(payload, Value::Null);

    let parsed = parse_args([
        OsString::from("--port"),
        OsString::from("0"),
        OsString::from("--app-data"),
        OsString::from("C:\\temp\\dev-host"),
        OsString::from("--runtime-manifest"),
        OsString::from("C:\\temp\\manifest.json"),
        OsString::from("--runtime-executable"),
        OsString::from("C:\\temp\\runtime.exe"),
    ])
    .expect("valid cli args");
    assert_eq!(
        parsed,
        CliConfig {
            port: 0,
            app_data: PathBuf::from("C:\\temp\\dev-host"),
            runtime_manifest: PathBuf::from("C:\\temp\\manifest.json"),
            runtime_executable: PathBuf::from("C:\\temp\\runtime.exe"),
        }
    );
    assert!(parse_args([OsString::from("--port"), OsString::from("0")]).is_err());
    assert!(validate_token("too-short").is_err());
    assert!(validate_token(DEV_HOST_TEST_TOKEN).is_ok());
}
