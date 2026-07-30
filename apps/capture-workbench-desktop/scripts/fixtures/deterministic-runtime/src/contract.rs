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

const RUNTIME_VERSION: &str = "0.3.4";
const API_VERSION: &str = "1.0";
const SCHEMA_VERSION: &str = "1";
const CREATED_AT: &str = "2000-01-01T00:00:00Z";
const COMPLETED_AT: &str = "2000-01-01T00:00:01Z";

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
struct CaptureRecord {
    capture_id: String,
    status: String,
    stage: String,
    structuring_mode: String,
    progress: f64,
    source: Value,
    raw: Value,
    result: Option<Value>,
    error: Option<Value>,
    completed_at: Option<String>,
}

impl CaptureRecord {
    fn wire(&self) -> Value {
        json!({
            "captureId": self.capture_id,
            "status": self.status,
            "stage": self.stage,
            "structuringMode": self.structuring_mode,
            "progress": self.progress,
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
    next_installation: AtomicUsize,
    captures: Mutex<HashMap<String, CaptureRecord>>,
    capture_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    commit_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    installations: Mutex<HashMap<String, InstallationRecord>>,
    installation_idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
}

impl FixtureState {
    pub fn new(settings: FixtureSettings) -> Self {
        Self {
            settings,
            next_capture: AtomicUsize::new(1),
            next_installation: AtomicUsize::new(1),
            captures: Mutex::new(HashMap::new()),
            capture_idempotency: Mutex::new(HashMap::new()),
            commit_idempotency: Mutex::new(HashMap::new()),
            installations: Mutex::new(HashMap::new()),
            installation_idempotency: Mutex::new(HashMap::new()),
        }
    }

    pub fn route(&self, request: Request) -> Response {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/health/ready") => self.ready(),
            ("GET", "/v1/runtime/requirements") => self.requirements(),
            ("GET", "/v1/runtime/installations") => self.list_installations(),
            ("POST", "/v1/runtime/installations") => self.create_installation(&request),
            ("POST", "/v1/captures") => self.create_capture(&request),
            _ if request.path.starts_with("/v1/runtime/installations/") => {
                self.route_installation(&request)
            }
            _ if request.path.starts_with("/v1/captures/") => self.route_capture(&request),
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

    fn create_capture(&self, request: &Request) -> Response {
        let idempotency_key = match required_idempotency_key(request) {
            Ok(key) => key,
            Err(response) => return response,
        };
        let upload = match parse_capture_form(request) {
            Ok(upload) => upload,
            Err(response) => return response,
        };
        if upload.content.is_empty() {
            return api_error(422, "empty_upload", "Uploaded file is empty.");
        }
        if upload.content.len() > self.settings.max_upload_bytes {
            return api_error(
                413,
                "upload_too_large",
                "Upload exceeds the configured size limit.",
            );
        }
        let (source_kind, media_type) = match sniff_source(&upload.content) {
            Some(source) => source,
            None => {
                return api_error(
                    415,
                    "unsupported_media_type",
                    "Only PDF, PNG, JPEG, WebP, and common audio are supported",
                )
            }
        };
        let digest = sha256_hex(&upload.content);
        let fingerprint = sha256_hex(
            format!(
                "{}|{}|{}",
                digest,
                upload.structuring_mode,
                upload.target_language.as_deref().unwrap_or_default()
            )
            .as_bytes(),
        );
        if let Some(existing) = self
            .capture_idempotency
            .lock()
            .ok()
            .and_then(|items| items.get(&idempotency_key).cloned())
        {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Idempotency key was already used with a different request.",
                );
            }
            return self.capture_response(&existing.resource_id, 202);
        }

        let source = json!({
            "sha256": digest,
            "fileName": safe_filename(&upload.file_name),
            "mediaType": media_type,
            "bytes": upload.content.len(),
        });
        let raw = build_raw_capture(&source, source_kind, &upload.content);
        let capture_id = format!(
            "capture-{}",
            self.next_capture.fetch_add(1, Ordering::Relaxed)
        );
        let (status, stage, progress, result, completed_at) =
            if upload.structuring_mode == "runtime" {
                (
                    "completed",
                    "completed",
                    1.0,
                    Some(build_result(&raw, upload.target_language.as_deref())),
                    Some(COMPLETED_AT.into()),
                )
            } else {
                ("running", "awaiting_structuring", 0.55, None, None)
            };
        let record = CaptureRecord {
            capture_id: capture_id.clone(),
            status: status.into(),
            stage: stage.into(),
            structuring_mode: upload.structuring_mode,
            progress,
            source,
            raw,
            result,
            error: None,
            completed_at,
        };
        if let Ok(mut captures) = self.captures.lock() {
            captures.insert(capture_id.clone(), record.clone());
        }
        if let Ok(mut idempotency) = self.capture_idempotency.lock() {
            idempotency.insert(
                idempotency_key,
                IdempotencyRecord {
                    fingerprint,
                    resource_id: capture_id,
                },
            );
        }
        Response::json(202, record.wire())
    }

    fn route_capture(&self, request: &Request) -> Response {
        let relative = request.path.trim_start_matches("/v1/captures/");
        if let Some(capture_id) = relative.strip_suffix("/cancel") {
            return if request.method == "POST" {
                self.cancel_capture(capture_id)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/raw") {
            return if request.method == "GET" {
                self.raw_response(capture_id)
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
        if let Some(capture_id) = relative.strip_suffix("/structure") {
            return if request.method == "POST" {
                self.commit_structure(capture_id, request)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if let Some(capture_id) = relative.strip_suffix("/structuring-failure") {
            return if request.method == "POST" {
                self.report_structuring_failure(capture_id, request)
            } else {
                api_error(404, "not_found", "Resource was not found.")
            };
        }
        if relative.contains('/') {
            return api_error(404, "not_found", "Resource was not found.");
        }
        match request.method.as_str() {
            "GET" => self.capture_response(relative, 200),
            "DELETE" => self.delete_capture(relative),
            _ => api_error(404, "not_found", "Resource was not found."),
        }
    }

    fn capture_response(&self, capture_id: &str, status: u16) -> Response {
        let record = self
            .captures
            .lock()
            .ok()
            .and_then(|captures| captures.get(capture_id).cloned());
        match record {
            Some(record) => Response::json(status, record.wire()),
            None => api_error(404, "capture_not_found", "Capture job was not found."),
        }
    }

    fn raw_response(&self, capture_id: &str) -> Response {
        let raw = self
            .captures
            .lock()
            .ok()
            .and_then(|captures| captures.get(capture_id).map(|record| record.raw.clone()));
        match raw {
            Some(raw) => Response::json(200, raw),
            None => api_error(404, "capture_not_found", "Capture job was not found."),
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
            Some(record) => match record.result {
                Some(result) if record.status == "completed" => Response::json(200, result),
                _ => api_error(
                    409,
                    "result_unavailable",
                    "Structured result is not available.",
                ),
            },
        }
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
        }
        Response::json(200, record.wire())
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
            return self.capture_response(capture_id, 200);
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
        let response = record.wire();
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
        Response::json(200, record.wire())
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

struct CaptureUpload {
    file_name: String,
    content: Vec<u8>,
    structuring_mode: String,
    target_language: Option<String>,
}

#[derive(Clone)]
struct MultipartPart {
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_capture_form(request: &Request) -> Result<CaptureUpload, Response> {
    let content_type = request
        .headers
        .get("content-type")
        .ok_or_else(|| validation_error("multipart/form-data content type is required."))?;
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|value| value.strip_prefix("boundary="))
        .map(|value| value.trim_matches('"'))
        .filter(|value| !value.is_empty() && value.len() <= 70)
        .ok_or_else(|| validation_error("multipart boundary is invalid."))?;
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("multipart/form-data"))
    {
        return Err(validation_error(
            "Capture creation requires multipart/form-data.",
        ));
    }
    let parts = multipart_parts(&request.body, boundary)
        .ok_or_else(|| validation_error("multipart body is invalid."))?;
    let mut file = None;
    let mut fields = HashMap::new();
    for part in parts {
        let Some(disposition) = part.headers.get("content-disposition") else {
            continue;
        };
        let Some(name) = disposition_parameter(disposition, "name") else {
            continue;
        };
        if name == "file" {
            let file_name = disposition_parameter(disposition, "filename")
                .unwrap_or_else(|| "upload.bin".into());
            file = Some((file_name, part.body));
        } else if let Ok(value) = String::from_utf8(part.body) {
            fields.insert(name, value);
        }
    }
    let (file_name, content) =
        file.ok_or_else(|| validation_error("multipart file field is required."))?;
    let structuring_mode = fields
        .remove("structuringMode")
        .unwrap_or_else(|| "runtime".into());
    if !matches!(structuring_mode.as_str(), "runtime" | "host") {
        return Err(validation_error("structuringMode must be runtime or host."));
    }
    let target_language = fields
        .remove("targetLanguage")
        .map(|value| value.trim().to_owned());
    if target_language
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 64)
    {
        return Err(api_error(
            422,
            "validation_error",
            "targetLanguage must be 1 to 64 characters.",
        ));
    }
    Ok(CaptureUpload {
        file_name,
        content,
        structuring_mode,
        target_language,
    })
}

fn multipart_parts(body: &[u8], boundary: &str) -> Option<Vec<MultipartPart>> {
    let delimiter = format!("--{boundary}").into_bytes();
    let mut positions = Vec::new();
    let mut offset = 0;
    while let Some(relative) = find_bytes(&body[offset..], &delimiter) {
        let absolute = offset + relative;
        positions.push(absolute);
        offset = absolute + delimiter.len();
    }
    if positions.len() < 2 {
        return None;
    }
    let mut parts = Vec::new();
    for pair in positions.windows(2) {
        let mut value = &body[pair[0] + delimiter.len()..pair[1]];
        if value.starts_with(b"--") {
            break;
        }
        value = value.strip_prefix(b"\r\n").unwrap_or(value);
        value = value.strip_suffix(b"\r\n").unwrap_or(value);
        let separator = find_bytes(value, b"\r\n\r\n")?;
        let headers = std::str::from_utf8(&value[..separator]).ok()?;
        let headers = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        parts.push(MultipartPart {
            headers,
            body: value[separator + 4..].to_vec(),
        });
    }
    Some(parts)
}

fn disposition_parameter(value: &str, name: &str) -> Option<String> {
    value
        .split(';')
        .map(str::trim)
        .filter_map(|part| part.split_once('='))
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim_matches('"').to_owned())
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

fn sniff_source(content: &[u8]) -> Option<(&'static str, &'static str)> {
    if content.starts_with(b"%PDF-") {
        Some(("pdf", "application/pdf"))
    } else if content.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image", "image/png"))
    } else if content.starts_with(b"\xff\xd8\xff") {
        Some(("image", "image/jpeg"))
    } else if content.len() >= 12 && &content[..4] == b"RIFF" && &content[8..12] == b"WEBP" {
        Some(("image", "image/webp"))
    } else if content.len() >= 12 && &content[..4] == b"RIFF" && &content[8..12] == b"WAVE" {
        Some(("audio", "audio/wav"))
    } else if content.starts_with(b"ID3")
        || content
            .get(..2)
            .is_some_and(|value| matches!(value, b"\xff\xfb" | b"\xff\xf3" | b"\xff\xf2"))
    {
        Some(("audio", "audio/mpeg"))
    } else if content.starts_with(b"fLaC") {
        Some(("audio", "audio/flac"))
    } else if content.starts_with(b"OggS") {
        Some(("audio", "audio/ogg"))
    } else if content.len() >= 12 && &content[4..8] == b"ftyp" {
        Some(("audio", "audio/mp4"))
    } else {
        None
    }
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
