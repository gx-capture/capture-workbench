use std::{
    collections::{HashMap, HashSet},
    env,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::{api_error, api_error_details, find_bytes, Request, Response};

const RUNTIME_VERSION: &str = "0.3.11";
const API_VERSION: &str = "1.0";
const SCHEMA_VERSION: &str = "1";
const CREATED_AT: &str = "2000-01-01T00:00:00Z";
const COMPLETED_AT: &str = "2000-01-01T00:00:01Z";
const INGESTION_EXPIRES_AT: &str = "2000-01-01T02:00:00Z";
const STREAM_CHUNK_BYTES: usize = 1024 * 1024;
const EVENT_REPLAY_WINDOW: u64 = 2;

pub struct FixtureSettings {
    pub api_token: String,
    max_upload_bytes: usize,
}

impl FixtureSettings {
    pub fn from_env() -> Result<Self, String> {
        let api_token = required_env("CAPTURE_API_TOKEN")?;
        if api_token.len() < 32 {
            return Err("CAPTURE_API_TOKEN must contain at least 32 characters.".into());
        }
        let max_upload_bytes = env::var("CAPTURE_MAX_UPLOAD_BYTES")
            .unwrap_or_else(|_| (50 * 1024 * 1024).to_string())
            .parse::<usize>()
            .map_err(|_| "CAPTURE_MAX_UPLOAD_BYTES must be a positive integer.".to_string())?;
        if max_upload_bytes == 0 {
            return Err("CAPTURE_MAX_UPLOAD_BYTES must be positive.".into());
        }
        Ok(Self {
            api_token,
            max_upload_bytes,
        })
    }
}

#[derive(Clone)]
struct IngestionRecord {
    ingestion_id: String,
    kind: String,
    file_name: String,
    media_type: String,
    total_bytes: u64,
    received_bytes: u64,
    contiguous_bytes: u64,
    next_chunk_index: u64,
    next_offset: u64,
    source_sha256: Option<String>,
    finalized_sha256: Option<String>,
    status: String,
    content: Vec<u8>,
}

impl IngestionRecord {
    fn wire(&self) -> Value {
        json!({
            "protocolVersion": "2",
            "ingestionId": self.ingestion_id,
            "kind": self.kind,
            "status": self.status,
            "fileName": self.file_name,
            "mediaType": self.media_type,
            "totalBytes": self.total_bytes,
            "receivedBytes": self.received_bytes,
            "contiguousBytes": self.contiguous_bytes,
            "nextChunkIndex": self.next_chunk_index,
            "nextOffset": self.next_offset,
            "sourceSha256": self.source_sha256,
            "finalizedSha256": self.finalized_sha256,
            "expiresAt": INGESTION_EXPIRES_AT,
        })
    }
}

#[derive(Clone)]
struct CaptureRecord {
    capture_id: String,
    ingestion_id: String,
    kind: String,
    status: String,
    stage: String,
    structuring_mode: String,
    target_language: Option<String>,
    progress: f64,
    source: Value,
    raw: Value,
    partial: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
    events: Vec<Value>,
    last_event_sequence: u64,
    partial_revision: u64,
    completed_at: Option<String>,
}

impl CaptureRecord {
    fn operation_wire(&self) -> Value {
        json!({
            "protocolVersion": "2",
            "captureId": self.capture_id,
            "ingestionId": self.ingestion_id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "partialRevision": self.partial_revision,
            "lastEventSequence": self.last_event_sequence,
            "source": self.source,
            "error": self.error,
            "createdAt": CREATED_AT,
            "updatedAt": if self.completed_at.is_some() { COMPLETED_AT } else { CREATED_AT },
            "completedAt": self.completed_at,
        })
    }
}

#[derive(Clone)]
struct InstallationRecord {
    installation_id: String,
    requirement_id: String,
}

#[derive(Clone)]
struct ModelInstallationRecord {
    installation_id: String,
    option_id: String,
}

impl ModelInstallationRecord {
    fn wire(&self) -> Value {
        json!({
            "installationId": self.installation_id,
            "optionId": self.option_id,
            "status": "completed",
            "progress": 1,
            "error": null,
            "createdAt": CREATED_AT,
            "updatedAt": COMPLETED_AT,
            "completedAt": COMPLETED_AT,
        })
    }
}

impl InstallationRecord {
    fn wire(&self) -> Value {
        json!({
            "installationId": self.installation_id,
            "requirementId": self.requirement_id,
            "status": "completed",
            "progress": 1,
            "error": null,
            "createdAt": CREATED_AT,
            "updatedAt": COMPLETED_AT,
            "completedAt": COMPLETED_AT,
        })
    }
}

#[derive(Clone)]
struct IdempotencyRecord {
    fingerprint: String,
    resource_id: String,
}

pub struct FixtureState {
    settings: FixtureSettings,
    next_capture: AtomicUsize,
    next_ingestion: AtomicUsize,
    next_installation: AtomicUsize,
    next_model_installation: AtomicUsize,
    captures: Mutex<HashMap<String, CaptureRecord>>,
    capture_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    commit_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    ingestions: Mutex<HashMap<String, IngestionRecord>>,
    ingestion_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    installations: Mutex<HashMap<String, InstallationRecord>>,
    installation_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    model_installations: Mutex<HashMap<String, ModelInstallationRecord>>,
    model_installation_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
}

impl FixtureState {
    pub fn new(settings: FixtureSettings) -> Self {
        Self {
            settings,
            next_capture: AtomicUsize::new(1),
            next_ingestion: AtomicUsize::new(1),
            next_installation: AtomicUsize::new(1),
            next_model_installation: AtomicUsize::new(1),
            captures: Mutex::new(HashMap::new()),
            capture_idempotency: Mutex::new(HashMap::new()),
            commit_idempotency: Mutex::new(HashMap::new()),
            ingestions: Mutex::new(HashMap::new()),
            ingestion_idempotency: Mutex::new(HashMap::new()),
            installations: Mutex::new(HashMap::new()),
            installation_idempotency: Mutex::new(HashMap::new()),
            model_installations: Mutex::new(HashMap::new()),
            model_installation_idempotency: Mutex::new(HashMap::new()),
        }
    }

    pub fn route(&self, request: Request) -> Response {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/health/ready") => self.ready(),
            ("GET", "/v1/runtime/requirements") => self.requirements(),
            ("GET", "/v1/runtime/model-options") => self.model_options(),
            ("GET", "/v1/runtime/installations") => self.list_installations(),
            ("POST", "/v1/runtime/installations") => self.create_installation(&request),
            ("POST", "/v1/runtime/model-installations") => self.create_model_installation(&request),
            ("POST", "/v2/ingestions") => self.open_ingestion(&request),
            _ if request.path.starts_with("/v2/ingestions/") => self.route_ingestion(&request),
            ("POST", "/v2/captures") => self.start_capture(&request),
            _ if request.path.starts_with("/v2/captures/") => self.route_capture(&request),
            _ if request.path.starts_with("/v1/runtime/installations/") => {
                self.route_installation(&request)
            }
            _ if request.path.starts_with("/v1/runtime/model-installations/") => {
                self.route_model_installation(&request)
            }
            _ => api_error(404, "not_found", "Resource was not found."),
        }
    }

    fn ready(&self) -> Response {
        Response::json(
            200,
            json!({
                "ready": true,
                "service": "capture-runtime",
                "apiVersion": API_VERSION,
                "runtimeVersion": RUNTIME_VERSION,
                "captureDocumentSchemaVersion": SCHEMA_VERSION,
                "capabilities": {
                    "captureKinds": ["pdf", "image", "audio"],
                    "structuringModes": ["runtime", "host"],
                    "supportsCancellation": true,
                    "supportsRawDiagnostics": true,
                    "maxUploadBytes": self.settings.max_upload_bytes,
                },
                "message": null,
            }),
        )
    }

    fn requirements(&self) -> Response {
        Response::json(
            200,
            json!({
                "items": [
                    requirement("windowsml-ocr", "ocr", "WindowsML OCR", &["pdf", "image"]),
                    requirement("whisper-primary", "stt", "Whisper", &["audio"]),
                    requirement("ollama-runtime", "llm-runtime", "Ollama", &["structuring"]),
                    requirement(
                        "capture-ollama-model",
                        "llm-model",
                        "Capture structuring model",
                        &["structuring"],
                    ),
                ]
            }),
        )
    }

    fn model_options(&self) -> Response {
        Response::json(
            200,
            json!({
                "catalogSha256": "a".repeat(64),
                "items": [
                    model_option("qwen3.5-0.8b-v1", "Qwen 3.5 0.8B", "qwen3.5:0.8b", "active"),
                    model_option("qwen3.5-2b-v1", "Qwen 3.5 2B", "qwen3.5:2b", "not-installed"),
                    model_option("qwen3.5-4b-v1", "Qwen 3.5 4B", "qwen3.5:4b", "not-installed"),
                ],
            }),
        )
    }

    fn open_ingestion(&self, request: &Request) -> Response {
        let payload = match parse_json_object(request) {
            Ok(payload) => payload,
            Err(response) => return response,
        };
        let client_request_id = match required_string_field(&payload, "clientRequestId") {
            Ok(value) => value,
            Err(response) => return response,
        };
        if !valid_opaque_id(&client_request_id) {
            return validation_error("clientRequestId is invalid.");
        }
        let kind = match required_string_field(&payload, "kind") {
            Ok(value) if matches!(value.as_str(), "pdf" | "image" | "audio") => value,
            _ => return validation_error("kind must be pdf, image, or audio."),
        };
        let mode = payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("file");
        if mode != "file" {
            return validation_error("mode must be file.");
        }
        let file_name = match required_string_field(&payload, "fileName") {
            Ok(value) if !value.trim().is_empty() && value.len() <= 255 => safe_filename(&value),
            _ => return validation_error("fileName is invalid."),
        };
        let media_type = match required_string_field(&payload, "mediaType") {
            Ok(value) if !value.trim().is_empty() && value.len() <= 128 => value,
            _ => return validation_error("mediaType is invalid."),
        };
        let total_bytes = match payload.get("totalBytes").and_then(Value::as_u64) {
            Some(value) if value > 0 && value as usize <= self.settings.max_upload_bytes => value,
            _ => return validation_error("totalBytes is invalid."),
        };
        let source_sha256 = match payload.get("sourceSha256") {
            Some(Value::Null) | None => None,
            Some(Value::String(value)) if valid_sha256_hex(value) => Some(value.clone()),
            _ => return validation_error("sourceSha256 must be a SHA-256 hex digest."),
        };
        let fingerprint = sha256_hex(&request.body);
        if let Some(existing) = self
            .ingestion_idempotency
            .lock()
            .ok()
            .and_then(|items| items.get(&client_request_id).cloned())
        {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Ingestion request id was already used with a different request.",
                );
            }
            return self.ingestion_response(&existing.resource_id, 201);
        }
        let ingestion_id = format!(
            "ingestion-{}",
            self.next_ingestion.fetch_add(1, Ordering::Relaxed)
        );
        let record = IngestionRecord {
            ingestion_id: ingestion_id.clone(),
            kind: kind.clone(),
            file_name,
            media_type,
            total_bytes,
            received_bytes: 0,
            contiguous_bytes: 0,
            next_chunk_index: 0,
            next_offset: 0,
            source_sha256,
            finalized_sha256: None,
            status: "open".into(),
            content: Vec::new(),
        };
        if let Ok(mut ingestions) = self.ingestions.lock() {
            ingestions.insert(ingestion_id.clone(), record.clone());
        }
        if let Ok(mut items) = self.ingestion_idempotency.lock() {
            items.insert(
                client_request_id,
                IdempotencyRecord {
                    fingerprint,
                    resource_id: ingestion_id,
                },
            );
        }
        Response::json(201, record.wire())
    }

    fn route_ingestion(&self, request: &Request) -> Response {
        let relative = request.path.trim_start_matches("/v2/ingestions/");
        if let Some(ingestion_id) = relative.strip_suffix("/finalize") {
            return if request.method == "POST" {
                self.finalize_ingestion(ingestion_id, request)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some((ingestion_id, chunk_path)) = relative.split_once('/') {
            if let Some(chunk_index) = chunk_path.strip_prefix("chunks/") {
                if !chunk_index.contains('/') {
                    return if request.method == "PUT" {
                        self.append_chunk(ingestion_id, chunk_index, request)
                    } else {
                        api_error(404, "not_found", "Resource was not found.")
                    };
                }
            }
            return api_error(404, "not_found", "Resource was not found.");
        }
        match request.method.as_str() {
            "GET" => self.ingestion_response(relative, 200),
            "DELETE" => self.delete_ingestion(relative),
            _ => api_error(404, "not_found", "Resource was not found."),
        }
    }

    fn ingestion_response(&self, ingestion_id: &str, status: u16) -> Response {
        let record = self
            .ingestions
            .lock()
            .ok()
            .and_then(|items| items.get(ingestion_id).cloned());
        match record {
            Some(record) => Response::json(status, record.wire()),
            None => api_error(404, "ingestion_not_found", "Ingestion was not found."),
        }
    }

    fn append_chunk(&self, ingestion_id: &str, chunk_index: &str, request: &Request) -> Response {
        let chunk_index = match chunk_index.parse::<u64>() {
            Ok(value) => value,
            Err(_) => return validation_error("Chunk index is invalid."),
        };
        let (start, end, total) = match parse_content_range(request) {
            Some(value) => value,
            None => return validation_error("Content-Range header is invalid."),
        };
        let digest = match request
            .headers
            .get("digest")
            .map(String::as_str)
            .and_then(parse_sha256_digest)
        {
            Some(value) => value,
            None => return validation_error("Digest header is invalid."),
        };
        if request
            .headers
            .get("x-idempotency-key")
            .is_none_or(|value| !valid_request_key(value))
        {
            return validation_error("X-Idempotency-Key is invalid.");
        }
        let Ok(mut ingestions) = self.ingestions.lock() else {
            return api_error(
                500,
                "runtime_unavailable",
                "Ingestion state is unavailable.",
            );
        };
        let Some(record) = ingestions.get_mut(ingestion_id) else {
            return api_error(404, "ingestion_not_found", "Ingestion was not found.");
        };
        if record.status != "open" {
            return api_error(409, "chunk_rejected", "Ingestion is not accepting chunks.");
        }
        if total != record.total_bytes {
            return api_error(
                409,
                "chunk_total_conflict",
                "Content-Range total does not match the ingestion source size.",
            );
        }
        if start != record.next_offset || chunk_index != record.next_chunk_index {
            return api_error(
                409,
                "chunk_out_of_order",
                "Chunk is not contiguous with the ingestion.",
            );
        }
        let chunk_len = request.body.len() as u64;
        if end < start || end - start + 1 != chunk_len {
            return api_error(
                422,
                "chunk_length_mismatch",
                "Chunk length does not match Content-Range.",
            );
        }
        if chunk_len as usize > STREAM_CHUNK_BYTES {
            return api_error(
                413,
                "chunk_too_large",
                "Chunk exceeds the configured size limit.",
            );
        }
        if sha256_hex(&request.body) != digest {
            return api_error(
                409,
                "chunk_checksum_mismatch",
                "Chunk digest does not match the uploaded bytes.",
            );
        }
        record.content.extend_from_slice(&request.body);
        record.received_bytes = end + 1;
        record.contiguous_bytes = end + 1;
        record.next_chunk_index = chunk_index + 1;
        record.next_offset = end + 1;
        let response = record.wire();
        drop(ingestions);
        Response::json(200, response)
    }

    fn finalize_ingestion(&self, ingestion_id: &str, request: &Request) -> Response {
        let payload = match parse_json_object(request) {
            Ok(payload) => payload,
            Err(response) => return response,
        };
        let total_bytes = match payload.get("totalBytes").and_then(Value::as_u64) {
            Some(value) => value,
            None => return validation_error("totalBytes is required."),
        };
        let sha256 = match payload.get("sha256").and_then(Value::as_str) {
            Some(value) if valid_sha256_hex(value) => value.to_owned(),
            _ => return validation_error("sha256 must be a SHA-256 hex digest."),
        };
        let Ok(mut ingestions) = self.ingestions.lock() else {
            return api_error(
                500,
                "runtime_unavailable",
                "Ingestion state is unavailable.",
            );
        };
        let Some(record) = ingestions.get_mut(ingestion_id) else {
            return api_error(404, "ingestion_not_found", "Ingestion was not found.");
        };
        if record.status != "open" {
            return api_error(
                409,
                "ingestion_finalize_rejected",
                "Ingestion is not open for finalization.",
            );
        }
        if total_bytes != record.total_bytes
            || record.received_bytes != record.total_bytes
            || record.next_offset != record.total_bytes
        {
            return api_error(
                409,
                "ingestion_finalize_rejected",
                "Ingestion is not complete or totalBytes does not match.",
            );
        }
        record.finalized_sha256 = Some(sha256);
        record.status = "ready".into();
        let response = record.wire();
        drop(ingestions);
        Response::json(200, response)
    }

    fn delete_ingestion(&self, ingestion_id: &str) -> Response {
        let removed = self
            .ingestions
            .lock()
            .ok()
            .and_then(|mut items| items.remove(ingestion_id));
        if removed.is_some() {
            Response::empty(204)
        } else {
            api_error(404, "ingestion_not_found", "Ingestion was not found.")
        }
    }

    fn start_capture(&self, request: &Request) -> Response {
        let payload = match parse_json_object(request) {
            Ok(payload) => payload,
            Err(response) => return response,
        };
        let client_request_id = match required_string_field(&payload, "clientRequestId") {
            Ok(value) => value,
            Err(response) => return response,
        };
        if !valid_opaque_id(&client_request_id) {
            return validation_error("clientRequestId is invalid.");
        }
        let ingestion_id = match required_string_field(&payload, "ingestionId") {
            Ok(value) if valid_opaque_id(&value) => value,
            _ => return validation_error("ingestionId is invalid."),
        };
        let structuring_mode = match required_string_field(&payload, "structuringMode") {
            Ok(value) if matches!(value.as_str(), "runtime" | "host") => value,
            _ => return validation_error("structuringMode must be runtime or host."),
        };
        if payload.get("startPolicy").and_then(Value::as_str) != Some("eager") {
            return validation_error("startPolicy must be eager.");
        }
        let target_language = match payload.get("targetLanguage") {
            Some(Value::Null) | None => None,
            Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= 64 => {
                Some(value.trim().to_owned())
            }
            _ => return validation_error("targetLanguage must be 1 to 64 characters."),
        };
        let fingerprint = sha256_hex(&request.body);
        if let Some(existing) = self
            .capture_idempotency
            .lock()
            .ok()
            .and_then(|items| items.get(&client_request_id).cloned())
        {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Capture request id was already used with a different request.",
                );
            }
            return self.operation_response(&existing.resource_id, 202);
        }
        let ingestion = self
            .ingestions
            .lock()
            .ok()
            .and_then(|items| items.get(&ingestion_id).cloned());
        let Some(ingestion) = ingestion else {
            return api_error(404, "ingestion_not_found", "Ingestion was not found.");
        };
        if ingestion.status != "ready" {
            return api_error(
                409,
                "ingestion_not_ready",
                "Ingestion must be finalized before starting a capture.",
            );
        }
        let source_sha256 = ingestion
            .finalized_sha256
            .clone()
            .unwrap_or_else(|| sha256_hex(&ingestion.content));
        let source = json!({
            "sha256": source_sha256,
            "fileName": safe_filename(&ingestion.file_name),
            "mediaType": ingestion.media_type,
            "bytes": ingestion.total_bytes,
        });
        let raw = build_raw_capture(&source, &ingestion.kind, &ingestion.content);
        let capture_id = format!(
            "capture-{}",
            self.next_capture.fetch_add(1, Ordering::Relaxed)
        );
        let partial_revision = if ingestion.kind == "audio" { 1 } else { 0 };
        let partial = if ingestion.kind == "audio" {
            Some(build_partial(
                &raw,
                &capture_id,
                &ingestion.kind,
                partial_revision,
            ))
        } else {
            None
        };
        let audio_covered_until_ms = if ingestion.kind == "audio" {
            raw["segments"]
                .as_array()
                .map(|segments| (segments.len() * 1000) as u64)
                .unwrap_or(0)
        } else {
            0
        };
        let mut record = CaptureRecord {
            capture_id: capture_id.clone(),
            ingestion_id: ingestion.ingestion_id,
            kind: ingestion.kind,
            status: "awaiting_structuring".into(),
            stage: "awaiting_structuring".into(),
            structuring_mode: structuring_mode.clone(),
            target_language: target_language.clone(),
            progress: 0.55,
            source,
            raw,
            partial,
            result: None,
            error: None,
            events: Vec::new(),
            last_event_sequence: 0,
            partial_revision,
            completed_at: None,
        };
        append_capture_event(&mut record, "accepted", "queued", 0.0, None, None, None);
        append_capture_event(
            &mut record,
            "checkpoint",
            "extracting",
            0.55,
            Some(partial_revision),
            Some(audio_covered_until_ms),
            None,
        );
        if structuring_mode == "runtime" {
            record.result = Some(build_result(&record.raw, target_language.as_deref()));
            record.status = "completed".into();
            record.stage = "completed".into();
            record.progress = 1.0;
            record.completed_at = Some(COMPLETED_AT.into());
            append_capture_event(
                &mut record,
                "completed",
                "completed",
                1.0,
                Some(partial_revision),
                None,
                None,
            );
        }
        if let Ok(mut captures) = self.captures.lock() {
            captures.insert(capture_id.clone(), record.clone());
        }
        if let Ok(mut idempotency) = self.capture_idempotency.lock() {
            idempotency.insert(
                client_request_id,
                IdempotencyRecord {
                    fingerprint,
                    resource_id: capture_id,
                },
            );
        }
        Response::json(202, record.operation_wire())
    }

    fn route_capture(&self, request: &Request) -> Response {
        let relative = request.path.trim_start_matches("/v2/captures/");
        if let Some(capture_id) = relative.strip_suffix("/structure/commit") {
            return if request.method == "POST" {
                self.commit_structure(capture_id, request)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/structure/failure") {
            return if request.method == "POST" {
                self.report_structuring_failure(capture_id, request)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/structure") {
            return if request.method == "POST" {
                self.structure_capture(capture_id)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/events") {
            return if request.method == "GET" {
                self.events_response(capture_id, request)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/partial") {
            return if request.method == "GET" {
                self.partial_response(capture_id)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/result") {
            return if request.method == "GET" {
                self.result_response(capture_id)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/cancel") {
            return if request.method == "POST" {
                self.cancel_capture(capture_id)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if relative.contains('/') {
            return api_error(404, "not_found", "Resource was not found.");
        }
        match request.method.as_str() {
            "GET" => self.operation_response(relative, 200),
            "DELETE" => self.delete_capture(relative),
            _ => api_error(404, "not_found", "Resource was not found."),
        }
    }

    fn operation_response(&self, capture_id: &str, status: u16) -> Response {
        let record = self
            .captures
            .lock()
            .ok()
            .and_then(|captures| captures.get(capture_id).cloned());
        match record {
            Some(record) => Response::json(status, record.operation_wire()),
            None => api_error(404, "capture_not_found", "Capture job was not found."),
        }
    }

    fn events_response(&self, capture_id: &str, request: &Request) -> Response {
        let has_cursor = request.headers.contains_key("last-event-id");
        let after_sequence = request
            .headers
            .get("last-event-id")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let record = self
            .captures
            .lock()
            .ok()
            .and_then(|captures| captures.get(capture_id).cloned());
        match record {
            Some(record) => {
                let replay_start = record
                    .last_event_sequence
                    .saturating_sub(EVENT_REPLAY_WINDOW.saturating_sub(1));
                if has_cursor && after_sequence.saturating_add(1) < replay_start {
                    let resync = json!({
                        "protocolVersion": "2",
                        "eventId": format!(
                            "event-{}-resync-{}",
                            record.capture_id, record.last_event_sequence
                        ),
                        "sequence": record.last_event_sequence,
                        "captureId": record.capture_id,
                        "kind": record.kind,
                        "eventType": "resync_required",
                        "stage": "resync",
                        "progress": record.progress,
                        "partialRevision": record.partial_revision,
                        "coveredUntilMs": Value::Null,
                        "segments": [],
                        "error": Value::Null,
                        "createdAt": CREATED_AT,
                    });
                    return Response::event_stream(sse_frame(&resync));
                }
                let body = record
                    .events
                    .iter()
                    .filter(|event| event["sequence"].as_u64().unwrap_or(0) > after_sequence)
                    .map(sse_frame)
                    .collect::<String>();
                Response::event_stream(body)
            }
            None => api_error(404, "capture_not_found", "Capture job was not found."),
        }
    }

    fn partial_response(&self, capture_id: &str) -> Response {
        let partial = self.captures.lock().ok().and_then(|captures| {
            captures
                .get(capture_id)
                .and_then(|record| record.partial.clone())
        });
        match partial {
            Some(partial) => Response::json(200, partial),
            None => api_error(
                409,
                "partial_unavailable",
                "Progressive partial capture is not available yet.",
            ),
        }
    }

    fn result_response(&self, capture_id: &str) -> Response {
        let record = self
            .captures
            .lock()
            .ok()
            .and_then(|captures| captures.get(capture_id).cloned());
        match record {
            None => api_error(404, "capture_not_found", "Capture job was not found."),
            Some(record) if record.status == "completed" && record.result.is_some() => {
                Response::json(
                    200,
                    json!({
                        "operation": record.operation_wire(),
                        "raw": record.raw,
                        "result": record.result,
                    }),
                )
            }
            Some(_) => api_error(
                409,
                "result_unavailable",
                "Structured result is not available.",
            ),
        }
    }

    fn structure_capture(&self, capture_id: &str) -> Response {
        let Ok(mut captures) = self.captures.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        let Some(record) = captures.get_mut(capture_id) else {
            return api_error(404, "capture_not_found", "Capture job was not found.");
        };
        if record.status == "completed" {
            let result = record.result.clone().unwrap_or_default();
            return Response::json(200, result);
        }
        if record.structuring_mode != "runtime" {
            return api_error(
                409,
                "invalid_capture_state",
                "host structuring requires a host-owned candidate",
            );
        }
        let result = build_result(&record.raw, record.target_language.as_deref());
        record.result = Some(result.clone());
        record.status = "completed".into();
        record.stage = "completed".into();
        record.progress = 1.0;
        record.completed_at = Some(COMPLETED_AT.into());
        append_capture_event(record, "completed", "completed", 1.0, Some(1), None, None);
        Response::json(200, result)
    }

    fn cancel_capture(&self, capture_id: &str) -> Response {
        let Ok(mut captures) = self.captures.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        let Some(record) = captures.get_mut(capture_id) else {
            return api_error(404, "capture_not_found", "Capture job was not found.");
        };
        if !matches!(record.status.as_str(), "completed" | "failed" | "cancelled") {
            let previous_stage = record.stage.clone();
            record.status = "cancelled".into();
            record.stage = "cancelled".into();
            record.error = Some(json!({
                "code": "capture_cancelled",
                "message": "Capture was cancelled.",
                "stage": previous_stage,
                "retryable": true,
            }));
            record.completed_at = Some(COMPLETED_AT.into());
            append_capture_event(
                record,
                "cancelled",
                "cancelled",
                record.progress,
                None,
                None,
                record.error.clone(),
            );
        }
        Response::json(200, record.operation_wire())
    }

    fn delete_capture(&self, capture_id: &str) -> Response {
        let removed = self
            .captures
            .lock()
            .ok()
            .and_then(|mut captures| captures.remove(capture_id));
        if removed.is_some() {
            Response::empty(204)
        } else {
            api_error(404, "capture_not_found", "Capture job was not found.")
        }
    }

    fn commit_structure(&self, capture_id: &str, request: &Request) -> Response {
        let idempotency_key = match required_idempotency_key(request) {
            Ok(key) => key,
            Err(response) => return response,
        };
        if !request
            .headers
            .get("content-type")
            .is_some_and(|value| value.starts_with("application/json"))
        {
            return validation_error("Request body must be application/json.");
        }
        let candidate: Value = match serde_json::from_slice(&request.body) {
            Ok(candidate) => candidate,
            Err(_) => return validation_error("Request body must be valid JSON."),
        };
        let fingerprint = sha256_hex(&serde_json::to_vec(&candidate).unwrap_or_default());
        let commit_key = format!("{capture_id}:{idempotency_key}");
        if let Some(existing) = self
            .commit_idempotency
            .lock()
            .ok()
            .and_then(|items| items.get(&commit_key).cloned())
        {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Commit idempotency key conflicts.",
                );
            }
            return self.operation_response(capture_id, 200);
        }

        let Ok(mut captures) = self.captures.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        let Some(record) = captures.get_mut(capture_id) else {
            return api_error(404, "capture_not_found", "Capture job was not found.");
        };
        if record.structuring_mode != "host" || record.stage != "awaiting_structuring" {
            return api_error(
                409,
                "invalid_capture_state",
                "capture is not awaiting host structuring",
            );
        }
        if let Err(issues) = validate_host_candidate(&candidate, &record.raw) {
            return api_error_details(
                422,
                "invalid_structure",
                "Candidate failed strict schema or provenance validation.",
                json!({ "issues": issues }),
            );
        }
        record.result = Some(candidate);
        record.status = "completed".into();
        record.stage = "completed".into();
        record.progress = 1.0;
        record.completed_at = Some(COMPLETED_AT.into());
        append_capture_event(record, "completed", "completed", 1.0, Some(1), None, None);
        let response = record.operation_wire();
        drop(captures);
        if let Ok(mut items) = self.commit_idempotency.lock() {
            items.insert(
                commit_key,
                IdempotencyRecord {
                    fingerprint,
                    resource_id: capture_id.into(),
                },
            );
        }
        Response::json(200, response)
    }

    fn report_structuring_failure(&self, capture_id: &str, request: &Request) -> Response {
        let payload: Value = match serde_json::from_slice(&request.body) {
            Ok(payload) => payload,
            Err(_) => return validation_error("Request body must be valid JSON."),
        };
        let code = payload.get("code").and_then(Value::as_str);
        let message = payload.get("message").and_then(Value::as_str);
        if code.is_none_or(|value| !valid_error_code(value))
            || message.is_none_or(|value| value.trim().is_empty() || value.len() > 500)
        {
            return validation_error("Structuring failure payload is invalid.");
        }
        let Ok(mut captures) = self.captures.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        let Some(record) = captures.get_mut(capture_id) else {
            return api_error(404, "capture_not_found", "Capture job was not found.");
        };
        if record.structuring_mode != "host" || record.stage != "awaiting_structuring" {
            return api_error(
                409,
                "invalid_capture_state",
                "capture is not awaiting host structuring",
            );
        }
        record.status = "failed".into();
        record.stage = "failed".into();
        record.error = Some(json!({
            "code": code,
            "message": message,
            "stage": "structuring",
            "retryable": false,
        }));
        record.completed_at = Some(COMPLETED_AT.into());
        append_capture_event(
            record,
            "failed",
            "failed",
            record.progress,
            None,
            None,
            record.error.clone(),
        );
        Response::json(200, record.operation_wire())
    }

    fn create_installation(&self, request: &Request) -> Response {
        let key = match required_idempotency_key(request) {
            Ok(key) => key,
            Err(response) => return response,
        };
        let payload: Value = match serde_json::from_slice(&request.body) {
            Ok(payload) => payload,
            Err(_) => return validation_error("Request body must be valid JSON."),
        };
        let requirement_id = payload.get("requirementId").and_then(Value::as_str);
        if !requirement_id.is_some_and(valid_requirement_id)
            || payload.get("consent").and_then(Value::as_bool) != Some(true)
        {
            return validation_error("Runtime installation payload is invalid.");
        }
        let requirement_id = requirement_id.unwrap_or_default().to_owned();
        let fingerprint = sha256_hex(&request.body);
        if let Some(existing) = self
            .installation_idempotency
            .lock()
            .ok()
            .and_then(|items| items.get(&key).cloned())
        {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Idempotency key was already used with a different request.",
                );
            }
            return self.installation_response(&existing.resource_id, 202);
        }
        let installation_id = format!(
            "installation-{}",
            self.next_installation.fetch_add(1, Ordering::Relaxed)
        );
        let record = InstallationRecord {
            installation_id: installation_id.clone(),
            requirement_id,
        };
        if let Ok(mut installations) = self.installations.lock() {
            installations.insert(installation_id.clone(), record.clone());
        }
        if let Ok(mut items) = self.installation_idempotency.lock() {
            items.insert(
                key,
                IdempotencyRecord {
                    fingerprint,
                    resource_id: installation_id,
                },
            );
        }
        Response::json(202, record.wire())
    }

    fn create_model_installation(&self, request: &Request) -> Response {
        let key = match required_idempotency_key(request) {
            Ok(key) => key,
            Err(response) => return response,
        };
        let payload: Value = match serde_json::from_slice(&request.body) {
            Ok(payload) => payload,
            Err(_) => return validation_error("Request body must be valid JSON."),
        };
        let option_id = payload.get("optionId").and_then(Value::as_str);
        if !option_id.is_some_and(valid_model_option_id)
            || payload.get("consent").and_then(Value::as_bool) != Some(true)
        {
            return validation_error("Runtime model installation payload is invalid.");
        }
        let fingerprint = sha256_hex(&request.body);
        if let Some(existing) = self
            .model_installation_idempotency
            .lock()
            .ok()
            .and_then(|items| items.get(&key).cloned())
        {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Idempotency key was already used with a different request.",
                );
            }
            return self.model_installation_response(&existing.resource_id, 202);
        }
        let installation_id = format!(
            "model-installation-{}",
            self.next_model_installation.fetch_add(1, Ordering::Relaxed)
        );
        let record = ModelInstallationRecord {
            installation_id: installation_id.clone(),
            option_id: option_id.unwrap_or_default().to_owned(),
        };
        if let Ok(mut installations) = self.model_installations.lock() {
            installations.insert(installation_id.clone(), record.clone());
        }
        if let Ok(mut items) = self.model_installation_idempotency.lock() {
            items.insert(
                key,
                IdempotencyRecord {
                    fingerprint,
                    resource_id: installation_id,
                },
            );
        }
        Response::json(202, record.wire())
    }

    fn list_installations(&self) -> Response {
        let mut items = self
            .installations
            .lock()
            .map(|installations| {
                installations
                    .values()
                    .map(InstallationRecord::wire)
                    .collect()
            })
            .unwrap_or_else(|_| Vec::<Value>::new());
        items.sort_by_key(|item| {
            item.get("installationId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        });
        Response::json(200, json!({ "items": items }))
    }

    fn route_installation(&self, request: &Request) -> Response {
        let relative = request
            .path
            .trim_start_matches("/v1/runtime/installations/");
        if let Some(installation_id) = relative.strip_suffix("/cancel") {
            return if request.method == "POST" {
                self.installation_response(installation_id, 200)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if request.method == "GET" && !relative.contains('/') {
            return self.installation_response(relative, 200);
        }
        api_error(404, "not_found", "Resource was not found.")
    }

    fn route_model_installation(&self, request: &Request) -> Response {
        let installation_id = request
            .path
            .trim_start_matches("/v1/runtime/model-installations/");
        if request.method == "GET" && !installation_id.contains('/') {
            return self.model_installation_response(installation_id, 200);
        }
        api_error(404, "not_found", "Resource was not found.")
    }

    fn model_installation_response(&self, installation_id: &str, status: u16) -> Response {
        let record = self
            .model_installations
            .lock()
            .ok()
            .and_then(|items| items.get(installation_id).cloned());
        match record {
            Some(record) => Response::json(status, record.wire()),
            None => api_error(
                404,
                "installation_not_found",
                "Model installation job was not found.",
            ),
        }
    }

    fn installation_response(&self, installation_id: &str, status: u16) -> Response {
        let record = self
            .installations
            .lock()
            .ok()
            .and_then(|items| items.get(installation_id).cloned());
        match record {
            Some(record) => Response::json(status, record.wire()),
            None => api_error(
                404,
                "installation_not_found",
                "Installation job was not found.",
            ),
        }
    }
}

fn parse_json_object(request: &Request) -> Result<Value, Response> {
    if !request
        .headers
        .get("content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return Err(validation_error("Request body must be application/json."));
    }
    match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(validation_error(
            "Request body must be a valid JSON object.",
        )),
    }
}

fn required_string_field(payload: &Value, name: &str) -> Result<String, Response> {
    payload
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| validation_error(&format!("{name} is required.")))
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_request_key(value: &str) -> bool {
    valid_opaque_id(value)
}

fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_content_range(request: &Request) -> Option<(u64, u64, u64)> {
    let value = request.headers.get("content-range")?;
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

fn parse_sha256_digest(value: &str) -> Option<String> {
    value
        .strip_prefix("sha-256=")
        .filter(|hex| valid_sha256_hex(hex))
        .map(str::to_owned)
}

fn append_capture_event(
    record: &mut CaptureRecord,
    event_type: &str,
    stage: &str,
    progress: f64,
    partial_revision: Option<u64>,
    covered_until_ms: Option<u64>,
    error: Option<Value>,
) {
    record.last_event_sequence += 1;
    let sequence = record.last_event_sequence;
    let segments = if event_type == "checkpoint" && record.kind == "audio" {
        record.raw["segments"].clone()
    } else {
        json!([])
    };
    record.events.push(json!({
        "protocolVersion": "2",
        "eventId": format!("event-{}-{sequence}", record.capture_id),
        "sequence": sequence,
        "captureId": record.capture_id,
        "kind": record.kind,
        "eventType": event_type,
        "stage": stage,
        "progress": progress,
        "partialRevision": partial_revision,
        "coveredUntilMs": covered_until_ms,
        "segments": segments,
        "error": error,
        "createdAt": CREATED_AT,
    }));
}

fn sse_frame(event: &Value) -> String {
    format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        event["sequence"].as_u64().unwrap_or_default(),
        event["eventType"].as_str().unwrap_or_default(),
        serde_json::to_string(event).unwrap_or_else(|_| "{}".into()),
    )
}

fn build_partial(raw: &Value, capture_id: &str, kind: &str, revision: u64) -> Value {
    let segments = raw["segments"].as_array().cloned().unwrap_or_default();
    json!({
        "protocolVersion": "2",
        "captureId": capture_id,
        "source": raw["source"],
        "revision": revision,
        "coveredUntilMs": if kind == "audio" {
            (segments.len() * 1000) as u64
        } else {
            0
        },
        "segments": segments,
        "sourceText": raw["sourceText"],
        "extractionEngine": raw["extractionEngine"],
        "updatedAt": CREATED_AT,
    })
}

fn build_raw_capture(source: &Value, source_kind: &str, content: &[u8]) -> Value {
    let text = fixture_text(
        content,
        source_kind,
        source["sha256"].as_str().unwrap_or_default(),
    );
    let parts = if source_kind == "audio" {
        text.split('|')
    } else {
        text.split('\x0c')
    }
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let segments = parts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            json!({
                "segmentId": format!("segment-{}", index + 1),
                "order": index,
                "locator": if source_kind == "audio" {
                    json!({ "kind": "time", "startMs": index * 1000, "endMs": (index + 1) * 1000 })
                } else {
                    json!({ "kind": "page", "page": index + 1 })
                },
                "text": text,
            })
        })
        .collect::<Vec<_>>();
    let (engine, model) = if source_kind == "audio" {
        ("whisper-primary", "deterministic-whisper-v1")
    } else {
        ("windowsml-ocr", "deterministic-windowsml-v1")
    };
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "diagnosticOnly": true,
        "source": source,
        "segments": segments,
        "sourceText": parts.join("\n"),
        "extractionEngine": {
            "engine": engine,
            "model": model,
            "digest": engine_digest(engine, model),
            "device": "fake",
        },
        "warnings": [],
        "createdAt": CREATED_AT,
    })
}

fn build_result(raw: &Value, target_language: Option<&str>) -> Value {
    let raw_segments = raw["segments"].as_array().cloned().unwrap_or_default();
    let blocks = raw_segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let source_text = segment["text"].as_str().unwrap_or_default();
            let target_text = target_language
                .map(|language| format!("[{language}] {source_text}"))
                .unwrap_or_else(|| source_text.into());
            json!({
                "blockId": format!("block-{}", index + 1),
                "order": index,
                "type": if segment["locator"]["kind"] == "time" { "transcript" } else { "paragraph" },
                "sourceSegmentId": segment["segmentId"],
                "locator": segment["locator"],
                "sourceText": source_text,
                "targetText": target_text,
            })
        })
        .collect::<Vec<_>>();
    let target_text = blocks
        .iter()
        .filter_map(|block| block["targetText"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "source": raw["source"],
        "rawSegments": raw_segments,
        "blocks": blocks,
        "sourceText": raw["sourceText"],
        "targetText": target_text,
        "extractionEngine": raw["extractionEngine"],
        "structuringEngine": {
            "engine": "fake-structurer",
            "model": "deterministic-structure-v1",
            "digest": engine_digest("fake-structurer", "deterministic-structure-v1"),
            "device": "fake",
        },
        "warnings": raw["warnings"],
        "createdAt": raw["createdAt"],
        "completedAt": COMPLETED_AT,
    })
}

