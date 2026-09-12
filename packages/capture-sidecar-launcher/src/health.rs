use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use serde::de::{DeserializeSeed, Deserializer, Error as DeError, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    constants::{HEALTH_PATH, LOOPBACK_HOST, MAX_HEALTH_RESPONSE_BYTES},
    manifest::SidecarManifest,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const STRICT_IO_POLL: Duration = Duration::from_millis(25);
const MAX_READINESS_SCHEMA_BYTES: u64 = 4 * 1024 * 1024;
const R3_SERVICE: &str = "capture-runtime";
const R3_API_VERSION: &str = "2.0";
const R3_RUNTIME_VERSION: &str = "0.4.2";
const R3_DOCUMENT_SCHEMA_VERSION: &str = "2";
const R3_CONTRACT_SET_VERSION: &str = "2";
pub(crate) const R3_SCHEMA_FILE_NAME: &str = "capture-document-v2.schema.json";
pub(crate) const CANONICAL_CAPTURE_DOCUMENT_V2_SHA256: &str =
    "850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335";

/// A schema identity is created only from the bounded bytes of the explicit
/// regular file named by the frozen manifest.  The path and bytes are not
/// retained across the readiness call.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct VerifiedReadinessSchema {
    file_name: String,
    sha256: String,
}

impl VerifiedReadinessSchema {
    pub(crate) fn sha256(&self) -> &str {
        &self.sha256
    }
}

/// Strict service-only readiness facts.  This value contains digests for
/// open-ended contract fields so no response body or bearer token crosses the
/// private adapter boundary.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct ServiceReadinessFacts {
    runtime_version: String,
    api_version: String,
    capture_document_schema_version: String,
    capture_document_schema_sha256: String,
    schema_sha256: Option<String>,
    contract_set_version: String,
    capabilities_sha256: String,
    ocr_compute_sha256: Option<String>,
    message_sha256: Option<String>,
}

impl ServiceReadinessFacts {
    /// A bounded digest of the validated service-only facts.  The response
    /// body and bearer token never cross this private lifecycle boundary.
    pub(crate) fn facts_digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"capture-runtime/service-readiness-facts/v1\0");
        digest_string(&mut hasher, &self.runtime_version);
        digest_string(&mut hasher, &self.api_version);
        digest_string(&mut hasher, &self.capture_document_schema_version);
        digest_string(&mut hasher, &self.capture_document_schema_sha256);
        digest_optional_string(&mut hasher, self.schema_sha256.as_deref());
        digest_string(&mut hasher, &self.contract_set_version);
        digest_string(&mut hasher, &self.capabilities_sha256);
        digest_optional_string(&mut hasher, self.ocr_compute_sha256.as_deref());
        digest_optional_string(&mut hasher, self.message_sha256.as_deref());
        format!("{:x}", hasher.finalize())
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum StrictProbeResult {
    Ready(ServiceReadinessFacts),
    NotReady,
    Cancelled,
}

enum StrictIoResult<T> {
    Value(T),
    NotReady,
    Cancelled,
}

fn validate_r3_manifest(manifest: &SidecarManifest) -> Result<(), String> {
    if manifest.runtime_version != R3_RUNTIME_VERSION
        || manifest.api_version != R3_API_VERSION
        || manifest.capture_document_schema_version != R3_DOCUMENT_SCHEMA_VERSION
        || manifest.schema_file_name != R3_SCHEMA_FILE_NAME
        || !valid_sha256(manifest.schema_sha256.as_str())
    {
        return Err("Capture runtime readiness manifest was incompatible with R3.".into());
    }
    Ok(())
}

