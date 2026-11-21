use std::{
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::config::BackendConfig;

use super::sse;

const MAX_RUNTIME_RESPONSE_BYTES: u64 = 60 * 1024 * 1024;
// The packaged runtime can spend tens of seconds importing the real OCR
// worker before its first authenticated request is serviced. Keep this
// bounded, but do not turn a slow cold start into a false unavailable state.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The loopback transport is the only place that attaches the sidecar token.
/// Its callers receive redacted JSON values rather than raw authenticated data.
pub(super) struct RequestBody {
    pub(super) bytes: Vec<u8>,
    pub(super) content_type: String,
}

pub(super) fn request(
    config: &BackendConfig,
    method: &str,
    path: &str,
    body: Option<RequestBody>,
    idempotency_key: Option<&str>,
) -> Result<Value, String> {
    request_with_headers(config, method, path, body, idempotency_key, &[])
}

pub(super) fn request_with_headers(
    config: &BackendConfig,
    method: &str,
    path: &str,
    body: Option<RequestBody>,
    idempotency_key: Option<&str>,
    extra_headers: &[(&str, String)],
) -> Result<Value, String> {
    request_classified(
        config,
        method,
        path,
        body.as_ref(),
        idempotency_key,
        extra_headers,
    )
    .map_err(|error| error.message)
}

pub(super) struct RequestError {
    pub(super) message: String,
    pub(super) transient: bool,
}

impl From<String> for RequestError {
    fn from(message: String) -> Self {
        Self {
            message,
            transient: false,
        }
    }
}

impl RequestError {
    fn transient(message: String) -> Self {
        Self {
            message,
            transient: true,
        }
    }
}

const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(200), Duration::from_secs(1)];

pub(super) fn request_with_retry(
    config: &BackendConfig,
    method: &str,
    path: &str,
    body: Option<RequestBody>,
    idempotency_key: Option<&str>,
    extra_headers: &[(&str, String)],
) -> Result<Value, RequestError> {
    retry_request(
        || {
            request_classified(
                config,
                method,
                path,
                body.as_ref(),
                idempotency_key,
                extra_headers,
            )
        },
        retry_wait,
    )
}

fn retry_wait(delay: Duration) {
    // Tests replay at once; a waiting test would only be slower.
    if !cfg!(test) {
        std::thread::sleep(delay);
    }
}

fn retry_request(
    mut send: impl FnMut() -> Result<Value, RequestError>,
    mut wait: impl FnMut(Duration),
) -> Result<Value, RequestError> {
    for delay in RETRY_DELAYS {
        match send() {
            Err(error) if error.transient => wait(delay),
            result => return result,
        }
    }
    send()
}

fn request_classified(
    config: &BackendConfig,
    method: &str,
    path: &str,
    body: Option<&RequestBody>,
    idempotency_key: Option<&str>,
    extra_headers: &[(&str, String)],
) -> Result<Value, RequestError> {
    let port = loopback_port(&config.base_url)?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, REQUEST_TIMEOUT)
        .map_err(|_| RequestError::transient("Capture Runtime is unavailable.".to_string()))?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| "Capture Runtime connection cannot be configured.".to_string())?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| "Capture Runtime connection cannot be configured.".to_string())?;

    let (body_bytes, content_type) = match body {
        Some(body) => (body.bytes.as_slice(), Some(body.content_type.as_str())),
        None => (&[][..], None),
    };
    let mut headers = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://tauri.localhost\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        config.token,
        body_bytes.len()
    );
    if let Some(content_type) = content_type {
        headers.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    if let Some(key) = idempotency_key {
        headers.push_str(&format!("X-Idempotency-Key: {key}\r\n"));
    }
    for (name, value) in extra_headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    headers.push_str("\r\n");
    stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(body_bytes))
        .map_err(|_| {
            RequestError::transient("Capture Runtime request could not be sent.".to_string())
        })?;
    let mut response = Vec::new();
    stream
        .take(MAX_RUNTIME_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|error| {
            response_rejection(&response)
                .unwrap_or_else(|| RequestError::transient(read_failure_message(&error)))
        })?;
    if response.len() as u64 > MAX_RUNTIME_RESPONSE_BYTES {
        return Err(
            "Capture Runtime response exceeded the desktop safety limit."
                .to_string()
                .into(),
        );
    }
    parse_response(&response, &config.token)
}

