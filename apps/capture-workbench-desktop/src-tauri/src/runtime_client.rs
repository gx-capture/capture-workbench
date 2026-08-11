use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[cfg(test)]
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    config::BackendConfig,
    contracts::{
        LibraryCaptureUpdate, RuntimeClientRequestIdInput, RuntimeIdInput,
        RuntimeInstallationStartInput, RuntimeModelInstallationStartInput,
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
    persist_capture_recovery(
        library,
        &input.document_id,
        "processing",
        "uploading",
        None,
        Some("capture_pending"),
        Some("Capture request is pending runtime reconciliation."),
        Some(&input.client_request_id),
        None,
    )?;
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
        .ok_or_else(|| "Progressive ingestion response is invalid.".to_string())?
        .to_string();
    persist_capture_recovery(
        library,
        &input.document_id,
        "processing",
        "uploading",
        None,
        Some("capture_pending"),
        Some("Capture request is pending runtime reconciliation."),
        Some(&input.client_request_id),
        Some(&ingestion_id),
    )?;
    let client_request_id = input.client_request_id.clone();
    let result = (|| {
        upload_source_chunks(&config, &source, &ingestion_id, &client_request_id)?;
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
        .and_then(|value| {
            let capture_id = value
                .get("captureId")
                .and_then(Value::as_str)
                .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
            let stage = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("created");
            persist_capture_recovery(
                library,
                &input.document_id,
                "processing",
                stage,
                Some(capture_id),
                None,
                None,
                None,
                None,
            )?;
            Ok(value)
        })
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

fn persist_capture_recovery(
    library: &LibraryStore,
    document_id: &str,
    status: &str,
    stage: &str,
    capture_id: Option<&str>,
    recovery_code: Option<&str>,
    recovery_message: Option<&str>,
    client_request_id: Option<&str>,
    ingestion_id: Option<&str>,
) -> Result<(), String> {
    library
        .update_capture(LibraryCaptureUpdate {
            document_id: document_id.to_string(),
            capture_id: capture_id.map(str::to_string),
            clear_capture_id: false,
            status: status.to_string(),
            stage: Some(stage.to_string()),
            raw: None,
            result: None,
            error_code: None,
            error_message: None,
            recovery_code: recovery_code.map(str::to_string),
            recovery_message: recovery_message.map(str::to_string),
            recovery_client_request_id: client_request_id.map(str::to_string),
            recovery_ingestion_id: ingestion_id.map(str::to_string),
        })
        .map(|_| ())
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
    if !is_uncertain_capture_create_error(&first_error) {
        return Err(first_error);
    }
    match send() {
        Ok(value) => Ok(value),
        Err(second_error) if is_uncertain_capture_create_error(&second_error) => {
            let recovered = request_with_headers(
                config,
                "GET",
                &format!("/v2/captures/by-client-request/{client_request_id}"),
                None,
                None,
                &[],
            )
            .map_err(|_| first_error)?;
            validate_recovered_capture(recovered, &body)
                .map_err(|_| "Capture Runtime recovered a conflicting capture.".to_string())
        }
        Err(second_error) => Err(second_error),
    }
}

fn validate_recovered_capture(value: Value, body: &RequestBody) -> Result<Value, String> {
    let request: Value = serde_json::from_slice(&body.bytes)
        .map_err(|_| "Capture recovery request was invalid.".to_string())?;
    let expected_ingestion_id = request
        .get("ingestionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Capture recovery request was missing its ingestion identity.".to_string()
        })?;
    let recovered_ingestion_id = value
        .get("ingestionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Capture recovery response was missing its ingestion identity.".to_string()
        })?;
    if recovered_ingestion_id != expected_ingestion_id
        || value
            .get("captureId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err("Capture Runtime recovered a conflicting capture.".to_string());
    }
    Ok(value)
}

fn is_uncertain_capture_create_error(error: &str) -> bool {
    if matches!(
        error,
        "Capture Runtime is unavailable."
            | "Capture Runtime request could not be sent."
            | "Capture Runtime response could not be read."
            | "Capture Runtime response was malformed."
            | "Capture Runtime response was not valid JSON."
    ) {
        return true;
    }
    let Some(status) = error
        .strip_prefix("Capture Runtime request was rejected with HTTP ")
        .and_then(|value| value.strip_suffix('.'))
        .and_then(|value| value.parse::<u16>().ok())
    else {
        return false;
    };
    (500..=599).contains(&status)
}

pub(crate) fn streaming_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    streaming_value(state, "GET", &input.id, "", None, None)
}

