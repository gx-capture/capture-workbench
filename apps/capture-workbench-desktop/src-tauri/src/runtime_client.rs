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

#[derive(Clone)]
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
    let ingestion_id =
        open_ingestion_with_recovery(&config, &source, source_kind, &input.client_request_id)?;
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
    let capture_body = RequestBody {
        bytes: serde_json::to_vec(&json!({
            "clientRequestId": client_request_id.clone(),
            "ingestionId": ingestion_id,
            "structuringMode": input.structuring_mode,
            "startPolicy": "eager",
        }))
        .map_err(|_| "Progressive capture request cannot be encoded.".to_string())?,
        content_type: "application/json".into(),
    };
    let mut capture_request_attempted = false;
    let mut capture_response_accepted = false;
    let mut capture_create_uncertain = false;
    let capture_expectation = CaptureStartExpectation {
        ingestion_id: ingestion_id.clone(),
        kind: source_kind.to_string(),
        file_name: source.file_name.clone(),
        media_type: source.media_type.clone(),
        total_bytes: source.bytes,
    };
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
        capture_request_attempted = true;
        let capture = match request_capture_with_recovery_state(
            &config,
            capture_body.clone(),
            &client_request_id,
        ) {
            Ok(value) => value,
            Err(error) => {
                capture_create_uncertain = error.uncertain;
                return Err(error.message);
            }
        };
        capture_response_accepted = true;
        Ok::<Value, String>(capture).and_then(|value| {
            let capture_id = validate_capture_start_response(&value, &capture_expectation)?;
            let stage = value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("created");
            persist_capture_recovery(
                library,
                &input.document_id,
                "processing",
                stage,
                Some(&capture_id),
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
        Err(error)
            if capture_response_accepted
                || (capture_request_attempted
                    && (capture_create_uncertain || is_uncertain_runtime_error(&error))) =>
        {
            match reconcile_capture_by_client_request(
                &config,
                &client_request_id,
                &capture_expectation,
            ) {
                CaptureReconciliation::Committed(value) if is_uncertain_runtime_error(&error) => {
                    match validate_capture_start_response(&value, &capture_expectation) {
                        Ok(capture_id) => {
                            let stage = value
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("created");
                            persist_capture_recovery(
                                library,
                                &input.document_id,
                                "processing",
                                stage,
                                Some(&capture_id),
                                None,
                                None,
                                None,
                                None,
                            )?;
                            Ok(value)
                        }
                        Err(_) => {
                            persist_capture_recovery(
                                library,
                                &input.document_id,
                                "recovery_required",
                                "capture",
                                None,
                                Some("capture_pending"),
                                Some(
                                    "Capture request could not be safely reconciled; retry is required.",
                                ),
                                Some(&client_request_id),
                                Some(&ingestion_id),
                            )?;
                            Err(error)
                        }
                    }
                }
                CaptureReconciliation::ConfirmedAbsent => {
                    Err(cleanup_uncommitted_ingestion(&config, &ingestion_id, error))
                }
                CaptureReconciliation::Committed(_) | CaptureReconciliation::Unknown => {
                    persist_capture_recovery(
                        library,
                        &input.document_id,
                        "recovery_required",
                        "capture",
                        None,
                        Some("capture_pending"),
                        Some("Capture request could not be safely reconciled; retry is required."),
                        Some(&client_request_id),
                        Some(&ingestion_id),
                    )?;
                    Err(error)
                }
            }
        }
        Err(error) => Err(cleanup_uncommitted_ingestion(&config, &ingestion_id, error)),
    }
}

fn open_ingestion_with_recovery(
    config: &BackendConfig,
    source: &RuntimeSourceFile,
    source_kind: &str,
    client_request_id: &str,
) -> Result<String, String> {
    validate_client_request_id(client_request_id)?;
    let ingestion_request = RequestBody {
        bytes: serde_json::to_vec(&json!({
            "clientRequestId": client_request_id,
            "kind": source_kind,
            "mode": "file",
            "fileName": source.file_name.clone(),
            "mediaType": source.media_type.clone(),
            "totalBytes": source.bytes,
        }))
        .map_err(|_| "Progressive ingestion request cannot be encoded.".to_string())?,
        content_type: "application/json".into(),
    };
    let response = request_with_headers(
        config,
        "POST",
        "/v2/ingestions",
        Some(ingestion_request),
        None,
        &[],
    );
    match response {
        Ok(ingestion) => {
            match validate_open_ingestion_response(
                &ingestion,
                source_kind,
                &source.file_name,
                &source.media_type,
                source.bytes,
            ) {
                Ok(ingestion_id) => Ok(ingestion_id),
                Err(validation_error) => {
                    match lookup_ingestion_by_client_request(config, client_request_id) {
                        Ok(recovered) => {
                            match validate_open_ingestion_response(
                                &recovered,
                                source_kind,
                                &source.file_name,
                                &source.media_type,
                                source.bytes,
                            ) {
                                Ok(ingestion_id) => Ok(ingestion_id),
                                Err(_) => Err(validation_error),
                            }
                        }
                        Err(_) => Err(validation_error),
                    }
                }
            }
        }
        Err(error) if is_uncertain_runtime_error(&error) => {
            match lookup_ingestion_by_client_request(config, client_request_id) {
                Ok(recovered) => validate_open_ingestion_response(
                    &recovered,
                    source_kind,
                    &source.file_name,
                    &source.media_type,
                    source.bytes,
                ),
                Err(lookup_error) if is_http_rejection(&lookup_error, 404) => Err(error),
                Err(_) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

fn lookup_ingestion_by_client_request(
    config: &BackendConfig,
    client_request_id: &str,
) -> Result<Value, String> {
    request_with_headers(
        config,
        "GET",
        &format!(
            "/v2/ingestions/by-client-request/{}",
            encode_path_segment(client_request_id)
        ),
        None,
        None,
        &[],
    )
}

fn validate_open_ingestion_response(
    value: &Value,
    expected_kind: &str,
    expected_file_name: &str,
    expected_media_type: &str,
    expected_total_bytes: u64,
) -> Result<String, String> {
    if value.get("protocolVersion").and_then(Value::as_str) != Some("2") {
        return Err("Progressive ingestion response is invalid.".into());
    }
    if value.get("status").and_then(Value::as_str) != Some("open") {
        return Err("Progressive ingestion response is invalid.".into());
    }
    let ingestion_id = value
        .get("ingestionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Progressive ingestion response is invalid.".to_string())?;
    validate_opaque_id(ingestion_id)
        .map_err(|_| "Progressive ingestion response identity is invalid.".to_string())?;
    if value.get("kind").and_then(Value::as_str) != Some(expected_kind)
        || value.get("fileName").and_then(Value::as_str) != Some(expected_file_name)
        || value.get("mediaType").and_then(Value::as_str) != Some(expected_media_type)
        || value.get("totalBytes").and_then(Value::as_u64) != Some(expected_total_bytes)
    {
        return Err("Progressive ingestion response identity is invalid.".into());
    }
    Ok(ingestion_id.to_string())
}

enum CaptureReconciliation {
    Committed(Value),
    ConfirmedAbsent,
    Unknown,
}

struct CaptureStartExpectation {
    ingestion_id: String,
    kind: String,
    file_name: String,
    media_type: String,
    total_bytes: u64,
}

fn reconcile_capture_by_client_request(
    config: &BackendConfig,
    client_request_id: &str,
    expectation: &CaptureStartExpectation,
) -> CaptureReconciliation {
    let response = request_with_headers(
        config,
        "GET",
        &format!(
            "/v2/captures/by-client-request/{}",
            encode_path_segment(client_request_id)
        ),
        None,
        None,
        &[],
    );
    match response {
        Ok(value) => match validate_capture_start_response(&value, expectation) {
            Ok(_) => CaptureReconciliation::Committed(value),
            Err(_) => CaptureReconciliation::Unknown,
        },
        Err(error) if is_http_rejection(&error, 404) => CaptureReconciliation::ConfirmedAbsent,
        Err(_) => CaptureReconciliation::Unknown,
    }
}

fn validate_capture_start_response(
    value: &Value,
    expectation: &CaptureStartExpectation,
) -> Result<String, String> {
    validate_capture_operation_contract(value)?;
    let capture_id = value
        .get("captureId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
    let ingestion_id = value
        .get("ingestionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
    if ingestion_id != expectation.ingestion_id {
        return Err("Progressive capture response identity is invalid.".into());
    }
    if value.get("kind").and_then(Value::as_str) != Some(expectation.kind.as_str()) {
        return Err("Progressive capture response identity is invalid.".into());
    }
    let source = value
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
    if source.get("fileName").and_then(Value::as_str) != Some(expectation.file_name.as_str())
        || source.get("mediaType").and_then(Value::as_str) != Some(expectation.media_type.as_str())
        || source.get("bytes").and_then(Value::as_u64) != Some(expectation.total_bytes)
    {
        return Err("Progressive capture response identity is invalid.".into());
    }
    Ok(capture_id.to_string())
}

fn validate_capture_operation_contract(value: &Value) -> Result<(), String> {
    if value.get("protocolVersion").and_then(Value::as_str) != Some("2") {
        return Err("Progressive capture response is invalid.".into());
    }
    let capture_id = value
        .get("captureId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
    validate_opaque_id(capture_id)
        .map_err(|_| "Progressive capture response identity is invalid.".to_string())?;
    let ingestion_id = value
        .get("ingestionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
    validate_opaque_id(ingestion_id)
        .map_err(|_| "Progressive capture response identity is invalid.".to_string())?;
    if !matches!(
        value.get("kind").and_then(Value::as_str),
        Some("pdf" | "image" | "audio")
    ) {
        return Err("Progressive capture response is invalid.".into());
    }
    if !matches!(
        value.get("status").and_then(Value::as_str),
        Some(
            "created"
                | "waiting_input"
                | "extracting"
                | "awaiting_structuring"
                | "structuring"
                | "completed"
                | "failed"
                | "cancelled"
        )
    ) {
        return Err("Progressive capture response is invalid.".into());
    }
    if value
        .get("partialRevision")
        .and_then(Value::as_u64)
        .is_none()
        || value
            .get("lastEventSequence")
            .and_then(Value::as_u64)
            .is_none()
    {
        return Err("Progressive capture response is invalid.".into());
    }
    let progress = value.get("progress");
    if progress.is_some_and(|value| {
        !value.is_null()
            && !value
                .as_f64()
                .is_some_and(|number| number.is_finite() && (0.0..=1.0).contains(&number))
    }) {
        return Err("Progressive capture response is invalid.".into());
    }
    for field in ["createdAt", "updatedAt"] {
        let timestamp = value.get(field).and_then(Value::as_str);
        if !timestamp.is_some_and(valid_rfc3339_timestamp) {
            return Err("Progressive capture response is invalid.".into());
        }
    }
    let completed_at = value.get("completedAt");
    let has_completed_at = completed_at.is_some_and(|value| !value.is_null());
    if has_completed_at
        && !completed_at
            .and_then(Value::as_str)
            .is_some_and(valid_rfc3339_timestamp)
    {
        return Err("Progressive capture response is invalid.".into());
    }
    let terminal_status = matches!(
        value.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "cancelled")
    );
    if terminal_status != has_completed_at {
        return Err("Progressive capture response is invalid.".into());
    }
    let error = value.get("error");
    if error.is_some_and(|value| !value.is_null()) {
        let error = error
            .and_then(Value::as_object)
            .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
        validate_capture_failure(error)
            .map_err(|_| "Progressive capture response is invalid.".to_string())?;
    }
    let source = value
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| "Progressive capture response is invalid.".to_string())?;
    if source
        .get("sha256")
        .and_then(Value::as_str)
        .is_none_or(|digest| {
            digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || source
            .get("fileName")
            .and_then(Value::as_str)
            .is_none_or(|value| value.is_empty())
        || source
            .get("mediaType")
            .and_then(Value::as_str)
            .is_none_or(|value| value.is_empty())
        || source
            .get("bytes")
            .and_then(Value::as_u64)
            .is_none_or(|bytes| bytes == 0)
    {
        return Err("Progressive capture response is invalid.".into());
    }
    Ok(())
}

fn cleanup_uncommitted_ingestion(
    config: &BackendConfig,
    ingestion_id: &str,
    original_error: String,
) -> String {
    match request_with_headers(
        config,
        "DELETE",
        &format!("/v2/ingestions/{ingestion_id}"),
        None,
        None,
        &[],
    ) {
        Ok(_) => original_error,
        Err(cleanup_error) if is_http_rejection(&cleanup_error, 404) => original_error,
        Err(cleanup_error) => format!("{original_error} Ingestion cleanup failed: {cleanup_error}"),
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

#[cfg(test)]
fn request_capture_with_recovery(
    config: &BackendConfig,
    body: RequestBody,
    client_request_id: &str,
) -> Result<Value, String> {
    request_capture_with_recovery_state(config, body, client_request_id)
        .map_err(|error| error.message)
}

#[derive(Debug)]
struct CaptureCreateFailure {
    message: String,
    uncertain: bool,
}

fn request_capture_with_recovery_state(
    config: &BackendConfig,
    body: RequestBody,
    client_request_id: &str,
) -> Result<Value, CaptureCreateFailure> {
    validate_client_request_id(client_request_id).map_err(|message| CaptureCreateFailure {
        message,
        uncertain: false,
    })?;
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
    if !is_uncertain_runtime_error(&first_error) {
        return Err(CaptureCreateFailure {
            message: first_error,
            uncertain: false,
        });
    }
    match send() {
        Ok(value) => Ok(value),
        Err(second_error) if is_uncertain_runtime_error(&second_error) => {
            let recovered = request_with_headers(
                config,
                "GET",
                &format!(
                    "/v2/captures/by-client-request/{}",
                    encode_path_segment(client_request_id)
                ),
                None,
                None,
                &[],
            )
            .map_err(|_| CaptureCreateFailure {
                message: first_error,
                uncertain: true,
            })?;
            validate_recovered_capture(recovered, &body).map_err(|_| CaptureCreateFailure {
                message: "Capture Runtime recovered a conflicting capture.".to_string(),
                uncertain: true,
            })
        }
        Err(second_error) => Err(CaptureCreateFailure {
            message: second_error,
            uncertain: true,
        }),
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
    validate_opaque_id(expected_ingestion_id)
        .map_err(|_| "Capture recovery request had an invalid ingestion identity.".to_string())?;
    let recovered_ingestion_id = value
        .get("ingestionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Capture recovery response was missing its ingestion identity.".to_string()
        })?;
    let recovered_capture_id = value
        .get("captureId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Capture recovery response was missing its capture identity.".to_string())?;
    if validate_opaque_id(recovered_ingestion_id).is_err()
        || validate_opaque_id(recovered_capture_id).is_err()
        || recovered_ingestion_id != expected_ingestion_id
    {
        return Err("Capture Runtime recovered a conflicting capture.".to_string());
    }
    Ok(value)
}

fn is_uncertain_runtime_error(error: &str) -> bool {
    if matches!(
        error,
        "Capture Runtime is unavailable."
            | "Capture Runtime request could not be sent."
            | "Capture Runtime response could not be read."
            | "Capture Runtime response was malformed."
            | "Capture Runtime response was not valid JSON."
            | "Capture Runtime response identifier is invalid."
            | "Capture Runtime recovered a conflicting capture."
            | "Progressive capture response is invalid."
            | "Progressive capture response identity is invalid."
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
    let value = streaming_value(state, "GET", &input.id, "", None, None)?;
    validate_capture_operation_contract(&value)?;
    Ok(value)
}

pub(crate) fn streaming_capture_by_client_request(
    state: &DesktopState,
    input: RuntimeClientRequestIdInput,
) -> Result<Value, String> {
    validate_client_request_id(&input.client_request_id)?;
    let config = state.backend_config()?;
    let value = null_for_http_rejection(
        request_with_headers(
            &config,
            "GET",
            &format!(
                "/v2/captures/by-client-request/{}",
                encode_path_segment(&input.client_request_id)
            ),
            None,
            None,
            &[],
        ),
        404,
    )?;
    if !value.is_null() {
        validate_capture_operation_contract(&value)?;
    }
    Ok(value)
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
    ensure_runtime_source_safe(&source.path, source.bytes)?;
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
    ensure_runtime_source_safe(&source.path, source.bytes)?;
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

fn ensure_runtime_source_safe(path: &std::path::Path, expected_len: u64) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Capture library source cannot be inspected.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("Capture library source is not a regular file.".into());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "Capture library source cannot be resolved.".to_string())?;
    if canonical != path {
        return Err("Capture library source path must be canonical.".into());
    }
    if metadata.len() != expected_len || metadata.len() == 0 {
        return Err("Capture library source changed after import.".into());
    }
    Ok(())
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
    request_sse_stream_bounded(
        config,
        path,
        last_event_id,
        expected_capture_id,
        cancellation,
        &mut on_event,
        MAX_RUNTIME_RESPONSE_BYTES,
    )
}

fn request_sse_stream_bounded<F>(
    config: &BackendConfig,
    path: &str,
    last_event_id: Option<&str>,
    expected_capture_id: Option<&str>,
    cancellation: Option<&AtomicBool>,
    mut on_event: &mut F,
    max_response_bytes: u64,
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
        if total_bytes > max_response_bytes {
            return Err("Capture Runtime response exceeded the desktop safety limit.".into());
        }
        response_prefix.extend_from_slice(&chunk[..count]);
        if let Some(index) = response_prefix
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            body_prefix.extend_from_slice(&response_prefix[index + 4..]);
            total_bytes = total_bytes.saturating_sub(body_prefix.len() as u64);
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
    let mut chunked_decoder = has_chunked_transfer_encoding(headers).then(ChunkedBodyDecoder::new);
    let mut body_prefix = body_prefix;
    let mut decoded_chunk = Vec::with_capacity(8192);
    loop {
        let Some(count) = read_http_body_chunk(
            &mut stream,
            &mut chunked_decoder,
            &mut body_prefix,
            &mut decoded_chunk,
            cancellation,
        )?
        else {
            return parser.finish(&mut on_event);
        };
        if count == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(count as u64);
        if total_bytes > max_response_bytes {
            return Err("Capture Runtime response exceeded the desktop safety limit.".into());
        }
        parser.feed(&decoded_chunk[..count], &mut on_event)?;
    }
    parser.finish(&mut on_event)
}

fn read_http_body_chunk(
    stream: &mut TcpStream,
    decoder: &mut Option<ChunkedBodyDecoder>,
    prefix: &mut Vec<u8>,
    output: &mut Vec<u8>,
    cancellation: Option<&AtomicBool>,
) -> Result<Option<usize>, String> {
    let mut raw = [0_u8; 8192];
    loop {
        output.clear();
        let input = if prefix.is_empty() {
            match read_sse_chunk(stream, &mut raw, cancellation)? {
                None => return Ok(None),
                Some(0) => {
                    if let Some(decoder) = decoder {
                        decoder.finish()?;
                    }
                    return Ok(None);
                }
                Some(count) => &raw[..count],
            }
        } else {
            let pending = std::mem::take(prefix);
            raw[..pending.len()].copy_from_slice(&pending);
            &raw[..pending.len()]
        };
        if let Some(decoder) = decoder {
            decoder.feed(input, output)?;
            if decoder.is_done() && output.is_empty() {
                decoder.finish()?;
                return Ok(None);
            }
        } else {
            output.extend_from_slice(input);
        }
        if !output.is_empty() {
            return Ok(Some(output.len()));
        }
    }
}

fn has_chunked_transfer_encoding(headers: &str) -> bool {
    headers
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.trim().eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|(_, value)| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case("chunked"))
}

#[derive(Debug, PartialEq, Eq)]
enum ChunkedBodyState {
    Size,
    Data(usize),
    DataCrlf(bool),
    Trailers,
    Done,
}

struct ChunkedBodyDecoder {
    state: ChunkedBodyState,
    line: Vec<u8>,
    pending_cr: bool,
}

impl ChunkedBodyDecoder {
    fn new() -> Self {
        Self {
            state: ChunkedBodyState::Size,
            line: Vec::new(),
            pending_cr: false,
        }
    }

    fn is_done(&self) -> bool {
        self.state == ChunkedBodyState::Done
    }

    fn feed(&mut self, input: &[u8], output: &mut Vec<u8>) -> Result<(), String> {
        let mut index = 0;
        while index < input.len() {
            match &mut self.state {
                ChunkedBodyState::Size | ChunkedBodyState::Trailers => {
                    let is_size = self.state == ChunkedBodyState::Size;
                    let byte = input[index];
                    index += 1;
                    if self.pending_cr {
                        if byte != b'\n' {
                            return Err("Capture Runtime HTTP chunk framing was invalid.".into());
                        }
                        self.pending_cr = false;
                        let line = std::mem::take(&mut self.line);
                        if is_size {
                            let size = parse_http_chunk_size(&line)?;
                            self.state = if size == 0 {
                                ChunkedBodyState::Trailers
                            } else {
                                ChunkedBodyState::Data(size)
                            };
                        } else if line.is_empty() {
                            self.state = ChunkedBodyState::Done;
                        }
                    } else if byte == b'\r' {
                        self.pending_cr = true;
                    } else if byte == b'\n' {
                        return Err("Capture Runtime HTTP chunk framing was invalid.".into());
                    } else {
                        self.line.push(byte);
                        if self.line.len() > 8 * 1024 {
                            return Err("Capture Runtime HTTP chunk metadata was too large.".into());
                        }
                    }
                }
                ChunkedBodyState::Data(remaining) => {
                    let count = (*remaining).min(input.len() - index);
                    output.extend_from_slice(&input[index..index + count]);
                    *remaining -= count;
                    index += count;
                    if *remaining == 0 {
                        self.state = ChunkedBodyState::DataCrlf(false);
                    }
                }
                ChunkedBodyState::DataCrlf(saw_cr) => {
                    let byte = input[index];
                    index += 1;
                    if !*saw_cr {
                        if byte != b'\r' {
                            return Err("Capture Runtime HTTP chunk framing was invalid.".into());
                        }
                        *saw_cr = true;
                    } else {
                        if byte != b'\n' {
                            return Err("Capture Runtime HTTP chunk framing was invalid.".into());
                        }
                        self.state = ChunkedBodyState::Size;
                    }
                }
                ChunkedBodyState::Done => {
                    return Err(
                        "Capture Runtime HTTP response contained data after trailers.".into(),
                    );
                }
            }
        }
        Ok(())
    }

    fn finish(&self) -> Result<(), String> {
        if self.is_done() && !self.pending_cr && self.line.is_empty() {
            Ok(())
        } else {
            Err("Capture Runtime HTTP chunked response ended before trailers.".into())
        }
    }
}

fn parse_http_chunk_size(line: &[u8]) -> Result<usize, String> {
    let line = std::str::from_utf8(line)
        .map_err(|_| "Capture Runtime HTTP chunk size was invalid.".to_string())?;
    let size = line.split(';').next().unwrap_or_default().trim();
    if size.is_empty() {
        return Err("Capture Runtime HTTP chunk size was invalid.".into());
    }
    usize::from_str_radix(size, 16)
        .map_err(|_| "Capture Runtime HTTP chunk size was invalid.".to_string())
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
        while let Some(index) = self
            .pending
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            if self.pending[index] == b'\r' && index + 1 == self.pending.len() {
                break;
            }
            let mut line = self.pending.drain(..=index).collect::<Vec<_>>();
            let terminator = line.pop();
            if terminator == Some(b'\r') && self.pending.first() == Some(&b'\n') {
                self.pending.remove(0);
            }
            self.process_line(&line, on_event)?;
        }
        Ok(())
    }

    fn finish<F>(&mut self, _on_event: &mut F) -> Result<(), String>
    where
        F: FnMut(Value) -> Result<(), String>,
    {
        if !self.pending.is_empty()
            || !self.frame.data.is_empty()
            || self.frame.id.is_some()
            || self.frame.event.is_some()
        {
            return Err(
                "Capture Runtime SSE response ended with an incomplete event frame.".into(),
            );
        }
        self.pending.clear();
        self.frame = SseFrame::default();
        Ok(())
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
        if self.frame.id.as_deref() != Some(sequence.to_string().as_str()) {
            return Err("Capture Runtime SSE event id did not match its sequence.".to_string());
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
    validate_opaque_id(capture_id)
        .map_err(|_| "Capture Runtime SSE event capture identity was invalid.".to_string())?;
    if expected_capture_id.is_some_and(|expected| expected != capture_id) {
        return Err(
            "Capture Runtime SSE event capture identity did not match the request.".to_string(),
        );
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
    if event_id != format!("{capture_id}/{sequence}") {
        return Err("Capture Runtime SSE event id did not match its capture sequence.".to_string());
    }
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
    validate_runtime_response_identities(&value)?;
    redact_token(&mut value, token);
    Ok(value)
}

fn validate_runtime_response_identities(value: &Value) -> Result<(), String> {
    match value {
        Value::Array(values) => {
            for item in values {
                validate_runtime_response_identities(item)?;
            }
        }
        Value::Object(values) => {
            for (key, item) in values {
                if matches!(key.as_str(), "captureId" | "ingestionId") {
                    let identifier =
                        item.as_str()
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| {
                                "Capture Runtime response identifier is invalid.".to_string()
                            })?;
                    validate_opaque_id(identifier).map_err(|_| {
                        "Capture Runtime response identifier is invalid.".to_string()
                    })?;
                }
                validate_runtime_response_identities(item)?;
            }
        }
        _ => {}
    }
    Ok(())
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
    if value.is_empty()
        || value.len() > 128
        || value != value.trim()
        || matches!(value, "." | "..")
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | '?' | '#'))
    {
        return Err("Capture client request identifier is invalid.".into());
    }
    Ok(())
}

fn encode_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0F) as usize] as char);
        }
    }
    encoded
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

#[cfg(test)]
fn capture_start_expectation(ingestion_id: &str) -> CaptureStartExpectation {
    CaptureStartExpectation {
        ingestion_id: ingestion_id.into(),
        kind: "pdf".into(),
        file_name: "scan.pdf".into(),
        media_type: "application/pdf".into(),
        total_bytes: 3,
    }
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
    fn consumer_request_ids_are_bounded_and_allow_dots_without_path_controls() {
        assert!(validate_client_request_id("consumer.request.v1").is_ok());
        assert!(validate_client_request_id("").is_err());
        assert!(validate_client_request_id(&"r".repeat(129)).is_err());
        assert!(validate_client_request_id("consumer/request").is_err());
        assert!(validate_client_request_id("consumer\\request").is_err());
    }

    #[test]
    fn native_runtime_responses_reject_malformed_capture_and_ingestion_ids() {
        let malformed_capture_response =
            br#"HTTP/1.1 200 OK\r\nContent-Length: 56\r\nConnection: close\r\n\r\n{"captureId":"../capture","ingestionId":"ingestion-1"}"#;
        assert!(parse_response(malformed_capture_response, "token").is_err());
        let malformed_ingestion_response =
            br#"HTTP/1.1 200 OK\r\nContent-Length: 78\r\nConnection: close\r\n\r\n{"operation":{"captureId":"capture-1","ingestionId":"C:\\source.bin"}}"#;
        assert!(parse_response(malformed_ingestion_response, "token").is_err());
        assert!(validate_runtime_response_identities(&serde_json::json!(
            {"captureId": "../capture", "ingestionId": "ingestion-1"}
        ))
        .is_err());
        assert!(validate_runtime_response_identities(&serde_json::json!(
            {"operation": {"captureId": "capture-1", "ingestionId": "C:\\source.bin"}}
        ))
        .is_err());
        assert!(validate_runtime_response_identities(&serde_json::json!(
            {"captureId": "capture-1", "ingestionId": "ingestion-1"}
        ))
        .is_ok());
    }

    #[test]
    fn capture_failure_cleanup_requires_a_client_request_absence_confirmation() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request.starts_with(
                "GET /v2/captures/by-client-request/capture-request-cleanup HTTP/1.1"
            ));
            write!(
                lookup,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("absent response");
            drop(lookup);

            let (mut cleanup, _) = listener.accept().expect("cleanup connection");
            let cleanup_request = read_http_request(&mut cleanup);
            assert!(cleanup_request.starts_with("DELETE /v2/ingestions/ingestion-1 HTTP/1.1"));
            write!(
                cleanup,
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("cleanup response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let expectation = capture_start_expectation("ingestion-1");
        assert!(matches!(
            reconcile_capture_by_client_request(&config, "capture-request-cleanup", &expectation),
            CaptureReconciliation::ConfirmedAbsent
        ));
        assert_eq!(
            cleanup_uncommitted_ingestion(&config, "ingestion-1", "capture failed".into()),
            "capture failed"
        );
        server.join().expect("server");
    }

    #[test]
    fn capture_failure_cleanup_does_not_delete_after_a_conflicting_lookup() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request.starts_with(
                "GET /v2/captures/by-client-request/capture-request-conflict HTTP/1.1"
            ));
            let body = r#"{"captureId":"capture-other","ingestionId":"ingestion-other"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("conflicting response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let expectation = capture_start_expectation("ingestion-1");
        assert!(matches!(
            reconcile_capture_by_client_request(&config, "capture-request-conflict", &expectation),
            CaptureReconciliation::Unknown
        ));
        server.join().expect("server");
    }

    #[test]
    fn capture_start_responses_require_full_semantic_correlation() {
        let expectation = capture_start_expectation("ingestion-1");
        let valid = serde_json::json!({
            "protocolVersion": "2",
            "captureId": "capture-1",
            "ingestionId": "ingestion-1",
            "kind": "pdf",
            "status": "extracting",
            "progress": 0.5,
            "partialRevision": 1,
            "lastEventSequence": 3,
            "source": {
                "sha256": "a".repeat(64),
                "fileName": "scan.pdf",
                "mediaType": "application/pdf",
                "bytes": 3,
            },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:01Z",
        });
        assert_eq!(
            validate_capture_start_response(&valid, &expectation).expect("valid capture"),
            "capture-1"
        );

        let mut no_protocol = valid.clone();
        no_protocol
            .as_object_mut()
            .expect("object")
            .remove("protocolVersion");
        assert!(validate_capture_start_response(&no_protocol, &expectation).is_err());

        let mut wrong_ingestion = valid.clone();
        wrong_ingestion.as_object_mut().expect("object")["ingestionId"] =
            serde_json::json!("ingestion-other");
        assert!(validate_capture_start_response(&wrong_ingestion, &expectation).is_err());

        let mut wrong_kind = valid.clone();
        wrong_kind.as_object_mut().expect("object")["kind"] = serde_json::json!("audio");
        assert!(validate_capture_start_response(&wrong_kind, &expectation).is_err());

        let mut invalid_status = valid.clone();
        invalid_status.as_object_mut().expect("object")["status"] = serde_json::json!("uploading");
        assert!(validate_capture_start_response(&invalid_status, &expectation).is_err());

        let mut wrong_source = valid.clone();
        wrong_source.as_object_mut().expect("object")["source"]
            .as_object_mut()
            .expect("source object")["fileName"] = serde_json::json!("other.pdf");
        assert!(validate_capture_start_response(&wrong_source, &expectation).is_err());

        let mut null_source = valid.clone();
        null_source.as_object_mut().expect("object")["source"] = serde_json::Value::Null;
        assert!(validate_capture_start_response(&null_source, &expectation).is_err());

        let mut missing_source = valid.clone();
        missing_source
            .as_object_mut()
            .expect("object")
            .remove("source");
        assert!(validate_capture_start_response(&missing_source, &expectation).is_err());

        let mut waiting_input = valid;
        waiting_input.as_object_mut().expect("object")["status"] =
            serde_json::json!("waiting_input");
        assert!(validate_capture_start_response(&waiting_input, &expectation).is_ok());
    }

    #[test]
    fn capture_start_responses_require_the_full_operation_contract() {
        let expectation = capture_start_expectation("ingestion-1");
        let valid = serde_json::json!({
            "protocolVersion": "2",
            "captureId": "capture-1",
            "ingestionId": "ingestion-1",
            "kind": "pdf",
            "status": "failed",
            "progress": 0.5,
            "partialRevision": 1,
            "lastEventSequence": 3,
            "source": {
                "sha256": "a".repeat(64),
                "fileName": "scan.pdf",
                "mediaType": "application/pdf",
                "bytes": 3,
            },
            "error": {
                "code": "provider_failed",
                "message": "Provider failed.",
                "stage": "extracting",
                "retryable": true,
            },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:01Z",
            "completedAt": "2026-01-01T00:00:01Z",
        });
        assert_eq!(
            validate_capture_start_response(&valid, &expectation).expect("valid terminal"),
            "capture-1"
        );

        let mut missing_revision = valid.clone();
        missing_revision
            .as_object_mut()
            .expect("object")
            .remove("partialRevision");
        assert!(validate_capture_start_response(&missing_revision, &expectation).is_err());

        let mut missing_sequence = valid.clone();
        missing_sequence
            .as_object_mut()
            .expect("object")
            .remove("lastEventSequence");
        assert!(validate_capture_start_response(&missing_sequence, &expectation).is_err());

        let mut invalid_progress = valid.clone();
        invalid_progress.as_object_mut().expect("object")["progress"] = serde_json::json!(1.5);
        assert!(validate_capture_start_response(&invalid_progress, &expectation).is_err());

        let mut invalid_timestamp = valid.clone();
        invalid_timestamp.as_object_mut().expect("object")["createdAt"] =
            serde_json::json!("2026-01-01T00:00:00");
        assert!(validate_capture_start_response(&invalid_timestamp, &expectation).is_err());

        let mut terminal_without_timestamp = valid.clone();
        terminal_without_timestamp
            .as_object_mut()
            .expect("object")
            .remove("completedAt");
        assert!(
            validate_capture_start_response(&terminal_without_timestamp, &expectation).is_err()
        );

        let mut active_with_timestamp = valid.clone();
        active_with_timestamp.as_object_mut().expect("object")["status"] =
            serde_json::json!("extracting");
        assert!(validate_capture_start_response(&active_with_timestamp, &expectation).is_err());

        let mut missing_digest = valid.clone();
        missing_digest.as_object_mut().expect("object")["source"]
            .as_object_mut()
            .expect("source object")
            .remove("sha256");
        assert!(validate_capture_start_response(&missing_digest, &expectation).is_err());

        let mut invalid_error = valid.clone();
        invalid_error.as_object_mut().expect("object")["error"] = serde_json::json!({
            "code": "Not Valid!",
            "message": "",
        });
        assert!(validate_capture_start_response(&invalid_error, &expectation).is_err());
    }

    #[test]
    fn capture_start_recovery_commits_a_fully_correlated_lookup() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/captures/by-client-request/capture-request-valid HTTP/1.1"));
            let body = r#"{"protocolVersion":"2","captureId":"capture-recovered","ingestionId":"ingestion-1","kind":"pdf","status":"extracting","progress":0.5,"partialRevision":1,"lastEventSequence":3,"source":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fileName":"scan.pdf","mediaType":"application/pdf","bytes":3},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:01Z"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("valid lookup response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let expectation = capture_start_expectation("ingestion-1");

        let recovered =
            reconcile_capture_by_client_request(&config, "capture-request-valid", &expectation);

        assert!(matches!(
            recovered,
            CaptureReconciliation::Committed(value) if value["captureId"] == "capture-recovered"
        ));
        server.join().expect("server");
    }

    #[test]
    fn capture_start_recovery_rejects_a_lookup_with_mismatched_metadata() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request.starts_with(
                "GET /v2/captures/by-client-request/capture-request-mismatch HTTP/1.1"
            ));
            let body = r#"{"protocolVersion":"2","captureId":"capture-other","ingestionId":"ingestion-1","kind":"audio","status":"extracting","progress":0.5,"partialRevision":1,"lastEventSequence":3,"source":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fileName":"scan.pdf","mediaType":"application/pdf","bytes":3},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:01Z"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("mismatched lookup response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let expectation = capture_start_expectation("ingestion-1");

        let recovered =
            reconcile_capture_by_client_request(&config, "capture-request-mismatch", &expectation);

        assert!(matches!(recovered, CaptureReconciliation::Unknown));
        server.join().expect("server");
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
            let chunked_body = format!("{:X}\r\n{body}\r\n0\r\n\r\n", body.len());
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{}",
                chunked_body
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
    fn streaming_sse_preserves_split_crlf_and_rejects_unterminated_eof_frames() {
        let payload = r#"{"protocolVersion":"2","eventId":"capture-1/8","sequence":8,"captureId":"capture-1","kind":"audio","eventType":"checkpoint","stage":"extracting","progress":0.5,"partialRevision":1,"createdAt":"2026-01-01T00:00:00Z"}"#;
        let body = format!("id: 8\r\nevent: checkpoint\r\ndata: {payload}\r\n\r\n");
        let split = body.find("\r\n").expect("line ending") + 1;
        let mut parser = SseParser::new(None, "token", Some("capture-1")).expect("parser");
        let mut events = Vec::new();
        let mut collect = |event| {
            events.push(event);
            Ok(())
        };
        parser
            .feed(body[..split].as_bytes(), &mut collect)
            .expect("partial CRLF");
        parser
            .feed(body[split..].as_bytes(), &mut collect)
            .expect("remaining frame");
        parser.finish(&mut collect).expect("finish");
        assert_eq!(events.len(), 1);

        let mut truncated = SseParser::new(None, "token", Some("capture-1")).expect("parser");
        let mut truncated_events = Vec::new();
        let mut collect_truncated = |event| {
            truncated_events.push(event);
            Ok(())
        };
        truncated
            .feed(
                format!("id: 8\nevent: checkpoint\ndata: {payload}").as_bytes(),
                &mut collect_truncated,
            )
            .expect("truncated frame");
        assert!(truncated.finish(&mut collect_truncated).is_err());
        assert!(truncated_events.is_empty());
    }

    #[test]
    fn request_sse_rejects_unterminated_final_frame_at_eof() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("GET /v2/captures/capture-1/events HTTP/1.1"));
            let body = "id: 8\nevent: checkpoint\ndata: {\"protocolVersion\":\"2\",\"eventId\":\"capture-1/8\",\"sequence\":8,\"captureId\":\"capture-1\",\"kind\":\"audio\",\"eventType\":\"checkpoint\",\"stage\":\"extracting\",\"createdAt\":\"2026-01-01T00:00:00Z\"}";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
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
        .expect_err("unterminated final frame");

        assert!(error.contains("incomplete event frame"));
        server.join().expect("server");
    }

    #[test]
    fn request_sse_counts_header_prefix_body_bytes_exactly_once() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let max_response_bytes = 1024;
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("GET /v2/captures/capture-1/events HTTP/1.1"));
            let body_size = max_response_bytes as usize - 256;
            let mut response =
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                    .to_vec();
            response.extend(std::iter::repeat(0u8).take(body_size));
            stream.write_all(&response).expect("response");
        });
        let error = request_sse_stream_bounded(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            "/v2/captures/capture-1/events",
            None,
            Some("capture-1"),
            None,
            &mut |_event| Ok(()),
            max_response_bytes,
        )
        .expect_err("bounded response");

        assert!(!error.contains("exceeded"));
        server.join().expect("server");
    }

    #[test]
    fn request_sse_rejects_body_over_the_bounded_limit() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let max_response_bytes = 1024;
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.contains("GET /v2/captures/capture-1/events HTTP/1.1"));
            let body_size = max_response_bytes as usize + 1;
            let mut response =
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                    .to_vec();
            response.extend(std::iter::repeat(0u8).take(body_size));
            stream.write_all(&response).expect("response");
        });
        let error = request_sse_stream_bounded(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "token".into(),
                runtime_version: "0.3.11".into(),
                api_version: "1.0".into(),
                capture_document_schema_version: "1".into(),
            },
            "/v2/captures/capture-1/events",
            None,
            Some("capture-1"),
            None,
            &mut |_event| Ok(()),
            max_response_bytes,
        )
        .expect_err("over-limit response");

        assert!(error.contains("exceeded"));
        server.join().expect("server");
    }

    #[test]
    fn runtime_sse_limit_stays_at_60_mib() {
        assert_eq!(MAX_RUNTIME_RESPONSE_BYTES, 60 * 1024 * 1024);
    }

    #[test]
    fn runtime_source_reopen_guard_rejects_symlinks_and_length_changes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let target = directory.path().join("target.bin");
        fs::write(&target, b"abc").expect("target");
        let canonical_target = fs::canonicalize(&target).expect("canonical target");

        assert!(ensure_runtime_source_safe(&canonical_target, 3).is_ok());
        assert!(ensure_runtime_source_safe(&canonical_target, 4).is_err());

        let link = directory.path().join("link.bin");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&target, &link);
        if symlink_result.is_ok() {
            assert!(ensure_runtime_source_safe(&link, 3).is_err());
        }
    }

    #[test]
    fn streaming_sse_rejects_missing_or_empty_event_ids() {
        let payload = r#"{"protocolVersion":"2","eventId":"capture-1/8","sequence":8,"captureId":"capture-1","kind":"audio","eventType":"checkpoint","stage":"extracting","createdAt":"2026-01-01T00:00:00Z"}"#;
        let missing = format!("event: checkpoint\ndata: {payload}\n\n");
        let empty = format!("id: \nevent: checkpoint\ndata: {payload}\n\n");
        let valid = format!("id: 8\nevent: checkpoint\ndata: {payload}\n\n");

        assert!(parse_sse_events(missing.as_bytes(), None, "token").is_err());
        assert!(parse_sse_events(empty.as_bytes(), None, "token").is_err());
        assert!(parse_sse_events(valid.as_bytes(), None, "token").is_ok());
    }

    #[test]
    fn streaming_sse_rejects_metadata_mismatch_and_non_increasing_sequences() {
        let payload = r#"{"protocolVersion":"2","eventId":"capture-1/8","sequence":8,"captureId":"capture-1","kind":"audio","eventType":"checkpoint","stage":"extracting","progress":0.5,"partialRevision":1,"createdAt":"2026-01-01T00:00:00Z"}"#;
        let id_mismatch = format!("id: 7\nevent: checkpoint\ndata: {payload}\n\n");
        let event_mismatch = format!("id: 8\nevent: completed\ndata: {payload}\n\n");
        let duplicate = format!("id: 8\ndata: {payload}\n\nid: 8\ndata: {payload}\n\n");

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
        let mut event_id = base.clone();
        event_id["eventId"] = serde_json::json!("capture-1/8/extra");
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
            ("event id", event_id, "capture sequence"),
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
    fn native_http_chunked_sse_body_is_decoded_across_split_chunk_boundaries() {
        let body = b"id: 1\r\nevent: accepted\r\ndata: {\"ok\":true}\r\n\r\n";
        let encoded = format!("{:X};stream=yes\r\n", body.len())
            .into_bytes()
            .into_iter()
            .chain(body.iter().copied())
            .chain(b"\r\n0\r\nX-Test: complete\r\n\r\n".iter().copied())
            .collect::<Vec<_>>();
        let split_points = [1, 3, 7, 11, encoded.len() - 2];
        let mut decoder = ChunkedBodyDecoder::new();
        let mut output = Vec::new();
        let mut decoded = Vec::new();
        let mut start = 0;
        for end in split_points.into_iter().chain([encoded.len()]) {
            output.clear();
            decoder
                .feed(&encoded[start..end], &mut output)
                .expect("split chunk framing");
            decoded.extend_from_slice(&output);
            start = end;
        }
        decoder.finish().expect("complete chunked body");
        assert_eq!(decoded, body);
    }

    #[test]
    fn native_http_chunked_sse_body_rejects_truncated_chunk_data() {
        let mut decoder = ChunkedBodyDecoder::new();
        let mut output = Vec::new();
        decoder
            .feed(b"4\r\ndata", &mut output)
            .expect("partial chunk");
        assert!(decoder.finish().is_err());
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
                    assert!(request.contains("X-Idempotency-Key: consumer.request.v1"));
                    continue;
                }
                assert!(request.starts_with(
                    "GET /v2/captures/by-client-request/consumer.request.v1 HTTP/1.1",
                ));
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
                bytes: br#"{"clientRequestId":"consumer.request.v1","ingestionId":"ingestion-2"}"#
                    .to_vec(),
                content_type: "application/json".into(),
            },
            "consumer.request.v1",
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
    fn capture_creation_keeps_uncertainty_after_a_retry_conflict() {
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

        assert!(request_capture_with_recovery_state(
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
        .is_err());
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
    fn open_ingestion_recovers_by_client_request_id_after_lost_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (lost, _) = listener.accept().expect("lost response connection");
            drop(lost);
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/consumer.request.v1 HTTP/1.1"));
            let body = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-recovered","status":"open","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("recovered response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let ingestion_id =
            open_ingestion_with_recovery(&config, &source, "pdf", "consumer.request.v1")
                .expect("recovered ingestion");

        assert_eq!(ingestion_id, "ingestion-recovered");
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_keeps_uncertainty_when_recovery_lookup_also_fails() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (lost, _) = listener.accept().expect("lost response connection");
            drop(lost);
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/unknown-open HTTP/1.1"));
            write!(
                lookup,
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .expect("lookup response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let error = open_ingestion_with_recovery(&config, &source, "pdf", "unknown-open")
            .expect_err("uncertain recovery");

        assert!(is_uncertain_runtime_error(&error));
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_rethrows_original_failure_when_lookup_confirms_absence() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (lost, _) = listener.accept().expect("lost response connection");
            drop(lost);
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/absent-open HTTP/1.1"));
            write!(
                lookup,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .expect("absent response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let error = open_ingestion_with_recovery(&config, &source, "pdf", "absent-open")
            .expect_err("confirmed absence");

        assert!(is_uncertain_runtime_error(&error));
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_recovers_after_semantically_invalid_committed_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut committed, _) = listener.accept().expect("committed response connection");
            let committed_request = read_http_request(&mut committed);
            assert!(committed_request.starts_with("POST /v2/ingestions HTTP/1.1"));
            write!(
                committed,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .expect("invalid committed response");
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/valid-open HTTP/1.1"));
            let body = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-recovered","status":"open","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("recovered response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let ingestion_id = open_ingestion_with_recovery(&config, &source, "pdf", "valid-open")
            .expect("recovered ingestion");

        assert_eq!(ingestion_id, "ingestion-recovered");
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_recovers_after_mismatched_committed_identity() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut committed, _) = listener.accept().expect("committed response connection");
            let committed_request = read_http_request(&mut committed);
            assert!(committed_request.starts_with("POST /v2/ingestions HTTP/1.1"));
            let body = r#"{"protocolVersion":"2","kind":"audio","ingestionId":"ingestion-committed","status":"open","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                committed,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("mismatched committed response");
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/mismatched-open HTTP/1.1"));
            let recovered = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-recovered","status":"open","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                recovered.len(),
                recovered
            )
            .expect("recovered response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let ingestion_id = open_ingestion_with_recovery(&config, &source, "pdf", "mismatched-open")
            .expect("recovered ingestion");

        assert_eq!(ingestion_id, "ingestion-recovered");
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_keeps_original_validation_error_when_recovery_is_also_invalid() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut committed, _) = listener.accept().expect("committed response connection");
            let committed_request = read_http_request(&mut committed);
            assert!(committed_request.starts_with("POST /v2/ingestions HTTP/1.1"));
            write!(
                committed,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .expect("invalid committed response");
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/invalid-recovery HTTP/1.1"));
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .expect("invalid recovery response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let error = open_ingestion_with_recovery(&config, &source, "pdf", "invalid-recovery")
            .expect_err("invalid recovery");

        assert_eq!(error, "Progressive ingestion response is invalid.");
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_recovers_after_committed_non_open_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut committed, _) = listener.accept().expect("committed response connection");
            let committed_request = read_http_request(&mut committed);
            assert!(committed_request.starts_with("POST /v2/ingestions HTTP/1.1"));
            let body = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-committed","status":"ready","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                committed,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("non-open committed response");
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/non-open-open HTTP/1.1"));
            let recovered = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-recovered","status":"open","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                recovered.len(),
                recovered
            )
            .expect("recovered response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let ingestion_id = open_ingestion_with_recovery(&config, &source, "pdf", "non-open-open")
            .expect("recovered ingestion");

        assert_eq!(ingestion_id, "ingestion-recovered");
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_fails_closed_when_recovery_is_also_non_open() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut committed, _) = listener.accept().expect("committed response connection");
            let committed_request = read_http_request(&mut committed);
            assert!(committed_request.starts_with("POST /v2/ingestions HTTP/1.1"));
            let body = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-committed","status":"ready","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                committed,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("non-open committed response");
            let (mut lookup, _) = listener.accept().expect("lookup connection");
            let lookup_request = read_http_request(&mut lookup);
            assert!(lookup_request
                .starts_with("GET /v2/ingestions/by-client-request/non-open-invalid HTTP/1.1"));
            write!(
                lookup,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("non-open recovery response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        let error = open_ingestion_with_recovery(&config, &source, "pdf", "non-open-invalid")
            .expect_err("non-open recovery");

        assert_eq!(error, "Progressive ingestion response is invalid.");
        server.join().expect("server");
    }

    #[test]
    fn open_ingestion_preserves_128_character_client_request_id_without_derived_suffix() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let request_id = "r".repeat(128);
        let expected_request_id = request_id.clone();
        let server = thread::spawn(move || {
            let (mut committed, _) = listener.accept().expect("committed response connection");
            let committed_request = read_http_request(&mut committed);
            assert!(committed_request.starts_with("POST /v2/ingestions HTTP/1.1"));
            assert!(committed_request
                .contains(&format!("\"clientRequestId\":\"{}\"", expected_request_id)));
            assert!(!committed_request.contains("-ingestion"));
            let body = r#"{"protocolVersion":"2","kind":"pdf","ingestionId":"ingestion-128","status":"open","fileName":"scan.pdf","mediaType":"application/pdf","totalBytes":3,"receivedBytes":0,"contiguousBytes":0,"nextChunkIndex":0,"nextOffset":0,"expiresAt":"2026-08-12T00:00:00Z"}"#;
            write!(
                committed,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("committed response");
        });
        let config = BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };
        let source = RuntimeSourceFile {
            file_name: "scan.pdf".into(),
            media_type: "application/pdf".into(),
            path: PathBuf::from("scan.pdf"),
            bytes: 3,
        };

        validate_client_request_id(&request_id).expect("bounded request id");
        assert!(validate_client_request_id(&format!("{request_id}-ingestion")).is_err());
        let ingestion_id = open_ingestion_with_recovery(&config, &source, "pdf", &request_id)
            .expect("bounded ingestion request id");

        assert_eq!(ingestion_id, "ingestion-128");
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
        let source_path = fs::canonicalize(&source_path).expect("canonical source");
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
