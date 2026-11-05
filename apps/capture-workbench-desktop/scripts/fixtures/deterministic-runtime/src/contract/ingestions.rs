use super::*;

const MAX_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub(super) struct IngestionRecord {
    pub ingestion_id: String,
    pub kind: String,
    pub file_name: String,
    pub media_type: String,
    pub total_bytes: usize,
    pub content: Vec<u8>,
    source_sha256: Option<String>,
    pub finalized_sha256: Option<String>,
    chunks: Vec<(usize, usize)>,
}

impl IngestionRecord {
    fn wire(&self) -> Value {
        json!({
            "protocolVersion": "2", "kind": self.kind, "ingestionId": self.ingestion_id,
            "status": if self.finalized_sha256.is_some() { "ready" } else { "open" },
            "fileName": self.file_name, "mediaType": self.media_type,
            "totalBytes": self.total_bytes, "receivedBytes": self.content.len(),
            "contiguousBytes": self.content.len(), "nextChunkIndex": self.chunks.len(),
            "nextOffset": self.content.len(), "sourceSha256": self.source_sha256,
            "finalizedSha256": self.finalized_sha256, "expiresAt": "2099-01-01T00:00:00Z",
        })
    }
}

impl FixtureState {
    pub(super) fn open_ingestion(&self, request: &Request) -> Response {
        let payload = match json_payload(request) {
            Ok(payload) => payload,
            Err(response) => return response,
        };
        let key = match matching_request_key(request, &payload, payload["kind"] == "audio") {
            Ok(key) => key,
            Err(response) => return response,
        };
        let kind = payload["kind"].as_str().unwrap_or("audio");
        let file_name = payload["fileName"].as_str().unwrap_or_default();
        let media_type = payload["mediaType"].as_str().unwrap_or_default();
        let total_bytes = payload["totalBytes"].as_u64().unwrap_or(0);
        let source_sha256 = payload.get("sourceSha256").filter(|value| !value.is_null());
        if !matches!(kind, "pdf" | "image" | "audio")
            || payload.get("mode").is_some_and(|value| value != "file")
            || file_name.trim().is_empty()
            || file_name.chars().count() > 255
            || media_type.trim().is_empty()
            || total_bytes == 0
            || source_sha256.is_some_and(|value| !value.as_str().is_some_and(valid_sha256))
        {
            return validation_error("Ingestion metadata is invalid.");
        }
        if total_bytes > self.settings.max_upload_bytes as u64 {
            return api_error(
                413,
                "upload_too_large",
                "Upload exceeds the configured size limit.",
            );
        }
        let fingerprint = sha256_hex(&serde_json::to_vec(&payload).unwrap_or_default());
        let Ok(mut keys) = self.ingestion_idempotency.lock() else {
            return api_error(
                500,
                "runtime_unavailable",
                "Ingestion state is unavailable.",
            );
        };
        let Ok(mut ingestions) = self.ingestions.lock() else {
            return api_error(
                500,
                "runtime_unavailable",
                "Ingestion state is unavailable.",
            );
        };
        if let Some(existing) = keys.get(&key) {
            if existing.fingerprint != fingerprint {
                return api_error(
                    409,
                    "idempotency_conflict",
                    "Ingestion request metadata conflicts.",
                );
            }
            return match ingestions.get(&existing.resource_id) {
                Some(record) => Response::json(201, record.wire()),
                None => api_error(404, "ingestion_not_found", "Ingestion was not found."),
            };
        }
        let ingestion_id = format!(
            "ingestion-{}",
            self.next_ingestion.fetch_add(1, Ordering::Relaxed)
        );
        let record = IngestionRecord {
            ingestion_id: ingestion_id.clone(),
            kind: kind.into(),
            file_name: file_name.trim().into(),
            media_type: media_type.into(),
            total_bytes: total_bytes as usize,
            content: Vec::new(),
            source_sha256: source_sha256.and_then(Value::as_str).map(str::to_owned),
            finalized_sha256: None,
            chunks: Vec::new(),
        };
        let response = Response::json(201, record.wire());
        ingestions.insert(ingestion_id.clone(), record);
        keys.insert(
            key,
            IdempotencyRecord {
                fingerprint,
                resource_id: ingestion_id,
            },
        );
        response
    }