/// Verifies the explicit RuntimeReady schema file against the frozen
/// manifest before a service response can be accepted.
#[allow(dead_code)]
pub(crate) fn verify_readiness_schema(
    schema_path: &Path,
    manifest: &SidecarManifest,
) -> Result<VerifiedReadinessSchema, String> {
    validate_r3_manifest(manifest)?;
    let expected_name = &manifest.schema_file_name;
    if !plain_file_name(expected_name)
        || !schema_path.is_absolute()
        || schema_path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
    {
        return Err(
            "Capture runtime readiness schema path was not the expected plain file.".into(),
        );
    }
    let metadata = fs::symlink_metadata(schema_path)
        .map_err(|_| "Capture runtime readiness schema was unavailable.".to_string())?;
    if !metadata.is_file() {
        return Err("Capture runtime readiness schema was not a regular file.".into());
    }
    if metadata.len() > MAX_READINESS_SCHEMA_BYTES {
        return Err("Capture runtime readiness schema exceeded the safety limit.".into());
    }
    let file = fs::File::open(schema_path)
        .map_err(|_| "Capture runtime readiness schema could not be opened.".to_string())?;
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| "Capture runtime readiness schema was too large.".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(MAX_READINESS_SCHEMA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Capture runtime readiness schema could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_READINESS_SCHEMA_BYTES {
        return Err("Capture runtime readiness schema exceeded the safety limit.".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != manifest.schema_sha256 {
        return Err("Capture runtime readiness schema digest did not match the manifest.".into());
    }
    Ok(VerifiedReadinessSchema {
        file_name: expected_name.clone(),
        sha256: digest,
    })
}

/// Probes the strict RuntimeReady contract against one caller-owned absolute
/// deadline.  It never refreshes a per-root timeout and checks cancellation at
/// every boundary that can otherwise turn a late response into readiness.
#[allow(dead_code)]
pub(crate) fn probe_service_ready(
    port: u16,
    token: &str,
    manifest: &SidecarManifest,
    schema: &VerifiedReadinessSchema,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<StrictProbeResult, String> {
    validate_r3_manifest(manifest)?;
    if cancellation.load(Ordering::Acquire) {
        return Ok(StrictProbeResult::Cancelled);
    }
    if remaining_budget(deadline).is_none() {
        return Ok(StrictProbeResult::NotReady);
    }
    if token.is_empty()
        || token
            .bytes()
            .any(|byte| byte == 0 || byte == b'\r' || byte == b'\n')
    {
        return Err("Capture runtime readiness token was invalid.".into());
    }
    if schema.sha256 != manifest.schema_sha256 || schema.file_name != manifest.schema_file_name {
        return Err("Capture runtime readiness schema identity did not match the manifest.".into());
    }
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Some(remaining) = remaining_budget(deadline) else {
        return Ok(StrictProbeResult::NotReady);
    };
    let mut stream = match TcpStream::connect_timeout(&address, remaining.min(CONNECT_TIMEOUT)) {
        Ok(stream) => stream,
        Err(_) => return Ok(StrictProbeResult::NotReady),
    };
    if cancellation.load(Ordering::Acquire) {
        return Ok(StrictProbeResult::Cancelled);
    }
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    match write_strict_request(&mut stream, request.as_bytes(), deadline, cancellation)? {
        StrictIoResult::Value(()) => {}
        StrictIoResult::NotReady => return Ok(StrictProbeResult::NotReady),
        StrictIoResult::Cancelled => return Ok(StrictProbeResult::Cancelled),
    }
    let response = match read_strict_response(&mut stream, deadline, cancellation)? {
        StrictIoResult::Value(response) => response,
        StrictIoResult::NotReady => return Ok(StrictProbeResult::NotReady),
        StrictIoResult::Cancelled => return Ok(StrictProbeResult::Cancelled),
    };
    if cancellation.load(Ordering::Acquire) {
        return Ok(StrictProbeResult::Cancelled);
    }
    if remaining_budget(deadline).is_none() {
        return Ok(StrictProbeResult::NotReady);
    }
    let result = match parse_strict_health_response(&response, manifest, schema) {
        Ok(StrictParsedResponse::Ready(facts)) => Ok(StrictProbeResult::Ready(facts)),
        Ok(StrictParsedResponse::NotReady) => Ok(StrictProbeResult::NotReady),
        Err(error) => Err(error),
    };
    if cancellation.load(Ordering::Acquire) {
        return Ok(StrictProbeResult::Cancelled);
    }
    if remaining_budget(deadline).is_none() {
        return Ok(StrictProbeResult::NotReady);
    }
    result
}

/// Readiness handshake returned by `/v2/health/ready`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyHandshake {
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

/// Result of one bounded readiness probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeResult {
    Ready(ReadyHandshake),
    NotReady,
}

/// Probes the authenticated loopback readiness endpoint once.
pub fn probe_ready_once(
    port: u16,
    token: &str,
    manifest: &SidecarManifest,
) -> Result<ProbeResult, String> {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Some(remaining) = remaining_budget(deadline) else {
        return Ok(ProbeResult::NotReady);
    };
    let mut stream = match TcpStream::connect_timeout(&address, remaining.min(CONNECT_TIMEOUT)) {
        Ok(stream) => stream,
        Err(_) => return Ok(ProbeResult::NotReady),
    };
    let Some(remaining) = remaining_budget(deadline) else {
        return Ok(ProbeResult::NotReady);
    };
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if !write_request(&mut stream, request.as_bytes(), deadline)? {
        return Ok(ProbeResult::NotReady);
    }

    let Some(response) = read_response(&mut stream, deadline)? else {
        return Ok(ProbeResult::NotReady);
    };
    if remaining_budget(deadline).is_none() {
        return Ok(ProbeResult::NotReady);
    }
    finish_probe_result(parse_health_response(&response, manifest), deadline)
}

fn remaining_budget(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
}

fn write_request(
    stream: &mut TcpStream,
    request: &[u8],
    deadline: Instant,
) -> Result<bool, String> {
    write_request_with_deadline(stream, request, deadline, |stream, remaining| {
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())
    })
}

fn write_request_with_deadline<W, F>(
    writer: &mut W,
    request: &[u8],
    deadline: Instant,
    mut set_timeout: F,
) -> Result<bool, String>
where
    W: Write,
    F: FnMut(&mut W, Duration) -> Result<(), String>,
{
    let mut written = 0;
    while written < request.len() {
        let Some(remaining) = remaining_budget(deadline) else {
            return Ok(false);
        };
        set_timeout(writer, remaining)?;
        match writer.write(&request[written..]) {
            Ok(0) => return Ok(false),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Ok(false),
        }
    }
    Ok(true)
}

fn finish_probe_result(
    result: Result<ProbeResult, String>,
    deadline: Instant,
) -> Result<ProbeResult, String> {
    if remaining_budget(deadline).is_none() {
        Ok(ProbeResult::NotReady)
    } else {
        result
    }
}

fn write_strict_request(
    stream: &mut TcpStream,
    request: &[u8],
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<StrictIoResult<()>, String> {
    let mut written = 0;
    while written < request.len() {
        if cancellation.load(Ordering::Acquire) {
            return Ok(StrictIoResult::Cancelled);
        }
        let Some(remaining) = remaining_budget(deadline) else {
            return Ok(StrictIoResult::NotReady);
        };
        stream
            .set_write_timeout(Some(remaining.min(PROBE_TIMEOUT)))
            .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
        match stream.write(&request[written..]) {
            Ok(0) => return Ok(StrictIoResult::NotReady),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Ok(StrictIoResult::NotReady),
        }
    }
    if cancellation.load(Ordering::Acquire) {
        Ok(StrictIoResult::Cancelled)
    } else {
        Ok(StrictIoResult::Value(()))
    }
}

fn read_strict_response(
    stream: &mut TcpStream,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<StrictIoResult<Vec<u8>>, String> {
    let max_bytes = usize::try_from(MAX_HEALTH_RESPONSE_BYTES)
        .expect("health response limit must fit in usize");
    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        if cancellation.load(Ordering::Acquire) {
            return Ok(StrictIoResult::Cancelled);
        }
        let Some(remaining) = remaining_budget(deadline) else {
            return Ok(StrictIoResult::NotReady);
        };
        stream
            .set_read_timeout(Some(remaining.min(PROBE_TIMEOUT).min(STRICT_IO_POLL)))
            .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
        let available = (max_bytes + 1 - response.len()).min(chunk.len());
        match stream.read(&mut chunk[..available]) {
            Ok(0) => {
                if cancellation.load(Ordering::Acquire) {
                    return Ok(StrictIoResult::Cancelled);
                }
                return if remaining_budget(deadline).is_some() {
                    Ok(StrictIoResult::Value(response))
                } else {
                    Ok(StrictIoResult::NotReady)
                };
            }
            Ok(count) => {
                response.extend_from_slice(&chunk[..count]);
                if response.len() > max_bytes {
                    return Err(
                        "Capture runtime readiness response exceeded the safety limit.".into(),
                    );
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::Interrupted | ErrorKind::TimedOut | ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            Err(_) => return Ok(StrictIoResult::NotReady),
        }
    }
}

fn read_response(stream: &mut TcpStream, deadline: Instant) -> Result<Option<Vec<u8>>, String> {
    let max_bytes = usize::try_from(MAX_HEALTH_RESPONSE_BYTES)
        .expect("health response limit must fit in usize");
    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        let Some(remaining) = remaining_budget(deadline) else {
            return Ok(None);
        };
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
        let available = (max_bytes + 1 - response.len()).min(chunk.len());
        match stream.read(&mut chunk[..available]) {
            Ok(0) => {
                return Ok(remaining_budget(deadline).map(|_| response));
            }
            Ok(count) => {
                response.extend_from_slice(&chunk[..count]);
                if response.len() > max_bytes {
                    return Err(
                        "Capture runtime readiness response exceeded the safety limit.".into(),
                    );
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        }
    }
}

fn parse_strict_health_response(
    response: &[u8],
    manifest: &SidecarManifest,
    schema: &VerifiedReadinessSchema,
) -> Result<StrictParsedResponse, String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Capture runtime readiness response was malformed.".to_string())?;
    let framing = parse_strict_http_headers(&response[..separator])?;
    let body = &response[separator + 4..];
    if let Some(expected_length) = framing.content_length {
        if body.len() != expected_length {
            return Err("Capture runtime readiness body length was inconsistent.".into());
        }
    } else if framing.version == "HTTP/1.1" && !framing.connection_close {
        return Err("Capture runtime readiness body had no unambiguous boundary.".into());
    }
    if framing.status == 503 {
        return Ok(StrictParsedResponse::NotReady);
    }
    if framing.status != 200 {
        return Err("Capture runtime readiness request was rejected.".into());
    }
    if !framing.json_content_type {
        return Err("Capture runtime readiness content type was not JSON.".into());
    }
    let value = parse_json_without_duplicate_keys(body)
        .map_err(|_| "Capture runtime readiness body was invalid JSON.".to_string())?;
    validate_strict_handshake(&value, manifest, schema).map(StrictParsedResponse::Ready)
}

struct StrictHttpFraming<'a> {
    version: &'a str,
    status: u16,
    content_length: Option<usize>,
    connection_close: bool,
    json_content_type: bool,
}

fn parse_strict_http_headers(headers: &[u8]) -> Result<StrictHttpFraming<'_>, String> {
    let headers = std::str::from_utf8(headers)
        .map_err(|_| "Capture runtime readiness headers were not UTF-8.".to_string())?;
    let mut lines = headers.split("\r\n");
    let status_line = lines
        .next()
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "Capture runtime readiness status was malformed.".to_string())?;
    let mut status_parts = status_line.splitn(3, ' ');
    let version = status_parts
        .next()
        .filter(|version| *version == "HTTP/1.0" || *version == "HTTP/1.1")
        .ok_or_else(|| "Capture runtime readiness HTTP version was unsupported.".to_string())?;
    let status = status_parts
        .next()
        .filter(|status| status.len() == 3 && status.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "Capture runtime readiness status was malformed.".to_string())?;
    if status_parts.next().is_none() {
        return Err("Capture runtime readiness status was malformed.".into());
    }

    let mut content_length = None;
    let mut connection_close = false;
    let mut json_content_type = false;
    let mut saw_content_type = false;
    let mut saw_transfer_encoding = false;
    for line in lines {
        if line.is_empty() {
            return Err("Capture runtime readiness headers were malformed.".into());
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| "Capture runtime readiness headers were malformed.".to_string())?;
        if !valid_http_header_name(name)
            || value
                .bytes()
                .any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
        {
            return Err("Capture runtime readiness headers were malformed.".into());
        }
        let name = name.to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "content-length" => {
                let parsed = value.parse::<usize>().map_err(|_| {
                    "Capture runtime readiness content length was malformed.".to_string()
                })?;
                if content_length.is_some_and(|previous| previous != parsed) {
                    return Err("Capture runtime readiness content lengths conflicted.".into());
                }
                content_length = Some(parsed);
            }
            "content-type" => {
                let media_type = value.split(';').next().map(str::trim).unwrap_or_default();
                if !media_type.eq_ignore_ascii_case("application/json") {
                    return Err("Capture runtime readiness content type was not JSON.".into());
                }
                saw_content_type = true;
                json_content_type = true;
            }
            "transfer-encoding" => {
                saw_transfer_encoding = true;
            }
            "connection" => {
                connection_close |= value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("close"));
            }
            _ => {}
        }
    }
    if saw_transfer_encoding && content_length.is_some() {
        return Err("Capture runtime readiness transfer encoding conflicted with length.".into());
    }
    if saw_transfer_encoding {
        return Err("Capture runtime readiness transfer encoding was unsupported.".into());
    }
    if !saw_content_type {
        json_content_type = false;
    }
    Ok(StrictHttpFraming {
        version,
        status,
        content_length,
        connection_close,
        json_content_type,
    })
}