pub(crate) fn streaming_capture_by_client_request(
    state: &DesktopState,
    input: RuntimeClientRequestIdInput,
) -> Result<Value, String> {
    validate_client_request_id(&input.client_request_id)?;
    let config = state.backend_config()?;
    null_for_http_rejection(
        request_with_headers(
            &config,
            "GET",
            &format!("/v2/captures/by-client-request/{}", input.client_request_id),
            None,
            None,
            &[],
        ),
        404,
    )
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

pub(crate) fn stream_streaming_events(
    state: &DesktopState,
    input: RuntimeStreamingEventsInput,
    channel: tauri::ipc::Channel<Value>,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    validate_opaque_id(&input.id)?;
    let config = state.backend_config()?;
    let last_event_id = input.last_event_id.map(|value| value.to_string());
    request_sse_stream(
        &config,
        &format!("/v2/captures/{}/events", input.id),
        last_event_id.as_deref(),
        Some(&input.id),
        cancellation.map(Arc::as_ref),
        |event| {
            channel
                .send(event)
                .map_err(|_| "Capture Runtime SSE channel closed.".to_string())
        },
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

pub(crate) fn delete_streaming_ingestion(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    validate_opaque_id(&input.id)?;
    let config = state.backend_config()?;
    null_for_http_rejection(
        request_with_headers(
            &config,
            "DELETE",
            &format!("/v2/ingestions/{}", input.id),
            None,
            None,
            &[],
        ),
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
    let mut events = Vec::new();
    request_sse_stream(
        config,
        path,
        last_event_id,
        capture_id_from_events_path(path),
        None,
        |event| {
            events.push(event);
            Ok(())
        },
    )?;
    Ok(Value::Array(events))
}

fn request_sse_stream<F>(
    config: &BackendConfig,
    path: &str,
    last_event_id: Option<&str>,
    expected_capture_id: Option<&str>,
    cancellation: Option<&AtomicBool>,
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(Value) -> Result<(), String>,
{
    let port = loopback_port(&config.base_url)?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, REQUEST_TIMEOUT)
        .map_err(|_| "Capture Runtime is unavailable.".to_string())?;
    stream
        .set_read_timeout(Some(
            cancellation.map_or(REQUEST_TIMEOUT, |_| Duration::from_millis(250)),
        ))
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
    let mut response_prefix = Vec::new();
    let mut body_prefix = Vec::new();
    let mut total_bytes = 0_u64;
    let separator = loop {
        let mut chunk = [0_u8; 8192];
        let Some(count) = read_sse_chunk(&mut stream, &mut chunk, cancellation)? else {
            return Ok(());
        };
        if count == 0 {
            return Err("Capture Runtime response was malformed.".to_string());
        }
        total_bytes = total_bytes.saturating_add(count as u64);
        if total_bytes > MAX_RUNTIME_RESPONSE_BYTES {
            return Err("Capture Runtime response exceeded the desktop safety limit.".into());
        }
        response_prefix.extend_from_slice(&chunk[..count]);
        if let Some(index) = response_prefix
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            body_prefix.extend_from_slice(&response_prefix[index + 4..]);
            break index;
        }
        if response_prefix.len() > 64 * 1024 {
            return Err("Capture Runtime response headers were too large.".to_string());
        }
    };
    let headers = std::str::from_utf8(&response_prefix[..separator])
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

    let mut parser = SseParser::new(last_event_id, &config.token, expected_capture_id)?;
    parser.feed(&body_prefix, &mut on_event)?;
    loop {
        let mut chunk = [0_u8; 8192];
        let Some(count) = read_sse_chunk(&mut stream, &mut chunk, cancellation)? else {
            return Ok(());
        };
        if count == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(count as u64);
        if total_bytes > MAX_RUNTIME_RESPONSE_BYTES {
            return Err("Capture Runtime response exceeded the desktop safety limit.".into());
        }
        parser.feed(&chunk[..count], &mut on_event)?;
    }
    parser.finish(&mut on_event)
}

fn read_sse_chunk(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    cancellation: Option<&AtomicBool>,
) -> Result<Option<usize>, String> {
    loop {
        if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
            return Ok(None);
        }
        match stream.read(buffer) {
            Ok(count) => return Ok(Some(count)),
            Err(error)
                if cancellation.is_some()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
            {
                continue;
            }
            Err(_) => return Err("Capture Runtime response could not be read.".to_string()),
        }
    }
}

#[derive(Default)]
struct SseFrame {
    id: Option<String>,
    event: Option<String>,
    data: Vec<String>,
}

struct SseParser<'a> {
    frame: SseFrame,
    pending: Vec<u8>,
    previous_sequence: Option<u64>,
    token: &'a str,
    expected_capture_id: Option<&'a str>,
}

impl<'a> SseParser<'a> {
    fn new(
        cursor: Option<&str>,
        token: &'a str,
        expected_capture_id: Option<&'a str>,
    ) -> Result<Self, String> {
        let previous_sequence = cursor
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| "Capture Runtime SSE cursor was invalid.".to_string())
            })
            .transpose()?;
        Ok(Self {
            frame: SseFrame::default(),
            pending: Vec::new(),
            previous_sequence,
            token,
            expected_capture_id,
        })
    }

    fn feed<F>(&mut self, bytes: &[u8], on_event: &mut F) -> Result<(), String>
    where
        F: FnMut(Value) -> Result<(), String>,
    {
        self.pending.extend_from_slice(bytes);
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending.drain(..=index).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line, on_event)?;
        }
        Ok(())
    }

    fn finish<F>(&mut self, on_event: &mut F) -> Result<(), String>
    where
        F: FnMut(Value) -> Result<(), String>,
    {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.process_line(&line, on_event)?;
        }
        self.dispatch(on_event)
    }

    fn process_line<F>(&mut self, line: &[u8], on_event: &mut F) -> Result<(), String>
    where
        F: FnMut(Value) -> Result<(), String>,
    {
        let line = std::str::from_utf8(line)
            .map_err(|_| "Capture Runtime SSE response was not valid UTF-8.".to_string())?;
        if line.is_empty() {
            return self.dispatch(on_event);
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, raw_value) = line
            .split_once(':')
            .map_or((line, ""), |(field, value)| (field, value));
        let value = raw_value.strip_prefix(' ').unwrap_or(raw_value);
        match field {
            "data" => self.frame.data.push(value.to_string()),
            "id" => self.frame.id = Some(value.to_string()),
            "event" => self.frame.event = Some(value.to_string()),
            _ => {}
        }
        Ok(())
    }

    fn dispatch<F>(&mut self, on_event: &mut F) -> Result<(), String>
    where
        F: FnMut(Value) -> Result<(), String>,
    {
        if self.frame.data.is_empty() {
            self.frame = SseFrame::default();
            return Ok(());
        }
        let mut value: Value = serde_json::from_str(&self.frame.data.join("\n"))
            .map_err(|_| "Capture Runtime SSE event was not valid JSON.".to_string())?;
        let (sequence, event_type) = validate_capture_event(&value, self.expected_capture_id)?;
        if let Some(id) = self.frame.id.as_deref() {
            if id != sequence.to_string() {
                return Err("Capture Runtime SSE event id did not match its sequence.".to_string());
            }
        }
        if let Some(event) = self.frame.event.as_deref() {
            if event != event_type {
                return Err("Capture Runtime SSE event name did not match its payload.".to_string());
            }
        }
        if self
            .previous_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return Err(
                "Capture Runtime SSE event sequence was not strictly increasing.".to_string(),
            );
        }
        self.previous_sequence = Some(sequence);
        redact_token(&mut value, self.token);
        on_event(value)?;
        self.frame = SseFrame::default();
        Ok(())
    }
}

