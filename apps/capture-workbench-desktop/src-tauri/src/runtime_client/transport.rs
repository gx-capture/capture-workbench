use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
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

    let (body_bytes, content_type) = match body {
        Some(body) => (body.bytes, Some(body.content_type)),
        None => (Vec::new(), None),
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
        .and_then(|_| stream.write_all(&body_bytes))
        .map_err(|_| "Capture Runtime request could not be sent.".to_string())?;
    let mut response = Vec::new();
    stream
        .take(MAX_RUNTIME_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|error| {
            format!("Capture Runtime response could not be read for {method} {path}: {error}.")
        })?;
    if response.len() as u64 > MAX_RUNTIME_RESPONSE_BYTES {
        return Err("Capture Runtime response exceeded the desktop safety limit.".into());
    }
    parse_response(&response, &config.token)
}

pub(super) fn request_sse(
    config: &BackendConfig,
    path: &str,
    last_event_id: Option<&str>,
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
    let mut response = Vec::new();
    stream
        .take(MAX_RUNTIME_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|_| "Capture Runtime response could not be read.".to_string())?;
    if response.len() as u64 > MAX_RUNTIME_RESPONSE_BYTES {
        return Err("Capture Runtime response exceeded the desktop safety limit.".into());
    }
    sse::parse_response(&response, &config.token)
}

fn parse_response(response: &[u8], token: &str) -> Result<Value, String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            format!(
                "Capture Runtime response was malformed ({}).",
                response_diagnostic(response)
            )
        })?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "Capture Runtime response headers were invalid.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| {
            format!(
                "Capture Runtime response status was malformed ({}).",
                response_diagnostic(response)
            )
        })?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "Capture Runtime request was rejected with HTTP {status}."
        ));
    }
    if status == 204 {
        return Ok(Value::Null);
    }
    let body = &response[separator + 4..];
    let body = decode_body(headers, body)?;
    let mut value: Value = serde_json::from_slice(&body)
        .map_err(|_| "Capture Runtime response was not valid JSON.".to_string())?;
    redact_token(&mut value, token);
    Ok(value)
}

pub(super) fn decode_body(headers: &str, body: &[u8]) -> Result<Vec<u8>, String> {
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
    use super::{decode_body, response_diagnostic};

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
