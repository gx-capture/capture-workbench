use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

#[cfg(test)]
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    config::BackendConfig,
    contracts::{
        RuntimeIdInput, RuntimeInstallationStartInput, RuntimeModelInstallationStartInput,
        RuntimeStreamingCaptureInput, RuntimeStreamingEventsInput,
    },
    library::{LibraryStore, RuntimeSourceFile},
    state::DesktopState,
};

const MAX_RUNTIME_RESPONSE_BYTES: u64 = 60 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const STREAM_CHUNK_BYTES: usize = 1024 * 1024;

struct RequestBody {
    bytes: Vec<u8>,
    content_type: String,
}

pub(crate) fn requirements(state: &DesktopState) -> Result<Value, String> {
    request_json(state, "GET", "/v1/runtime/requirements", None, None)
}

pub(crate) fn start_installation(
    state: &DesktopState,
    input: RuntimeInstallationStartInput,
) -> Result<Value, String> {
    validate_client_request_id(&input.client_request_id)?;
    validate_requirement_id(&input.requirement_id)?;
    let body = serde_json::to_vec(&json!({
        "requirementId": input.requirement_id,
        "consent": true,
    }))
    .map_err(|_| "Capture Runtime installation request cannot be encoded.".to_string())?;
    request_json(
        state,
        "POST",
        "/v1/runtime/installations",
        Some(RequestBody {
            bytes: body,
            content_type: "application/json".into(),
        }),
        Some(&input.client_request_id),
    )
}

pub(crate) fn installation(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    validate_opaque_id(&input.id)?;
    request_json(
        state,
        "GET",
        &format!("/v1/runtime/installations/{}", input.id),
        None,
        None,
    )
}

pub(crate) fn model_options(state: &DesktopState) -> Result<Value, String> {
    request_json(state, "GET", "/v1/runtime/model-options", None, None)
}

pub(crate) fn start_model_installation(
    state: &DesktopState,
    input: RuntimeModelInstallationStartInput,
) -> Result<Value, String> {
    validate_client_request_id(&input.client_request_id)?;
    validate_model_option_id(&input.option_id)?;
    let body = serde_json::to_vec(&json!({
        "optionId": input.option_id,
        "consent": true,
    }))
    .map_err(|_| "Capture Runtime model installation request cannot be encoded.".to_string())?;
    request_json(
        state,
        "POST",
        "/v1/runtime/model-installations",
        Some(RequestBody {
            bytes: body,
            content_type: "application/json".into(),
        }),
        Some(&input.client_request_id),
    )
}

pub(crate) fn model_installation(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    validate_opaque_id(&input.id)?;
    request_json(
        state,
        "GET",
        &format!("/v1/runtime/model-installations/{}", input.id),
        None,
        None,
    )
}

