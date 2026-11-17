use std::{
    io::{self, Read, Write},
    net::{Ipv4Addr, Shutdown, TcpListener, TcpStream},
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::dispatch::{
    dispatch, is_feature_gated_command, is_served_command, HostContext, HostError, HostResponse,
};

pub(super) const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_IN_FLIGHT_CONNECTIONS: usize = 64;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(30);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const CLOSE_DRAIN_READ_TIMEOUT: Duration = Duration::from_millis(250);
const CLOSE_DRAIN_DEADLINE: Duration = Duration::from_secs(1);
const READ_POLL_INTERVAL: Duration = Duration::from_millis(100);

struct ServerState {
    port: u16,
    expected_host: String,
    token: String,
    context: Arc<HostContext>,
    shutdown_requested: AtomicBool,
    external_shutdown: Option<&'static AtomicBool>,
    in_flight: AtomicUsize,
    max_in_flight: usize,
    worker_panicked: AtomicBool,
}

struct InFlightGuard<'a> {
    counter: &'a AtomicUsize,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ServerState {
    fn is_shutting_down(&self) -> bool {
        self.shutdown_requested.load(Ordering::Acquire)
            || self
                .external_shutdown
                .is_some_and(|flag| flag.load(Ordering::Acquire))
    }
}

pub(crate) struct DevHostServer {
    listener: TcpListener,
    state: Arc<ServerState>,
}

#[cfg(test)]
pub(crate) struct ServerShutdownHandle {
    state: Arc<ServerState>,
}

#[cfg(test)]
impl ServerShutdownHandle {
    pub(crate) fn shutdown(&self) {
        self.state.context.state.shutdown();
        self.state.shutdown_requested.store(true, Ordering::Release);
    }
}

impl DevHostServer {
    pub(crate) fn bind(
        port: u16,
        token: String,
        context: Arc<HostContext>,
        external_shutdown: Option<&'static AtomicBool>,
    ) -> Result<Self, String> {
        Self::bind_inner(
            port,
            token,
            context,
            external_shutdown,
            MAX_IN_FLIGHT_CONNECTIONS,
        )
    }

    #[cfg(test)]
    pub(crate) fn bind_for_test(
        port: u16,
        token: String,
        context: Arc<HostContext>,
        external_shutdown: Option<&'static AtomicBool>,
        max_in_flight: usize,
    ) -> Result<Self, String> {
        Self::bind_inner(port, token, context, external_shutdown, max_in_flight)
    }

    fn bind_inner(
        port: u16,
        token: String,
        context: Arc<HostContext>,
        external_shutdown: Option<&'static AtomicBool>,
        max_in_flight: usize,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .map_err(|error| format!("Dev host HTTP server failed to bind loopback: {error}"))?;
        let bound_port = listener
            .local_addr()
            .map_err(|error| format!("Dev host bound address is unavailable: {error}"))?
            .port();
        let state = Arc::new(ServerState {
            port: bound_port,
            expected_host: format!("127.0.0.1:{bound_port}"),
            token,
            context,
            shutdown_requested: AtomicBool::new(false),
            external_shutdown,
            in_flight: AtomicUsize::new(0),
            max_in_flight,
            worker_panicked: AtomicBool::new(false),
        });
        Ok(Self { listener, state })
    }

    pub(crate) fn port(&self) -> u16 {
        self.state.port
    }

    #[cfg(test)]
    pub(crate) fn shutdown_handle(&self) -> ServerShutdownHandle {
        ServerShutdownHandle {
            state: Arc::clone(&self.state),
        }
    }

