use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};

const JOURNAL_SCHEMA: &str = "RuntimeSessionJournalV1";
const JOURNAL_PRODUCER: &str = "capture-runtime";
const HOST: &str = "127.0.0.1";
const JOURNAL_ENV: &str = "CAPTURE_TEST_JOURNAL_PATH";
const MARKER_ENV: &str = "CAPTURE_TEST_MARKER_PATH";
const SESSION_ENV: &str = "CAPTURE_TEST_SESSION_NONCE";
const ORDINAL_ENV: &str = "CAPTURE_TEST_ROOT_ORDINAL";
const TOKEN_ENV: &str = "CAPTURE_API_TOKEN";
const HTTP_MODE_ENV: &str = "CAPTURE_TEST_HTTP_MODE";
const HTTP_CHECKPOINT_ENV: &str = "CAPTURE_TEST_HTTP_CHECKPOINT_PATH";
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const MARKER_RETRY: Duration = Duration::from_millis(10);
const MARKER_TIMEOUT: Duration = Duration::from_secs(2);
const HOLD_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_SUCCESS_HOLD: Duration = Duration::from_secs(2);
const HTTP_IO_TIMEOUT: Duration = Duration::from_millis(250);
const HTTP_RETRY: Duration = Duration::from_millis(5);
const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024;
const MIN_HTTP_TOKEN_BYTES: usize = 32;
#[cfg_attr(not(test), allow(dead_code))]
const RUNTIME_READY_SCHEMA_SHA256: &str =
    "850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335";

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeError {
    Invocation,
    Environment,
    JournalRead,
    JournalRejected,
    MarkerWrite,
    HttpNonblocking,
    HttpServer,
    HttpRequest,
}

impl fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Invocation => "activation probe invocation was invalid",
            Self::Environment => "activation probe environment was invalid",
            Self::JournalRead => "activation probe journal could not be read",
            Self::JournalRejected => "activation probe journal was rejected",
            Self::MarkerWrite => "activation probe marker could not be written",
            Self::HttpNonblocking => "activation probe HTTP listener could not be configured",
            Self::HttpServer => "activation probe HTTP server failed",
            Self::HttpRequest => "activation probe HTTP request was invalid",
        };
        formatter.write_str(message)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct ProbeConfig {
    journal_path: PathBuf,
    journal_path_is_directory: bool,
    marker_path: PathBuf,
    http_checkpoint_path: Option<PathBuf>,
    session_nonce: String,
    root_ordinal: u32,
    port: u16,
    http_mode: Option<HttpMode>,
    token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpMode {
    Ready,
    Status503,
    Partial,
    Silent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchingRecord {
    journal_revision: u64,
}

fn main() {
    let result = run_probe(parse_config(env::args_os().skip(1)), std::process::id());
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(2);
    }
    thread::sleep(HOLD_TIMEOUT);
}

fn run_probe(config: Result<ProbeConfig, ProbeError>, process_id: u32) -> Result<(), ProbeError> {
    let config = config?;
    let record = read_launching_record(&config, process_id)?;
    write_marker(&config, process_id, &record)?;
    if config.http_mode.is_some() {
        serve_http(&config)?;
    }
    Ok(())
}

fn parse_config<I>(arguments: I) -> Result<ProbeConfig, ProbeError>
where
    I: IntoIterator<Item = OsString>,
{
    let arguments: Vec<_> = arguments.into_iter().collect();
    if arguments.len() != 5
        || arguments[0] != "serve"
        || arguments[1] != "--host"
        || arguments[2] != HOST
        || arguments[3] != "--port"
    {
        return Err(ProbeError::Invocation);
    }
    let port_text = arguments[4].to_str().ok_or(ProbeError::Invocation)?;
    let port = port_text
        .parse::<u16>()
        .map_err(|_| ProbeError::Invocation)?;
    if port == 0 || port_text != port.to_string() {
        return Err(ProbeError::Invocation);
    }

    let journal_path = required_path(JOURNAL_ENV)?;
    let marker_path = required_path(MARKER_ENV)?;
    let http_checkpoint_path = env::var_os(HTTP_CHECKPOINT_ENV)
        .map(|_| required_path(HTTP_CHECKPOINT_ENV))
        .transpose()?;
    if journal_path == marker_path || !journal_path.is_absolute() || !marker_path.is_absolute() {
        return Err(ProbeError::Environment);
    }
    if http_checkpoint_path
        .as_ref()
        .is_some_and(|path| path == &journal_path || path == &marker_path || !path.is_absolute())
    {
        return Err(ProbeError::Environment);
    }
    let session_nonce = required_text(SESSION_ENV)?;
    if !valid_opaque(&session_nonce) {
        return Err(ProbeError::Environment);
    }
    let ordinal_text = required_text(ORDINAL_ENV)?;
    let root_ordinal = ordinal_text
        .parse::<u32>()
        .map_err(|_| ProbeError::Environment)?;
    if ordinal_text != root_ordinal.to_string() {
        return Err(ProbeError::Environment);
    }
    let http_mode = match env::var(HTTP_MODE_ENV) {
        Ok(value) => Some(parse_http_mode(&value)?),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => return Err(ProbeError::Environment),
    };
    let token = if http_mode.is_some() {
        let token = required_text(TOKEN_ENV)?;
        if !valid_http_token(&token) {
            return Err(ProbeError::Environment);
        }
        Some(token)
    } else {
        None
    };
    Ok(ProbeConfig {
        journal_path_is_directory: journal_path.is_dir(),
        journal_path,
        marker_path,
        http_checkpoint_path,
        session_nonce,
        root_ordinal,
        port,
        http_mode,
        token,
    })
}

fn parse_http_mode(value: &str) -> Result<HttpMode, ProbeError> {
    match value {
        "ready" => Ok(HttpMode::Ready),
        "status503" => Ok(HttpMode::Status503),
        "partial" => Ok(HttpMode::Partial),
        "silent" => Ok(HttpMode::Silent),
        _ => Err(ProbeError::Environment),
    }
}

fn valid_http_token(value: &str) -> bool {
    value.len() >= MIN_HTTP_TOKEN_BYTES
        && value.len() <= 4096
        && value
            .bytes()
            .all(|byte| byte >= 0x21 && byte <= 0x7e && byte != b'\r' && byte != b'\n')
}

fn required_path(name: &str) -> Result<PathBuf, ProbeError> {
    let value = env::var_os(name).ok_or(ProbeError::Environment)?;
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty()
        || path.as_os_str().to_str().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(ProbeError::Environment);
    }
    Ok(path)
}

