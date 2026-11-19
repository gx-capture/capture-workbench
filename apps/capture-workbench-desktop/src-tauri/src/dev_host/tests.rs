use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    io::{ErrorKind, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tempfile::tempdir;

use super::{
    app_data::{validate_app_data_dir, validate_app_data_dir_against, PRODUCT_IDENTIFIER},
    cli::{parse_args, validate_token, CliConfig},
    dispatch::{dispatch, HostContext, HostError, COMMAND_GROUPS, FEATURE_GATED_GROUPS},
    server::{DevHostServer, ServerShutdownHandle, MAX_HEADER_BYTES},
};
use crate::{config::BackendConfig, library::LibraryStore, state::DesktopState};

const DEV_HOST_TEST_TOKEN: &str = "dev-host-test-token-0123456789abcdef";
const RUNTIME_TEST_TOKEN: &str = "runtime-bearer-secret-token-for-test";
static TEST_EXTERNAL_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static TEST_EXTERNAL_SHUTDOWN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct TestServer {
    port: u16,
    shutdown: ServerShutdownHandle,
    thread: Option<JoinHandle<Result<(), String>>>,
}

impl TestServer {
    fn start(state: DesktopState, library: Arc<LibraryStore>) -> Self {
        Self::from_server(
            DevHostServer::bind(
                0,
                DEV_HOST_TEST_TOKEN.into(),
                host_context(state, library),
                None,
            )
            .expect("bind server"),
        )
    }

    fn start_limited(
        state: DesktopState,
        library: Arc<LibraryStore>,
        max_in_flight: usize,
    ) -> Self {
        Self::from_server(
            DevHostServer::bind_for_test(
                0,
                DEV_HOST_TEST_TOKEN.into(),
                host_context(state, library),
                None,
                max_in_flight,
            )
            .expect("bind server"),
        )
    }

    fn start_with_external(
        state: DesktopState,
        library: Arc<LibraryStore>,
        external_shutdown: &'static AtomicBool,
    ) -> Self {
        Self::from_server(
            DevHostServer::bind(
                0,
                DEV_HOST_TEST_TOKEN.into(),
                host_context(state, library),
                Some(external_shutdown),
            )
            .expect("bind server"),
        )
    }

    fn from_server(server: DevHostServer) -> Self {
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

fn host_context(state: DesktopState, library: Arc<LibraryStore>) -> Arc<HostContext> {
    Arc::new(HostContext::new(state, library, None))
}

fn ready_desktop_state() -> DesktopState {
    DesktopState::with_backend_config_for_test(BackendConfig {
        base_url: "http://127.0.0.1:9".into(),
        token: "dev-host-status-stand-in".into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        api_version: "2.0".into(),
        capture_document_schema_version: "2".into(),
    })
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

    let (status, _, _) = invoke_json(server.port(), "desktop_close_window", &json!({}));
    assert_eq!(status, 404);

    let (status, _, _) = invoke_json(
        server.port(),
        "library_list",
        &json!({ "request": { "query": 123 } }),
    );
    assert_eq!(status, 400);

    let (status, _, _) = invoke_json(
        server.port(),
        "desktop_set_speech_prefer_gpu",
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
    let product_dir = root.path().join(PRODUCT_IDENTIFIER);
    let nested_missing = product_dir.join("nested").join("child");
    let sibling = root.path().join(format!("{PRODUCT_IDENTIFIER}-dev"));
    let forbidden = vec![product_dir.clone()];

    assert!(
        validate_app_data_dir_against(PathBuf::from("relative/dir").as_path(), &forbidden).is_err()
    );
    let allowed = root.path().join("allowed");
    fs::create_dir(&allowed).expect("allowed dir");
    assert!(
        validate_app_data_dir_against(&allowed, &[PathBuf::from("relative/forbidden")]).is_err()
    );
    assert!(validate_app_data_dir_against(&product_dir, &forbidden).is_err());
    assert!(validate_app_data_dir_against(&nested_missing, &forbidden).is_err());
    if cfg!(windows) {
        let upper_variant = root
            .path()
            .join(PRODUCT_IDENTIFIER.to_ascii_uppercase())
            .join("sub");
        assert!(validate_app_data_dir_against(&upper_variant, &forbidden).is_err());
        let unresolved = PathBuf::from(r"\\.\pipe\capture-dev-host-missing-root\child");
        assert!(validate_app_data_dir_against(&allowed, &[unresolved]).is_err());
    }
    assert!(validate_app_data_dir_against(&sibling, &forbidden).is_ok());

    for env_name in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(env_name) {
            let base_path = PathBuf::from(base);
            if base_path.is_absolute() {
                let real_product = base_path.join(PRODUCT_IDENTIFIER);
                assert!(validate_app_data_dir(&real_product).is_err());
                assert!(validate_app_data_dir(&real_product.join("sub")).is_err());
            }
        }
    }
}

#[test]
fn app_data_guard_rejects_known_folder_product_directories() {
    let roaming = dirs::data_dir()
        .expect("roaming app data")
        .join(PRODUCT_IDENTIFIER);
    let local = dirs::data_local_dir()
        .expect("local app data")
        .join(PRODUCT_IDENTIFIER);
    assert!(validate_app_data_dir(&roaming).is_err());
    assert!(validate_app_data_dir(&roaming.join("sub")).is_err());
    assert!(validate_app_data_dir(&local).is_err());
    assert!(validate_app_data_dir(&local.join("nested")).is_err());
    let scratch = tempdir().expect("tempdir");
    assert!(validate_app_data_dir(scratch.path()).is_ok());
}

#[test]
fn app_data_guard_compares_directory_identity() {
    let root = tempdir().expect("tempdir");
    let product = root.path().join("ProductDir");
    fs::create_dir(&product).expect("product dir");
    let via_parent = product.join("missing-child").join("..");
    assert!(validate_app_data_dir_against(&via_parent, &[product.clone()]).is_err());
    if cfg!(windows) {
        let different_case = root.path().join("productdir");
        assert!(validate_app_data_dir_against(&different_case, &[product.clone()]).is_err());
    }
    let sibling = root.path().join("ProductDirSibling");
    fs::create_dir(&sibling).expect("sibling dir");
    assert!(validate_app_data_dir_against(&sibling, &[product.clone()]).is_ok());

    let nested = product.join("nested").join("child");
    assert!(validate_app_data_dir_against(&nested, &[product]).is_err());

    let missing = root.path().join("not-installed");
    assert!(validate_app_data_dir_against(&missing, &[missing.clone()]).is_err());
    assert!(validate_app_data_dir_against(&missing.join("child"), &[missing.clone()]).is_err());
    let elsewhere = root.path().join("installed-elsewhere");
    assert!(validate_app_data_dir_against(&elsewhere, &[missing]).is_ok());
}

#[cfg(windows)]
#[test]
fn app_data_guard_rejects_loopback_share_spelling() {
    let root = tempdir().expect("tempdir");
    let product = root.path().join("share-product");
    fs::create_dir(&product).expect("product dir");
    let Some(share) = localhost_admin_share(&product) else {
        eprintln!("skipping loopback share identity check: path has no drive letter");
        return;
    };
    if let Err(error) = fs::metadata(&share) {
        eprintln!("skipping loopback share identity check: {share:?} could not be opened: {error}");
        return;
    }
    assert!(
        validate_app_data_dir_against(&share, &[product.clone()]).is_err(),
        "loopback share spelling must be the same directory as the drive-letter path"
    );
    assert!(
        validate_app_data_dir_against(&product, &[share]).is_err(),
        "drive-letter path must be refused when the forbidden root is the loopback share"
    );
}

#[cfg(windows)]
fn localhost_admin_share(path: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};
    let canonical = fs::canonicalize(path).ok()?;
    let mut components = canonical.components();
    let Component::Prefix(prefix) = components.next()? else {
        return None;
    };
    let drive = match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
        _ => return None,
    };
    let mut share = PathBuf::from(format!(r"\\localhost\{}$", char::from(drive)));
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => share.push(part),
            _ => return None,
        }
    }
    Some(share)
}