    pub(crate) fn run(self) -> Result<(), String> {
        self.listener.set_nonblocking(true).map_err(|error| {
            format!("Dev host HTTP listener could not be set non-blocking: {error}")
        })?;
        let mut workers: Vec<JoinHandle<()>> = Vec::new();
        loop {
            if self.state.is_shutting_down() {
                break;
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if self.state.is_shutting_down() {
                        drop(stream);
                        break;
                    }
                    if stream.set_nonblocking(false).is_err() {
                        drop(stream);
                        continue;
                    }
                    if self.state.in_flight.load(Ordering::Acquire) >= self.state.max_in_flight {
                        drop(stream);
                        continue;
                    }
                    self.state.in_flight.fetch_add(1, Ordering::AcqRel);
                    workers.retain(|handle| !handle.is_finished());
                    let state = Arc::clone(&self.state);
                    workers.push(thread::spawn(move || {
                        let _in_flight = InFlightGuard {
                            counter: &state.in_flight,
                        };
                        let caught = std::panic::catch_unwind(AssertUnwindSafe(|| {
                            handle_connection(stream, &state);
                        }));
                        if caught.is_err() {
                            state.worker_panicked.store(true, Ordering::Release);
                            state.shutdown_requested.store(true, Ordering::Release);
                        }
                    }));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(ACCEPT_POLL_INTERVAL);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    self.state.context.state.shutdown();
                    return Err(format!("Dev host HTTP accept failed: {error}"));
                }
            }
        }
        self.state.context.state.shutdown();
        // A worker that is waiting for request bytes sees the shutdown within
        // one read poll (`read_request_bytes`), so an idle or trickling client
        // cannot hold the join.
        for worker in workers {
            let _ = worker.join();
        }
        if self.state.worker_panicked.load(Ordering::Acquire) {
            return Err("Dev host request handler panicked.".into());
        }
        Ok(())
    }
}

struct ParsedRequestHead<'a> {
    method: &'a str,
    target: &'a str,
    host: Option<&'a str>,
    authorization: Option<&'a str>,
    content_length: Option<usize>,
}

struct HttpRejection {
    status: u16,
    message: String,
}