pub(crate) fn start_streaming_capture(
    state: &DesktopState,
    library: &LibraryStore,
    input: RuntimeStreamingCaptureInput,
) -> Result<Value, String> {
    validate_document_id(&input.document_id)?;
    validate_client_request_id(&input.client_request_id)?;
    validate_structuring_mode(&input.structuring_mode)?;
    let source = library.runtime_source_file(&input.document_id)?;
    let source_kind = match source.media_type.as_str() {
        "application/pdf" => "pdf",
        media_type if media_type.starts_with("image/") => "image",
        media_type if media_type.starts_with("audio/") => "audio",
        _ => return Err("Streaming capture source media type is unsupported.".into()),
    };
    let config = state.backend_config()?;
    let ingestion = request_with_headers(
        &config,
        "POST",
        "/v2/ingestions",
        Some(RequestBody {
            bytes: serde_json::to_vec(&json!({
                "clientRequestId": format!("{}-ingestion", input.client_request_id),
                "kind": source_kind,
                "mode": "file",
                "fileName": source.file_name.clone(),
                "mediaType": source.media_type.clone(),
                "totalBytes": source.bytes,
            }))
            .map_err(|_| "Progressive ingestion request cannot be encoded.".to_string())?,
            content_type: "application/json".into(),
        }),
        None,
        &[],
    )?;
    let ingestion_id = ingestion
        .get("ingestionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Progressive ingestion response is invalid.".to_string())?;
    let client_request_id = input.client_request_id.clone();
    let result = (|| {
        upload_source_chunks(&config, &source, ingestion_id, &client_request_id)?;
        let source_digest = source_sha256(&source)?;
        request_json(
            state,
            "POST",
            &format!("/v2/ingestions/{ingestion_id}/finalize"),
            Some(RequestBody {
                bytes: serde_json::to_vec(&json!({
                    "totalBytes": source.bytes,
                    "sha256": source_digest,
                }))
                .map_err(|_| "Progressive finalize request cannot be encoded.".to_string())?,
                content_type: "application/json".into(),
            }),
            None,
        )?;
        request_capture_with_recovery(
            &config,
            RequestBody {
                bytes: serde_json::to_vec(&json!({
                    "clientRequestId": client_request_id.clone(),
                    "ingestionId": ingestion_id,
                    "structuringMode": input.structuring_mode,
                    "startPolicy": "eager",
                }))
                .map_err(|_| "Progressive capture request cannot be encoded.".to_string())?,
                content_type: "application/json".into(),
            },
            &client_request_id,
        )
    })();
    match result {
        Ok(value) => Ok(value),
        Err(error) => match request_json(
            state,
            "DELETE",
            &format!("/v2/ingestions/{ingestion_id}"),
            None,
            None,
        ) {
            Ok(_) => Err(error),
            Err(cleanup_error) => Err(format!("{error} Ingestion cleanup failed: {cleanup_error}")),
        },
    }
}

fn request_capture_with_recovery(
    config: &BackendConfig,
    body: RequestBody,
    client_request_id: &str,
) -> Result<Value, String> {
    let send = || {
        request_with_headers(
            config,
            "POST",
            "/v2/captures",
            Some(RequestBody {
                bytes: body.bytes.clone(),
                content_type: body.content_type.clone(),
            }),
            Some(client_request_id),
            &[],
        )
    };
    let first_error = match send() {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    match send() {
        Ok(value) => Ok(value),
        Err(_) => request_with_headers(
            config,
            "GET",
            &format!("/v2/captures/by-client-request/{client_request_id}"),
            None,
            None,
            &[],
        )
        .map_err(|_| first_error),
    }
}

pub(crate) fn streaming_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    streaming_value(state, "GET", &input.id, "", None, None)
}

pub(crate) fn streaming_partial(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    null_for_http_rejection(
        streaming_value(state, "GET", &input.id, "/partial", None, None),
        409,
    )
}

pub(crate) fn streaming_result(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    streaming_value(state, "GET", &input.id, "/result", None, None)
}

pub(crate) fn streaming_structure(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    streaming_value(state, "POST", &input.id, "/structure", None, None)
}

pub(crate) fn streaming_events(
    state: &DesktopState,
    input: RuntimeStreamingEventsInput,
) -> Result<Value, String> {
    let last_event_id = input.last_event_id.map(|value| value.to_string());
    streaming_value(
        state,
        "GET",
        &input.id,
        "/events",
        None,
        last_event_id.as_deref(),
    )
}

pub(crate) fn cancel_streaming_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    streaming_value(state, "POST", &input.id, "/cancel", None, None)
}

pub(crate) fn delete_streaming_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    null_for_http_rejection(
        streaming_value(state, "DELETE", &input.id, "", None, None),
        404,
    )
}

fn upload_source_chunks(
    config: &BackendConfig,
    source: &RuntimeSourceFile,
    ingestion_id: &str,
    request_id: &str,
) -> Result<(), String> {
    let mut file = std::fs::File::open(&source.path)
        .map_err(|_| "Capture library source cannot be opened for streaming.".to_string())?;
    let mut offset = 0_u64;
    let mut chunk_index = 0_u64;
    let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
    while offset < source.bytes {
        let remaining = (source.bytes - offset) as usize;
        let target = remaining.min(STREAM_CHUNK_BYTES);
        file.read_exact(&mut buffer[..target])
            .map_err(|_| "Capture library source changed during streaming upload.".to_string())?;
        let bytes = &buffer[..target];
        let digest = hex_digest(bytes);
        let end = offset + bytes.len() as u64 - 1;
        request_with_headers(
            config,
            "PUT",
            &format!("/v2/ingestions/{ingestion_id}/chunks/{chunk_index}"),
            Some(RequestBody {
                bytes: bytes.to_vec(),
                content_type: "application/octet-stream".into(),
            }),
            Some(&format!("{request_id}-chunk-{chunk_index}")),
            &[
                (
                    "Content-Range",
                    format!("bytes {offset}-{end}/{}", source.bytes),
                ),
                ("Digest", format!("sha-256={digest}")),
            ],
        )?;
        offset += bytes.len() as u64;
        chunk_index += 1;
    }
    Ok(())
}