#[cfg(test)]
fn parse_sse_events(body: &[u8], cursor: Option<&str>, token: &str) -> Result<Value, String> {
    parse_sse_events_for_capture(body, cursor, token, None)
}

#[cfg(test)]
fn parse_sse_events_for_capture(
    body: &[u8],
    cursor: Option<&str>,
    token: &str,
    expected_capture_id: Option<&str>,
) -> Result<Value, String> {
    let mut events = Vec::new();
    let mut parser = SseParser::new(cursor, token, expected_capture_id)?;
    parser.feed(body, &mut |event| {
        events.push(event);
        Ok(())
    })?;
    parser.finish(&mut |event| {
        events.push(event);
        Ok(())
    })?;
    Ok(Value::Array(events))
}

fn capture_id_from_events_path(path: &str) -> Option<&str> {
    path.strip_prefix("/v2/captures/")?.strip_suffix("/events")
}

fn validate_capture_event(
    value: &Value,
    expected_capture_id: Option<&str>,
) -> Result<(u64, String), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Capture Runtime SSE event was not an object.".to_string())?;
    const EVENT_FIELDS: &[&str] = &[
        "protocolVersion",
        "eventId",
        "sequence",
        "captureId",
        "kind",
        "eventType",
        "stage",
        "progress",
        "partialRevision",
        "coveredUntilMs",
        "segments",
        "error",
        "createdAt",
    ];
    if object
        .keys()
        .any(|key| !EVENT_FIELDS.contains(&key.as_str()))
    {
        return Err("Capture Runtime SSE event contained an unexpected field.".to_string());
    }
    if object.get("protocolVersion").and_then(Value::as_str) != Some("2") {
        return Err("Capture Runtime SSE event protocol version was invalid.".to_string());
    }
    let event_id = object
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Capture Runtime SSE event identity was invalid.".to_string())?;
    let capture_id = object
        .get("captureId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Capture Runtime SSE event capture identity was invalid.".to_string())?;
    if expected_capture_id.is_some_and(|expected| expected != capture_id) {
        return Err(
            "Capture Runtime SSE event capture identity did not match the request.".to_string(),
        );
    }
    if !event_id.starts_with(&format!("{capture_id}/")) {
        return Err("Capture Runtime SSE event id did not match its capture identity.".to_string());
    }
    if !matches!(
        object.get("kind").and_then(Value::as_str),
        Some("pdf" | "image" | "audio")
    ) {
        return Err("Capture Runtime SSE event kind was invalid.".to_string());
    }
    let sequence = object
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Capture Runtime SSE event sequence was invalid.".to_string())?;
    let event_type = object
        .get("eventType")
        .and_then(Value::as_str)
        .filter(|event_type| {
            matches!(
                *event_type,
                "accepted"
                    | "input_checkpoint"
                    | "heartbeat"
                    | "segment"
                    | "checkpoint"
                    | "resync_required"
                    | "completed"
                    | "failed"
                    | "cancelled"
            )
        })
        .ok_or_else(|| "Capture Runtime SSE event type was invalid.".to_string())?
        .to_string();
    if object
        .get("stage")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("Capture Runtime SSE event stage was invalid.".to_string());
    }
    if let Some(progress) = object.get("progress") {
        if !progress.is_null()
            && !progress
                .as_f64()
                .is_some_and(|value| value.is_finite() && (0.0..=1.0).contains(&value))
        {
            return Err("Capture Runtime SSE event progress was invalid.".to_string());
        }
    }
    for field in ["partialRevision", "coveredUntilMs"] {
        if object
            .get(field)
            .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
        {
            return Err(format!("Capture Runtime SSE event {field} was invalid."));
        }
    }
    let segments = object.get("segments");
    if event_type == "segment"
        && !segments.is_some_and(|value| value.as_array().is_some_and(|items| !items.is_empty()))
    {
        return Err("Capture Runtime SSE segment event payload was invalid.".to_string());
    }
    if segments.is_some_and(|value| !value.is_null() && value.as_array().is_none()) {
        return Err("Capture Runtime SSE event segments payload was invalid.".to_string());
    }
    if let Some(segments) = segments.filter(|value| !value.is_null()) {
        validate_capture_segments(segments)?;
    }
    let error = object.get("error");
    if event_type == "failed" {
        let error = error
            .and_then(Value::as_object)
            .ok_or_else(|| "Capture Runtime SSE failed event payload was invalid.".to_string())?;
        validate_capture_failure(error)?;
    } else if error.is_some_and(|value| !value.is_null()) {
        return Err("Capture Runtime SSE non-failed event contained an error.".to_string());
    }
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "Capture Runtime SSE event timestamp was invalid.".to_string())?;
    if !valid_rfc3339_timestamp(created_at) {
        return Err("Capture Runtime SSE event timestamp was invalid.".to_string());
    }
    Ok((sequence, event_type))
}