fn required_text(name: &str) -> Result<String, ProbeError> {
    let value = env::var_os(name).ok_or(ProbeError::Environment)?;
    let value = value.to_str().ok_or(ProbeError::Environment)?.to_owned();
    if value.is_empty() {
        return Err(ProbeError::Environment);
    }
    Ok(value)
}

fn read_launching_record(
    config: &ProbeConfig,
    process_id: u32,
) -> Result<LaunchingRecord, ProbeError> {
    let journal_path = if config.journal_path_is_directory {
        discover_journal_path(&config.journal_path)?
    } else {
        config.journal_path.clone()
    };
    let bytes = read_bounded(&journal_path)?;
    let journal: Value = serde_json::from_slice(&bytes).map_err(|_| ProbeError::JournalRejected)?;
    validate_journal(&journal, config, process_id)
}

/// The launcher freezes command environment before the final plan digest is
/// available, while the store derives the journal filename from that digest.
/// The test-only probe therefore accepts the producer root as its frozen
/// journal path and resolves exactly one runtime-session JSON record after
/// Launching CAS. It remains an acceptance fixture, not a lifecycle authority.
fn discover_journal_path(directory: &Path) -> Result<PathBuf, ProbeError> {
    let mut candidates = fs::read_dir(directory)
        .map_err(|_| ProbeError::JournalRead)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("runtime-session-") && name.ends_with(".json"))
        });
    let first = candidates.next().ok_or(ProbeError::JournalRead)?;
    if candidates.next().is_some() {
        return Err(ProbeError::JournalRejected);
    }
    Ok(first)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, ProbeError> {
    let file = File::open(path).map_err(|_| ProbeError::JournalRead)?;
    let size = file.metadata().map_err(|_| ProbeError::JournalRead)?.len();
    if size > MAX_JOURNAL_BYTES {
        return Err(ProbeError::JournalRejected);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProbeError::JournalRead)?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(ProbeError::JournalRejected);
    }
    Ok(bytes)
}