/// The socket timeout limits each read, so it fires whenever the runtime sends
/// nothing for that long: before the headers, or partway through a body or an
/// event stream. Say so, so that a busy runtime is not mistaken for a dropped
/// connection.
fn read_failure_message(error: &std::io::Error) -> String {
    match error.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => format!(
            "Capture Runtime sent no data for {} seconds.",
            REQUEST_TIMEOUT.as_secs()
        ),
        _ => "Capture Runtime response could not be read.".to_string(),
    }
}

/// How long one read of a capture's event stream waits (issue #479). The
/// runtime keeps the stream open while the capture runs, so a call returns
/// what has arrived instead of waiting for the stream to close.
#[derive(Debug, Clone, Copy)]
pub(super) struct EventWait {
    /// Once at least one complete event has arrived, return when no further
    /// byte arrives for this long, so a burst of events comes back together.
    pub(super) quiet: Duration,
    /// Return the events received so far, possibly none, once this long has
    /// passed, so one call never holds a host worker thread for long. The
    /// Workbench polls again after each call.
    pub(super) bound: Duration,
}

const EVENT_WAIT: EventWait = EventWait {
    quiet: Duration::from_millis(250),
    bound: Duration::from_secs(10),
};

pub(super) fn request_sse(
    config: &BackendConfig,
    path: &str,
    last_event_id: Option<&str>,
) -> Result<Value, String> {
    request_sse_within(
        config,
        path,
        last_event_id,
        EVENT_WAIT,
        MAX_RUNTIME_RESPONSE_BYTES,
    )
}

pub(super) fn request_sse_within(
    config: &BackendConfig,
    path: &str,
    last_event_id: Option<&str>,
    wait: EventWait,
    max_response_bytes: u64,
) -> Result<Value, String> {
    let port = loopback_port(&config.base_url)?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, REQUEST_TIMEOUT)
        .map_err(|_| "Capture Runtime is unavailable.".to_string())?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| "Capture Runtime connection cannot be configured.".to_string())?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| "Capture Runtime connection cannot be configured.".to_string())?;
    let mut headers = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://tauri.localhost\r\nAuthorization: Bearer {}\r\nAccept: text/event-stream\r\nConnection: close\r\n",
        config.token
    );
    if let Some(cursor) = last_event_id {
        headers.push_str(&format!("Last-Event-ID: {cursor}\r\n"));
    }
    headers.push_str("\r\n");
    stream
        .write_all(headers.as_bytes())
        .map_err(|_| "Capture Runtime request could not be sent.".to_string())?;
    let started = Instant::now();
    let mut events = sse::EventStream::new();
    let mut received: u64 = 0;
    let mut buffer = [0_u8; 16 * 1024];
    while !events.ended() {
        // Until the headers arrive, a silent runtime is an error as for any
        // request; afterwards silence only ends the wait.
        let read_timeout = if events.headers_received() {
            let left = wait.bound.saturating_sub(started.elapsed());
            if left.is_zero() {
                break;
            }
            if events.has_complete_event() {
                left.min(wait.quiet)
            } else {
                left
            }
        } else {
            REQUEST_TIMEOUT
        };
        stream
            .set_read_timeout(Some(read_timeout.max(Duration::from_millis(1))))
            .map_err(|_| "Capture Runtime connection cannot be configured.".to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => events.finish(),
            Ok(count) => {
                received += count as u64;
                if received > max_response_bytes {
                    return Err(
                        "Capture Runtime response exceeded the desktop safety limit.".into(),
                    );
                }
                events.push(&buffer[..count])?;
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error)
                if events.headers_received()
                    && matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
            {
                if events.has_complete_event() {
                    break;
                }
            }
            Err(error) => return Err(read_failure_message(&error)),
        }
    }
    events.events(&config.token)
}

