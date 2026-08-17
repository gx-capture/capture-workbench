use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

use serde_json::Value;

use crate::config::BackendConfig;

use super::sse;

const MAX_RUNTIME_RESPONSE_BYTES: u64 = 60 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

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
        .map_err(|_| "Capture Runtime response could not be read.".to_string())?;
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
        .ok_or_else(|| "Capture Runtime response was malformed.".to_string())?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "Capture Runtime response headers were invalid.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Capture Runtime response status was malformed.".to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "Capture Runtime request was rejected with HTTP {status}."
        ));
    }
    if status == 204 {
        return Ok(Value::Null);
    }
    let mut value: Value = serde_json::from_slice(&response[separator + 4..])
        .map_err(|_| "Capture Runtime response was not valid JSON.".to_string())?;
    redact_token(&mut value, token);
    Ok(value)
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