#[test]
fn product_identifier_matches_tauri_conf() {
    let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let text = fs::read_to_string(&config_path).expect("read tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(&text).expect("parse tauri.conf.json");
    assert_eq!(
        config["identifier"].as_str().expect("identifier"),
        PRODUCT_IDENTIFIER
    );
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
    assert_eq!(COMMAND_GROUPS.not_served, &["desktop_close_window"]);
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

    for command in COMMAND_GROUPS.not_served {
        assert_eq!(
            dispatch(command, json!({}), &context).unwrap_err(),
            HostError::UnknownCommand,
            "not-served command {command} must return UnknownCommand"
        );
    }

    let mut feature_names = HashSet::new();
    for group in FEATURE_GATED_GROUPS {
        for command in *group {
            assert!(
                feature_names.insert(*command),
                "feature-gated command {command} appears in two groups"
            );
            assert!(
                !COMMAND_GROUPS.served.contains(command)
                    && !COMMAND_GROUPS.replaced.contains(command)
                    && !COMMAND_GROUPS.not_served.contains(command),
                "feature-gated command {command} is also in the desktop command list"
            );
            assert_eq!(
                dispatch(command, json!({}), &context).unwrap_err(),
                HostError::UnknownCommand,
                "feature-gated command {command} must return UnknownCommand"
            );
        }
    }
}

#[test]
fn shutdown_endpoint_stops_runtime_and_server() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    // A real owned session cannot be installed from the HTTP stand-in: start()
    // verifies a sidecar manifest. The ready status is the existing test double,
    // so "stopped" is the result of shutdown rather than the idle state.
    let state = ready_desktop_state();
    assert_eq!(state.status().status, "ready");
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

fn exchange(port: u16, raw: &[u8]) -> (u16, Vec<u8>) {
    exchange_in_parts(port, &[raw])
}

/// Sends each part as its own write, with a pause between them, so the
/// server's reads do not line up with its 4096-byte chunks.
fn exchange_in_parts(port: u16, parts: &[&[u8]]) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect dev host");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout");
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .expect("write timeout");
    stream.set_nodelay(true).expect("no delay");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            thread::sleep(Duration::from_millis(150));
        }
        let _ = stream.write_all(part);
        let _ = stream.flush();
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("response header separator");
    let headers = std::str::from_utf8(&response[..header_end]).expect("utf8 headers");
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code");
    (status, response[header_end + 4..].to_vec())
}