fn source_sha256(source: &RuntimeSourceFile) -> Result<String, String> {
    let mut file = std::fs::File::open(&source.path)
        .map_err(|_| "Capture library source cannot be opened for finalization.".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
    let mut read_bytes = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Capture library source cannot be hashed.".to_string())?;
        if count == 0 {
            break;
        }
        read_bytes += count as u64;
        hasher.update(&buffer[..count]);
    }
    if read_bytes != source.bytes {
        return Err("Capture library source changed during finalization.".into());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn null_for_http_rejection(
    result: Result<Value, String>,
    accepted_status: u16,
) -> Result<Value, String> {
    match result {
        Err(error) if is_http_rejection(&error, accepted_status) => Ok(Value::Null),
        result => result,
    }
}

fn streaming_value(
    state: &DesktopState,
    method: &str,
    capture_id: &str,
    suffix: &str,
    body: Option<RequestBody>,
    last_event_id: Option<&str>,
) -> Result<Value, String> {
    validate_opaque_id(capture_id)?;
    let config = state.backend_config()?;
    let path = format!("/v2/captures/{capture_id}{suffix}");
    if suffix == "/events" {
        return request_sse(&config, &path, last_event_id);
    }
    request_with_headers(&config, method, &path, body, None, &[])
}

fn request_json(
    state: &DesktopState,
    method: &str,
    path: &str,
    body: Option<RequestBody>,
    idempotency_key: Option<&str>,
) -> Result<Value, String> {
    let config = state.backend_config()?;
    request(&config, method, path, body, idempotency_key)
}

fn request(
    config: &BackendConfig,
    method: &str,
    path: &str,
    body: Option<RequestBody>,
    idempotency_key: Option<&str>,
) -> Result<Value, String> {
    request_with_headers(config, method, path, body, idempotency_key, &[])
}

fn request_with_headers(
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

fn request_sse(
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
    if !has_event_stream_content_type(headers) {
        return Err("Capture Runtime SSE response Content-Type was not text/event-stream.".into());
    }
    parse_sse_events(&response[separator + 4..], last_event_id, &config.token)
}

#[derive(Default)]
struct SseFrame {
    id: Option<String>,
    event: Option<String>,
    data: Vec<String>,
}

fn parse_sse_events(body: &[u8], cursor: Option<&str>, token: &str) -> Result<Value, String> {
    let text = std::str::from_utf8(body)
        .map_err(|_| "Capture Runtime SSE response was not valid UTF-8.".to_string())?;
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let cursor_sequence = cursor
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "Capture Runtime SSE cursor was invalid.".to_string())
        })
        .transpose()?;
    let mut frame = SseFrame::default();
    let mut events = Vec::new();
    let mut previous_sequence = cursor_sequence;

    for line in normalized.split('\n') {
        if line.is_empty() {
            dispatch_sse_frame(&mut frame, &mut events, &mut previous_sequence, token)?;
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        let (field, raw_value) = line
            .split_once(':')
            .map_or((line, ""), |(field, value)| (field, value));
        let value = raw_value.strip_prefix(' ').unwrap_or(raw_value);
        match field {
            "data" => frame.data.push(value.to_string()),
            "id" => frame.id = Some(value.to_string()),
            "event" => frame.event = Some(value.to_string()),
            _ => {}
        }
    }
    dispatch_sse_frame(&mut frame, &mut events, &mut previous_sequence, token)?;
    Ok(Value::Array(events))
}

fn dispatch_sse_frame(
    frame: &mut SseFrame,
    events: &mut Vec<Value>,
    previous_sequence: &mut Option<u64>,
    token: &str,
) -> Result<(), String> {
    if frame.data.is_empty() {
        frame.id = None;
        frame.event = None;
        return Ok(());
    }
    let mut value: Value = serde_json::from_str(&frame.data.join("\n"))
        .map_err(|_| "Capture Runtime SSE event was not valid JSON.".to_string())?;
    let sequence = value
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Capture Runtime SSE event sequence was invalid.".to_string())?;
    let event_type = value
        .get("eventType")
        .and_then(Value::as_str)
        .filter(|event_type| !event_type.is_empty())
        .ok_or_else(|| "Capture Runtime SSE event type was invalid.".to_string())?;
    if let Some(id) = frame.id.as_deref() {
        if id != sequence.to_string() {
            return Err("Capture Runtime SSE event id did not match its sequence.".to_string());
        }
    }
    if let Some(event) = frame.event.as_deref() {
        if event != event_type {
            return Err("Capture Runtime SSE event name did not match its payload.".to_string());
        }
    }
    if previous_sequence.is_some_and(|previous| sequence <= previous) {
        return Err("Capture Runtime SSE event sequence was not strictly increasing.".to_string());
    }
    *previous_sequence = Some(sequence);
    redact_token(&mut value, token);
    events.push(value);
    frame.id = None;
    frame.event = None;
    frame.data.clear();
    Ok(())
}

fn has_event_stream_content_type(headers: &str) -> bool {
    let content_types = headers
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.trim().eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.trim())
        .collect::<Vec<_>>();
    content_types.len() == 1
        && content_types[0]
            .split(';')
            .next()
            .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("text/event-stream"))
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