    pub(super) fn route_ingestion(&self, request: &Request) -> Response {
        let relative = request.path.trim_start_matches("/v2/ingestions/");
        let (id, suffix) = relative.split_once('/').unwrap_or((relative, ""));
        let Ok(mut ingestions) = self.ingestions.lock() else {
            return api_error(
                500,
                "runtime_unavailable",
                "Ingestion state is unavailable.",
            );
        };
        let Some(record) = ingestions.get_mut(id) else {
            return api_error(404, "ingestion_not_found", "Ingestion was not found.");
        };
        match (request.method.as_str(), suffix) {
            ("GET", "") => Response::json(200, record.wire()),
            ("DELETE", "") => {
                ingestions.remove(id);
                drop(ingestions);
                if let Ok(mut keys) = self.ingestion_idempotency.lock() {
                    keys.retain(|_, entry| entry.resource_id != id);
                }
                Response::empty(204)
            }
            ("POST", "finalize") => finalize(record, request),
            ("PUT", suffix) if suffix.starts_with("chunks/") => {
                let Ok(index) = suffix[7..].parse::<usize>() else {
                    return validation_error("Chunk index must be a non-negative integer.");
                };
                append_chunk(record, request, index)
            }
            _ => api_error(404, "not_found", "Resource was not found."),
        }
    }
}

fn append_chunk(record: &mut IngestionRecord, request: &Request, index: usize) -> Response {
    if let Err(response) = required_idempotency_key(request) {
        return response;
    }
    let range = request.headers.get("content-range").and_then(|value| {
        let (offsets, total) = value.strip_prefix("bytes ")?.split_once('/')?;
        let (start, end) = offsets.split_once('-')?;
        Some((
            start.parse::<usize>().ok()?,
            end.parse::<usize>().ok()?,
            total.parse::<usize>().ok()?,
        ))
    });
    let digest = request
        .headers
        .get("digest")
        .and_then(|value| value.strip_prefix("sha-256="))
        .filter(|value| valid_sha256(value));
    let (Some((start, end, total)), Some(digest)) = (range, digest) else {
        return api_error(
            422,
            "invalid_chunk_headers",
            "Content-Range and Digest headers are invalid.",
        );
    };
    let length = end
        .checked_sub(start)
        .and_then(|value| value.checked_add(1));
    if length.is_none_or(|value| value > MAX_CHUNK_BYTES) || request.body.len() > MAX_CHUNK_BYTES {
        return api_error(
            413,
            "chunk_too_large",
            "Chunk exceeds the configured size limit.",
        );
    }
    if total != record.total_bytes {
        return api_error(
            409,
            "chunk_total_conflict",
            "Content-Range total does not match the ingestion.",
        );
    }
    if length != Some(request.body.len()) {
        return api_error(
            422,
            "chunk_length_mismatch",
            "Chunk length does not match Content-Range.",
        );
    }
    if record.finalized_sha256.is_some() {
        return api_error(409, "chunk_rejected", "Ingestion is not open.");
    }
    if digest != sha256_hex(&request.body) {
        return api_error(
            409,
            "chunk_checksum_mismatch",
            "Chunk checksum does not match bytes.",
        );
    }
    if let Some(&(offset, count)) = record.chunks.get(index) {
        return if start == offset && request.body == record.content[offset..offset + count] {
            Response::json(200, record.wire())
        } else {
            api_error(
                409,
                "chunk_conflict",
                "Chunk conflicts with an accepted chunk.",
            )
        };
    }
    if index != record.chunks.len() || start != record.content.len() {
        return api_error(
            409,
            "chunk_out_of_order",
            "Chunks must be contiguous and ordered.",
        );
    }
    if end >= record.total_bytes {
        return api_error(
            409,
            "chunk_too_large",
            "Chunks exceed declared source size.",
        );
    }
    record.chunks.push((start, request.body.len()));
    record.content.extend_from_slice(&request.body);
    Response::json(200, record.wire())
}

fn finalize(record: &mut IngestionRecord, request: &Request) -> Response {
    let payload = match json_payload(request) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(digest) = payload["sha256"]
        .as_str()
        .filter(|value| valid_sha256(value))
    else {
        return validation_error("sha256 must be a lowercase SHA-256 digest.");
    };
    if payload["totalBytes"].as_u64() != Some(record.total_bytes as u64)
        || record.content.len() != record.total_bytes
        || digest != sha256_hex(&record.content)
        || record
            .source_sha256
            .as_deref()
            .is_some_and(|expected| expected != digest)
    {
        return api_error(
            409,
            "ingestion_finalize_rejected",
            "Final source size or checksum does not match upload.",
        );
    }
    let Some((kind, media_type)) = sniff_source(&record.content) else {
        return api_error(
            415,
            "unsupported_media_type",
            "Source media type is unsupported.",
        );
    };
    if kind != record.kind || media_type != record.media_type {
        return api_error(
            415,
            "unsupported_media_type",
            "Source bytes do not match ingestion metadata.",
        );
    }
    record.finalized_sha256 = Some(digest.into());
    Response::json(200, record.wire())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