fn validate_journal(
    journal: &Value,
    config: &ProbeConfig,
    process_id: u32,
) -> Result<LaunchingRecord, ProbeError> {
    let root = exact_object(
        journal,
        &[
            "schemaVersion",
            "producer",
            "sessionNonce",
            "journalRevision",
            "planDigest",
            "state",
            "createdAt",
            "updatedAt",
            "jobBinding",
            "binding",
            "stagingBinding",
            "roots",
            "proof",
            "recoveryEpoch",
            "attempt",
        ],
    )?;
    if string_field(root, "schemaVersion")? != JOURNAL_SCHEMA
        || string_field(root, "producer")? != JOURNAL_PRODUCER
        || string_field(root, "sessionNonce")? != config.session_nonce
        || string_field(root, "state")? != "launching"
        || !valid_opaque(string_field(root, "sessionNonce")?)
        || !valid_digest(string_field(root, "planDigest")?)
        || string_field(root, "createdAt")?.is_empty()
        || string_field(root, "updatedAt")?.is_empty()
        || !root["proof"].is_null()
        || number_field(root, "journalRevision")? == 0
        || number_field(root, "attempt")? > 3
    {
        return Err(ProbeError::JournalRejected);
    }
    let journal_revision = number_field(root, "journalRevision")?;
    validate_job_binding(root.get("jobBinding"))?;
    validate_binding(root.get("binding"), root.get("roots"))?;
    validate_staging_binding(root.get("stagingBinding"), &config.session_nonce)?;
    let roots = root
        .get("roots")
        .and_then(Value::as_array)
        .ok_or(ProbeError::JournalRejected)?;
    if roots.is_empty() || config.root_ordinal as usize >= roots.len() {
        return Err(ProbeError::JournalRejected);
    }
    let mut seen_nonces = HashSet::with_capacity(roots.len());
    let mut seen_listeners = HashSet::with_capacity(roots.len());
    let mut selected_pid = None;
    let mut selected_port = None;
    for (index, value) in roots.iter().enumerate() {
        let root = exact_object(
            value,
            &[
                "ordinal",
                "role",
                "rootRefDigest",
                "rootGeneration",
                "rootNonce",
                "pid",
                "creationIdentity",
                "state",
                "reservedListenerIdentity",
                "loopbackPort",
                "liveListenerReadiness",
                "startedAt",
            ],
        )?;
        if number_field(root, "ordinal")? != index as u64
            || string_field(root, "role")?.is_empty()
            || !valid_digest(string_field(root, "rootRefDigest")?)
            || number_field(root, "rootGeneration")? == 0
            || !valid_opaque(string_field(root, "rootNonce")?)
            || number_field(root, "pid")? == 0
            || string_field(root, "state")? != "suspended"
            || !root["liveListenerReadiness"].is_null()
            || !valid_opaque(string_field(root, "reservedListenerIdentity")?)
            || number_field(root, "loopbackPort")? == 0
            || string_field(root, "startedAt")?.is_empty()
            || !seen_nonces.insert(string_field(root, "rootNonce")?)
            || !seen_listeners.insert(string_field(root, "reservedListenerIdentity")?)
        {
            return Err(ProbeError::JournalRejected);
        }
        validate_creation_identity(root.get("creationIdentity"))?;
        if index == config.root_ordinal as usize {
            selected_pid = Some(number_field(root, "pid")?);
            selected_port = Some(number_field(root, "loopbackPort")?);
        }
    }
    if selected_pid != Some(u64::from(process_id))
        || (config.http_mode.is_some() && selected_port != Some(u64::from(config.port)))
    {
        return Err(ProbeError::JournalRejected);
    }
    Ok(LaunchingRecord { journal_revision })
}

fn validate_job_binding(value: Option<&Value>) -> Result<(), ProbeError> {
    let binding = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &["setupState", "jobNonce"],
    )?;
    if string_field(binding, "setupState")? != "committed"
        || !valid_opaque(string_field(binding, "jobNonce")?)
    {
        return Err(ProbeError::JournalRejected);
    }
    Ok(())
}

fn validate_binding(value: Option<&Value>, roots: Option<&Value>) -> Result<(), ProbeError> {
    let binding = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &[
            "kind",
            "bindingAttemptId",
            "groupRefDigest",
            "groupGeneration",
            "rootBindings",
            "activationReceiptDigest",
        ],
    )?;
    if string_field(binding, "kind")? != "bound"
        || !valid_opaque(string_field(binding, "bindingAttemptId")?)
        || !valid_digest(string_field(binding, "groupRefDigest")?)
        || number_field(binding, "groupGeneration")? == 0
        || !valid_digest(string_field(binding, "activationReceiptDigest")?)
    {
        return Err(ProbeError::JournalRejected);
    }
    let root_bindings = binding
        .get("rootBindings")
        .and_then(Value::as_array)
        .ok_or(ProbeError::JournalRejected)?;
    let roots = roots
        .and_then(Value::as_array)
        .ok_or(ProbeError::JournalRejected)?;
    if root_bindings.is_empty() || root_bindings.len() != roots.len() {
        return Err(ProbeError::JournalRejected);
    }
    for (index, (binding, root)) in root_bindings.iter().zip(roots).enumerate() {
        let binding = exact_object(
            binding,
            &[
                "ordinal",
                "role",
                "rootRefDigest",
                "rootGeneration",
                "specDigest",
                "reservedListenerIdentity",
            ],
        )?;
        let root = root.as_object().ok_or(ProbeError::JournalRejected)?;
        if number_field(binding, "ordinal")? != index as u64
            || number_field(root, "ordinal")? != index as u64
            || string_field(binding, "role")? != string_field(root, "role")?
            || string_field(binding, "rootRefDigest")? != string_field(root, "rootRefDigest")?
            || number_field(binding, "rootGeneration")? != number_field(root, "rootGeneration")?
            || !valid_digest(string_field(binding, "specDigest")?)
            || string_field(binding, "reservedListenerIdentity")?
                != string_field(root, "reservedListenerIdentity")?
        {
            return Err(ProbeError::JournalRejected);
        }
    }
    Ok(())
}