fn valid_http_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
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
                )
        })
}

enum StrictParsedResponse {
    Ready(ServiceReadinessFacts),
    NotReady,
}

fn validate_strict_handshake(
    value: &Value,
    manifest: &SidecarManifest,
    schema: &VerifiedReadinessSchema,
) -> Result<ServiceReadinessFacts, String> {
    validate_r3_manifest(manifest)?;
    let object = value
        .as_object()
        .ok_or_else(|| "Capture runtime readiness body was not an object.".to_string())?;
    const ALLOWED: &[&str] = &[
        "ready",
        "service",
        "apiVersion",
        "runtimeVersion",
        "captureDocumentSchemaVersion",
        "captureDocumentSchemaSha256",
        "schemaSha256",
        "contractSetVersion",
        "capabilities",
        "ocrCompute",
        "message",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("Capture runtime readiness body contained an unknown field.".into());
    }
    if object.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err("Capture runtime did not report ready.".into());
    }
    required_const_string(object, "service", R3_SERVICE)?;
    let api_version = required_const_string(object, "apiVersion", R3_API_VERSION)?;
    let runtime_version = required_const_string(object, "runtimeVersion", R3_RUNTIME_VERSION)?;
    let document_version = required_const_string(
        object,
        "captureDocumentSchemaVersion",
        R3_DOCUMENT_SCHEMA_VERSION,
    )?;
    let contract_set_version =
        required_const_string(object, "contractSetVersion", R3_CONTRACT_SET_VERSION)?;

    let capture_document_schema_sha256 = required_sha256(
        object.get("captureDocumentSchemaSha256"),
        "captureDocumentSchemaSha256",
    )?;
    if capture_document_schema_sha256 != schema.sha256 {
        return Err(
            "Capture runtime document schema digest did not match the verified schema.".into(),
        );
    }
    let schema_sha256 = optional_sha256(object.get("schemaSha256"), "schemaSha256")?;
    let capabilities = match object.get("capabilities") {
        Some(Value::Object(capabilities)) => Value::Object(capabilities.clone()),
        None | Some(_) => {
            return Err("Capture runtime readiness capabilities were not an object.".into());
        }
    };
    let ocr_compute = match object.get("ocrCompute") {
        None | Some(Value::Null) => None,
        Some(value) => {
            validate_ocr_compute(value)?;
            Some(value.clone())
        }
    };
    let message = match object.get("message") {
        None | Some(Value::Null) => None,
        Some(Value::String(message)) => Some(message.as_str()),
        Some(_) => return Err("Capture runtime readiness message was not a string.".into()),
    };
    Ok(ServiceReadinessFacts {
        runtime_version,
        api_version,
        capture_document_schema_version: document_version,
        capture_document_schema_sha256,
        schema_sha256,
        contract_set_version,
        capabilities_sha256: digest_json(&capabilities),
        ocr_compute_sha256: ocr_compute.as_ref().map(digest_json),
        message_sha256: message.map(|message| digest_bytes(message.as_bytes())),
    })
}

