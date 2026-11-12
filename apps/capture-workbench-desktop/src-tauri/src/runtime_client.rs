use std::io::Read;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    config::BackendConfig,
    contracts::{
        RuntimeCancelUploadInput, RuntimeCreateCaptureInput, RuntimeIdInput,
        RuntimeInstallationStartInput, RuntimeModelInstallationStartInput, RuntimeRequirementInput,
        RuntimeStreamingCaptureInput, RuntimeStreamingEventsInput,
    },
    library::{LibraryStore, RuntimeSourceFile, RECORDING_MEDIA_TYPES},
    state::DesktopState,
};

const STREAM_CHUNK_BYTES: usize = 1024 * 1024;

mod sse;
mod transport;
mod upload_cancellation;
mod validation;

pub(crate) use upload_cancellation::{Upload, UploadCancellations};

use transport::{
    is_http_rejection, request, request_sse, request_with_headers, request_with_retry, RequestBody,
};
use validation::{
    validate_client_request_id, validate_document_id, validate_model_option_id, validate_opaque_id,
    validate_pdf_page_numbers, validate_requirement_id, validate_structuring_mode,
};

pub(crate) fn ready(state: &DesktopState) -> Result<Value, String> {
    request_json(state, "GET", "/v2/health/ready", None, None)
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

pub(crate) fn list_installations(state: &DesktopState) -> Result<Value, String> {
    request_json(state, "GET", "/v2/runtime/installations", None, None)
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

pub(crate) fn cancel_installation(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    validate_opaque_id(&input.id)?;
    request_json(
        state,
        "POST",
        &format!("/v2/runtime/installations/{}/cancel", input.id),
        None,
        None,
    )
}

pub(crate) fn uninstall_requirement(
    state: &DesktopState,
    input: RuntimeRequirementInput,
) -> Result<Value, String> {
    validate_requirement_id(&input.requirement_id)?;
    request_json(
        state,
        "DELETE",
        &format!(
            "/v2/runtime/requirements/{}/installation",
            input.requirement_id
        ),
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

pub(crate) fn cancel_upload(
    uploads: &UploadCancellations,
    input: RuntimeCancelUploadInput,
) -> Result<(), String> {
    uploads.request(&input.client_request_id)
}

pub(crate) fn create_capture(
    state: &DesktopState,
    library: &LibraryStore,
    input: RuntimeCreateCaptureInput,
    upload: &Upload,
) -> Result<Value, String> {
    validate_document_id(&input.document_id)?;
    validate_client_request_id(&input.client_request_id)?;
    let source = library.runtime_source_file(&input.document_id)?;
    let source_kind = match source.media_type.as_str() {
        "application/pdf" => "pdf",
        "image/png" | "image/jpeg" => "image",
        media_type if RECORDING_MEDIA_TYPES.contains(&media_type) => "audio",
        _ => return Err("Capture source media type is unsupported.".into()),
    };
    if let Some(page_numbers) = input.pdf_page_numbers.as_deref() {
        validate_pdf_page_numbers(page_numbers)?;
        if source_kind != "pdf" {
            return Err("Capture PDF page selection is only valid for PDF sources.".into());
        }
    }
    let config = state.backend_config()?;
    let ingestion_request_id = format!("{}-ingestion", input.client_request_id);
    let pdf_page_numbers = input.pdf_page_numbers.clone();
    let open_body = json_body(json!({
        "protocolVersion": "2",
        "clientRequestId": ingestion_request_id,
        "kind": source_kind,
        "mode": "file",
        "fileName": source.file_name.clone(),
        "mediaType": source.media_type.clone(),
        "totalBytes": source.bytes,
    }))?;
    let ingestion_id = upload_ingestion_source(
        &config,
        &source,
        open_body,
        &input.client_request_id,
        upload,
    )?;
    let capture_body =
        capture_start_body(&input.client_request_id, &ingestion_id, pdf_page_numbers);
    cancel_before_capture_start(&config, &ingestion_id, upload)?;
    let result = request_with_retry(
        &config,
        "POST",
        "/v2/captures",
        Some(json_body(capture_body)?),
        Some(&input.client_request_id),
        &[],
    );
    finish_capture_start(&config, &ingestion_id, result)
}

pub(crate) fn start_streaming_capture(
    state: &DesktopState,
    library: &LibraryStore,
    input: RuntimeStreamingCaptureInput,
    upload: &Upload,
) -> Result<Value, String> {
    validate_document_id(&input.document_id)?;
    validate_client_request_id(&input.client_request_id)?;
    validate_structuring_mode(&input.structuring_mode)?;
    let source = library.runtime_source_file(&input.document_id)?;
    // Audio, or video whose audio track is transcribed.
    if !RECORDING_MEDIA_TYPES.contains(&source.media_type.as_str()) {
        return Err("Progressive capture is available only for recordings.".into());
    }
    let config = state.backend_config()?;
    start_streaming_capture_inner(&config, &source, &input, upload)
}

fn start_streaming_capture_inner(
    config: &BackendConfig,
    source: &RuntimeSourceFile,
    input: &RuntimeStreamingCaptureInput,
    upload: &Upload,
) -> Result<Value, String> {
    let open_body = RequestBody {
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
    };
    let ingestion_id =
        upload_ingestion_source(config, source, open_body, &input.client_request_id, upload)?;
    let capture_body = RequestBody {
        bytes: serde_json::to_vec(&json!({
            "clientRequestId": input.client_request_id,
            "ingestionId": ingestion_id,
            "structuringMode": input.structuring_mode,
            "startPolicy": "eager",
            "identifySpeakers": input.identify_speakers,
        }))
        .map_err(|_| "Progressive capture request cannot be encoded.".to_string())?,
        content_type: "application/json".into(),
    };
    cancel_before_capture_start(config, &ingestion_id, upload)?;
    let result = request_with_retry(
        config,
        "POST",
        "/v2/captures",
        Some(capture_body),
        Some(&input.client_request_id),
        &[],
    );
    finish_capture_start(config, &ingestion_id, result)
}

fn cancel_before_capture_start(
    config: &BackendConfig,
    ingestion_id: &str,
    upload: &Upload,
) -> Result<(), String> {
    if let Err(error) = upload.check() {
        let _ = request(
            config,
            "DELETE",
            &format!("/v2/ingestions/{ingestion_id}"),
            None,
            None,
        );
        return Err(error);
    }
    Ok(())
}

fn finish_capture_start(
    config: &BackendConfig,
    ingestion_id: &str,
    result: Result<Value, transport::RequestError>,
) -> Result<Value, String> {
    match result {
        Err(error) if error.transient => Err("Capture could not be confirmed.".into()),
        Err(error) => {
            let _ = request(
                config,
                "DELETE",
                &format!("/v2/ingestions/{ingestion_id}"),
                None,
                None,
            );
            Err(error.message)
        }
        Ok(value) => Ok(value),
    }
}

fn upload_ingestion_source(
    config: &BackendConfig,
    source: &RuntimeSourceFile,
    open_body: RequestBody,
    client_request_id: &str,
    upload: &Upload,
) -> Result<String, String> {
    upload.check()?;
    let ingestion_request_id = format!("{client_request_id}-ingestion");
    let ingestion = request_with_retry(
        config,
        "POST",
        "/v2/ingestions",
        Some(open_body),
        Some(&ingestion_request_id),
        &[],
    )
    .map_err(|error| upload.outcome(error.message))?;
    let ingestion_id = ingestion
        .get("ingestionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Capture Runtime ingestion response is invalid.".to_string())?;
    validate_opaque_id(ingestion_id)?;
    let result = (|| {
        let source_digest =
            upload_source_chunks(config, source, ingestion_id, client_request_id, upload)?;
        upload.check()?;
        request_with_retry(
            config,
            "POST",
            &format!("/v2/ingestions/{ingestion_id}/finalize"),
            Some(json_body(json!({
                "protocolVersion": "2",
                "totalBytes": source.bytes,
                "sha256": source_digest,
            }))?),
            None,
            &[],
        )
        .map_err(|error| error.message)
    })();
    if let Err(error) = result {
        let _ = request(
            config,
            "DELETE",
            &format!("/v2/ingestions/{ingestion_id}"),
            None,
            None,
        );
        return Err(upload.outcome(error));
    }
    Ok(ingestion_id.to_string())
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
    upload: &Upload,
) -> Result<String, String> {
    let mut file = std::fs::File::open(&source.path)
        .map_err(|_| "Capture library source cannot be opened for streaming.".to_string())?;
    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    let mut chunk_index = 0_u64;
    let mut buffer = vec![0_u8; STREAM_CHUNK_BYTES];
    while offset < source.bytes {
        upload.check()?;
        let remaining = (source.bytes - offset) as usize;
        let target = remaining.min(STREAM_CHUNK_BYTES);
        file.read_exact(&mut buffer[..target])
            .map_err(|_| "Capture library source changed during streaming upload.".to_string())?;
        let bytes = &buffer[..target];
        hasher.update(bytes);
        let digest = hex_digest(bytes);
        let end = offset + bytes.len() as u64 - 1;
        request_with_retry(
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
        )
        .map_err(|error| error.message)?;
        offset += bytes.len() as u64;
        chunk_index += 1;
    }
    let mut extra = [0_u8; 1];
    if file
        .read(&mut extra)
        .map_err(|_| "Capture library source cannot be hashed.".to_string())?
        != 0
    {
        return Err("Capture library source changed during finalization.".into());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn json_body(value: Value) -> Result<RequestBody, String> {
    serde_json::to_vec(&value)
        .map(|bytes| RequestBody {
            bytes,
            content_type: "application/json".into(),
        })
        .map_err(|_| "Capture Runtime JSON request cannot be encoded.".to_string())
}

fn capture_start_body(
    client_request_id: &str,
    ingestion_id: &str,
    pdf_page_numbers: Option<Vec<u32>>,
) -> Value {
    let mut body = json!({
        "protocolVersion": "2",
        "clientRequestId": client_request_id,
        "ingestionId": ingestion_id,
        "structuringMode": "host",
        "startPolicy": "eager",
    });
    if let Some(page_numbers) = pdf_page_numbers {
        body["pdfPageNumbers"] = json!(page_numbers);
    }
    body
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

pub(crate) fn capture_ocr(state: &DesktopState, input: RuntimeIdInput) -> Result<Value, String> {
    capture_value(state, "GET", &input.id, "/ocr", None)
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
    request_json(state, method, &capture_path(capture_id, suffix), body, None)
}

fn capture_path(capture_id: &str, suffix: &str) -> String {
    format!("/v2/captures/{capture_id}{suffix}")
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener, TcpStream},
        path::PathBuf,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

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
                runtime_version: env!("CARGO_PKG_VERSION").into(),
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
    fn ocr_path_is_fixed_and_keeps_the_capture_id_as_one_url_segment() {
        assert_eq!(
            capture_path("capture-1", "/ocr"),
            "/v2/captures/capture-1/ocr"
        );
        assert_eq!(
            capture_path("capture_1", "/ocr"),
            "/v2/captures/capture_1/ocr"
        );
        assert!(!capture_path("capture-1", "/ocr").contains("/v2/captures/capture-1/raw"));
    }

    #[test]
    fn ocr_projection_round_trip_is_authenticated_and_409_is_not_mapped_to_null() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("GET /v2/captures/capture-1/ocr HTTP/1.1"));
            assert!(request.contains("Authorization: Bearer secret-token"));
            let body = concat!(
                r#"{
                "apiVersion":"2.0",
                "schemaVersion":"3",
                "captureId":"capture-1",
                "status":"completed",
                "source":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fileName":"scan.pdf","mediaType":"application/pdf","bytes":1024},
                "pages":[{"page":1,"status":"recognized","raster":{"width":120,"height":80,"scale":1,"coordinateSystem":"pixel"},"text":"OCR","boxes":[{"polygon":[{"x":1,"y":1},{"x":20,"y":1},{"x":20,"y":20},{"x":1,"y":20}],"text":"OCR","confidence":0.9}],"confidence":0.9,"provenance":{"status":"resolved","engine":"windowsml-ocr","model":"pp-ocrv6-medium-windowsml","modelDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","device":"windowsml-dml","profileId":"capture-workbench-ocr-pipeline-v1","profileSpecSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}],
                "pageCount":1,
                "runtimeVersion":""#,
                env!("CARGO_PKG_VERSION"),
                r#"",
                "contractSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "provenance":{"status":"resolved","engine":"windowsml-ocr","model":"pp-ocrv6-medium-windowsml","modelDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","device":"windowsml-dml","profileId":"capture-workbench-ocr-pipeline-v1","profileSpecSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
                "createdAt":"2026-08-14T00:00:00Z"
            }"#
            );
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
                runtime_version: env!("CARGO_PKG_VERSION").into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
            },
            "GET",
            &capture_path("capture-1", "/ocr"),
            None,
            None,
        )
        .expect("projection");
        assert_eq!(value["captureId"], "capture-1");
        server.join().expect("server");

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("request");
            let body = r#"{"code":"ocr_unavailable","message":"OCR is still processing."}"#;
            write!(
                stream,
                "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });
        let error = request(
            &BackendConfig {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "secret-token".into(),
                runtime_version: env!("CARGO_PKG_VERSION").into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
            },
            "GET",
            &capture_path("capture-1", "/ocr"),
            None,
            None,
        )
        .expect_err("OCR unavailable must remain an error");
        assert!(error.contains("HTTP 409"));
        assert!(!error.contains("secret-token"));
        assert_ne!(error, "null");
        server.join().expect("server");
    }

    #[test]
    fn legacy_capture_start_omits_the_optional_pdf_page_scope() {
        let body = capture_start_body("request-1", "ingestion-1", None);
        assert!(!body
            .as_object()
            .expect("capture request object")
            .contains_key("pdfPageNumbers"));

        let scoped = capture_start_body("request-1", "ingestion-1", Some(vec![1]));
        assert_eq!(scoped["pdfPageNumbers"], json!([1]));
    }

    #[test]
    fn phase1_one_shot_image_and_pdf_requests_use_host_structuring() {
        let image = capture_start_body("image-request", "image-ingestion", None);
        assert_eq!(image["structuringMode"], "host");

        let pdf = capture_start_body("pdf-request", "pdf-ingestion", Some(vec![1]));
        assert_eq!(pdf["structuringMode"], "host");
        assert_eq!(pdf["pdfPageNumbers"], json!([1]));
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
                runtime_version: env!("CARGO_PKG_VERSION").into(),
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
            "capture-workbench-streaming-test-{}-{}.mp3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let bytes = vec![0x41_u8; STREAM_CHUNK_BYTES + 17];
        let source_bytes = bytes.len() as u64;
        fs::write(&source_path, &bytes).expect("source");
        let _guard = TempFileGuard(source_path.clone());
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
                runtime_version: env!("CARGO_PKG_VERSION").into(),
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
            &test_upload(),
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

    #[test]
    fn list_and_cancel_installations_proxy_authenticated_runtime_routes() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept list");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request list");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("GET /v2/runtime/installations HTTP/1.1"));
            assert!(request.contains("Authorization: Bearer secret-token"));
            let body = r#"{"items":[{"installationId":"install-1","requirementId":"speech-recognition","status":"running","progress":0.5,"downloadedBytes":1400000000,"downloadBytes":2800000000}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response list");
            // The client reads until the server closes the connection.
            drop(stream);

            let (mut stream, _) = listener.accept().expect("accept cancel");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request cancel");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("POST /v2/runtime/installations/install-1/cancel HTTP/1.1"));
            assert!(request.contains("Authorization: Bearer secret-token"));
            let body = r#"{"installationId":"install-1","requirementId":"speech-recognition","status":"cancelled","progress":0.5}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response cancel");
        });

        let state = DesktopState::with_backend_config_for_test(BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "secret-token".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        });

        let listed = list_installations(&state).expect("list installations");
        assert_eq!(listed["items"][0]["installationId"], "install-1");
        assert_eq!(listed["items"][0]["status"], "running");

        let cancelled = cancel_installation(
            &state,
            RuntimeIdInput {
                id: "install-1".into(),
            },
        )
        .expect("cancel installation");
        assert_eq!(cancelled["installationId"], "install-1");
        assert_eq!(cancelled["status"], "cancelled");

        assert!(cancel_installation(
            &state,
            RuntimeIdInput {
                id: "../install-1".into(),
            },
        )
        .is_err());

        server.join().expect("server");
    }

    #[test]
    fn uninstall_requirement_proxies_delete_and_reports_http_conflict() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept uninstall");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request uninstall");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with(
                "DELETE /v2/runtime/requirements/windowsml-ocr/installation HTTP/1.1"
            ));
            assert!(request.contains("Authorization: Bearer secret-token"));
            let body = r#"{"requirementId":"windowsml-ocr","kind":"runtime","displayName":"WindowsML OCR","status":"installable","requiredFor":["capture"],"installStrategy":"automatic","downloadBytes":144000000}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response uninstall");
            drop(stream);

            let (mut stream, _) = listener.accept().expect("accept conflict");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request conflict");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with(
                "DELETE /v2/runtime/requirements/speech-recognition/installation HTTP/1.1"
            ));
            write!(
                stream,
                "HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("response conflict");
        });

        let state = DesktopState::with_backend_config_for_test(BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "secret-token".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        });

        assert!(uninstall_requirement(
            &state,
            RuntimeRequirementInput {
                requirement_id: "../windowsml-ocr".into(),
            },
        )
        .is_err());

        let removed = uninstall_requirement(
            &state,
            RuntimeRequirementInput {
                requirement_id: "windowsml-ocr".into(),
            },
        )
        .expect("uninstall");
        assert_eq!(removed["requirementId"], "windowsml-ocr");
        assert_eq!(removed["status"], "installable");

        let conflict = uninstall_requirement(
            &state,
            RuntimeRequirementInput {
                requirement_id: "speech-recognition".into(),
            },
        );
        assert!(conflict.expect_err("conflict").contains("HTTP 409"));

        server.join().expect("server");
    }

    struct TempFileGuard(PathBuf);

    impl Drop for TempFileGuard {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn test_upload() -> Upload {
        std::sync::Arc::new(UploadCancellations::default())
            .begin("test-upload")
            .expect("upload")
    }

    fn test_backend_config(port: u16) -> BackendConfig {
        BackendConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "secret-token".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        }
    }

    fn create_test_source_file(
        name: &str,
        content: &[u8],
        media_type: &str,
    ) -> (TempFileGuard, RuntimeSourceFile) {
        let path = PathBuf::from(std::env::temp_dir()).join(format!(
            "capture-workbench-{}-{}-{}.bin",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::write(&path, content).expect("write test source file");
        let source = RuntimeSourceFile {
            file_name: format!("{name}.mp3"),
            media_type: media_type.to_string(),
            path: path.clone(),
            bytes: content.len() as u64,
        };
        (TempFileGuard(path), source)
    }

    fn handle_idempotent_post(
        stream: &mut TcpStream,
        request: &str,
        expected_path: &str,
        success_status: &str,
        success_body: &str,
    ) -> String {
        assert!(request.starts_with(&format!("POST {expected_path} HTTP/1.1")));
        let separator = request.find("\r\n\r\n").expect("headers separator");
        let headers_part = &request[..separator];
        let body_part = &request[separator + 4..];

        let idempotency_header = headers_part
            .lines()
            .find_map(|line| line.strip_prefix("X-Idempotency-Key: "));

        let body_json: Value = serde_json::from_str(body_part).expect("valid json body");
        let client_request_id = body_json.get("clientRequestId").and_then(Value::as_str);

        match idempotency_header {
            None => {
                let error = r#"{"code":"validation_error","message":"Missing X-Idempotency-Key"}"#;
                write!(
                    stream,
                    "HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    error.len(),
                    error
                )
                .expect("write 422");
                String::new()
            }
            Some(key) if Some(key) != client_request_id => {
                let error = r#"{"code":"idempotency_conflict","message":"Key mismatch"}"#;
                write!(
                    stream,
                    "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    error.len(),
                    error
                )
                .expect("write 409");
                String::new()
            }
            Some(key) => {
                write!(
                    stream,
                    "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    success_status,
                    success_body.len(),
                    success_body
                )
                .expect("write success response");
                key.to_string()
            }
        }
    }

    #[test]
    fn cancel_upload_command_accepts_unknown_ids_and_rejects_invalid_ids() {
        let registry = std::sync::Arc::new(UploadCancellations::default());
        // A cancel that overtakes its start command is kept for that upload.
        cancel_upload(
            &registry,
            RuntimeCancelUploadInput {
                client_request_id: "early-upload".into(),
            },
        )
        .expect("unknown upload accepted");
        assert_eq!(
            registry
                .begin("early-upload")
                .expect("upload")
                .check()
                .unwrap_err(),
            "Upload was cancelled."
        );
        let upload = registry.begin("active-upload").expect("new upload");
        assert!(cancel_upload(
            &registry,
            RuntimeCancelUploadInput {
                client_request_id: "invalid/id".into(),
            }
        )
        .is_err());
        upload
            .check()
            .expect("rejected cancellation leaves active uploads unchanged");
    }

    #[test]
    fn recording_path_cancellation_boundaries_and_registry_cleanup() {
        // The server marks cancellation before closing a response, so the next
        // client request observes it deterministically, without sleeps.
        for boundary in [
            "open", "chunk", "chunk-1", "finalize", "capture", "failure", "success",
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
            let config = test_backend_config(listener.local_addr().expect("address").port());
            let (_guard, source) = create_test_source_file(
                "cancel-upload",
                &vec![b'x'; STREAM_CHUNK_BYTES + 1],
                "audio/mpeg",
            );
            let input = RuntimeStreamingCaptureInput {
                document_id: "0123456789abcdef0123456789abcdef".into(),
                client_request_id: "cancel-boundary".into(),
                structuring_mode: "host".into(),
                identify_speakers: false,
            };
            let registry = std::sync::Arc::new(UploadCancellations::default());
            let server_registry = std::sync::Arc::clone(&registry);
            let server = thread::spawn(move || {
                let mut steps = vec![("POST /v2/ingestions HTTP/1.1", "open")];
                if boundary != "open" {
                    steps.push((
                        "PUT /v2/ingestions/ingestion-cancel/chunks/0 HTTP/1.1",
                        "chunk",
                    ));
                }
                if !matches!(boundary, "open" | "chunk" | "failure") {
                    steps.push((
                        "PUT /v2/ingestions/ingestion-cancel/chunks/1 HTTP/1.1",
                        "chunk-1",
                    ));
                    if boundary != "chunk-1" {
                        steps.push((
                            "POST /v2/ingestions/ingestion-cancel/finalize HTTP/1.1",
                            "finalize",
                        ));
                    }
                }
                if matches!(boundary, "capture" | "success") {
                    steps.push(("POST /v2/captures HTTP/1.1", "capture"));
                } else {
                    steps.push(("DELETE /v2/ingestions/ingestion-cancel HTTP/1.1", "delete"));
                }
                for (expected, step) in steps {
                    let (mut stream, _) = listener.accept().expect("accept");
                    let request = read_http_request(&mut stream);
                    assert!(
                        request.starts_with(expected),
                        "unexpected request at {boundary}/{step}"
                    );
                    if boundary == step {
                        server_registry.request("cancel-boundary").expect("cancel");
                    }
                    let (status, body) = match step {
                        "open" => ("201 Created", r#"{"ingestionId":"ingestion-cancel"}"#),
                        "capture" => (
                            "201 Created",
                            r#"{"captureId":"capture-cancel","status":"queued"}"#,
                        ),
                        "chunk" if boundary == "failure" => ("422 Unprocessable Entity", "{}"),
                        _ => ("200 OK", "{}"),
                    };
                    write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("response");
                    drop(stream);
                }
                listener.set_nonblocking(true).expect("nonblocking");
                assert!(listener.accept().is_err(), "no additional request");
            });
            let result = (|| {
                let upload = registry.begin(&input.client_request_id)?;
                start_streaming_capture_inner(&config, &source, &input, &upload)
            })();
            server.join().expect("server");
            match boundary {
                "capture" | "success" => assert_eq!(
                    result.expect("capture succeeds")["captureId"],
                    "capture-cancel"
                ),
                "failure" => assert!(result.is_err()),
                _ => assert_eq!(
                    result.expect_err("upload cancelled"),
                    "Upload was cancelled."
                ),
            }
            // A live duplicate is rejected; reuse after every outcome proves removal.
            let reused = registry
                .begin(&input.client_request_id)
                .expect("entry removed");
            assert!(registry.begin(&input.client_request_id).is_err());
            reused.check().expect("late cancellation is not retained");
        }
    }

    #[test]
    fn recording_path_cancelled_during_chunk_retries_reports_the_cancellation() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let config = test_backend_config(listener.local_addr().expect("address").port());
        let (_guard, source) = create_test_source_file("cancel-retry", b"ID3audio", "audio/mpeg");
        let input = RuntimeStreamingCaptureInput {
            document_id: "0123456789abcdef0123456789abcdef".into(),
            client_request_id: "cancel-retry".into(),
            structuring_mode: "host".into(),
            identify_speakers: false,
        };
        let registry = std::sync::Arc::new(UploadCancellations::default());
        let server_registry = std::sync::Arc::clone(&registry);
        let server = thread::spawn(move || {
            let chunk = "PUT /v2/ingestions/ingestion-retry/chunks/0 HTTP/1.1";
            let steps = [
                ("POST /v2/ingestions HTTP/1.1", "201 Created"),
                (chunk, "503 Service Unavailable"),
                (chunk, "503 Service Unavailable"),
                (chunk, "503 Service Unavailable"),
                ("DELETE /v2/ingestions/ingestion-retry HTTP/1.1", "200 OK"),
            ];
            for (index, (expected, status)) in steps.into_iter().enumerate() {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                assert!(request.starts_with(expected), "unexpected request {index}");
                if index == 1 {
                    // The user cancels while the first attempt fails transiently.
                    server_registry.request("cancel-retry").expect("cancel");
                }
                let body = if index == 0 {
                    r#"{"ingestionId":"ingestion-retry"}"#
                } else {
                    "{}"
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .expect("response");
                drop(stream);
            }
            listener.set_nonblocking(true).expect("nonblocking");
            assert!(listener.accept().is_err(), "no additional request");
        });
        let result = (|| {
            let upload = registry.begin(&input.client_request_id)?;
            start_streaming_capture_inner(&config, &source, &input, &upload)
        })();
        server.join().expect("server");
        assert_eq!(
            result.expect_err("upload cancelled"),
            "Upload was cancelled."
        );
    }

    #[test]
    fn recording_path_sends_required_idempotency_keys_and_returns_capture_json() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (_guard, source) =
            create_test_source_file("streaming-rec", b"small audio content", "audio/mpeg");
        let config = test_backend_config(port);
        let input = RuntimeStreamingCaptureInput {
            document_id: "0123456789abcdef0123456789abcdef".into(),
            client_request_id: "test-client-req".into(),
            structuring_mode: "host".into(),
            identify_speakers: false,
        };

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept ingestion");
            let req = read_http_request(&mut stream);
            let ingestion_key = handle_idempotent_post(
                &mut stream,
                &req,
                "/v2/ingestions",
                "201 Created",
                r#"{"ingestionId":"ingestion-stream-1"}"#,
            );

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept chunk");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("PUT /v2/ingestions/ingestion-stream-1/chunks/0 HTTP/1.1"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .expect("write chunk response");

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept finalize");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("POST /v2/ingestions/ingestion-stream-1/finalize HTTP/1.1"));
            let finalize_body = r#"{"ingestionId":"ingestion-stream-1","status":"ready"}"#;
            write!(
                stream,
                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                finalize_body.len(),
                finalize_body
            )
            .expect("write finalize response");

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept capture");
            let req = read_http_request(&mut stream);
            let capture_key = handle_idempotent_post(
                &mut stream,
                &req,
                "/v2/captures",
                "201 Created",
                r#"{"captureId":"capture-stream-1","status":"queued"}"#,
            );

            (ingestion_key, capture_key)
        });

        let result = start_streaming_capture_inner(&config, &source, &input, &test_upload())
            .expect("capture call succeeds");
        let (ingestion_key, capture_key) = server.join().expect("server thread");

        assert_eq!(result["captureId"], "capture-stream-1");
        assert_eq!(result["status"], "queued");
        assert_eq!(ingestion_key, "test-client-req-ingestion");
        assert_eq!(capture_key, "test-client-req");
    }

    #[test]
    fn recording_path_rejects_invalid_ingestion_id_before_uploading_chunks() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (_guard, source) =
            create_test_source_file("streaming-invalid-id", b"audio-bytes", "audio/mpeg");
        let config = test_backend_config(port);
        let input = RuntimeStreamingCaptureInput {
            document_id: "0123456789abcdef0123456789abcdef".into(),
            client_request_id: "test-client-req".into(),
            structuring_mode: "host".into(),
            identify_speakers: false,
        };

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept ingestion");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("POST /v2/ingestions HTTP/1.1"));
            let body = r#"{"ingestionId":"../invalid_id"}"#;
            write!(
                stream,
                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write response");
        });

        let error = start_streaming_capture_inner(&config, &source, &input, &test_upload())
            .expect_err("should reject invalid ingestionId");
        assert_eq!(error, "Capture Runtime identifier is invalid.");
        server.join().expect("server thread");
    }

    #[test]
    fn recording_path_deletes_ingestion_when_capture_start_fails() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (_guard, source) =
            create_test_source_file("streaming-fail", b"audio-bytes", "audio/mpeg");
        let config = test_backend_config(port);
        let input = RuntimeStreamingCaptureInput {
            document_id: "0123456789abcdef0123456789abcdef".into(),
            client_request_id: "test-client-req".into(),
            structuring_mode: "host".into(),
            identify_speakers: false,
        };

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept ingestion");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("POST /v2/ingestions HTTP/1.1"));
            let body = r#"{"ingestionId":"ingestion-delete-test"}"#;
            write!(
                stream,
                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write ingestion response");

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept chunk");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("PUT /v2/ingestions/ingestion-delete-test/chunks/0 HTTP/1.1"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
            .expect("write chunk response");

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept finalize");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("POST /v2/ingestions/ingestion-delete-test/finalize HTTP/1.1"));
            let body = r#"{"ingestionId":"ingestion-delete-test","status":"ready"}"#;
            write!(
                stream,
                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write finalize response");

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept capture");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("POST /v2/captures HTTP/1.1"));
            let body = r#"{"code":"internal_error","message":"capture failed"}"#;
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write capture 500");

            drop(stream);
            let (mut stream, _) = listener.accept().expect("accept delete");
            let req = read_http_request(&mut stream);
            assert!(req.starts_with("DELETE /v2/ingestions/ingestion-delete-test HTTP/1.1"));
            write!(
                stream,
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("write delete response");
        });

        let error = start_streaming_capture_inner(&config, &source, &input, &test_upload())
            .expect_err("capture start should fail");
        assert!(error.contains("HTTP 500"));
        server.join().expect("server thread");
    }
    // Each script entry consumes exactly one connection; dropping it is required
    // because the native transport reads to EOF before issuing the next request.
    fn replay_scenario(stage: usize, failures: usize, status: Option<u16>, succeeds: bool) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let content = vec![b'a'; STREAM_CHUNK_BYTES + 17];
        let expected_digest = hex_digest(&content);
        let (_guard, source) = create_test_source_file("replay", &content, "audio/mpeg");
        let config = test_backend_config(port);
        let input = RuntimeStreamingCaptureInput {
            document_id: "0123456789abcdef0123456789abcdef".into(),
            client_request_id: "replay-request".into(),
            structuring_mode: "host".into(),
            identify_speakers: false,
        };
        let server = thread::spawn(move || {
            let paths = [
                "POST /v2/ingestions HTTP/1.1",
                "PUT /v2/ingestions/replay-ingestion/chunks/0 HTTP/1.1",
                "PUT /v2/ingestions/replay-ingestion/chunks/1 HTTP/1.1",
                "POST /v2/ingestions/replay-ingestion/finalize HTTP/1.1",
                "POST /v2/captures HTTP/1.1",
            ];
            for (index, path) in paths.iter().enumerate() {
                let attempts = if index == stage {
                    failures + usize::from(succeeds)
                } else {
                    1
                };
                let mut first_request = None;
                for attempt in 0..attempts {
                    let (mut stream, _) = listener.accept().expect("accept request");
                    let req = read_http_request(&mut stream);
                    assert!(req.starts_with(path), "unexpected request route");
                    if let Some(first) = &first_request {
                        // Avoid printing authenticated request bytes on failure.
                        assert!(&req == first, "replay must be byte-identical");
                    } else {
                        first_request = Some(req.clone());
                    }
                    if index == 3 {
                        let (_, body) = req.split_once("\r\n\r\n").expect("body");
                        let body: Value = serde_json::from_str(body).expect("finalize json");
                        assert_eq!(body["sha256"], expected_digest);
                        assert_eq!(body["totalBytes"], (STREAM_CHUNK_BYTES + 17) as u64);
                    }
                    if index == stage && attempt < failures {
                        if let Some(status) = status {
                            write!(
                                stream,
                                "HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\n\r\n"
                            )
                            .expect("failure");
                        }
                    } else {
                        let body = match index {
                            0 => r#"{"ingestionId":"replay-ingestion"}"#,
                            4 => r#"{"captureId":"replay-capture"}"#,
                            _ => "{}",
                        };
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .expect("success");
                    }
                    drop(stream);
                }
                if index == stage && !succeeds {
                    // An exhausted transient start may already own the source.
                    if stage != 4 || !matches!(status, None | Some(502..=504)) {
                        let (mut stream, _) = listener.accept().expect("accept cleanup");
                        let req = read_http_request(&mut stream);
                        assert!(req.starts_with("DELETE /v2/ingestions/replay-ingestion HTTP/1.1"));
                        write!(
                            stream,
                            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"
                        )
                        .expect("cleanup");
                        drop(stream);
                    }
                    break;
                }
            }
            listener.set_nonblocking(true).expect("nonblocking");
            // Keep the listener alive until the caller has returned, so a
            // forbidden extra request is observed rather than connection-refused.
            listener
        });
        let result = start_streaming_capture_inner(&config, &source, &input, &test_upload());
        let listener = server.join().expect("server");
        assert!(listener.accept().is_err(), "unexpected additional request");
        if succeeds {
            assert_eq!(result.expect("capture")["captureId"], "replay-capture");
        } else if stage == 4 && matches!(status, None | Some(502..=504)) {
            assert_eq!(
                result.expect_err("unconfirmed"),
                "Capture could not be confirmed."
            );
        } else {
            assert!(result.is_err());
        }
    }

    #[test]
    fn upload_replays_lost_responses_and_gateway_failures_identically() {
        for stage in [0, 1, 3, 4] {
            for status in [None, Some(502), Some(503), Some(504)] {
                replay_scenario(stage, 1, status, true);
            }
        }
    }

    #[test]
    fn exhausted_chunk_stops_before_next_chunk_and_cleans_up() {
        for status in [None, Some(503)] {
            replay_scenario(1, 3, status, false);
        }
    }

    #[test]
    fn exhausted_finalize_cleans_up() {
        replay_scenario(3, 3, None, false);
        replay_scenario(3, 3, Some(503), false);
    }

    #[test]
    fn rejected_chunk_is_not_retried_and_cleans_up() {
        for status in [409, 422] {
            replay_scenario(1, 1, Some(status), false);
        }
    }

    #[test]
    fn start_cleanup_depends_on_confirmation() {
        replay_scenario(4, 1, Some(500), false);
        for status in [None, Some(503)] {
            replay_scenario(4, 3, status, false);
        }
    }
}