fn response_rejection(response: &[u8]) -> Option<RequestError> {
    let line_end = response.windows(2).position(|window| window == b"\r\n")?;
    let status = std::str::from_utf8(&response[..line_end])
        .ok()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    if (200..300).contains(&status) {
        return None;
    }
    Some(RequestError {
        message: format!("Capture Runtime request was rejected with HTTP {status}."),
        transient: matches!(status, 502 | 503 | 504),
    })
}

fn parse_response(response: &[u8], token: &str) -> Result<Value, RequestError> {
    // A received rejection is decisive even if the peer closes before sending
    // the remaining headers or body. Only gateway failures permit replay.
    if let Some(error) = response_rejection(response) {
        return Err(error);
    }
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            RequestError::transient(format!(
                "Capture Runtime response was malformed ({}).",
                response_diagnostic(response)
            ))
        })?;
    let headers = std::str::from_utf8(&response[..separator]).map_err(|_| {
        RequestError::transient("Capture Runtime response headers were invalid.".to_string())
    })?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| {
            RequestError::transient(format!(
                "Capture Runtime response status was malformed ({}).",
                response_diagnostic(response)
            ))
        })?;
    if status == 204 {
        return Ok(Value::Null);
    }
    let body = &response[separator + 4..];
    let body = decode_body(headers, body).map_err(RequestError::transient)?;
    let mut value: Value = serde_json::from_slice(&body)
        .map_err(|_| "Capture Runtime response was not valid JSON.".to_string())?;
    redact_token(&mut value, token);
    Ok(value)
}

fn decode_body(headers: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    let mut content_length = None;
    let mut chunked = false;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                content_length = Some(value.trim().parse::<usize>().map_err(|_| {
                    "Capture Runtime response Content-Length was invalid.".to_string()
                })?);
            }
            "transfer-encoding" => {
                chunked = value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
            }
            _ => {}
        }
    }
    if chunked {
        return decode_chunked_body(body);
    }
    if let Some(length) = content_length {
        return body
            .get(..length)
            .map(ToOwned::to_owned)
            .ok_or_else(|| "Capture Runtime response body was truncated.".to_string());
    }
    Ok(body.to_vec())
}

fn decode_chunked_body(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let size_end = body
            .get(cursor..)
            .and_then(|remaining| remaining.windows(2).position(|window| window == b"\r\n"))
            .map(|offset| cursor + offset)
            .ok_or_else(|| "Capture Runtime chunk size was malformed.".to_string())?;
        let size_line = std::str::from_utf8(&body[cursor..size_end])
            .map_err(|_| "Capture Runtime chunk size was invalid.".to_string())?;
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| "Capture Runtime chunk size was invalid.".to_string())?;
        cursor = size_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        let chunk_end = cursor
            .checked_add(size)
            .ok_or_else(|| "Capture Runtime chunk size overflowed.".to_string())?;
        let framing_end = chunk_end
            .checked_add(2)
            .ok_or_else(|| "Capture Runtime chunk framing overflowed.".to_string())?;
        if body.get(chunk_end..framing_end) != Some(b"\r\n") {
            return Err("Capture Runtime chunk was truncated.".into());
        }
        decoded.extend_from_slice(
            body.get(cursor..chunk_end)
                .ok_or_else(|| "Capture Runtime chunk was truncated.".to_string())?,
        );
        cursor = chunk_end + 2;
    }
}