fn const_string(object: &Map<String, Value>, key: &str, expected: &str) -> Result<String, String> {
    match object.get(key) {
        None => Ok(expected.to_owned()),
        Some(Value::String(actual)) if actual == expected => Ok(actual.clone()),
        Some(_) => Err(format!(
            "Capture runtime readiness {key} was incompatible with the verified contract."
        )),
    }
}

fn required_const_string(
    object: &Map<String, Value>,
    key: &str,
    expected: &str,
) -> Result<String, String> {
    match object.get(key) {
        Some(Value::String(actual)) if actual == expected => Ok(actual.clone()),
        None | Some(_) => Err(format!(
            "Capture runtime readiness {key} was missing or incompatible with the verified contract."
        )),
    }
}

fn required_sha256(value: Option<&Value>, key: &str) -> Result<String, String> {
    match value {
        Some(Value::String(value)) if valid_sha256(value) => Ok(value.clone()),
        None | Some(_) => Err(format!(
            "Capture runtime readiness {key} was missing or invalid."
        )),
    }
}

fn optional_sha256(value: Option<&Value>, key: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_sha256(value) => Ok(Some(value.clone())),
        Some(_) => Err(format!(
            "Capture runtime readiness {key} was not a valid SHA-256 value."
        )),
    }
}

fn validate_ocr_compute(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Capture runtime readiness ocrCompute was not an object.".to_string())?;
    const ALLOWED: &[&str] = &[
        "apiVersion",
        "schemaVersion",
        "service",
        "runtimeVersion",
        "contractSetVersion",
        "contractSha256",
        "workerSha256",
        "mode",
        "adapterClass",
        "reasonCode",
        "userNoticeRequired",
        "noticeCode",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("Capture runtime readiness ocrCompute contained an unknown field.".into());
    }
    if const_string(object, "apiVersion", R3_API_VERSION)? != R3_API_VERSION
        || const_string(object, "schemaVersion", "1")? != "1"
        || const_string(object, "service", R3_SERVICE)? != R3_SERVICE
        || const_string(object, "runtimeVersion", R3_RUNTIME_VERSION)? != R3_RUNTIME_VERSION
        || const_string(object, "contractSetVersion", R3_CONTRACT_SET_VERSION)?
            != R3_CONTRACT_SET_VERSION
    {
        return Err("Capture runtime readiness ocrCompute identity was invalid.".into());
    }
    if !matches!(object.get("contractSha256"), Some(Value::String(value)) if valid_sha256(value)) {
        return Err("Capture runtime readiness ocrCompute contract digest was invalid.".into());
    }
    match object.get("workerSha256") {
        None | Some(Value::Null) => {}
        Some(Value::String(value)) if valid_sha256(value) => {}
        _ => {
            return Err("Capture runtime readiness ocrCompute worker digest was invalid.".into());
        }
    }
    let mode = match object.get("mode") {
        Some(Value::String(mode)) if mode == "gpu-dml" || mode == "cpu-fallback" => mode,
        _ => return Err("Capture runtime readiness ocrCompute mode was invalid.".into()),
    };
    let adapter_class = match object.get("adapterClass") {
        Some(Value::String(adapter_class))
            if matches!(
                adapter_class.as_str(),
                "dedicated" | "integrated" | "unknown"
            ) =>
        {
            adapter_class
        }
        _ => return Err("Capture runtime readiness ocrCompute adapter was invalid.".into()),
    };
    let _ = adapter_class;
    let user_notice_required = object
        .get("userNoticeRequired")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            "Capture runtime readiness ocrCompute notice flag was invalid.".to_string()
        })?;
    let reason_code = match object.get("reasonCode") {
        None | Some(Value::Null) => None,
        Some(Value::String(reason))
            if matches!(
                reason.as_str(),
                "no_compatible_gpu" | "dml_provider_unavailable"
            ) =>
        {
            Some(reason.as_str())
        }
        Some(_) => {
            return Err("Capture runtime readiness ocrCompute reason was invalid.".into());
        }
    };
    let notice_code = match object.get("noticeCode") {
        None | Some(Value::Null) => None,
        Some(Value::String(notice)) if notice == "ocr_cpu_fallback" => Some(notice.as_str()),
        Some(_) => {
            return Err("Capture runtime readiness ocrCompute notice was invalid.".into());
        }
    };
    if mode == "gpu-dml" {
        if reason_code.is_some() || user_notice_required || notice_code.is_some() {
            return Err(
                "Capture runtime readiness GPU preflight carried a fallback notice.".into(),
            );
        }
    } else if reason_code.is_none()
        || !user_notice_required
        || notice_code != Some("ocr_cpu_fallback")
    {
        return Err("Capture runtime readiness CPU preflight was incomplete.".into());
    }
    Ok(())
}

