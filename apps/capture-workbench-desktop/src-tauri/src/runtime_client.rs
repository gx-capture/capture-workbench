use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    config::BackendConfig,
    contracts::{
        RuntimeCreateCaptureInput, RuntimeIdInput, RuntimeInstallationStartInput,
        RuntimeModelInstallationStartInput, RuntimeStreamingCaptureInput,
        RuntimeStreamingEventsInput,
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
    request_json(state, "GET", "/v2/runtime/requirements", None, None)
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
        "/v2/runtime/installations",
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
        &format!("/v2/runtime/installations/{}", input.id),
        None,
        None,
    )
}

pub(crate) fn model_options(state: &DesktopState) -> Result<Value, String> {
    request_json(state, "GET", "/v2/runtime/model-options", None, None)
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
        "/v2/runtime/model-installations",
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
        &format!("/v2/runtime/model-installations/{}", input.id),
        None,
        None,
    )
}

pub(crate) fn create_capture(
    state: &DesktopState,
    library: &LibraryStore,
    input: RuntimeCreateCaptureInput,
) -> Result<Value, String> {
    validate_document_id(&input.document_id)?;
    validate_client_request_id(&input.client_request_id)?;
    let source = library.runtime_source(&input.document_id)?;
    let source_kind = match source.media_type.as_str() {
        "application/pdf" => "pdf",
        "image/png" | "image/jpeg" => "image",
        "audio/wav" | "audio/mpeg" | "audio/mp4" => "audio",
        _ => return Err("Capture source media type is unsupported.".into()),
    };
    let body = multipart_capture_body(
        &source.file_name,
        &source.media_type,
        source_kind,
        &source.bytes,
    )?;
    request_json(
        state,
        "POST",
        "/v2/captures",
        Some(body),
        Some(&input.client_request_id),
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
    if !source.media_type.starts_with("audio/") {
        return Err("Progressive capture is available only for audio sources.".into());
    }
    let config = state.backend_config()?;
    let ingestion = request_with_headers(
        &config,
        "POST",
        "/v2/ingestions",
        Some(RequestBody {
            bytes: serde_json::to_vec(&json!({
                "clientRequestId": format!("{}-ingestion", input.client_request_id),
                "kind": "audio",
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
    let result = (|| {
        upload_source_chunks(&config, &source, ingestion_id, &input.client_request_id)?;
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
        request_json(
            state,
            "POST",
            "/v2/captures",
            Some(RequestBody {
                bytes: serde_json::to_vec(&json!({
                    "clientRequestId": input.client_request_id,
                    "ingestionId": ingestion_id,
                    "structuringMode": input.structuring_mode,
                    "startPolicy": "eager",
                }))
                .map_err(|_| "Progressive capture request cannot be encoded.".to_string())?,
                content_type: "application/json".into(),
            }),
            None,
        )
    })();
    if result.is_err() {
        let _ = request_json(
            state,
            "DELETE",
            &format!("/v2/ingestions/{ingestion_id}"),
            None,
            None,
        );
    }
    result
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

pub(crate) fn capture(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    capture_value(state, "GET", &input.id, "", None)
}

pub(crate) fn cancel_capture(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    capture_value(state, "POST", &input.id, "/cancel", None)
}

pub(crate) fn raw_capture(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    null_for_http_rejection(capture_value(state, "GET", &input.id, "/raw", None), 409)
}

pub(crate) fn capture_result(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    capture_value(state, "GET", &input.id, "/result", None)
}

pub(crate) fn delete_capture(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    null_for_http_rejection(capture_value(state, "DELETE", &input.id, "", None), 404)
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

fn capture_value(
    state: &DesktopState,
    method: &str,
    capture_id: &str,
    suffix: &str,
    body: Option<RequestBody>,
) -> Result<Value, String> {
    validate_opaque_id(capture_id)?;
    request_json(
        state,
        method,
        &format!("/v2/captures/{capture_id}{suffix}"),
        body,
        None,
    )
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
    let events = response[separator + 4..]
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(b"data: "))
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut value: Value = serde_json::from_slice(line)
                .map_err(|_| "Capture Runtime SSE event was not valid JSON.".to_string())?;
            redact_token(&mut value, &config.token);
            Ok(value)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Value::Array(events))
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

fn multipart_capture_body(
    file_name: &str,
    media_type: &str,
    source_kind: &str,
    bytes: &[u8],
) -> Result<RequestBody, String> {
    if file_name.is_empty()
        || file_name
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'"' | b'\\'))
    {
        return Err("Capture source file name is invalid.".into());
    }
    let boundary = format!("capture-workbench-{}", random_hex()?);
    let mut body = Vec::with_capacity(bytes.len() + 1024);
    multipart_field(
        &mut body,
        &boundary,
        "file",
        bytes,
        Some((file_name, media_type)),
    );
    multipart_field(
        &mut body,
        &boundary,
        "sourceKind",
        source_kind.as_bytes(),
        None,
    );
    multipart_field(&mut body, &boundary, "structuringMode", b"runtime", None);
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(RequestBody {
        bytes: body,
        content_type: format!("multipart/form-data; boundary={boundary}"),
    })
}

fn multipart_field(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    value: &[u8],
    file: Option<(&str, &str)>,
) {
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    if let Some((file_name, media_type)) = file {
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\nContent-Type: {media_type}\r\n\r\n"
            )
            .as_bytes(),
        );
    } else {
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(value);
    body.extend_from_slice(b"\r\n");
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
                runtime_version: "0.4.1".into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
            },
            "GET",
            "/v2/runtime/requirements",
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
                "data: {\"sequence\":8,\"message\":\"secret-token\"}\r\n\r\n",
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });
        let events = request_sse(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "secret-token".into(),
                runtime_version: "0.4.1".into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
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
                runtime_version: "0.4.1".into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
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