fn response_diagnostic(response: &[u8]) -> String {
    // Never include response bytes in an IPC-facing diagnostic.  A malformed
    // response may contain an authorization header or model output, and the
    // desktop boundary must remain safe even before JSON redaction runs.
    format!("bytes={}", response.len())
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;

    use super::{decode_body, read_failure_message, response_diagnostic};

    #[test]
    fn retry_budget_and_delays_are_bounded() {
        let mut attempts = 0;
        let mut delays = Vec::new();
        let result = super::retry_request(
            || {
                attempts += 1;
                Err(super::RequestError::transient("unavailable".into()))
            },
            |delay| delays.push(delay),
        );
        assert!(result.is_err());
        assert_eq!(attempts, 3);
        assert_eq!(delays, super::RETRY_DELAYS);
    }

    #[test]
    fn definite_rejection_does_not_wait_or_retry() {
        let mut attempts = 0;
        let result = super::retry_request(
            || {
                attempts += 1;
                super::parse_response(b"HTTP/1.1 500 Failure\r\n", "secret")
            },
            |_| panic!("definite rejection must not wait"),
        );
        assert!(result.is_err());
        assert_eq!(attempts, 1);
    }

    #[test]
    fn response_classification_preserves_definite_statuses() {
        for status in [409, 422, 500, 502, 503, 504] {
            let response = format!("HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\n\r\n");
            let error = super::parse_response(response.as_bytes(), "secret")
                .err()
                .expect("rejection");
            assert_eq!(error.transient, matches!(status, 502..=504));
        }
        for response in [
            &b""[..],
            &b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}"[..],
        ] {
            assert!(
                super::parse_response(response, "secret")
                    .err()
                    .expect("incomplete")
                    .transient
            );
        }
    }

    #[test]
    fn definite_failure_does_not_wait_or_retry() {
        let mut attempts = 0;
        let result = super::retry_request(
            || {
                attempts += 1;
                Err("Capture Runtime request was rejected with HTTP 500."
                    .to_string()
                    .into())
            },
            |_| panic!("definite failures must not wait"),
        );
        assert!(result.is_err());
        assert_eq!(attempts, 1);
    }

    #[test]
    fn rejection_status_is_preserved_when_the_response_is_incomplete() {
        for status in [409, 422, 500, 502, 503, 504] {
            let response = format!("HTTP/1.1 {status} Failure\r\nContent-Length: 100\r\n");
            let error = super::parse_response(response.as_bytes(), "secret")
                .err()
                .expect("rejection");
            assert_eq!(error.transient, matches!(status, 502..=504));
            assert_eq!(
                error.message,
                format!("Capture Runtime request was rejected with HTTP {status}.")
            );
        }
    }

    #[test]
    fn a_read_timeout_says_the_runtime_sent_no_data() {
        for kind in [ErrorKind::TimedOut, ErrorKind::WouldBlock] {
            assert_eq!(
                read_failure_message(&std::io::Error::from(kind)),
                format!(
                    "Capture Runtime sent no data for {} seconds.",
                    super::REQUEST_TIMEOUT.as_secs()
                )
            );
        }
        assert_eq!(
            read_failure_message(&std::io::Error::from(ErrorKind::ConnectionReset)),
            "Capture Runtime response could not be read."
        );
    }

    #[test]
    fn malformed_response_diagnostic_never_includes_response_bytes() {
        let diagnostic = response_diagnostic(b"Authorization: Bearer raw-secret\r\n");
        assert_eq!(diagnostic, "bytes=34");
        assert!(!diagnostic.contains("raw-secret"));
    }

    #[test]
    fn decodes_content_length_body() {
        let body = decode_body(
            "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n",
            br#"{"ok":1}trailing"#,
        )
        .expect("content-length body");
        assert_eq!(body, br#"{"ok":1}"#);
    }

    mod event_stream {
        use std::{
            io::{Read, Write},
            net::{Ipv4Addr, TcpListener, TcpStream},
            thread,
            time::{Duration, Instant},
        };

        use serde_json::Value;

        use super::super::{request_sse_within, EventWait};
        use crate::config::BackendConfig;

        const TOKEN: &str = "secret-token";
        const OPEN_HEADERS: &str =
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
        // Short waits keep the suite fast; the bound is far above the quiet
        // period so a test that returns early is told apart from one that waits.
        const WAIT: EventWait = EventWait {
            quiet: Duration::from_millis(150),
            bound: Duration::from_secs(3),
        };

        fn chunk(text: &str) -> String {
            format!("{:x}\r\n{text}\r\n", text.len())
        }

        fn event(sequence: u64) -> String {
            chunk(&format!(
                "id: {sequence}\nevent: segment\ndata: {{\"sequence\":{sequence}}}\n\n"
            ))
        }

        /// Serves one request with the given writes, then keeps the connection
        /// open until the client closes it, as the runtime does while a capture runs.
        fn serve(writes: Vec<(Duration, String)>) -> (u16, thread::JoinHandle<()>) {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
            let port = listener.local_addr().expect("address").port();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request).expect("request");
                for (pause, bytes) in writes {
                    thread::sleep(pause);
                    if stream.write_all(bytes.as_bytes()).is_err() {
                        return;
                    }
                }
                wait_for_close(&mut stream);
            });
            (port, server)
        }

        fn wait_for_close(stream: &mut TcpStream) {
            let mut buffer = [0_u8; 64];
            while matches!(stream.read(&mut buffer), Ok(count) if count > 0) {}
        }

        fn config(port: u16) -> BackendConfig {
            BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: TOKEN.into(),
                runtime_version: env!("CARGO_PKG_VERSION").into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
            }
        }

        fn read(port: u16, wait: EventWait, limit: u64) -> (Result<Value, String>, Duration) {
            let started = Instant::now();
            let result = request_sse_within(
                &config(port),
                "/v2/captures/capture-1/events",
                Some("0"),
                wait,
                limit,
            );
            (result, started.elapsed())
        }

        fn sequences(events: &Value) -> Vec<u64> {
            events
                .as_array()
                .expect("event array")
                .iter()
                .map(|event| event["sequence"].as_u64().expect("sequence"))
                .collect()
        }

        #[test]
        fn returns_the_events_that_arrived_while_the_stream_stays_open() {
            let (port, server) = serve(vec![(
                Duration::ZERO,
                format!("{OPEN_HEADERS}{}{}", event(1), event(2)),
            )]);
            let (events, elapsed) = read(port, WAIT, 1 << 20);
            assert_eq!(sequences(&events.expect("events")), [1, 2]);
            assert!(elapsed < WAIT.bound, "returned after {elapsed:?}");
            server.join().expect("server");
        }

        #[test]
        fn drops_an_incomplete_trailing_event() {
            let (port, server) = serve(vec![(
                Duration::ZERO,
                format!(
                    "{OPEN_HEADERS}{}{}",
                    event(1),
                    chunk("id: 2\nevent: segment\ndata: {\"sequence\":2}\n")
                ),
            )]);
            let (events, _) = read(port, WAIT, 1 << 20);
            assert_eq!(sequences(&events.expect("events")), [1]);
            server.join().expect("server");
        }

        #[test]
        fn batches_events_that_arrive_within_the_quiet_period() {
            let (port, server) = serve(vec![
                (Duration::ZERO, format!("{OPEN_HEADERS}{}", event(1))),
                (WAIT.quiet / 3, event(2)),
                (WAIT.quiet / 3, event(3)),
            ]);
            let (events, _) = read(port, WAIT, 1 << 20);
            assert_eq!(sequences(&events.expect("events")), [1, 2, 3]);
            server.join().expect("server");
        }

        #[test]
        fn returns_no_events_at_the_bound_when_only_heartbeats_arrive() {
            let wait = EventWait {
                quiet: Duration::from_millis(50),
                bound: Duration::from_millis(400),
            };
            let (port, server) = serve(vec![(
                Duration::ZERO,
                format!("{OPEN_HEADERS}{}", chunk(": heartbeat\n\n")),
            )]);
            let (events, elapsed) = read(port, wait, 1 << 20);
            assert_eq!(events.expect("events"), serde_json::json!([]));
            assert!(elapsed >= wait.bound, "returned after {elapsed:?}");
            assert!(elapsed < wait.bound * 5, "returned after {elapsed:?}");
            server.join().expect("server");
        }

        #[test]
        fn a_finished_stream_returns_at_once_with_its_events() {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
            let port = listener.local_addr().expect("address").port();
            let closing = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request).expect("request");
                stream
                    .write_all(format!("{OPEN_HEADERS}{}0\r\n\r\n", event(6)).as_bytes())
                    .expect("response");
            });
            let (events, elapsed) = read(port, WAIT, 1 << 20);
            assert_eq!(sequences(&events.expect("events")), [6]);
            assert!(elapsed < WAIT.bound / 2, "returned after {elapsed:?}");
            closing.join().expect("server");
        }

        #[test]
        fn enforces_the_response_size_limit() {
            let (port, server) = serve(vec![(
                Duration::ZERO,
                format!(
                    "{OPEN_HEADERS}{}",
                    chunk(&format!("data: \"{}\"\n\n", "x".repeat(4096)))
                ),
            )]);
            let (events, _) = read(port, WAIT, 1024);
            assert_eq!(
                events.expect_err("limit"),
                "Capture Runtime response exceeded the desktop safety limit."
            );
            server.join().expect("server");
        }

        #[test]
        fn a_rejection_returns_its_status_without_waiting_or_the_token() {
            let (port, server) = serve(vec![(
                Duration::ZERO,
                format!(
                    "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nX-Echo: Bearer {TOKEN}\r\nContent-Length: 40\r\n\r\n"
                ),
            )]);
            let (events, elapsed) = read(port, WAIT, 1 << 20);
            let error = events.expect_err("rejection");
            assert_eq!(error, "Capture Runtime request was rejected with HTTP 404.");
            assert!(super::super::is_http_rejection(&error, 404));
            assert!(!error.contains(TOKEN));
            assert!(elapsed < WAIT.bound, "returned after {elapsed:?}");
            server.join().expect("server");
        }

        #[test]
        fn event_payloads_and_malformed_streams_never_carry_the_token() {
            let (port, server) = serve(vec![(
                Duration::ZERO,
                format!(
                    "{OPEN_HEADERS}{}",
                    chunk(&format!("data: {{\"message\":\"{TOKEN}\"}}\n\n"))
                ),
            )]);
            let (events, _) = read(port, WAIT, 1 << 20);
            assert_eq!(events.expect("events")[0]["message"], "[REDACTED]");
            server.join().expect("server");

            let (port, server) =
                serve(vec![(Duration::ZERO, format!("{OPEN_HEADERS}{TOKEN}\r\n"))]);
            let (events, _) = read(port, WAIT, 1 << 20);
            assert!(!events.expect_err("malformed").contains(TOKEN));
            server.join().expect("server");
        }
    }

    #[test]
    fn decodes_chunked_body_with_extensions() {
        let body = decode_body(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n",
            b"4;name=one\r\ntest\r\n4\r\ning!\r\n0\r\n\r\n",
        )
        .expect("chunked body");
        assert_eq!(body, b"testing!");
    }
}

pub(super) fn is_http_rejection(error: &str, status: u16) -> bool {
    error == format!("Capture Runtime request was rejected with HTTP {status}.")
}

fn loopback_port(base_url: &str) -> Result<u16, String> {
    base_url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "Capture Runtime connection is invalid.".to_string())
}

pub(super) fn redact_token(value: &mut Value, token: &str) {
    match value {
        Value::String(text) => *text = text.replace(token, "[REDACTED]"),
        Value::Array(values) => values.iter_mut().for_each(|item| redact_token(item, token)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|item| redact_token(item, token)),
        _ => {}
    }
}