fn plain_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && Path::new(value)
            .file_name()
            .is_some_and(|name| name == value)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn digest_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn digest_optional_string(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            digest_string(hasher, value);
        }
        None => {
            hasher.update([0]);
        }
    }
}

fn digest_json(value: &Value) -> String {
    let mut bytes = Vec::new();
    write_canonical_json(value, &mut bytes);
    digest_bytes(&bytes)
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        Value::String(value) => output.extend_from_slice(
            serde_json::to_string(value)
                .expect("JSON strings are serializable")
                .as_bytes(),
        ),
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json(value, output);
            }
            output.push(b']');
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
            output.push(b'{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .expect("JSON keys are serializable")
                        .as_bytes(),
                );
                output.push(b':');
                write_canonical_json(value, output);
            }
            output.push(b'}');
        }
    }
}

struct NoDuplicateJson;

impl<'de> DeserializeSeed<'de> for NoDuplicateJson {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(NoDuplicateJsonVisitor)
    }
}

struct NoDuplicateJsonVisitor;

impl<'de> Visitor<'de> for NoDuplicateJsonVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: DeError,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        NoDuplicateJson.deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(NoDuplicateJson)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(A::Error::custom("duplicate JSON object key"));
            }
            values.insert(key, map.next_value_seed(NoDuplicateJson)?);
        }
        Ok(Value::Object(values))
    }
}

fn parse_json_without_duplicate_keys(bytes: &[u8]) -> Result<Value, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = NoDuplicateJson
        .deserialize(&mut deserializer)
        .map_err(|_| "JSON object contained a duplicate or malformed value.".to_string())?;
    deserializer
        .end()
        .map_err(|_| "JSON body contained trailing data.".to_string())?;
    Ok(value)
}

fn parse_health_response(
    response: &[u8],
    manifest: &SidecarManifest,
) -> Result<ProbeResult, String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Capture runtime readiness response was malformed.".to_string())?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "Capture runtime readiness headers were not UTF-8.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Capture runtime readiness status was malformed.".to_string())?;
    if status == 503 {
        return Ok(ProbeResult::NotReady);
    }
    if status != 200 {
        return Err(format!(
            "Capture runtime readiness request was rejected with HTTP {status}."
        ));
    }

    let body = &response[separator + 4..];
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| "Capture runtime readiness body was invalid JSON.".to_string())?;
    validate_handshake(&value, manifest).map(ProbeResult::Ready)
}

fn validate_handshake(value: &Value, manifest: &SidecarManifest) -> Result<ReadyHandshake, String> {
    let ready = value.get("ready").and_then(Value::as_bool).unwrap_or(false)
        || value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("ready"));
    if !ready {
        return Err("Capture runtime did not report ready.".into());
    }
    if value.get("capabilities").is_none_or(Value::is_null) {
        return Err("Capture runtime readiness response omitted capabilities.".into());
    }

    let runtime_version = response_string(value, "runtimeVersion")?;
    let api_version = response_string(value, "apiVersion")?;
    let schema_version = response_string(value, "captureDocumentSchemaVersion")?;
    compare_handshake(
        "runtimeVersion",
        &runtime_version,
        &manifest.runtime_version,
    )?;
    compare_handshake("apiVersion", &api_version, &manifest.api_version)?;
    compare_handshake(
        "captureDocumentSchemaVersion",
        &schema_version,
        &manifest.capture_document_schema_version,
    )?;

    Ok(ReadyHandshake {
        runtime_version,
        api_version,
        capture_document_schema_version: schema_version,
    })
}

fn response_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .or_else(|| value.get("versions").and_then(|versions| versions.get(key)))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Capture runtime readiness response omitted {key}."))
}