fn validate_staging_binding(value: Option<&Value>, session_nonce: &str) -> Result<(), ProbeError> {
    let binding = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &["runNonce", "rootDigest", "scope"],
    )?;
    if string_field(binding, "runNonce")? != session_nonce
        || !valid_digest(string_field(binding, "rootDigest")?)
        || string_field(binding, "scope")? != "run"
    {
        return Err(ProbeError::JournalRejected);
    }
    Ok(())
}

fn validate_creation_identity(value: Option<&Value>) -> Result<(), ProbeError> {
    let identity = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &["kind", "value"],
    )?;
    if string_field(identity, "kind")?.is_empty() || string_field(identity, "value")?.is_empty() {
        return Err(ProbeError::JournalRejected);
    }
    Ok(())
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, ProbeError> {
    let object = value.as_object().ok_or(ProbeError::JournalRejected)?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(ProbeError::JournalRejected);
    }
    Ok(object)
}

fn string_field<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str, ProbeError> {
    object
        .get(name)
        .and_then(Value::as_str)
        .ok_or(ProbeError::JournalRejected)
}

fn number_field(object: &Map<String, Value>, name: &str) -> Result<u64, ProbeError> {
    object
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(ProbeError::JournalRejected)
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn serve_http(config: &ProbeConfig) -> Result<(), ProbeError> {
    serve_http_until(config, Instant::now() + HTTP_TIMEOUT)
}

fn serve_http_until(config: &ProbeConfig, overall_deadline: Instant) -> Result<(), ProbeError> {
    let listener = loop {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, config.port)) {
            Ok(listener) => break listener,
            Err(error)
                if error.kind() == io::ErrorKind::AddrInUse
                    && Instant::now() < overall_deadline =>
            {
                thread::sleep(HTTP_RETRY);
            }
            Err(_) => return Err(ProbeError::HttpServer),
        }
    };
    listener
        .set_nonblocking(true)
        .map_err(|_| ProbeError::HttpNonblocking)?;
    let mut idle_deadline = overall_deadline;
    let mut served_authorized_request = false;
    loop {
        let deadline = overall_deadline.min(idle_deadline);
        if Instant::now() >= deadline {
            return if served_authorized_request {
                Ok(())
            } else {
                Err(ProbeError::HttpServer)
            };
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if handle_http_connection(&mut stream, config, deadline)? {
                    served_authorized_request = true;
                    idle_deadline = Instant::now() + HTTP_SUCCESS_HOLD;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(HTTP_RETRY);
            }
            Err(_) => return Err(ProbeError::HttpServer),
        }
    }
}

fn handle_http_connection(
    stream: &mut TcpStream,
    config: &ProbeConfig,
    deadline: Instant,
) -> Result<bool, ProbeError> {
    let request = read_http_request(stream, deadline)?;
    let expected_host = format!("{HOST}:{}", config.port);
    match parse_http_request(
        &request,
        config.token.as_deref().unwrap_or_default(),
        &expected_host,
    ) {
        HttpRequestKind::Authorized => match config.http_mode {
            Some(HttpMode::Ready) => {
                write_http_checkpoint(config)?;
                let body = ready_body();
                write_http_response(stream, 200, "OK", &body, deadline)?;
                Ok(true)
            }
            Some(HttpMode::Status503) => {
                write_http_checkpoint(config)?;
                write_http_response(
                    stream,
                    503,
                    "Service Unavailable",
                    br#"{"ready":false}"#,
                    deadline,
                )?;
                Ok(true)
            }
            Some(HttpMode::Partial) => {
                write_http_checkpoint(config)?;
                let body = ready_body();
                write_http_partial_response(stream, &body, deadline)?;
                Ok(true)
            }
            Some(HttpMode::Silent) => {
                write_http_checkpoint(config)?;
                if let Some(remaining) = remaining_http_budget(deadline) {
                    thread::sleep(remaining);
                }
                Ok(true)
            }
            None => Err(ProbeError::HttpServer),
        },
        HttpRequestKind::Unauthorized => {
            write_http_response_with_headers(
                stream,
                401,
                "Unauthorized",
                "WWW-Authenticate: Bearer\r\n",
                b"unauthorized",
                deadline,
            )?;
            Ok(false)
        }
        HttpRequestKind::Invalid => {
            write_http_response(stream, 400, "Bad Request", b"bad request", deadline)?;
            Ok(false)
        }
    }
}

fn write_http_checkpoint(config: &ProbeConfig) -> Result<(), ProbeError> {
    let Some(path) = config.http_checkpoint_path.as_ref() else {
        return Ok(());
    };
    const CHECKPOINT: &[u8] = b"authorized\n";
    if path.exists() {
        return if fs::read(path).ok().as_deref() == Some(CHECKPOINT) {
            Ok(())
        } else {
            Err(ProbeError::MarkerWrite)
        };
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| ProbeError::MarkerWrite)?;
    file.write_all(CHECKPOINT)
        .map_err(|_| ProbeError::MarkerWrite)?;
    file.flush().map_err(|_| ProbeError::MarkerWrite)?;
    file.sync_all().map_err(|_| ProbeError::MarkerWrite)?;
    drop(file);
    if fs::read(path).ok().as_deref() == Some(CHECKPOINT) {
        Ok(())
    } else {
        Err(ProbeError::MarkerWrite)
    }
}