fn is_http_rejection(error: &str, status: u16) -> bool {
    error == format!("Capture Runtime request was rejected with HTTP {status}.")
}

fn loopback_port(base_url: &str) -> Result<u16, String> {
    base_url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "Capture Runtime connection is invalid.".to_string())
}

fn validate_document_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Capture library document identifier is invalid.".into());
    }
    Ok(())
}

fn validate_opaque_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Capture Runtime identifier is invalid.".into());
    }
    Ok(())
}

fn validate_client_request_id(value: &str) -> Result<(), String> {
    validate_opaque_id(value)
        .map_err(|_| "Capture client request identifier is invalid.".to_string())
}

fn validate_requirement_id(value: &str) -> Result<(), String> {
    if !matches!(
        value,
        "windowsml-ocr" | "whisper-primary" | "ollama-runtime" | "capture-ollama-model"
    ) {
        return Err("Capture Runtime requirement identifier is invalid.".into());
    }
    Ok(())
}

fn validate_model_option_id(value: &str) -> Result<(), String> {
    if !matches!(value, "qwen3.5-0.8b-v1" | "qwen3.5-2b-v1" | "qwen3.5-4b-v1") {
        return Err("Capture Runtime model option identifier is invalid.".into());
    }
    Ok(())
}

fn validate_structuring_mode(value: &str) -> Result<(), String> {
    if matches!(value, "runtime" | "host") {
        Ok(())
    } else {
        Err("Capture structuring mode is invalid.".into())
    }
}