fn compare_handshake(name: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime readiness {name} is incompatible with the verified manifest."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{self, Write},
        net::TcpListener,
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };

    fn manifest() -> SidecarManifest {
        SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: 1,
            sha256: "0".repeat(64),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        }
    }

    fn verified_schema(directory: &Path) -> (SidecarManifest, VerifiedReadinessSchema) {
        let schema_path = directory.join("capture-document-v2.schema.json");
        let schema_bytes =
            br#"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}"#;
        fs::write(&schema_path, schema_bytes).expect("schema");
        let mut manifest = manifest();
        manifest.schema_sha256 = digest_bytes(schema_bytes);
        let schema = verify_readiness_schema(&schema_path, &manifest).expect("verified schema");
        (manifest, schema)
    }

    fn strict_body(_manifest: &SidecarManifest, schema: &VerifiedReadinessSchema) -> Value {
        serde_json::json!({
            "ready": true,
            "service": R3_SERVICE,
            "apiVersion": R3_API_VERSION,
            "runtimeVersion": R3_RUNTIME_VERSION,
            "captureDocumentSchemaVersion": R3_DOCUMENT_SCHEMA_VERSION,
            "captureDocumentSchemaSha256": schema.sha256,
            "schemaSha256": null,
            "contractSetVersion": "2",
            "capabilities": {},
            "ocrCompute": null,
            "message": null
        })
    }

    fn http_response(body: &Value) -> Vec<u8> {
        let body = serde_json::to_vec(body).expect("body");
        let content_length = format!("Content-Length: {}", body.len());
        raw_http_response(
            "HTTP/1.1 200 OK",
            &[
                "Content-Type: application/json; charset=utf-8",
                content_length.as_str(),
                "Connection: close",
            ],
            &body,
        )
    }

    fn raw_http_response(status_line: &str, headers: &[&str], body: &[u8]) -> Vec<u8> {
        let mut response = format!("{status_line}\r\n").into_bytes();
        for header in headers {
            response.extend_from_slice(header.as_bytes());
            response.extend_from_slice(b"\r\n");
        }
        response.extend_from_slice(b"\r\n");
        response.extend_from_slice(body);
        response
    }

    fn serve_response(response: Vec<u8>) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            stream.write_all(&response).expect("response");
        });
        (port, server)
    }

    fn parse_strict_body(
        body: Value,
        manifest: &SidecarManifest,
        schema: &VerifiedReadinessSchema,
    ) -> Result<ServiceReadinessFacts, String> {
        match parse_strict_health_response(&http_response(&body), manifest, schema)? {
            StrictParsedResponse::Ready(facts) => Ok(facts),
            StrictParsedResponse::NotReady => Err("response was not ready".into()),
        }
    }

    #[test]
    fn strict_probe_accepts_runtime_ready_with_nullable_optional_fields() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let (port, server) = serve_response(http_response(&strict_body(&manifest, &schema)));
        let cancellation = AtomicBool::new(false);
        let result = probe_service_ready(
            port,
            "secret-token",
            &manifest,
            &schema,
            Instant::now() + Duration::from_secs(2),
            &cancellation,
        )
        .expect("strict probe");
        let StrictProbeResult::Ready(facts) = result else {
            panic!("valid RuntimeReady response was not accepted");
        };
        assert_eq!(facts.runtime_version, "0.4.2");
        assert_eq!(facts.api_version, "2.0");
        assert_eq!(facts.capture_document_schema_version, "2");
        assert_eq!(facts.capture_document_schema_sha256, schema.sha256);
        assert_eq!(facts.schema_sha256, None);
        assert_eq!(facts.contract_set_version, "2");
        assert!(!facts.capabilities_sha256.is_empty());
        assert!(facts.ocr_compute_sha256.is_none());
        assert!(facts.message_sha256.is_none());
        server.join().expect("server");
    }

    #[test]
    fn strict_probe_uses_one_absolute_deadline_and_cancellation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let cancellation = AtomicBool::new(true);
        assert!(matches!(
            probe_service_ready(
                0,
                "secret-token",
                &manifest,
                &schema,
                Instant::now() + Duration::from_secs(2),
                &cancellation
            )
            .expect("cancelled probe"),
            StrictProbeResult::Cancelled
        ));

        let cancellation = AtomicBool::new(false);
        assert!(matches!(
            probe_service_ready(
                0,
                "secret-token",
                &manifest,
                &schema,
                Instant::now()
                    .checked_sub(Duration::from_millis(1))
                    .expect("past deadline"),
                &cancellation
            )
            .expect("expired probe"),
            StrictProbeResult::NotReady
        ));
    }

    #[test]
    fn strict_schema_identity_rejects_missing_nonregular_wrong_name_and_tampered_files() {
        let directory = tempfile::tempdir().expect("tempdir");
        let schema_path = directory.path().join("capture-document-v2.schema.json");
        let bytes = b"schema";
        let mut manifest = manifest();
        manifest.schema_sha256 = digest_bytes(bytes);

        assert!(verify_readiness_schema(&schema_path, &manifest).is_err());
        fs::create_dir(&schema_path).expect("schema directory");
        assert!(verify_readiness_schema(&schema_path, &manifest).is_err());
        fs::remove_dir(&schema_path).expect("remove schema directory");

        let wrong_name = directory.path().join("other.schema.json");
        fs::write(&wrong_name, bytes).expect("wrong schema name");
        assert!(verify_readiness_schema(&wrong_name, &manifest).is_err());

        fs::write(&schema_path, bytes).expect("schema");
        let verified = verify_readiness_schema(&schema_path, &manifest).expect("schema");
        fs::write(&schema_path, b"schemA").expect("tamper schema");
        assert_eq!(verified.sha256, manifest.schema_sha256);
        assert!(verify_readiness_schema(&schema_path, &manifest).is_err());
    }

    #[test]
    fn strict_r3_rejects_a_foreign_manifest_even_with_a_matching_schema() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (mut foreign_manifest, foreign_schema) = verified_schema(directory.path());
        foreign_manifest.runtime_version = "0.4.3".into();
        assert!(verify_readiness_schema(
            &directory.path().join(R3_SCHEMA_FILE_NAME),
            &foreign_manifest
        )
        .is_err());
        assert!(parse_strict_body(
            strict_body(&foreign_manifest, &foreign_schema),
            &foreign_manifest,
            &foreign_schema
        )
        .is_err());
    }

    #[test]
    fn strict_handshake_rejects_unknown_duplicate_bad_identity_and_scalar_fields() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let cases = [
            ("ready", serde_json::json!(1)),
            ("service", serde_json::json!("other-service")),
            ("apiVersion", serde_json::json!(2)),
            ("runtimeVersion", serde_json::json!("0.4.1")),
            ("captureDocumentSchemaVersion", serde_json::json!("1")),
            ("contractSetVersion", serde_json::json!("1")),
            ("capabilities", serde_json::json!([])),
            ("message", serde_json::json!(false)),
            (
                "captureDocumentSchemaSha256",
                serde_json::json!("0".repeat(64)),
            ),
            ("schemaSha256", serde_json::json!(42)),
            ("unexpected", serde_json::json!(true)),
        ];
        for (field, value) in cases {
            let mut body = strict_body(&manifest, &schema);
            body[field] = value;
            assert!(
                parse_strict_body(body, &manifest, &schema).is_err(),
                "field {field} was accepted"
            );
        }

        for field in [
            "ready",
            "service",
            "apiVersion",
            "runtimeVersion",
            "captureDocumentSchemaVersion",
            "captureDocumentSchemaSha256",
            "contractSetVersion",
            "capabilities",
        ] {
            let mut body = strict_body(&manifest, &schema);
            body.as_object_mut().expect("object").remove(field);
            assert!(
                parse_strict_body(body, &manifest, &schema).is_err(),
                "required field {field} was omitted"
            );
        }

        let mut null_document_digest = strict_body(&manifest, &schema);
        null_document_digest["captureDocumentSchemaSha256"] = Value::Null;
        assert!(parse_strict_body(null_document_digest, &manifest, &schema).is_err());

        let duplicate = format!(
            r#"{{"ready":true,"ready":false,"service":"capture-runtime","apiVersion":"2.0","runtimeVersion":"0.4.2","captureDocumentSchemaVersion":"2","contractSetVersion":"2","capabilities":{{}}}}"#
        );
        let body = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            duplicate.len(),
            duplicate
        );
        assert!(parse_strict_health_response(body.as_bytes(), &manifest, &schema).is_err());

        let duplicate_nested = r#"{"ready":true,"service":"capture-runtime","apiVersion":"2.0","runtimeVersion":"0.4.2","captureDocumentSchemaVersion":"2","contractSetVersion":"2","capabilities":{"x":1,"x":2}}"#;
        let body = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            duplicate_nested.len(),
            duplicate_nested
        );
        assert!(parse_strict_health_response(body.as_bytes(), &manifest, &schema).is_err());
    }

    #[test]
    fn strict_handshake_validates_optional_ocr_compute_contract() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let mut body = strict_body(&manifest, &schema);
        body["ocrCompute"] = serde_json::json!({
            "contractSha256": "a".repeat(64),
            "mode": "cpu-fallback",
            "adapterClass": "unknown",
            "reasonCode": "no_compatible_gpu",
            "userNoticeRequired": true,
            "noticeCode": "ocr_cpu_fallback"
        });
        let facts = parse_strict_body(body, &manifest, &schema).expect("ocr preflight");
        assert!(facts.ocr_compute_sha256.is_some());

        let mut invalid = strict_body(&manifest, &schema);
        invalid["ocrCompute"] = serde_json::json!({
            "contractSha256": "a".repeat(64),
            "mode": "gpu-dml",
            "adapterClass": "unknown",
            "userNoticeRequired": true
        });
        assert!(parse_strict_body(invalid, &manifest, &schema).is_err());
    }

    #[test]
    fn strict_probe_treats_service_unavailable_as_not_ready() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let response = b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n";
        assert!(matches!(
            parse_strict_health_response(response, &manifest, &schema),
            Ok(StrictParsedResponse::NotReady)
        ));
    }

    #[test]
    fn strict_http_framing_rejects_ambiguous_or_unsupported_responses() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let body = serde_json::to_vec(&strict_body(&manifest, &schema)).expect("body");
        let body_length = format!("Content-Length: {}", body.len());

        let invalid_protocol = raw_http_response(
            "HTTP/9 200 OK",
            &[
                "Content-Type: application/json",
                body_length.as_str(),
                "Connection: close",
            ],
            &body,
        );
        let (port, server) = serve_response(invalid_protocol);
        let cancellation = AtomicBool::new(false);
        assert!(probe_service_ready(
            port,
            "secret-token",
            &manifest,
            &schema,
            Instant::now() + Duration::from_secs(2),
            &cancellation,
        )
        .is_err());
        server.join().expect("invalid protocol server");

        let http10_eof = raw_http_response(
            "HTTP/1.0 200 OK",
            &["Content-Type: application/json; charset=utf-8"],
            &body,
        );
        assert!(matches!(
            parse_strict_health_response(&http10_eof, &manifest, &schema),
            Ok(StrictParsedResponse::Ready(_))
        ));

        let http11_ambiguous_eof = raw_http_response(
            "HTTP/1.1 200 OK",
            &["Content-Type: application/json"],
            &body,
        );
        assert!(parse_strict_health_response(&http11_ambiguous_eof, &manifest, &schema).is_err());

        let conflicting_length = raw_http_response(
            "HTTP/1.1 200 OK",
            &[
                "Content-Type: application/json",
                "Content-Length: 1",
                body_length.as_str(),
                "Connection: close",
            ],
            &body,
        );
        assert!(parse_strict_health_response(&conflicting_length, &manifest, &schema).is_err());

        let transfer_with_length = raw_http_response(
            "HTTP/1.1 200 OK",
            &[
                "Content-Type: application/json",
                body_length.as_str(),
                "Transfer-Encoding: chunked",
                "Connection: close",
            ],
            &body,
        );
        assert!(parse_strict_health_response(&transfer_with_length, &manifest, &schema).is_err());

        let unsupported_transfer = raw_http_response(
            "HTTP/1.1 200 OK",
            &[
                "Content-Type: application/json",
                "Transfer-Encoding: chunked",
                "Connection: close",
            ],
            &body,
        );
        assert!(parse_strict_health_response(&unsupported_transfer, &manifest, &schema).is_err());

        let unsupported_content_type = raw_http_response(
            "HTTP/1.1 200 OK",
            &[
                "Content-Type: text/plain",
                body_length.as_str(),
                "Connection: close",
            ],
            &body,
        );
        assert!(
            parse_strict_health_response(&unsupported_content_type, &manifest, &schema).is_err()
        );

        let malformed_header = raw_http_response(
            "HTTP/1.1 200 OK",
            &[
                "Content-Type: application/json",
                "Content-Length",
                "Connection: close",
            ],
            &body,
        );
        assert!(parse_strict_health_response(&malformed_header, &manifest, &schema).is_err());
    }

    #[test]
    fn strict_probe_rejects_partial_and_late_responses() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let partial_response =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"ready\":true"
                .to_vec();
        let (port, server) = serve_response(partial_response);
        let cancellation = AtomicBool::new(false);
        let error = probe_service_ready(
            port,
            "secret-token",
            &manifest,
            &schema,
            Instant::now() + Duration::from_secs(2),
            &cancellation,
        );
        assert!(error.is_err(), "partial response was accepted");
        server.join().expect("partial server");

        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            let body = r#"{"ready":true,"service":"capture-runtime","apiVersion":"2.0","runtimeVersion":"0.4.2","captureDocumentSchemaVersion":"2","capabilities":{}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            thread::sleep(Duration::from_millis(150));
            let _ = stream.write_all(response.as_bytes());
        });
        let cancellation = AtomicBool::new(false);
        let result = probe_service_ready(
            port,
            "secret-token",
            &manifest,
            &schema,
            Instant::now() + Duration::from_millis(100),
            &cancellation,
        )
        .expect("late probe");
        assert!(matches!(result, StrictProbeResult::NotReady));
        server.join().expect("late server");
    }

    #[test]
    fn strict_probe_cancellation_during_socket_read_cannot_accept_ready() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (manifest, schema) = verified_schema(directory.path());
        let response = http_response(&strict_body(&manifest, &schema));
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let cancellation = Arc::new(AtomicBool::new(false));
        let server_cancellation = Arc::clone(&cancellation);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            thread::sleep(Duration::from_millis(75));
            server_cancellation.store(true, Ordering::Release);
            stream.write_all(&response).expect("response");
        });

        let started = Instant::now();
        let result = probe_service_ready(
            port,
            "secret-token",
            &manifest,
            &schema,
            Instant::now() + Duration::from_secs(2),
            cancellation.as_ref(),
        )
        .expect("cancelled probe");
        assert!(matches!(result, StrictProbeResult::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(1));
        server.join().expect("server");
    }

    struct ScriptedWriter {
        output: Vec<u8>,
        attempts: usize,
        timeouts: Vec<Duration>,
        delay: Duration,
    }

    impl Write for ScriptedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            thread::sleep(self.delay);
            match self.attempts {
                0 => {
                    self.attempts += 1;
                    let count = bytes.len().min(1);
                    self.output.extend_from_slice(&bytes[..count]);
                    Ok(count)
                }
                1 => {
                    self.attempts += 1;
                    Err(io::Error::from(ErrorKind::Interrupted))
                }
                _ => {
                    self.attempts += 1;
                    self.output.extend_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct ZeroProgressWriter;

    impl Write for ZeroProgressWriter {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            Ok(0)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn request_writer_retries_short_and_interrupted_writes_with_remaining_deadline() {
        let mut writer = ScriptedWriter {
            output: Vec::new(),
            attempts: 0,
            timeouts: Vec::new(),
            delay: Duration::from_millis(10),
        };
        let deadline = Instant::now() + Duration::from_millis(200);
        let completed =
            write_request_with_deadline(&mut writer, b"request", deadline, |writer, remaining| {
                writer.timeouts.push(remaining);
                Ok(())
            })
            .expect("write");

        assert!(completed);
        assert_eq!(writer.output, b"request");
        assert_eq!(writer.attempts, 3);
        assert_eq!(writer.timeouts.len(), 3);
        assert!(writer
            .timeouts
            .windows(2)
            .all(|window| window[0] > window[1]));
    }

    #[test]
    fn request_writer_fails_closed_on_zero_progress() {
        let mut writer = ZeroProgressWriter;
        let completed = write_request_with_deadline(
            &mut writer,
            b"request",
            Instant::now() + Duration::from_secs(1),
            |_writer, _remaining| Ok(()),
        )
        .expect("write");

        assert!(!completed);
    }

    #[test]
    fn request_writer_makes_no_progress_after_deadline() {
        let mut writer = ScriptedWriter {
            output: Vec::new(),
            attempts: 0,
            timeouts: Vec::new(),
            delay: Duration::ZERO,
        };
        let deadline = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .expect("past deadline");
        let completed =
            write_request_with_deadline(&mut writer, b"request", deadline, |writer, remaining| {
                writer.timeouts.push(remaining);
                Ok(())
            })
            .expect("write");

        assert!(!completed);
        assert_eq!(writer.attempts, 0);
        assert!(writer.timeouts.is_empty());
    }

    #[test]
    fn post_parse_deadline_never_accepts_ready() {
        let ready = Ok(ProbeResult::Ready(ReadyHandshake {
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        }));
        let deadline = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .expect("past deadline");

        assert_eq!(
            finish_probe_result(ready, deadline),
            Ok(ProbeResult::NotReady)
        );
    }

    #[test]
    fn authenticated_ready_handshake_is_exact_and_token_is_only_in_request() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            sender.send(request[..count].to_vec()).expect("send");
            let body = r#"{"ready":true,"runtimeVersion":"0.4.2","apiVersion":"2.0","captureDocumentSchemaVersion":"2","capabilities":{}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });

        let result = probe_ready_once(port, "secret-token", &manifest()).expect("probe");
        assert!(matches!(result, ProbeResult::Ready(_)));
        let request = String::from_utf8(receiver.recv().expect("request")).expect("utf8");
        assert!(request.contains("Authorization: Bearer secret-token"));
        server.join().expect("server");
    }

    #[test]
    fn incompatible_handshake_does_not_echo_the_received_value() {
        let body = br#"{"ready":true,"runtimeVersion":"0.4.2","apiVersion":"2.0","captureDocumentSchemaVersion":"99","capabilities":{}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        );
        let error = parse_health_response(response.as_bytes(), &manifest()).expect_err("schema");
        assert!(error.contains("captureDocumentSchemaVersion"));
        assert!(!error.contains("99"));
    }

    #[test]
    fn partial_response_is_rejected_without_echoing_the_token() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{\"ready\":true")
                .expect("partial response");
        });

        let error = probe_ready_once(port, "partial-secret-token", &manifest())
            .expect_err("partial response");
        assert!(error.contains("invalid JSON"));
        assert!(!error.contains("partial-secret-token"));
        server.join().expect("server");
    }

    #[test]
    fn silent_peer_is_bounded_by_the_whole_probe_deadline() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (release, wait) = mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("accept");
            wait.recv().expect("release");
        });

        let started = Instant::now();
        let result = probe_ready_once(port, "silent-secret-token", &manifest());
        let elapsed = started.elapsed();
        assert_eq!(result, Ok(ProbeResult::NotReady));
        assert!(elapsed < Duration::from_secs(2), "probe took {elapsed:?}");
        release.send(()).expect("release server");
        server.join().expect("server");
    }

    #[test]
    fn slow_drip_response_cannot_extend_the_whole_probe_deadline() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\n\r\n{")
                .expect("response prefix");
            for _ in 0..16 {
                thread::sleep(Duration::from_millis(150));
                if stream.write_all(b" ").is_err() {
                    break;
                }
            }
        });

        let started = Instant::now();
        let result = probe_ready_once(port, "slow-secret-token", &manifest());
        let elapsed = started.elapsed();
        assert_eq!(result, Ok(ProbeResult::NotReady));
        assert!(elapsed < Duration::from_secs(2), "probe took {elapsed:?}");
        server.join().expect("server");
    }

    #[test]
    fn oversized_response_is_rejected_before_unbounded_read() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            let body = vec![b'x'; MAX_HEALTH_RESPONSE_BYTES as usize + 1];
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            stream.write_all(headers.as_bytes()).expect("headers");
            stream.write_all(&body).expect("body");
        });

        let error = probe_ready_once(port, "oversized-secret-token", &manifest())
            .expect_err("oversized response");
        assert!(error.contains("safety limit"));
        assert!(!error.contains("oversized-secret-token"));
        server.join().expect("server");
    }
}