fn read_http_request(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, ProbeError> {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let remaining = remaining_http_budget(deadline).ok_or(ProbeError::HttpRequest)?;
        stream
            .set_read_timeout(Some(remaining.min(HTTP_IO_TIMEOUT)))
            .map_err(|_| ProbeError::HttpRequest)?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err(ProbeError::HttpRequest),
            Ok(count) => {
                request.extend_from_slice(&chunk[..count]);
                if request.len() > MAX_HTTP_REQUEST_BYTES {
                    return Err(ProbeError::HttpRequest);
                }
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    return Ok(request);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ProbeError::HttpRequest),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpRequestKind {
    Authorized,
    Unauthorized,
    Invalid,
}

fn parse_http_request(request: &[u8], token: &str, expected_host: &str) -> HttpRequestKind {
    let Ok(request) = std::str::from_utf8(request) else {
        return HttpRequestKind::Invalid;
    };
    let Some(separator) = request.find("\r\n\r\n") else {
        return HttpRequestKind::Invalid;
    };
    if !request[separator + 4..].is_empty() {
        return HttpRequestKind::Invalid;
    }
    let mut lines = request[..separator].split("\r\n");
    if lines.next() != Some("GET /v2/health/ready HTTP/1.1") {
        return HttpRequestKind::Invalid;
    }
    let mut host = None;
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return HttpRequestKind::Invalid;
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value
                .bytes()
                .any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
        {
            return HttpRequestKind::Invalid;
        }
        if name.eq_ignore_ascii_case("authorization") {
            if authorization.is_some() {
                return HttpRequestKind::Invalid;
            }
            authorization = Some(value.trim());
        } else if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return HttpRequestKind::Invalid;
            }
            host = Some(value.trim());
        }
    }
    if host != Some(expected_host) {
        return HttpRequestKind::Invalid;
    }
    let Some(authorization) = authorization else {
        return HttpRequestKind::Unauthorized;
    };
    let expected = format!("Bearer {token}");
    if authorization == expected {
        HttpRequestKind::Authorized
    } else {
        HttpRequestKind::Unauthorized
    }
}

fn ready_body() -> Vec<u8> {
    let mut body = br#"{"ready":true,"service":"capture-runtime","apiVersion":"2.0","runtimeVersion":"0.4.2","captureDocumentSchemaVersion":"2","captureDocumentSchemaSha256":""#
        .to_vec();
    body.extend_from_slice(RUNTIME_READY_SCHEMA_SHA256.as_bytes());
    body.extend_from_slice(
        br#"","schemaSha256":null,"contractSetVersion":"2","capabilities":{},"ocrCompute":null,"message":null}"#,
    );
    body
}

fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
    deadline: Instant,
) -> Result<(), ProbeError> {
    write_http_response_with_headers(stream, status, reason, "", body, deadline)
}

fn write_http_response_with_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra_headers: &str,
    body: &[u8],
    deadline: Instant,
) -> Result<(), ProbeError> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n{extra_headers}Content-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    write_http_bytes(stream, response.as_bytes(), deadline)?;
    write_http_bytes(stream, body, deadline)
}

fn write_http_partial_response(
    stream: &mut TcpStream,
    body: &[u8],
    deadline: Instant,
) -> Result<(), ProbeError> {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    write_http_bytes(stream, response.as_bytes(), deadline)?;
    let partial = body.len().saturating_sub(1);
    write_http_bytes(stream, &body[..partial], deadline)
}

fn write_http_bytes(
    stream: &mut TcpStream,
    bytes: &[u8],
    deadline: Instant,
) -> Result<(), ProbeError> {
    let mut written = 0;
    while written < bytes.len() {
        let remaining = remaining_http_budget(deadline).ok_or(ProbeError::HttpServer)?;
        stream
            .set_write_timeout(Some(remaining.min(HTTP_IO_TIMEOUT)))
            .map_err(|_| ProbeError::HttpServer)?;
        match stream.write(&bytes[written..]) {
            Ok(0) => return Err(ProbeError::HttpServer),
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ProbeError::HttpServer),
        }
    }
    loop {
        let remaining = remaining_http_budget(deadline).ok_or(ProbeError::HttpServer)?;
        stream
            .set_write_timeout(Some(remaining.min(HTTP_IO_TIMEOUT)))
            .map_err(|_| ProbeError::HttpServer)?;
        match stream.flush() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ProbeError::HttpServer),
        }
    }
}

fn remaining_http_budget(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
}