#[test]
fn header_budget_keeps_a_body_that_arrives_with_the_headers() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);
    let host = format!("127.0.0.1:{}", server.port());
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");
    let body = br#"{"request":{}}"#;
    let mut head = format!(
        "POST /invoke/library_list HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nContent-Length: {}\r\nX-Pad: ",
        body.len()
    );
    let ending = "\r\n\r\n";
    let target = MAX_HEADER_BYTES - 8;
    let pad_len = target
        .checked_sub(head.len() + ending.len())
        .expect("header prefix fits under the budget");
    head.push_str(&"p".repeat(pad_len));
    head.push_str(ending);
    assert_eq!(head.len(), target);
    let mut raw = head.into_bytes();
    raw.extend_from_slice(body);
    // A first write of 100 bytes shifts every later read by 100, so the read
    // that completes the headers reaches past the 64 KiB budget and carries
    // the body. A server that drops the bytes over the budget loses part of
    // the body and never answers.
    let (first, rest) = raw.split_at(100);
    let (status, response_body) = exchange_in_parts(server.port(), &[first, rest]);
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&response_body).expect("json"),
        json!([])
    );

    let mut oversized =
        format!("GET /__dev/health HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\n");
    let pad_line = format!("X-Overflow: {}\r\n", "z".repeat(1024));
    while oversized.len() <= MAX_HEADER_BYTES {
        oversized.push_str(&pad_line);
    }
    oversized.push_str("\r\n");
    let (status, response_body) = exchange(server.port(), oversized.as_bytes());
    assert_eq!(status, 400);
    assert!(String::from_utf8_lossy(&response_body).contains("Request headers are too large."));
}

#[test]
fn duplicate_framing_headers_and_localhost_host_are_rejected() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);
    let host = format!("127.0.0.1:{}", server.port());
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");

    let duplicate_length = format!(
        "POST /invoke/library_list HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nContent-Length: 15\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{{\"request\":{{}}}}"
    );
    let (status, body) = exchange(server.port(), duplicate_length.as_bytes());
    assert_eq!(status, 400);
    assert!(String::from_utf8_lossy(&body).contains("Duplicate Content-Length header."));

    let transfer_encoding = format!(
        "POST /invoke/library_list HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"
    );
    let (status, body) = exchange(server.port(), transfer_encoding.as_bytes());
    assert_eq!(status, 400);
    assert!(String::from_utf8_lossy(&body).contains("Transfer-Encoding is not supported."));

    let duplicate_authorization = format!(
        "GET /__dev/health HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nAuthorization: {auth}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let (status, body) = exchange(server.port(), duplicate_authorization.as_bytes());
    assert_eq!(status, 400);
    assert!(String::from_utf8_lossy(&body).contains("Duplicate Authorization header."));

    let localhost_host = format!(
        "GET /__dev/health HTTP/1.1\r\nHost: localhost:{}\r\nAuthorization: {auth}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        server.port()
    );
    let (status, body) = exchange(server.port(), localhost_host.as_bytes());
    assert_eq!(status, 403);
    assert!(String::from_utf8_lossy(&body).contains("Forbidden."));
}

