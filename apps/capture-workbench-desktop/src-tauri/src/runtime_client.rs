use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};

use crate::{
    config::BackendConfig,
    contracts::{RuntimeCreateCaptureInput, RuntimeIdInput, RuntimeInstallationStartInput},
    library::LibraryStore,
    state::DesktopState,
};

const MAX_RUNTIME_RESPONSE_BYTES: u64 = 60 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

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
        "/v1/captures",
        Some(body),
        Some(&input.client_request_id),
    )
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
        &format!("/v1/captures/{capture_id}{suffix}"),
        body,
        None,
    )
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
    use std::{net::TcpListener, thread};

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
                runtime_version: "0.3.6".into(),
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
}
