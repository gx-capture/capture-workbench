use std::{
    collections::HashMap,
    env,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::{api_error, api_error_details, find_bytes, Request, Response};

mod ingestions;
use ingestions::IngestionRecord;

const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
const API_VERSION: &str = "2.0";
const SCHEMA_VERSION: &str = "2";
const CREATED_AT: &str = "2000-01-01T00:00:00Z";
const COMPLETED_AT: &str = "2000-01-01T00:00:01Z";

#[cfg(test)]
mod tests;

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
    ingestion_id: String,
    kind: String,
    source: Value,
    raw: Value,
    result: Value,
}

impl CaptureRecord {
    fn wire(&self) -> Value {
        json!({
            "protocolVersion": "2",
            "captureId": self.capture_id,
            "ingestionId": self.ingestion_id,
            "kind": self.kind,
            "status": "completed",
            "progress": 1.0,
            "partialRevision": 0,
            "lastEventSequence": 1,
            "source": self.source,
            "error": null,
            "createdAt": CREATED_AT,
            "updatedAt": COMPLETED_AT,
            "completedAt": COMPLETED_AT,
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
            ("GET", "/v2/health/ready") => self.ready(),
            ("GET", "/v2/runtime/requirements") => self.requirements(),
            ("GET", "/v2/runtime/model-options") => self.model_options(),
            ("GET", "/v2/runtime/installations") => self.list_installations(),
            ("POST", "/v2/runtime/installations") => self.create_installation(&request),
            ("POST", "/v2/runtime/model-installations") => self.create_model_installation(&request),
            ("POST", "/v2/captures") => self.create_capture(&request),
            ("POST", "/v2/ingestions") => self.open_ingestion(&request),
            _ if request.path.starts_with("/v2/ingestions/") => self.route_ingestion(&request),
            _ if request.path.starts_with("/v2/runtime/installations/") => {
                self.route_installation(&request)
            }
            _ if request.path.starts_with("/v2/runtime/model-installations/") => {
                self.route_model_installation(&request)
            }
            _ if request.path.starts_with("/v2/captures/") => self.route_capture(&request),
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
                "contractSetVersion": "2",
                "ocrCompute": {
                    "apiVersion": API_VERSION,
                    "schemaVersion": "1",
                    "service": "capture-runtime",
                    "runtimeVersion": RUNTIME_VERSION,
                    "contractSetVersion": "2",
                    "contractSha256": sha256_hex(b"deterministic-ocr-contract"),
                    "workerSha256": sha256_hex(b"deterministic-ocr-worker"),
                    "mode": "cpu-fallback",
                    "adapterClass": "unknown",
                    "reasonCode": "no_compatible_gpu",
                    "userNoticeRequired": true,
                    "noticeCode": "ocr_cpu_fallback",
                },
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
                    requirement("speech-recognition", "stt", "Speech recognition", &["audio"]),
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

    fn create_capture(&self, request: &Request) -> Response {
        let payload = match json_payload(request) {
            Ok(payload) => payload,
            Err(response) => return response,
        };
        let ingestion = self.ingestions.lock().ok().and_then(|items| {
            payload["ingestionId"]
                .as_str()
                .and_then(|id| items.get(id).cloned())
        });
        let Some(ingestion) = ingestion else {
            return api_error(404, "ingestion_not_found", "Ingestion was not found.");
        };
        let key = match matching_request_key(request, &payload, ingestion.kind == "audio") {
            Ok(key) => key,
            Err(response) => return response,
        };
        if !matches!(
            payload["structuringMode"].as_str(),
            Some("host" | "runtime")
        ) || payload
            .get("startPolicy")
            .is_some_and(|value| value != "eager")
        {
            return validation_error("Capture start metadata is invalid.");
        }
        let fingerprint = sha256_hex(&serde_json::to_vec(&payload).unwrap_or_default());
        let Ok(mut keys) = self.capture_idempotency.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        if let Some(existing) = keys.get(&key) {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Capture request metadata conflicts.",
                );
            }
            return self.capture_response(&existing.resource_id, 202);
        }
        if ingestion.finalized_sha256.is_none() {
            return api_error(409, "invalid_capture_state", "Ingestion must be finalized.");
        }
        let source = json!({
            "sha256": ingestion.finalized_sha256,
            "fileName": safe_filename(&ingestion.file_name),
            "mediaType": ingestion.media_type,
            "bytes": ingestion.total_bytes,
        });
        let mut raw = build_raw_capture(&source, &ingestion.kind, &ingestion.content);
        if let Some(pages) = payload
            .get("pdfPageNumbers")
            .filter(|value| !value.is_null())
        {
            let Some(pages) = pages.as_array() else {
                return validation_error("pdfPageNumbers must be an array.");
            };
            let mut previous = 0;
            let page_count = raw["segments"].as_array().map_or(0, Vec::len) as u64;
            if ingestion.kind != "pdf"
                || pages.is_empty()
                || pages.len() > 500
                || pages.iter().any(|page| {
                    let number = page.as_u64().unwrap_or(0);
                    let invalid = number <= previous || number > page_count;
                    previous = number;
                    invalid
                })
            {
                return validation_error("pdfPageNumbers must select ascending source PDF pages.");
            }
            let segments = raw["segments"].as_array_mut().expect("raw segments");
            segments.retain(|segment| pages.contains(&segment["locator"]["page"]));
            for (order, segment) in segments.iter_mut().enumerate() {
                segment["order"] = json!(order);
            }
            raw["sourceText"] = json!(segments
                .iter()
                .filter_map(|segment| segment["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"));
        }
        let target_language = payload.get("targetLanguage").and_then(Value::as_str);
        let capture_id = format!(
            "capture-{}",
            self.next_capture.fetch_add(1, Ordering::Relaxed)
        );
        // The installed fixture finishes extraction and structuring synchronously,
        // including host-mode requests, so no model or confirmation is needed.
        let record = CaptureRecord {
            capture_id: capture_id.clone(),
            ingestion_id: ingestion.ingestion_id,
            kind: ingestion.kind,
            source,
            result: build_result(&raw, target_language),
            raw,
        };
        let Ok(mut captures) = self.captures.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        captures.insert(capture_id.clone(), record.clone());
        keys.insert(
            key,
            IdempotencyRecord {
                fingerprint,
                resource_id: capture_id,
            },
        );
        Response::json(202, record.wire())
    }

    fn route_capture(&self, request: &Request) -> Response {
        let relative = request.path.trim_start_matches("/v2/captures/");
        let (capture_id, suffix) = relative.split_once('/').unwrap_or((relative, ""));
        let Ok(mut captures) = self.captures.lock() else {
            return api_error(500, "runtime_unavailable", "Capture state is unavailable.");
        };
        let Some(record) = captures.get(capture_id) else {
            return api_error(404, "capture_not_found", "Capture job was not found.");
        };
        match (request.method.as_str(), suffix) {
            ("GET", "") | ("POST", "cancel") => Response::json(200, record.wire()),
            ("GET", "raw") => Response::json(200, record.raw.clone()),
            ("GET", "result") => Response::json(
                200,
                json!({
                    "operation": record.wire(), "raw": record.raw, "result": record.result,
                }),
            ),
            ("POST", "structure") => Response::json(200, record.result.clone()),
            ("GET", "ocr") if record.kind != "audio" => Response::json(200, build_ocr(record)),
            ("GET", "partial") if record.kind == "audio" => Response::json(
                200,
                json!({
                    "protocolVersion": "2", "captureId": capture_id, "source": record.source,
                    "revision": 0, "coveredUntilMs": record.raw["segments"].as_array().map_or(0, Vec::len) * 1000,
                    "segments": record.raw["segments"], "sourceText": record.raw["sourceText"],
                    "extractionEngine": record.raw["extractionEngine"], "updatedAt": COMPLETED_AT,
                }),
            ),
            ("GET", "events") => {
                let cursor = match request.headers.get("last-event-id") {
                    None => -1,
                    Some(value) => match value.parse::<i64>() {
                        Ok(value) if value >= -1 => value,
                        _ => {
                            return validation_error(
                                "Last-Event-ID must be an integer of at least -1.",
                            )
                        }
                    },
                };
                let event = json!({
                    "protocolVersion": "2", "eventId": format!("{capture_id}-completed"),
                    "sequence": 1, "captureId": capture_id, "kind": record.kind,
                    "eventType": "completed", "stage": "completed", "progress": 1.0,
                    "partialRevision": 0, "segments": [], "error": null, "createdAt": COMPLETED_AT,
                });
                Response::event_stream(if cursor < 1 {
                    format!("id: 1\nevent: completed\ndata: {event}\n\n")
                } else {
                    String::new()
                })
            }
            ("DELETE", "") => {
                let ingestion_id = record.ingestion_id.clone();
                captures.remove(capture_id);
                let remove_ingestion = !captures
                    .values()
                    .any(|record| record.ingestion_id == ingestion_id);
                drop(captures);
                if let Ok(mut keys) = self.capture_idempotency.lock() {
                    keys.retain(|_, entry| entry.resource_id != capture_id);
                }
                if remove_ingestion {
                    self.route_ingestion(&Request {
                        method: "DELETE".into(),
                        path: format!("/v2/ingestions/{ingestion_id}"),
                        headers: HashMap::new(),
                        body: Vec::new(),
                    });
                }
                Response::empty(204)
            }
            _ => api_error(404, "not_found", "Resource was not found."),
        }
    }

    fn capture_response(&self, capture_id: &str, status: u16) -> Response {
        let record = self
            .captures
            .lock()
            .ok()
            .and_then(|items| items.get(capture_id).cloned());
        match record {
            Some(record) => Response::json(status, record.wire()),
            None => api_error(404, "capture_not_found", "Capture job was not found."),
        }
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
            .trim_start_matches("/v2/runtime/installations/");
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
            .trim_start_matches("/v2/runtime/model-installations/");
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
        ("speech-recognition", "deterministic-speech-recognition-v1")
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

fn build_ocr(record: &CaptureRecord) -> Value {
    let provenance = json!({
        "status": "resolved", "engine": "windowsml-ocr",
        "model": record.raw["extractionEngine"]["model"],
        "modelDigest": record.raw["extractionEngine"]["digest"],
        "device": "fake", "profileId": "deterministic-windowsml-v1",
        "profileSpecSha256": sha256_hex(b"deterministic-ocr-profile"),
    });
    let pages = record.raw["segments"]
        .as_array()
        .expect("raw segments")
        .iter()
        .map(|segment| {
            json!({
                "page": segment["locator"]["page"], "status": "recognized",
                "raster": { "width": 1, "height": 1, "scale": 1.0, "coordinateSystem": "pixel" },
                "text": segment["text"], "boxes": [], "confidence": 0.0,
                "provenance": provenance, "failure": null,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "apiVersion": API_VERSION, "schemaVersion": "3", "captureId": record.capture_id,
        "status": "completed", "source": record.source, "pageCount": pages.len(), "pages": pages,
        "runtimeVersion": RUNTIME_VERSION, "contractSha256": sha256_hex(b"deterministic-ocr-contract"),
        "provenance": provenance, "warnings": [], "failure": null, "createdAt": CREATED_AT,
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

fn json_payload(request: &Request) -> Result<Value, Response> {
    if !request
        .headers
        .get("content-type")
        .is_some_and(|value| value.split(';').next() == Some("application/json"))
    {
        return Err(validation_error("Request body must be application/json."));
    }
    let payload: Value = serde_json::from_slice(&request.body)
        .map_err(|_| validation_error("Request body must be valid JSON."))?;
    if !payload.is_object()
        || payload
            .get("protocolVersion")
            .is_some_and(|value| value != "2")
    {
        return Err(validation_error(
            "Request must be a protocol version 2 object.",
        ));
    }
    Ok(payload)
}

fn matching_request_key(
    request: &Request,
    payload: &Value,
    progressive_audio: bool,
) -> Result<String, Response> {
    // The desktop's progressive audio bridge supplies only clientRequestId.
    // Document uploads send both the body id and its matching header.
    let key = if progressive_audio && !request.headers.contains_key("x-idempotency-key") {
        payload["clientRequestId"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .map(str::to_owned)
            .ok_or_else(|| validation_error("clientRequestId is required."))?
    } else {
        required_idempotency_key(request)?
    };
    if payload["clientRequestId"].as_str() != Some(key.as_str()) {
        return Err(api_error(
            409,
            "idempotency_conflict",
            "X-Idempotency-Key must match clientRequestId.",
        ));
    }
    Ok(key)
}

fn required_idempotency_key(request: &Request) -> Result<String, Response> {
    let key = request
        .headers
        .get("x-idempotency-key")
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .cloned();
    key.ok_or_else(|| validation_error("X-Idempotency-Key must contain 1 to 128 characters."))
}

fn valid_requirement_id(value: &str) -> bool {
    matches!(
        value,
        "windowsml-ocr" | "speech-recognition" | "ollama-runtime" | "capture-ollama-model"
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