impl HttpRejection {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueSelectionRequest {
    paths: Vec<PathBuf>,
}

fn handle_connection(mut stream: TcpStream, state: &ServerState) {
    if stream.set_read_timeout(Some(READ_POLL_INTERVAL)).is_err()
        || stream.set_write_timeout(Some(SOCKET_TIMEOUT)).is_err()
    {
        return;
    }
    serve_connection(&mut stream, state);
    close_after_response(&mut stream);
}

/// A rejected request can leave unread bytes in the socket, and closing a
/// socket with unread input makes Windows reset the connection, so the client
/// can lose the response it was just sent. Stop sending, then discard what the
/// client still sends, for a bounded time.
fn close_after_response(stream: &mut TcpStream) {
    if stream.shutdown(Shutdown::Write).is_err()
        || stream
            .set_read_timeout(Some(CLOSE_DRAIN_READ_TIMEOUT))
            .is_err()
    {
        return;
    }
    let deadline = Instant::now() + CLOSE_DRAIN_DEADLINE;
    let mut discard = [0_u8; 4096];
    while Instant::now() < deadline {
        match stream.read(&mut discard) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

fn serve_connection(stream: &mut TcpStream, state: &ServerState) {
    let (head_buffer, header_end) = match read_request_head(stream, state) {
        Ok(Some(head)) => head,
        Ok(None) => return,
        Err(rejection) => {
            let _ = send_json_error(stream, rejection.status, &rejection.message);
            return;
        }
    };

    let head_str = match std::str::from_utf8(&head_buffer[..header_end]) {
        Ok(text) => text,
        Err(_) => {
            let _ = send_json_error(stream, 400, "Malformed HTTP request.");
            return;
        }
    };

    let parsed = match parse_request_head(head_str) {
        Ok(parsed) => parsed,
        Err(rejection) => {
            let _ = send_json_error(stream, rejection.status, &rejection.message);
            return;
        }
    };

    if parsed.host != Some(state.expected_host.as_str()) {
        let _ = send_json_error(stream, 403, "Forbidden.");
        return;
    }

    let provided_token = parsed
        .authorization
        .and_then(|value| value.strip_prefix("Bearer "));
    if !provided_token.is_some_and(|token| constant_time_token_eq(&state.token, token)) {
        let _ = send_json_error(stream, 401, "Unauthorized.");
        return;
    }

    let content_length = parsed.content_length.unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        let _ = send_json_error(stream, 413, "Request body exceeds 1 MiB limit.");
        return;
    }

    let already_read = &head_buffer[header_end + 4..];
    let body = match read_exact_body(stream, state, already_read, content_length) {
        Ok(body) => body,
        Err(rejection) => {
            let _ = send_json_error(stream, rejection.status, &rejection.message);
            return;
        }
    };

    route_request(stream, state, parsed.method, parsed.target, &body);
}

fn route_request(
    stream: &mut TcpStream,
    state: &ServerState,
    method: &str,
    target: &str,
    body: &[u8],
) {
    match (method, target) {
        ("GET", "/__dev/health") => {
            let _ = send_json_value(stream, 200, &json!({ "ok": true }));
        }
        ("POST", "/__dev/selection") => {
            let request: QueueSelectionRequest = match serde_json::from_slice(body) {
                Ok(request) => request,
                Err(error) => {
                    let _ = send_json_error(
                        stream,
                        400,
                        &format!("Invalid selection payload: {error}"),
                    );
                    return;
                }
            };
            let count = request.paths.len();
            match state.context.push_selection(request.paths) {
                Ok(()) => {
                    let _ = send_json_value(stream, 200, &json!({ "queued": count }));
                }
                Err(error) => {
                    let _ = send_json_error(stream, 500, &error);
                }
            }
        }
        ("POST", "/__dev/shutdown") => {
            state.context.state.shutdown();
            state.shutdown_requested.store(true, Ordering::Release);
            let _ = send_json_value(stream, 200, &json!({ "ok": true }));
        }
        #[cfg(test)]
        ("POST", "/__dev/panic") => {
            panic!("dev host test panic");
        }
        ("POST", path) if path.starts_with("/invoke/") => {
            let command = &path["/invoke/".len()..];
            if command.is_empty()
                || command.contains('/')
                || is_feature_gated_command(command)
                || !is_served_command(command)
            {
                let _ = send_json_error(stream, 404, "Unknown command.");
                return;
            }
            let args: serde_json::Value = match serde_json::from_slice(body) {
                Ok(args) => args,
                Err(error) => {
                    let _ =
                        send_json_error(stream, 400, &format!("Invalid JSON arguments: {error}"));
                    return;
                }
            };
            match dispatch(command, args, &state.context) {
                Ok(HostResponse::Json(value)) => {
                    let _ = send_json_value(stream, 200, &value);
                }
                Ok(HostResponse::Bytes(bytes)) => {
                    let _ = send_response(stream, 200, "application/octet-stream", &bytes);
                }
                Err(HostError::UnknownCommand) => {
                    let _ = send_json_error(stream, 404, "Unknown command.");
                }
                Err(HostError::InvalidArgs(message) | HostError::CommandFailed(message)) => {
                    let _ = send_json_error(stream, 400, &message);
                }
            }
        }
        _ => {
            let _ = send_json_error(stream, 404, "Not found.");
        }
    }
}

/// Reads request bytes. The socket's read timeout is one short poll; this keeps
/// waiting until bytes arrive, the deadline passes or the host is shutting
/// down, so a client that sends nothing, or a byte now and then, can hold a
/// connection neither past the deadline nor past shutdown.
fn read_request_bytes(
    stream: &mut TcpStream,
    state: &ServerState,
    deadline: Instant,
    buffer: &mut [u8],
) -> io::Result<usize> {
    loop {
        if state.is_shutting_down() {
            return Err(io::ErrorKind::ConnectionAborted.into());
        }
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        match stream.read(buffer) {
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            other => return other,
        }
    }
}

fn read_request_head(
    stream: &mut TcpStream,
    state: &ServerState,
) -> Result<Option<(Vec<u8>, usize)>, HttpRejection> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let deadline = Instant::now() + SOCKET_TIMEOUT;
    loop {
        if let Some(end) = find_header_end(&buffer) {
            if end + 4 > MAX_HEADER_BYTES {
                return Err(HttpRejection::bad_request("Request headers are too large."));
            }
            return Ok(Some((buffer, end)));
        }
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(HttpRejection::bad_request("Request headers are too large."));
        }
        let read_count = match read_request_bytes(stream, state, deadline, &mut chunk) {
            Ok(count) => count,
            Err(_) if buffer.is_empty() => return Ok(None),
            Err(_) => return Err(HttpRejection::bad_request("Malformed HTTP request.")),
        };
        if read_count == 0 {
            if buffer.is_empty() {
                return Ok(None);
            }
            return Err(HttpRejection::bad_request("Incomplete HTTP request."));
        }
        buffer.extend_from_slice(&chunk[..read_count]);
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_request_head(head: &str) -> Result<ParsedRequestHead<'_>, HttpRejection> {
    let mut lines = head.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| HttpRejection::bad_request("Missing HTTP request line."))?;