#[test]
fn in_flight_cap_closes_the_extra_socket_until_a_slot_frees() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start_limited(state, library, 2);
    let mut held = Vec::new();
    for _ in 0..2 {
        held.push(TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).expect("idle connect"));
    }
    let mut rejected = false;
    for _ in 0..40 {
        let mut probe =
            TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).expect("probe connect");
        probe
            .set_read_timeout(Some(Duration::from_millis(200)))
            .expect("probe timeout");
        let mut buf = [0_u8; 1];
        match probe.read(&mut buf) {
            Ok(0) => {
                rejected = true;
                break;
            }
            Err(error)
                if error.kind() == ErrorKind::TimedOut || error.kind() == ErrorKind::WouldBlock =>
            {
                held.push(probe);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::ConnectionReset
                        | ErrorKind::ConnectionAborted
                        | ErrorKind::UnexpectedEof
                        | ErrorKind::BrokenPipe
                ) =>
            {
                rejected = true;
                break;
            }
            Ok(_) => panic!("capped connection received a response"),
            Err(error) => panic!("unexpected probe error: {error}"),
        }
    }
    assert!(rejected, "server did not close the connection past the cap");
    drop(held);

    let mut served = false;
    for _ in 0..50 {
        let host = format!("127.0.0.1:{}", server.port());
        let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");
        let raw = format!(
            "GET /__dev/health HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let mut stream = match TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())) {
            Ok(stream) => stream,
            Err(_) => {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .expect("health timeout");
        if stream.write_all(raw.as_bytes()).is_err() {
            thread::sleep(Duration::from_millis(20));
            continue;
        }
        let mut response = Vec::new();
        if stream.read_to_end(&mut response).is_err() {
            thread::sleep(Duration::from_millis(20));
            continue;
        }
        if response.windows(4).any(|window| window == b"\r\n\r\n")
            && response.starts_with(b"HTTP/1.1 200 ")
        {
            served = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        served,
        "a normal request was not served after idle connections closed"
    );
}

#[test]
fn shutdown_stops_the_runtime_and_exits_while_a_connection_stays_open() {
    TEST_EXTERNAL_SHUTDOWN_IN_FLIGHT.store(false, Ordering::SeqCst);
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = ready_desktop_state();
    assert_eq!(state.status().status, "ready");
    let server =
        TestServer::start_with_external(state.clone(), library, &TEST_EXTERNAL_SHUTDOWN_IN_FLIGHT);
    let mut slow = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).expect("slow connect");
    let partial = format!(
        "POST /invoke/library_list HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {DEV_HOST_TEST_TOKEN}\r\n",
        server.port()
    );
    slow.write_all(partial.as_bytes())
        .expect("write partial headers");
    slow.flush().expect("flush partial headers");
    thread::sleep(Duration::from_millis(150));

    // Only the flag is set: the server itself has to stop the runtime, and it
    // has to do so while the slow connection is still being served.
    let requested = Instant::now();
    TEST_EXTERNAL_SHUTDOWN_IN_FLIGHT.store(true, Ordering::SeqCst);
    while state.status().status != "stopped" {
        assert!(
            requested.elapsed() < Duration::from_secs(1),
            "the runtime was not stopped while a request was in flight"
        );
        thread::sleep(Duration::from_millis(10));
    }

    // The client never finishes its request and never closes. The server
    // closes the connection after its grace period and exits.
    server
        .finish()
        .expect("server exits although a connection stays open");
    assert!(
        requested.elapsed() < Duration::from_secs(10),
        "the open connection held the server for {:?}",
        requested.elapsed()
    );
    drop(slow);
    TEST_EXTERNAL_SHUTDOWN_IN_FLIGHT.store(false, Ordering::SeqCst);
}

#[test]
fn external_shutdown_flag_stops_the_server_without_a_wakeup_connection() {
    TEST_EXTERNAL_SHUTDOWN.store(false, Ordering::SeqCst);
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = ready_desktop_state();
    assert_eq!(state.status().status, "ready");
    let server = TestServer::start_with_external(state.clone(), library, &TEST_EXTERNAL_SHUTDOWN);
    TEST_EXTERNAL_SHUTDOWN.store(true, Ordering::SeqCst);
    server
        .finish()
        .expect("server stops when the external flag is set");
    assert_eq!(state.status().status, "stopped");
    TEST_EXTERNAL_SHUTDOWN.store(false, Ordering::SeqCst);
}

#[test]
fn worker_panic_stops_the_server_with_an_error() {
    let dir = tempdir().expect("tempdir");
    let library = Arc::new(LibraryStore::open(dir.path()).expect("library"));
    let state = DesktopState::new(dir.path().to_path_buf());
    let server = TestServer::start(state, library);
    let host = format!("127.0.0.1:{}", server.port());
    let auth = format!("Bearer {DEV_HOST_TEST_TOKEN}");
    let raw = format!(
        "POST /__dev/panic HTTP/1.1\r\nHost: {host}\r\nAuthorization: {auth}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    let _ = stream.write_all(raw.as_bytes());
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    assert!(!String::from_utf8_lossy(&response).contains("dev host test panic"));
    let error = server.finish().expect_err("panic stops the server");
    assert!(error.contains("panicked"), "{error}");
    assert!(!error.contains("dev host test panic"), "{error}");
}