fn validate_host_candidate(candidate: &Value, raw: &Value) -> Result<(), Vec<Value>> {
    let mut issues = Vec::new();
    for field in [
        "schemaVersion",
        "source",
        "rawSegments",
        "blocks",
        "sourceText",
        "targetText",
        "extractionEngine",
        "structuringEngine",
        "warnings",
        "createdAt",
        "completedAt",
    ] {
        if candidate.get(field).is_none() {
            issues.push(issue(field, "field is required"));
        }
    }
    if candidate.get("schemaVersion") != Some(&json!(SCHEMA_VERSION)) {
        issues.push(issue("schemaVersion", "must equal 1"));
    }
    for (candidate_field, raw_field) in [
        ("source", "source"),
        ("rawSegments", "segments"),
        ("sourceText", "sourceText"),
        ("extractionEngine", "extractionEngine"),
        ("createdAt", "createdAt"),
    ] {
        if candidate.get(candidate_field) != raw.get(raw_field) {
            issues.push(issue(candidate_field, "must equal raw capture"));
        }
    }
    let blocks = candidate
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let segments = raw["segments"].as_array().cloned().unwrap_or_default();
    if blocks.is_empty() {
        issues.push(issue("blocks", "must contain at least one block"));
    }
    let mut block_ids = HashSet::new();
    for (index, block) in blocks.iter().enumerate() {
        if block.get("order").and_then(Value::as_u64) != Some(index as u64) {
            issues.push(issue("blocks.order", "must be contiguous"));
        }
        if let Some(block_id) = block.get("blockId").and_then(Value::as_str) {
            if !block_ids.insert(block_id) {
                issues.push(issue("blocks.blockId", "must be unique"));
            }
        } else {
            issues.push(issue("blocks.blockId", "is required"));
        }
        let segment_id = block.get("sourceSegmentId").and_then(Value::as_str);
        let segment = segments
            .iter()
            .find(|segment| segment.get("segmentId").and_then(Value::as_str) == segment_id);
        match segment {
            Some(segment) if block.get("locator") == segment.get("locator") => {}
            Some(_) => issues.push(issue("blocks.locator", "must equal source segment")),
            None => issues.push(issue(
                "blocks.sourceSegmentId",
                "must reference a raw segment",
            )),
        }
    }
    let projected_target = blocks
        .iter()
        .filter_map(|block| block.get("targetText").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if candidate.get("targetText").and_then(Value::as_str) != Some(projected_target.as_str()) {
        issues.push(issue("targetText", "must be exact block projection"));
    }
    let digest = candidate
        .pointer("/structuringEngine/digest")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if digest.len() != 71
        || !digest.starts_with("sha256:")
        || !digest[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        issues.push(issue("structuringEngine.digest", "must be a sha256 digest"));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

fn issue(location: &str, message: &str) -> Value {
    json!({ "location": [location], "message": message, "type": "value_error" })
}

fn validation_error(message: &str) -> Response {
    api_error_details(
        422,
        "validation_error",
        "Request validation failed.",
        json!({
            "issues": [{
                "location": ["body"],
                "message": message,
                "type": "value_error",
            }]
        }),
    )
}

fn required_idempotency_key(request: &Request) -> Result<String, Response> {
    let key = request
        .headers
        .get("x-idempotency-key")
        .filter(|value| valid_uuid(value))
        .cloned();
    key.ok_or_else(|| validation_error("X-Idempotency-Key must be a UUID."))
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn valid_error_code(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || (index > 0 && (byte == b'_' || byte.is_ascii_digit()))
        })
}

fn valid_requirement_id(value: &str) -> bool {
    matches!(
        value,
        "windowsml-ocr" | "whisper-primary" | "ollama-runtime" | "capture-ollama-model"
    )
}

fn valid_model_option_id(value: &str) -> bool {
    matches!(value, "qwen3.5-0.8b-v1" | "qwen3.5-2b-v1" | "qwen3.5-4b-v1")
}

fn model_option(option_id: &str, display_name: &str, model_reference: &str, status: &str) -> Value {
    json!({
        "optionId": option_id,
        "displayName": display_name,
        "modelReference": model_reference,
        "expectedDigest": null,
        "expectedBytes": null,
        "profileId": format!("capture-workbench-{option_id}-structure-v1"),
        "profileSpecSha256": "b".repeat(64),
        "status": status,
    })
}

fn requirement(
    requirement_id: &str,
    kind: &str,
    display_name: &str,
    required_for: &[&str],
) -> Value {
    json!({
        "requirementId": requirement_id,
        "kind": kind,
        "displayName": display_name,
        "status": "ready",
        "requiredFor": required_for,
        "installStrategy": "deterministic-fixture",
        "detail": "Available in deterministic verification mode.",
    })
}

fn fixture_text(content: &[u8], kind: &str, sha256: &str) -> String {
    let marker = b"CAPTURE_TEXT:";
    if let Some(index) = find_bytes(content, marker) {
        let candidate = String::from_utf8_lossy(&content[index + marker.len()..])
            .trim_matches(|character| matches!(character, '\0' | '\r' | '\n' | ' '))
            .to_owned();
        if !candidate.is_empty() {
            return candidate;
        }
    }
    format!(
        "Deterministic {kind} capture {}",
        sha256.get(..12).unwrap_or(sha256)
    )
}

fn safe_filename(value: &str) -> String {
    let safe = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("upload.bin")
        .chars()
        .filter(|character| *character >= ' ' && *character != '\u{7f}')
        .take(255)
        .collect::<String>()
        .trim()
        .to_owned();
    if safe.is_empty() {
        "upload.bin".into()
    } else {
        safe
    }
}

fn engine_digest(engine: &str, model: &str) -> String {
    format!(
        "sha256:{}",
        sha256_hex(format!("{engine}:{model}").as_bytes())
    )
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required."))
}