#[cfg(test)]
fn random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Capture Runtime multipart boundary cannot be generated.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn redact_token(value: &mut Value, token: &str) {
    match value {
        Value::String(text) => *text = text.replace(token, "[REDACTED]"),
        Value::Array(values) => values.iter_mut().for_each(|item| redact_token(item, token)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|item| redact_token(item, token)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read, net::TcpListener, path::PathBuf, thread};

    #[test]
    fn authenticated_runtime_responses_are_redacted_before_returning_to_ipc() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("Authorization: Bearer secret-token"));
            let body = r#"{"detail":"secret-token must not cross IPC"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });
        let value = request(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "secret-token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            "GET",
            "/v1/runtime/requirements",
            None,
            None,
        )
        .expect("response");
        assert_eq!(value["detail"], "[REDACTED] must not cross IPC");
        assert!(!serde_json::to_string(&value)
            .expect("value")
            .contains("secret-token"));
        server.join().expect("server");
    }

    #[test]
    fn runtime_identifiers_reject_path_traversal() {
        assert!(validate_opaque_id("../capture").is_err());
        assert!(validate_document_id("../document").is_err());
    }

    #[test]
    fn private_http_status_mapping_is_exact_and_idempotent() {
        let not_found = Err("Capture Runtime request was rejected with HTTP 404.".into());
        assert_eq!(
            null_for_http_rejection(not_found, 404).expect("idempotent delete"),
            Value::Null
        );
        let conflict = Err("Capture Runtime request was rejected with HTTP 409.".into());
        assert_eq!(
            null_for_http_rejection(conflict, 409).expect("optional raw"),
            Value::Null
        );
        let unexpected = Err("Capture Runtime request was rejected with HTTP 500.".into());
        assert_eq!(
            null_for_http_rejection(unexpected, 404).expect_err("unexpected failure"),
            "Capture Runtime request was rejected with HTTP 500."
        );
    }

    #[test]
    fn streaming_sse_uses_exclusive_cursor_and_redacts_payloads() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("GET /v2/captures/capture-1/events HTTP/1.1"));
            assert!(request.contains("Last-Event-ID: 7"));
            let body = concat!(
                "id: 8\r\n",
                "event: checkpoint\r\n",
                "data: {\"sequence\":8,\"eventType\":\"checkpoint\",\"message\":\"secret-token\"}\r\n\r\n",
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });
        let events = request_sse(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "secret-token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            "/v2/captures/capture-1/events",
            Some("7"),
        )
        .expect("events");
        assert_eq!(events[0]["sequence"], 8);
        assert_eq!(events[0]["message"], "[REDACTED]");
        server.join().expect("server");
    }

    #[test]
    fn streaming_sse_implements_framing_metadata_and_strict_cursor_ordering() {
        let first = r#"{"sequence":8,"eventType":"checkpoint","message":"secret-token"}"#;
        let second = r#"{"sequence":9,"eventType":"completed"}"#;
        let body = format!(
            ": keep-alive\r\n\r\n\r\nid: 8\r\nevent: checkpoint\r\ndata:{}\r\ndata: {}\r\n\r\nid: 9\nevent: completed\ndata:{}\n\n",
            &first[..first.find(",\"message\"").expect("split") + 1],
            &first[first.find(",\"message\"").expect("split") + 1..],
            second,
        );

        let events =
            parse_sse_events(body.as_bytes(), Some("7"), "secret-token").expect("framed events");

        assert_eq!(events[0]["sequence"], 8);
        assert_eq!(events[0]["message"], "[REDACTED]");
        assert_eq!(events[1]["eventType"], "completed");
    }

    #[test]
    fn streaming_sse_rejects_metadata_mismatch_and_non_increasing_sequences() {
        let payload = r#"{"sequence":8,"eventType":"checkpoint"}"#;
        let id_mismatch = format!("id: 7\nevent: checkpoint\ndata: {payload}\n\n");
        let event_mismatch = format!("id: 8\nevent: completed\ndata: {payload}\n\n");
        let duplicate = format!("data: {payload}\n\ndata: {payload}\n\n",);

        assert!(parse_sse_events(id_mismatch.as_bytes(), None, "token")
            .expect_err("id mismatch")
            .contains("id"));
        assert!(parse_sse_events(event_mismatch.as_bytes(), None, "token")
            .expect_err("event mismatch")
            .contains("name"));
        assert!(parse_sse_events(duplicate.as_bytes(), None, "token")
            .expect_err("duplicate sequence")
            .contains("strictly increasing"));
        assert!(
            parse_sse_events(payload.as_bytes(), Some("not-a-number"), "token")
                .expect_err("invalid cursor")
                .contains("cursor")
        );
    }

    #[test]
    fn streaming_sse_rejects_a_non_event_stream_content_type() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            let body = "<html>not an SSE response</html>";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });
        let error = request_sse(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            "/v2/captures/capture-1/events",
            None,
        )
        .expect_err("wrong content type must fail closed");
        assert_eq!(
            error,
            "Capture Runtime SSE response Content-Type was not text/event-stream."
        );
        server.join().expect("server");
    }

    #[test]
    fn capture_creation_retries_same_idempotent_request_after_lost_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                assert!(request.starts_with("POST /v2/captures HTTP/1.1"));
                assert!(request.contains("X-Idempotency-Key: capture-request-1"));
                assert!(request.contains("\"clientRequestId\":\"capture-request-1\""));
                if attempt == 1 {
                    let body = r#"{"captureId":"capture-1"}"#;
                    write!(
                        stream,
                        "HTTP/1.1 202 Accepted\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .expect("response");
                }
            }
        });

        let value = request_capture_with_recovery(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            RequestBody {
                bytes: br#"{"clientRequestId":"capture-request-1"}"#.to_vec(),
                content_type: "application/json".into(),
            },
            "capture-request-1",
        )
        .expect("idempotent recovery");

        assert_eq!(value["captureId"], "capture-1");
        server.join().expect("server");
    }

    #[test]
    fn capture_creation_recovers_by_client_request_id_after_two_lost_responses() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            for attempt in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                if attempt < 2 {
                    assert!(request.starts_with("POST /v2/captures HTTP/1.1"));
                    assert!(request.contains("X-Idempotency-Key: capture-request-2"));
                    continue;
                }
                assert!(request
                    .starts_with("GET /v2/captures/by-client-request/capture-request-2 HTTP/1.1",));
                let body = r#"{"captureId":"capture-recovered"}"#;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .expect("response");
            }
        });

        let value = request_capture_with_recovery(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            RequestBody {
                bytes: br#"{"clientRequestId":"capture-request-2"}"#.to_vec(),
                content_type: "application/json".into(),
            },
            "capture-request-2",
        )
        .expect("lookup recovery");

        assert_eq!(value["captureId"], "capture-recovered");
        server.join().expect("server");
    }

    #[test]
    fn streaming_upload_is_sequential_and_bounded_to_one_megabyte_chunks() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let source_path = PathBuf::from(std::env::temp_dir()).join(format!(
            "capture-workbench-streaming-test-{}.mp3",
            random_hex().expect("random id")
        ));
        let bytes = vec![0x41_u8; STREAM_CHUNK_BYTES + 17];
        let source_bytes = bytes.len() as u64;
        fs::write(&source_path, &bytes).expect("source");
        let server = thread::spawn(move || {
            for expected in [
                (0_u64, 0_u64, STREAM_CHUNK_BYTES as u64 - 1),
                (
                    1_u64,
                    STREAM_CHUNK_BYTES as u64,
                    STREAM_CHUNK_BYTES as u64 + 16,
                ),
            ] {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                assert!(request.starts_with(&format!(
                    "PUT /v2/ingestions/ingestion-1/chunks/{} HTTP/1.1",
                    expected.0
                )));
                assert!(request.contains(&format!(
                    "Content-Range: bytes {}-{}/{}",
                    expected.1, expected.2, source_bytes
                )));
                assert!(request.contains(&format!(
                    "X-Idempotency-Key: request-1-chunk-{}",
                    expected.0
                )));
                assert!(request.contains("Digest: sha-256="));
                let body = request.split("\r\n\r\n").nth(1).expect("body").as_bytes();
                let expected_len = (expected.2 - expected.1 + 1) as usize;
                assert_eq!(body.len(), expected_len);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                )
                .expect("response");
            }
        });
        upload_source_chunks(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            &RuntimeSourceFile {
                file_name: "sample.mp3".into(),
                media_type: "audio/mpeg".into(),
                path: source_path.clone(),
                bytes: source_bytes,
            },
            "ingestion-1",
            "request-1",
        )
        .expect("upload");
        server.join().expect("server");
        fs::remove_file(source_path).expect("cleanup");
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let separator = loop {
            let mut chunk = [0_u8; 8192];
            let count = stream.read(&mut chunk).expect("request");
            assert!(count > 0, "request ended before headers");
            request.extend_from_slice(&chunk[..count]);
            if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break position;
            }
        };
        let headers = String::from_utf8_lossy(&request[..separator]);
        let content_length = headers
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .expect("content length")
            .parse::<usize>()
            .expect("content length number");
        let body_start = separator + 4;
        while request.len() - body_start < content_length {
            let mut chunk = [0_u8; 8192];
            let count = stream.read(&mut chunk).expect("body");
            assert!(count > 0, "request ended before body");
            request.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(request).expect("utf8")
    }
}