fn write_marker(
    config: &ProbeConfig,
    process_id: u32,
    record: &LaunchingRecord,
) -> Result<(), ProbeError> {
    let marker = format!(
        "state=launching\nordinal={}\npid={process_id}\njournalRevision={}\n",
        config.root_ordinal, record.journal_revision
    );
    let deadline = Instant::now() + MARKER_TIMEOUT;
    loop {
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&config.marker_path)
        {
            Ok(mut file) => {
                file.write_all(marker.as_bytes())
                    .and_then(|_| file.flush())
                    .and_then(|_| file.sync_all())
                    .map_err(|_| ProbeError::MarkerWrite)?;
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(ProbeError::MarkerWrite);
            }
            Err(_) if Instant::now() < deadline => thread::sleep(MARKER_RETRY),
            Err(_) => return Err(ProbeError::MarkerWrite),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(directory: &Path, session: &str, ordinal: u32) -> ProbeConfig {
        ProbeConfig {
            journal_path: directory.join("runtime-session.json"),
            journal_path_is_directory: false,
            marker_path: directory.join(format!("marker-{ordinal}.txt")),
            http_checkpoint_path: None,
            session_nonce: session.into(),
            root_ordinal: ordinal,
            port: 49152 + ordinal as u16,
            http_mode: None,
            token: None,
        }
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn tempdir() -> TestDirectory {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = env::temp_dir().join(format!(
            "capture-activation-probe-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("temporary fixture directory");
        TestDirectory { path }
    }

    fn valid_journal(session: &str, pid: u32, root_count: usize) -> Value {
        let roots = (0..root_count)
            .map(|ordinal| {
                json!({
                    "ordinal": ordinal,
                    "role": if ordinal == 0 { "capture" } else { "worker" },
                    "rootRefDigest": format!("{ordinal:064x}"),
                    "rootGeneration": ordinal + 1,
                    "rootNonce": format!("root-{ordinal}"),
                    "pid": if ordinal == 0 { pid } else { pid.saturating_add(1 + ordinal as u32) },
                    "creationIdentity": { "kind": "windows-process-creation", "value": format!("{ordinal:016x}") },
                    "state": "suspended",
                    "reservedListenerIdentity": format!("listener-{ordinal}"),
                    "loopbackPort": 49152 + ordinal,
                    "liveListenerReadiness": null,
                    "startedAt": "2026-09-12T00:00:00Z"
                })
            })
            .collect::<Vec<_>>();
        let root_bindings = roots
            .iter()
            .map(|root| {
                json!({
                    "ordinal": root["ordinal"],
                    "role": root["role"],
                    "rootRefDigest": root["rootRefDigest"],
                    "rootGeneration": root["rootGeneration"],
                    "specDigest": format!("{}", "a".repeat(64)),
                    "reservedListenerIdentity": root["reservedListenerIdentity"]
                })
            })
            .collect::<Vec<_>>();
        json!({
            "schemaVersion": JOURNAL_SCHEMA,
            "producer": JOURNAL_PRODUCER,
            "sessionNonce": session,
            "journalRevision": 3,
            "planDigest": "b".repeat(64),
            "state": "launching",
            "createdAt": "2026-09-12T00:00:00Z",
            "updatedAt": "2026-09-12T00:00:00Z",
            "jobBinding": { "setupState": "committed", "jobNonce": "job-1" },
            "binding": {
                "kind": "bound",
                "bindingAttemptId": "attempt-1",
                "groupRefDigest": "c".repeat(64),
                "groupGeneration": 1,
                "rootBindings": root_bindings,
                "activationReceiptDigest": "d".repeat(64)
            },
            "stagingBinding": { "runNonce": session, "rootDigest": "e".repeat(64), "scope": "run" },
            "roots": roots,
            "proof": null,
            "recoveryEpoch": 0,
            "attempt": 0
        })
    }

    fn write_configured_journal(config: &ProbeConfig, journal: &Value) {
        fs::write(
            &config.journal_path,
            serde_json::to_vec(journal).expect("journal JSON"),
        )
        .expect("journal");
    }

    fn exchange_http(port: u16, request: &str) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if Instant::now() >= deadline {
                panic!("HTTP fixture did not become reachable");
            }
            match TcpStream::connect((HOST, port)) {
                Ok(mut stream) => {
                    stream.write_all(request.as_bytes()).expect("HTTP request");
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .expect("HTTP test read timeout");
                    let mut response = Vec::new();
                    stream.read_to_end(&mut response).expect("HTTP response");
                    return response;
                }
                Err(_) => thread::sleep(HTTP_RETRY),
            }
        }
    }

    fn run_with(config: &ProbeConfig, process_id: u32) -> Result<(), ProbeError> {
        run_probe(Ok(config.clone()), process_id)
    }

    #[test]
    fn launching_with_own_pid_writes_minimal_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        write_configured_journal(
            &config,
            &valid_journal(&config.session_nonce, std::process::id(), 1),
        );
        run_with(&config, std::process::id()).expect("valid Launching record");
        let marker = fs::read_to_string(&config.marker_path).expect("marker");
        assert_eq!(
            marker,
            format!(
                "state=launching\nordinal=0\npid={}\njournalRevision=3\n",
                std::process::id()
            )
        );
    }

    #[test]
    fn producer_root_journal_path_resolves_one_runtime_record() {
        let directory = tempdir();
        let mut config = config(&directory.path, "session-1", 0);
        let journal_path = directory.path.join("runtime-session-one.json");
        config.journal_path = directory.path.clone();
        config.journal_path_is_directory = true;
        write_configured_journal(
            &ProbeConfig {
                journal_path: journal_path,
                ..config.clone()
            },
            &valid_journal(&config.session_nonce, std::process::id(), 1),
        );
        run_with(&config, std::process::id()).expect("valid Launching record");
        assert!(config.marker_path.exists());
    }

    #[test]
    fn ready_state_is_rejected_without_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        let mut journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        journal["state"] = json!("ready");
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn http_mode_rejects_journal_port_mismatch_before_marker_or_listener() {
        let directory = tempdir();
        let mut config = config(&directory.path, "session-1", 0);
        config.http_mode = Some(HttpMode::Ready);
        config.token = Some("fixture-bearer-token-0123456789abcdef".into());
        config.port = 49153;
        write_configured_journal(
            &config,
            &valid_journal(&config.session_nonce, std::process::id(), 1),
        );
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn malformed_and_unknown_journal_are_rejected_without_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        fs::write(&config.journal_path, b"not-json").expect("malformed journal");
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        let mut journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        journal["unexpected"] = json!(true);
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn wrong_session_root_and_pid_are_rejected_without_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        let mut journal = valid_journal("other-session", std::process::id(), 1);
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(
                &ProbeConfig {
                    root_ordinal: 1,
                    ..config.clone()
                },
                std::process::id()
            ),
            Err(ProbeError::JournalRejected)
        );
        journal["roots"][0]["pid"] = json!(std::process::id().saturating_add(1));
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn marker_collision_never_overwrites_existing_bytes() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        write_configured_journal(
            &config,
            &valid_journal(&config.session_nonce, std::process::id(), 1),
        );
        fs::write(&config.marker_path, b"foreign").expect("foreign marker");
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::MarkerWrite)
        );
        assert_eq!(fs::read(&config.marker_path).expect("marker"), b"foreign");
    }

    #[test]
    fn invocation_requires_the_exact_serve_host_port_shape() {
        assert!(matches!(
            parse_config(
                ["serve", "--host", "localhost", "--port", "49152"]
                    .into_iter()
                    .map(OsString::from),
            ),
            Err(ProbeError::Invocation)
        ));
        assert!(matches!(
            parse_config(
                ["serve", "--host", HOST, "--port", "0"]
                    .into_iter()
                    .map(OsString::from),
            ),
            Err(ProbeError::Invocation)
        ));
    }

    #[test]
    fn optional_http_mode_is_closed_and_marker_default_has_no_listener_mode() {
        assert_eq!(parse_http_mode("ready"), Ok(HttpMode::Ready));
        assert_eq!(parse_http_mode("status503"), Ok(HttpMode::Status503));
        assert_eq!(parse_http_mode("partial"), Ok(HttpMode::Partial));
        assert_eq!(parse_http_mode("silent"), Ok(HttpMode::Silent));
        assert_eq!(
            parse_http_mode("anything-else"),
            Err(ProbeError::Environment)
        );
        assert_eq!(
            config(Path::new("C:\\capture"), "session-1", 0).http_mode,
            None
        );
    }

    #[test]
    fn http_request_requires_exact_route_and_single_bearer_header() {
        const TOKEN: &str = "fixture-bearer-token-0123456789abcdef";
        const HOST: &str = "127.0.0.1:49152";
        let valid = format!(
            "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
        );
        assert_eq!(
            parse_http_request(valid.as_bytes(), TOKEN, HOST),
            HttpRequestKind::Authorized
        );
        assert_eq!(
            parse_http_request(
                format!(
                    "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer wrong\r\n\r\n"
                )
                .as_bytes(),
                TOKEN,
                HOST
            ),
            HttpRequestKind::Unauthorized
        );
        assert_eq!(
            parse_http_request(
                format!(
                    "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
                )
                .as_bytes(),
                TOKEN,
                HOST
            ),
            HttpRequestKind::Invalid
        );
        assert_eq!(
            parse_http_request(
                format!(
                    "GET /health HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
                )
                .as_bytes(),
                TOKEN,
                HOST
            ),
            HttpRequestKind::Invalid
        );
        assert_eq!(
            parse_http_request(
                format!("GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}\r\n\r\n").as_bytes(),
                TOKEN,
                HOST
            ),
            HttpRequestKind::Unauthorized
        );
        assert_eq!(
            parse_http_request(
                format!(
                    "GET /v2/health/ready HTTP/1.1\r\nHost: localhost:49152\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
                )
                .as_bytes(),
                TOKEN,
                HOST
            ),
            HttpRequestKind::Invalid
        );
        assert_eq!(
            parse_http_request(
                format!(
                    "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
                )
                .as_bytes(),
                TOKEN,
                HOST
            ),
            HttpRequestKind::Invalid
        );
    }

    #[test]
    fn http_tokens_match_runtime_minimum() {
        assert!(!valid_http_token("short-token"));
        assert!(valid_http_token("fixture-bearer-token-0123456789abcdef"));
    }

    #[test]
    fn ready_body_has_source_pinned_service_identity_and_nullable_compute() {
        let body: Value = serde_json::from_slice(&ready_body()).expect("ready JSON");
        assert_eq!(body["ready"], json!(true));
        assert_eq!(body["service"], json!("capture-runtime"));
        assert_eq!(
            body["captureDocumentSchemaSha256"],
            json!(RUNTIME_READY_SCHEMA_SHA256)
        );
        assert!(body["ocrCompute"].is_null());
    }

    #[test]
    fn opt_in_http_mode_binds_the_canonical_port_and_serves_ready() {
        let directory = tempdir();
        let reservation = TcpListener::bind((HOST, 0)).expect("HTTP test port");
        let port = reservation.local_addr().expect("HTTP test address").port();
        drop(reservation);
        let mut config = config(&directory.path, "session-1", 0);
        config.port = port;
        config.http_mode = Some(HttpMode::Ready);
        config.token = Some("fixture-bearer-token-0123456789abcdef".into());
        let mut journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        journal["roots"][0]["loopbackPort"] = json!(port);
        write_configured_journal(&config, &journal);
        let server_config = config.clone();
        let server = thread::spawn(move || run_with(&server_config, std::process::id()));
        let wrong = exchange_http(
            port,
            &format!(
                "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}:{port}\r\nAuthorization: Bearer wrong-token\r\n\r\n"
            ),
        );
        assert!(wrong.starts_with(b"HTTP/1.1 401 Unauthorized\r\n"));
        assert!(wrong
            .windows(b"WWW-Authenticate: Bearer\r\n".len())
            .any(|window| window == b"WWW-Authenticate: Bearer\r\n"));
        let missing = exchange_http(
            port,
            &format!("GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}:{port}\r\n\r\n"),
        );
        assert!(missing.starts_with(b"HTTP/1.1 401 Unauthorized\r\n"));
        assert!(missing
            .windows(b"WWW-Authenticate: Bearer\r\n".len())
            .any(|window| window == b"WWW-Authenticate: Bearer\r\n"));
        let bad_host = exchange_http(
            port,
            "GET /v2/health/ready HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-bearer-token-0123456789abcdef\r\n\r\n",
        );
        assert!(bad_host.starts_with(b"HTTP/1.1 400 Bad Request\r\n"));
        let response = exchange_http(
            port,
            &format!(
                "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}:{port}\r\nAuthorization: Bearer fixture-bearer-token-0123456789abcdef\r\n\r\n"
            ),
        );
        assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
        assert_eq!(server.join().expect("HTTP fixture thread"), Ok(()));
    }

    #[test]
    fn http_server_authorized_requests_cannot_extend_the_overall_deadline() {
        let directory = tempdir();
        let reservation = TcpListener::bind((HOST, 0)).expect("HTTP test port");
        let port = reservation.local_addr().expect("HTTP test address").port();
        drop(reservation);
        let mut config = config(&directory.path, "session-1", 0);
        config.port = port;
        config.http_mode = Some(HttpMode::Ready);
        config.token = Some("fixture-bearer-token-0123456789abcdef".into());
        let server_config = config.clone();
        let started = Instant::now();
        let overall_deadline = started + Duration::from_millis(350);
        let server = thread::spawn(move || serve_http_until(&server_config, overall_deadline));
        let request = format!(
            "GET /v2/health/ready HTTP/1.1\r\nHost: {HOST}:{port}\r\nAuthorization: Bearer fixture-bearer-token-0123456789abcdef\r\n\r\n"
        );
        let polling_deadline = started + Duration::from_millis(900);
        let mut successful_requests = 0;
        while !server.is_finished() && Instant::now() < polling_deadline {
            if let Ok(mut stream) = TcpStream::connect_timeout(
                &format!("{HOST}:{port}").parse().expect("loopback address"),
                Duration::from_millis(50),
            ) {
                stream
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .expect("HTTP test read timeout");
                if stream.write_all(request.as_bytes()).is_ok() {
                    let mut response = Vec::new();
                    if stream.read_to_end(&mut response).is_ok()
                        && response.starts_with(b"HTTP/1.1 200 OK\r\n")
                    {
                        successful_requests += 1;
                    }
                }
            }
            thread::sleep(HTTP_RETRY);
        }
        assert!(server.is_finished(), "HTTP server exceeded hard deadline");
        assert!(
            successful_requests >= 2,
            "authorized request loop was not exercised"
        );
        assert_eq!(server.join().expect("HTTP fixture thread"), Ok(()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