fn validate_capture_segments(value: &Value) -> Result<(), String> {
    let items = value
        .as_array()
        .ok_or_else(|| "Capture Runtime SSE event segments payload was invalid.".to_string())?;
    for segment in items {
        let segment = segment
            .as_object()
            .ok_or_else(|| "Capture Runtime SSE segment payload was invalid.".to_string())?;
        if segment
            .keys()
            .any(|key| !["segmentId", "order", "locator", "text"].contains(&key.as_str()))
            || segment
                .get("segmentId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            || segment.get("order").and_then(Value::as_u64).is_none()
            || segment
                .get("text")
                .and_then(Value::as_str)
                .is_none_or(|text| text.is_empty() || text.chars().count() > 2_000_000)
        {
            return Err("Capture Runtime SSE segment payload was invalid.".to_string());
        }
        validate_capture_locator(
            segment
                .get("locator")
                .ok_or_else(|| "Capture Runtime SSE segment locator was invalid.".to_string())?,
        )?;
    }
    Ok(())
}

fn validate_capture_locator(value: &Value) -> Result<(), String> {
    let locator = value
        .as_object()
        .ok_or_else(|| "Capture Runtime SSE segment locator was invalid.".to_string())?;
    let kind = locator
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Capture Runtime SSE segment locator was invalid.".to_string())?;
    match kind {
        "page" => {
            if locator
                .keys()
                .any(|key| !["kind", "page", "boundingBox"].contains(&key.as_str()))
                || locator
                    .get("page")
                    .and_then(Value::as_u64)
                    .is_none_or(|page| page == 0)
            {
                return Err("Capture Runtime SSE segment locator was invalid.".to_string());
            }
            if let Some(bounding_box) = locator.get("boundingBox") {
                if !bounding_box.is_null()
                    && !bounding_box.as_array().is_some_and(|items| {
                        items.len() == 4
                            && items
                                .iter()
                                .all(|item| item.as_f64().is_some_and(|value| value.is_finite()))
                    })
                {
                    return Err("Capture Runtime SSE segment locator was invalid.".to_string());
                }
            }
        }
        "time" => {
            if locator
                .keys()
                .any(|key| !["kind", "startMs", "endMs"].contains(&key.as_str()))
                || locator.get("startMs").and_then(Value::as_u64).is_none()
                || locator
                    .get("endMs")
                    .and_then(Value::as_u64)
                    .is_none_or(|end| end == 0)
                || locator
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .zip(locator.get("endMs").and_then(Value::as_u64))
                    .is_some_and(|(start, end)| end <= start)
            {
                return Err("Capture Runtime SSE segment locator was invalid.".to_string());
            }
        }
        _ => return Err("Capture Runtime SSE segment locator was invalid.".to_string()),
    }
    Ok(())
}

fn validate_capture_failure(error: &serde_json::Map<String, Value>) -> Result<(), String> {
    if error
        .keys()
        .any(|key| !["code", "message", "stage", "retryable"].contains(&key.as_str()))
        || error
            .get("code")
            .and_then(Value::as_str)
            .is_none_or(|code| {
                !(2..=64).contains(&code.len())
                    || !code.bytes().enumerate().all(|(index, byte)| {
                        (index == 0 && byte.is_ascii_lowercase())
                            || (index > 0
                                && (byte.is_ascii_lowercase()
                                    || byte.is_ascii_digit()
                                    || byte == b'_'))
                    })
            })
        || error
            .get("message")
            .and_then(Value::as_str)
            .is_none_or(|message| message.is_empty() || message.chars().count() > 500)
        || error
            .get("stage")
            .is_some_and(|stage| !stage.is_null() && stage.as_str().is_none_or(str::is_empty))
        || error
            .get("retryable")
            .is_some_and(|retryable| retryable.as_bool().is_none())
    {
        return Err("Capture Runtime SSE failed event payload was invalid.".to_string());
    }
    Ok(())
}

fn valid_rfc3339_timestamp(value: &str) -> bool {
    let Some((date, time_and_zone)) = value.split_once('T') else {
        return false;
    };
    let date_bytes = date.as_bytes();
    if date_bytes.len() != 10
        || date_bytes[4] != b'-'
        || date_bytes[7] != b'-'
        || !date_bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let year = date[0..4].parse::<u16>().ok();
    let month = date[5..7].parse::<u8>().ok();
    let day = date[8..10].parse::<u8>().ok();
    if !year.is_some_and(|value| (1..=9999).contains(&value))
        || !month.is_some_and(|value| (1..=12).contains(&value))
        || !day.is_some_and(|value| {
            let month = month.expect("validated month");
            value >= 1 && value <= days_in_month(year.expect("validated year"), month)
        })
    {
        return false;
    }
    if let Some(clock) = time_and_zone.strip_suffix('Z') {
        return valid_rfc3339_clock(clock);
    }
    let (clock, offset) = if let Some((clock, offset)) = time_and_zone.rsplit_once('+') {
        (clock, offset)
    } else if let Some((clock, offset)) = time_and_zone.rsplit_once('-') {
        (clock, offset)
    } else {
        return false;
    };
    valid_rfc3339_clock(clock)
        && offset.len() == 5
        && offset.as_bytes()[2] == b':'
        && offset
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
        && offset[0..2].parse::<u8>().is_ok_and(|hours| hours <= 23)
        && offset[3..5]
            .parse::<u8>()
            .is_ok_and(|minutes| minutes <= 59)
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn valid_rfc3339_clock(value: &str) -> bool {
    let Some((whole, fraction)) = value.split_once('.') else {
        return valid_rfc3339_whole_clock(value);
    };
    !fraction.is_empty()
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
        && valid_rfc3339_whole_clock(whole)
}

fn valid_rfc3339_whole_clock(value: &str) -> bool {
    value.len() == 8
        && value.as_bytes()[2] == b':'
        && value.as_bytes()[5] == b':'
        && value
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit())
        && value[0..2].parse::<u8>().is_ok_and(|hours| hours <= 23)
        && value[3..5].parse::<u8>().is_ok_and(|minutes| minutes <= 59)
        && value[6..8].parse::<u8>().is_ok_and(|seconds| seconds <= 60)
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
                "data: {\"protocolVersion\":\"2\",\"eventId\":\"capture-1/8\",\"sequence\":8,\"captureId\":\"capture-1\",\"kind\":\"audio\",\"eventType\":\"checkpoint\",\"stage\":\"extracting-secret-token\",\"progress\":0.5,\"partialRevision\":1,\"createdAt\":\"2026-01-01T00:00:00Z\"}\r\n\r\n",
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
        assert_eq!(events[0]["stage"], "extracting-[REDACTED]");
        server.join().expect("server");
    }

    #[test]
    fn streaming_sse_implements_framing_metadata_and_strict_cursor_ordering() {
        let first = r#"{"protocolVersion":"2","eventId":"capture-1/8","sequence":8,"captureId":"capture-1","kind":"audio","eventType":"checkpoint","stage":"extracting-secret-token","progress":0.5,"partialRevision":1,"createdAt":"2026-01-01T00:00:00Z"}"#;
        let second = r#"{"protocolVersion":"2","eventId":"capture-1/9","sequence":9,"captureId":"capture-1","kind":"audio","eventType":"completed","stage":"completed","progress":1,"partialRevision":1,"createdAt":"2026-01-01T00:00:01Z"}"#;
        let body = format!(
            ": keep-alive\r\n\r\n\r\nid: 8\r\nevent: checkpoint\r\ndata:{}\r\ndata: {}\r\n\r\nid: 9\nevent: completed\ndata:{}\n\n",
            &first[..first.find(",\"stage\"").expect("split") + 1],
            &first[first.find(",\"stage\"").expect("split") + 1..],
            second,
        );

        let events =
            parse_sse_events(body.as_bytes(), Some("7"), "secret-token").expect("framed events");

        assert_eq!(events[0]["sequence"], 8);
        assert_eq!(events[0]["stage"], "extracting-[REDACTED]");
        assert_eq!(events[1]["eventType"], "completed");
    }

    #[test]
    fn streaming_sse_dispatches_each_frame_before_the_body_finishes() {
        let first = r#"{"protocolVersion":"2","eventId":"capture-1/8","sequence":8,"captureId":"capture-1","kind":"audio","eventType":"checkpoint","stage":"extracting","progress":0.5,"partialRevision":1,"createdAt":"2026-01-01T00:00:00Z"}"#;
        let second = r#"{"protocolVersion":"2","eventId":"capture-1/9","sequence":9,"captureId":"capture-1","kind":"audio","eventType":"completed","stage":"completed","progress":1,"partialRevision":1,"createdAt":"2026-01-01T00:00:01Z"}"#;
        let mut parser = SseParser::new(None, "token", Some("capture-1")).expect("parser");
        let mut events = Vec::new();
        {
            let mut collect = |event| {
                events.push(event);
                Ok(())
            };
            parser
                .feed(
                    format!("id: 8\nevent: checkpoint\ndata: {first}\n\n").as_bytes(),
                    &mut collect,
                )
                .expect("first event");
        }
        assert_eq!(events.len(), 1);
        {
            let mut collect = |event| {
                events.push(event);
                Ok(())
            };
            parser
                .feed(
                    format!("id: 9\nevent: completed\ndata: {second}\n\n").as_bytes(),
                    &mut collect,
                )
                .expect("second event");
            parser.finish(&mut collect).expect("stream finish");
        }
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn streaming_sse_rejects_metadata_mismatch_and_non_increasing_sequences() {
        let payload = r#"{"protocolVersion":"2","eventId":"capture-1/8","sequence":8,"captureId":"capture-1","kind":"audio","eventType":"checkpoint","stage":"extracting","progress":0.5,"partialRevision":1,"createdAt":"2026-01-01T00:00:00Z"}"#;
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
    fn streaming_sse_rejects_capture_event_boundary_invariant_violations() {
        let base = serde_json::json!({
            "protocolVersion": "2",
            "eventId": "capture-1/8",
            "sequence": 8,
            "captureId": "capture-1",
            "kind": "audio",
            "eventType": "checkpoint",
            "stage": "extracting",
            "progress": 0.5,
            "partialRevision": 1,
            "createdAt": "2026-01-01T00:00:00Z"
        });
        let mut identity = base.clone();
        identity["captureId"] = serde_json::json!("capture-2");
        let mut timestamp = base.clone();
        timestamp["createdAt"] = serde_json::json!("2026-01-01T00:00:00");
        let mut segment = base.clone();
        segment["eventType"] = serde_json::json!("segment");
        segment["segments"] = serde_json::json!([]);
        let mut failure = base.clone();
        failure["eventType"] = serde_json::json!("failed");
        let mut malformed_segment = base.clone();
        malformed_segment["eventType"] = serde_json::json!("segment");
        malformed_segment["segments"] = serde_json::json!([{
            "segmentId": "segment-1",
            "order": 0,
            "locator": {"kind": "time", "startMs": 100, "endMs": 100},
            "text": "segment"
        }]);
        let mut invalid_calendar = base.clone();
        invalid_calendar["createdAt"] = serde_json::json!("2026-02-30T00:00:00Z");
        let cases = [
            ("identity", identity, "capture identity"),
            ("timestamp", timestamp, "timestamp"),
            ("segment", segment, "segment event payload"),
            ("failure", failure, "failed event payload"),
            ("segment locator", malformed_segment, "segment locator"),
            ("calendar", invalid_calendar, "timestamp"),
        ];
        for (_name, value, expected) in cases {
            let body = format!(
                "id: 8\nevent: {}\ndata: {}\n\n",
                value["eventType"],
                serde_json::to_string(&value).expect("payload"),
            );
            assert!(
                parse_sse_events_for_capture(body.as_bytes(), None, "token", Some("capture-1"))
                    .expect_err("malformed event")
                    .contains(expected),
                "expected {expected} rejection",
            );
        }
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
                let body = r#"{"captureId":"capture-recovered","ingestionId":"ingestion-2"}"#;
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
                bytes: br#"{"clientRequestId":"capture-request-2","ingestionId":"ingestion-2"}"#
                    .to_vec(),
                content_type: "application/json".into(),
            },
            "capture-request-2",
        )
        .expect("lookup recovery");

        assert_eq!(value["captureId"], "capture-recovered");
        server.join().expect("server");
    }

    #[test]
    fn capture_creation_keeps_transport_failure_recoverable_when_lookup_also_fails() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            for attempt in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                if attempt < 2 {
                    assert!(request.starts_with("POST /v2/captures HTTP/1.1"));
                    assert!(request.contains("X-Idempotency-Key: capture-request-3"));
                    write!(
                        stream,
                        "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .expect("lost create response");
                } else {
                    assert!(request.starts_with(
                        "GET /v2/captures/by-client-request/capture-request-3 HTTP/1.1"
                    ));
                    write!(
                        stream,
                        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .expect("failed lookup response");
                }
            }
        });

        let error = request_capture_with_recovery(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            RequestBody {
                bytes: br#"{"clientRequestId":"capture-request-3","ingestionId":"ingestion-3"}"#
                    .to_vec(),
                content_type: "application/json".into(),
            },
            "capture-request-3",
        )
        .expect_err("both create responses and lookup must fail closed");

        assert_eq!(error, "Capture Runtime response was not valid JSON.");
        server.join().expect("server");
    }

    #[test]
    fn capture_creation_surfaces_deterministic_conflicts_without_retry_or_lookup() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_http_request(&mut stream);
            assert!(request.starts_with("POST /v2/captures HTTP/1.1"));
            write!(
                stream,
                "HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .expect("conflict response");
        });

        let error = request_capture_with_recovery(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            RequestBody {
                bytes:
                    br#"{"clientRequestId":"capture-conflict","ingestionId":"ingestion-conflict"}"#
                        .to_vec(),
                content_type: "application/json".into(),
            },
            "capture-conflict",
        )
        .expect_err("deterministic conflict");

        assert_eq!(error, "Capture Runtime request was rejected with HTTP 409.");
        server.join().expect("server");
    }

    #[test]
    fn capture_creation_does_not_lookup_after_uncertain_retry_returns_a_conflict() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            for (attempt, status) in [(0, 503), (1, 409)] {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                assert!(request.starts_with("POST /v2/captures HTTP/1.1"));
                assert!(request.contains("X-Idempotency-Key: capture-conflict-retry"));
                write!(
                    stream,
                    "HTTP/1.1 {status} Response\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .expect("response");
                assert!(attempt < 2);
            }
        });

        let error = request_capture_with_recovery(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            RequestBody {
                bytes: br#"{"clientRequestId":"capture-conflict-retry","ingestionId":"ingestion-conflict-retry"}"#.to_vec(),
                content_type: "application/json".into(),
            },
            "capture-conflict-retry",
        )
        .expect_err("retry conflict");

        assert_eq!(error, "Capture Runtime request was rejected with HTTP 409.");
        server.join().expect("server");
    }

    #[test]
    fn capture_creation_rejects_a_lookup_for_a_different_ingestion() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            for attempt in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                if attempt < 2 {
                    assert!(request.starts_with("POST /v2/captures HTTP/1.1"));
                    write!(
                        stream,
                        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .expect("uncertain response");
                } else {
                    assert!(request.starts_with(
                        "GET /v2/captures/by-client-request/capture-conflict-lookup HTTP/1.1"
                    ));
                    let body = r#"{"captureId":"capture-other","ingestionId":"ingestion-other"}"#;
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .expect("lookup response");
                }
            }
        });

        let error = request_capture_with_recovery(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            RequestBody {
                bytes: br#"{"clientRequestId":"capture-conflict-lookup","ingestionId":"ingestion-expected"}"#.to_vec(),
                content_type: "application/json".into(),
            },
            "capture-conflict-lookup",
        )
        .expect_err("conflicting lookup");

        assert_eq!(error, "Capture Runtime recovered a conflicting capture.");
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