    let mut parts = request_line.split(' ');
    let method = parts
        .next()
        .ok_or_else(|| HttpRejection::bad_request("Malformed HTTP request line."))?;
    let target = parts
        .next()
        .ok_or_else(|| HttpRejection::bad_request("Malformed HTTP request line."))?;
    let version = parts
        .next()
        .ok_or_else(|| HttpRejection::bad_request("Malformed HTTP request line."))?;
    if parts.next().is_some() {
        return Err(HttpRejection::bad_request("Malformed HTTP request line."));
    }
    if !is_http_token(method)
        || !target.starts_with('/')
        || target.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
        || version != "HTTP/1.1"
    {
        return Err(HttpRejection::bad_request("Malformed HTTP request line."));
    }

    let mut host = None;
    let mut authorization = None;
    let mut content_length = None;

    for line in lines {
        let Some((name, raw_value)) = line.split_once(':') else {
            return Err(HttpRejection::bad_request("Malformed HTTP header."));
        };
        if !is_http_token(name) {
            return Err(HttpRejection::bad_request("Malformed HTTP header name."));
        }
        let value = raw_value.trim_matches(|ch| ch == ' ' || ch == '\t');
        if value
            .bytes()
            .any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
        {
            return Err(HttpRejection::bad_request("Malformed HTTP header value."));
        }
        match name.to_ascii_lowercase().as_str() {
            "host" => {
                if host.is_some() {
                    return Err(HttpRejection::bad_request("Duplicate Host header."));
                }
                host = Some(value);
            }
            "authorization" => {
                if authorization.is_some() {
                    return Err(HttpRejection::bad_request(
                        "Duplicate Authorization header.",
                    ));
                }
                authorization = Some(value);
            }
            "content-length" => {
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(HttpRejection::bad_request("Invalid Content-Length header."));
                }
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| HttpRejection::bad_request("Invalid Content-Length header."))?;
                if content_length.is_some() {
                    return Err(HttpRejection::bad_request(
                        "Duplicate Content-Length header.",
                    ));
                }
                content_length = Some(parsed);
            }
            "transfer-encoding" => {
                return Err(HttpRejection::bad_request(
                    "Transfer-Encoding is not supported.",
                ));
            }
            _ => {}
        }
    }

    Ok(ParsedRequestHead {
        method,
        target,
        host,
        authorization,
        content_length,
    })
}

fn read_exact_body(
    stream: &mut TcpStream,
    state: &ServerState,
    already_read: &[u8],
    content_length: usize,
) -> Result<Vec<u8>, HttpRejection> {
    if content_length == 0 {
        return Ok(Vec::new());
    }
    if already_read.len() >= content_length {
        return Ok(already_read[..content_length].to_vec());
    }
    let mut body = vec![0_u8; content_length];
    let mut filled = already_read.len();
    body[..filled].copy_from_slice(already_read);
    let deadline = Instant::now() + SOCKET_TIMEOUT;
    while filled < content_length {
        match read_request_bytes(stream, state, deadline, &mut body[filled..]) {
            Ok(count) if count > 0 => filled += count,
            _ => return Err(HttpRejection::bad_request("Incomplete HTTP request body.")),
        }
    }
    Ok(body)
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(is_http_token_byte)
}

fn is_http_token_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
            | b'0'..=b'9'
            | b'A'..=b'Z'
            | b'a'..=b'z'
    )
}

fn constant_time_token_eq(expected: &str, provided: &str) -> bool {
    let expected_digest: [u8; 32] = Sha256::digest(expected.as_bytes()).into();
    let provided_digest: [u8; 32] = Sha256::digest(provided.as_bytes()).into();
    let mut diff = 0_u8;
    for (left, right) in expected_digest.iter().zip(provided_digest.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn send_json_error(stream: &mut TcpStream, status: u16, message: &str) -> io::Result<()> {
    send_json_value(stream, status, &json!({ "error": message }))
}

fn send_json_value(
    stream: &mut TcpStream,
    status: u16,
    value: &serde_json::Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(value)
        .unwrap_or_else(|_| br#"{"error":"Response could not be encoded."}"#.to_vec());
    send_response(stream, status, "application/json", &body)
}

fn send_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
