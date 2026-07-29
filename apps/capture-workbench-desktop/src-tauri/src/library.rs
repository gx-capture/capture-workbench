use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::{
    LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest, LibraryDocumentSummary,
    LibraryExportFormat, LibraryExportPayload, LibraryExportRequest, LibraryListRequest,
    LibrarySourceInput, LibrarySourcePayload,
};

const INDEX_FILE_NAME: &str = "library-index-v1.json";
const INDEX_BACKUP_FILE_NAME: &str = "library-index-v1.backup.json";
const INDEX_VERSION: u8 = 1;
const MAX_SOURCE_BYTES: usize = 50 * 1024 * 1024;
const SOURCE_FILE_NAME: &str = "source.bin";
const RAW_FILE_NAME: &str = "raw.json";
const RESULT_FILE_NAME: &str = "result.json";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIndex {
    version: u8,
    documents: Vec<StoredDocument>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocument {
    document_id: String,
    file_name: String,
    media_type: String,
    byte_length: u64,
    created_at_ms: u64,
    updated_at_ms: u64,
    status: String,
    stage: Option<String>,
    capture_id: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

impl StoredDocument {
    fn summary(&self) -> LibraryDocumentSummary {
        LibraryDocumentSummary {
            document_id: self.document_id.clone(),
            file_name: self.file_name.clone(),
            media_type: self.media_type.clone(),
            byte_length: self.byte_length,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            status: self.status.clone(),
            stage: self.stage.clone(),
            capture_id: self.capture_id.clone(),
            error_code: self.error_code.clone(),
            error_message: self.error_message.clone(),
        }
    }
}

/// Durable desktop-owned capture data. Runtime credentials and filesystem paths
/// never cross this boundary.
pub(crate) struct LibraryStore {
    root: PathBuf,
    index: Mutex<LibraryIndex>,
}

impl LibraryStore {
    pub(crate) fn open(app_data_dir: &Path) -> Result<Self, String> {
        let root = app_data_dir.join("library");
        fs::create_dir_all(root.join("items"))
            .map_err(|error| format!("Capture library cannot be created: {error}"))?;
        let index_path = root.join(INDEX_FILE_NAME);
        let index = match fs::read(&index_path) {
            Ok(bytes) => match serde_json::from_slice::<LibraryIndex>(&bytes) {
                Ok(index) => index,
                Err(primary_error) => load_backup_index(&root).map_err(|backup_error| {
                    format!(
                        "Capture library index is invalid ({primary_error}); recovery copy is unavailable: {backup_error}"
                    )
                })?,
            },
            Err(error) if error.kind() == ErrorKind::NotFound => LibraryIndex {
                version: INDEX_VERSION,
                documents: Vec::new(),
            },
            Err(error) => return Err(format!("Capture library index cannot be read: {error}")),
        };
        if index.version != INDEX_VERSION {
            return Err("Capture library version is unsupported.".into());
        }
        Ok(Self {
            root,
            index: Mutex::new(index),
        })
    }

    pub(crate) fn create_source(
        &self,
        input: LibrarySourceInput,
    ) -> Result<LibraryDocumentSummary, String> {
        validate_source_input(&input)?;
        let now = now_ms()?;
        let document_id = random_document_id()?;
        let document_directory = self.document_directory(&document_id)?;
        fs::create_dir_all(&document_directory).map_err(|error| {
            format!("Capture library source directory cannot be created: {error}")
        })?;
        atomic_write(&document_directory.join(SOURCE_FILE_NAME), &input.bytes)?;
        let document = StoredDocument {
            document_id,
            file_name: input.file_name,
            media_type: input.media_type,
            byte_length: input.bytes.len() as u64,
            created_at_ms: now,
            updated_at_ms: now,
            status: "queued".into(),
            stage: Some("uploading".into()),
            capture_id: None,
            error_code: None,
            error_message: None,
        };
        let summary = document.summary();
        let mut index = self.lock_index()?;
        index.documents.insert(0, document);
        if let Err(error) = self.save_index(&index) {
            index.documents.remove(0);
            let _ = fs::remove_dir_all(document_directory);
            return Err(error);
        }
        Ok(summary)
    }

    pub(crate) fn update_capture(
        &self,
        update: LibraryCaptureUpdate,
    ) -> Result<LibraryDocumentSummary, String> {
        validate_document_id(&update.document_id)?;
        validate_status(&update.status)?;
        if update.clear_capture_id && update.capture_id.is_some() {
            return Err(
                "Capture library update cannot set and clear a runtime identifier together.".into(),
            );
        }
        let mut index = self.lock_index()?;
        let document = index
            .documents
            .iter_mut()
            .find(|candidate| candidate.document_id == update.document_id)
            .ok_or_else(|| "Capture library document was not found.".to_string())?;
        let directory = self.document_directory(&document.document_id)?;
        if let Some(raw) = &update.raw {
            atomic_write_json(&directory.join(RAW_FILE_NAME), raw)?;
        }
        if let Some(result) = &update.result {
            atomic_write_json(&directory.join(RESULT_FILE_NAME), result)?;
        }
        if update.clear_capture_id {
            document.capture_id = None;
        } else if update.capture_id.is_some() {
            document.capture_id = update.capture_id;
        }
        document.status = update.status;
        document.stage = update.stage;
        document.error_code = update.error_code;
        document.error_message = update.error_message;
        document.updated_at_ms = now_ms()?;
        let summary = document.summary();
        self.save_index(&index)?;
        Ok(summary)
    }

    pub(crate) fn list(
        &self,
        request: LibraryListRequest,
    ) -> Result<Vec<LibraryDocumentSummary>, String> {
        let query = request.query.unwrap_or_default().trim().to_lowercase();
        let status = request.status.unwrap_or_default().trim().to_lowercase();
        Ok(self
            .lock_index()?
            .documents
            .iter()
            .filter(|document| {
                (query.is_empty() || document.file_name.to_lowercase().contains(&query))
                    && (status.is_empty() || document.status == status)
            })
            .map(StoredDocument::summary)
            .collect())
    }

    pub(crate) fn get(
        &self,
        request: LibraryDocumentRequest,
    ) -> Result<LibraryDocumentDetail, String> {
        let document = self.find_document(&request.document_id)?;
        let directory = self.document_directory(&document.document_id)?;
        Ok(LibraryDocumentDetail {
            summary: document.summary(),
            raw: read_json_optional(&directory.join(RAW_FILE_NAME))?,
            result: read_json_optional(&directory.join(RESULT_FILE_NAME))?,
        })
    }

    pub(crate) fn load_source(
        &self,
        request: LibraryDocumentRequest,
    ) -> Result<LibrarySourcePayload, String> {
        let document = self.find_document(&request.document_id)?;
        let source_path = self
            .document_directory(&document.document_id)?
            .join(SOURCE_FILE_NAME);
        let bytes = fs::read(source_path)
            .map_err(|error| format!("Capture library source cannot be read: {error}"))?;
        Ok(LibrarySourcePayload {
            document_id: document.document_id,
            file_name: document.file_name,
            media_type: document.media_type,
            bytes,
        })
    }

    pub(crate) fn runtime_source(&self, document_id: &str) -> Result<LibrarySourcePayload, String> {
        self.load_source(LibraryDocumentRequest {
            document_id: document_id.into(),
        })
    }

    pub(crate) fn export(
        &self,
        request: LibraryExportRequest,
    ) -> Result<LibraryExportPayload, String> {
        let document = self.find_document(&request.document_id)?;
        let directory = self.document_directory(&document.document_id)?;
        match request.format {
            LibraryExportFormat::Json => {
                let result = read_json_optional(&directory.join(RESULT_FILE_NAME))?
                    .ok_or_else(|| "Capture library result is not available.".to_string())?;
                Ok(LibraryExportPayload {
                    file_name: format!("{}.json", stem(&document.file_name)),
                    media_type: "application/json".into(),
                    content: serde_json::to_string_pretty(&result)
                        .map_err(|error| format!("Capture export cannot be encoded: {error}"))?,
                })
            }
            LibraryExportFormat::Text => {
                let result = read_json_optional(&directory.join(RESULT_FILE_NAME))?
                    .ok_or_else(|| "Capture library result is not available.".to_string())?;
                let content = result
                    .get("targetText")
                    .or_else(|| result.get("sourceText"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Capture result has no exportable text.".to_string())?;
                Ok(LibraryExportPayload {
                    file_name: format!("{}.txt", stem(&document.file_name)),
                    media_type: "text/plain;charset=utf-8".into(),
                    content: content.into(),
                })
            }
        }
    }

    pub(crate) fn delete(&self, request: LibraryDocumentRequest) -> Result<(), String> {
        validate_document_id(&request.document_id)?;
        let mut index = self.lock_index()?;
        let position = index
            .documents
            .iter()
            .position(|document| document.document_id == request.document_id)
            .ok_or_else(|| "Capture library document was not found.".to_string())?;
        let directory = self.document_directory(&request.document_id)?;
        let tombstone = directory.with_extension("deleting");
        fs::rename(&directory, &tombstone).map_err(|error| {
            format!("Capture library source cannot be prepared for deletion: {error}")
        })?;
        let removed = index.documents.remove(position);
        if let Err(error) = self.save_index(&index) {
            index.documents.insert(position, removed);
            let _ = fs::rename(tombstone, directory);
            return Err(error);
        }
        fs::remove_dir_all(tombstone)
            .map_err(|error| format!("Capture library source cannot be deleted: {error}"))
    }

    fn find_document(&self, document_id: &str) -> Result<StoredDocument, String> {
        validate_document_id(document_id)?;
        self.lock_index()?
            .documents
            .iter()
            .find(|candidate| candidate.document_id == document_id)
            .cloned()
            .ok_or_else(|| "Capture library document was not found.".to_string())
    }

    fn lock_index(&self) -> Result<std::sync::MutexGuard<'_, LibraryIndex>, String> {
        self.index
            .lock()
            .map_err(|_| "Capture library state is unavailable.".to_string())
    }

    fn document_directory(&self, document_id: &str) -> Result<PathBuf, String> {
        validate_document_id(document_id)?;
        Ok(self.root.join("items").join(document_id))
    }

    fn save_index(&self, index: &LibraryIndex) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(index)
            .map_err(|error| format!("Capture library index cannot be encoded: {error}"))?;
        let index_path = self.root.join(INDEX_FILE_NAME);
        if index_path.exists() {
            fs::copy(&index_path, self.root.join(INDEX_BACKUP_FILE_NAME)).map_err(|error| {
                format!("Capture library recovery copy cannot be written: {error}")
            })?;
        }
        atomic_write(&index_path, &bytes)
    }
}

fn validate_source_input(input: &LibrarySourceInput) -> Result<(), String> {
    let file_name = input.file_name.trim();
    if file_name.is_empty()
        || file_name.len() > 255
        || file_name
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'"' | b'\\'))
        || Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name)
    {
        return Err("Capture source file name is invalid.".into());
    }
    if !matches!(
        input.media_type.as_str(),
        "application/pdf" | "image/png" | "image/jpeg" | "audio/wav" | "audio/mpeg" | "audio/mp4"
    ) {
        return Err("Capture source media type is unsupported.".into());
    }
    if input.bytes.is_empty() || input.bytes.len() > MAX_SOURCE_BYTES {
        return Err("Capture source exceeds the desktop library limit.".into());
    }
    Ok(())
}

fn validate_document_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Capture library document identifier is invalid.".into());
    }
    Ok(())
}

fn validate_status(value: &str) -> Result<(), String> {
    if !matches!(
        value,
        "queued"
            | "processing"
            | "persisting"
            | "recovery_required"
            | "awaiting_confirmation"
            | "completed"
            | "failed"
            | "canceled"
    ) {
        return Err("Capture library status is invalid.".into());
    }
    Ok(())
}

fn random_document_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Capture library identifier cannot be generated.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "Capture library clock is invalid.".into())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Capture library cannot be written: {error}"))?;
    fs::rename(temporary, path)
        .map_err(|error| format!("Capture library cannot finalize data: {error}"))
}

fn load_backup_index(root: &Path) -> Result<LibraryIndex, String> {
    let backup_path = root.join(INDEX_BACKUP_FILE_NAME);
    let bytes = fs::read(backup_path)
        .map_err(|error| format!("Capture library recovery copy cannot be read: {error}"))?;
    serde_json::from_slice::<LibraryIndex>(&bytes)
        .map_err(|error| format!("Capture library recovery copy is invalid: {error}"))
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Capture library JSON cannot be encoded: {error}"))?;
    atomic_write(path, &bytes)
}

fn read_json_optional(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("Capture library JSON is invalid: {error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Capture library JSON cannot be read: {error}")),
    }
}

fn stem(file_name: &str) -> &str {
    Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("capture")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_lifecycle_is_opaque_and_persistent() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "notes.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        assert_eq!(created.status, "queued");
        assert!(!serde_json::to_string(&created)
            .expect("summary")
            .contains("items"));

        library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id.clone(),
                capture_id: Some("capture-1".into()),
                clear_capture_id: false,
                status: "completed".into(),
                stage: Some("completed".into()),
                raw: Some(serde_json::json!({ "sourceText": "OCR" })),
                result: Some(serde_json::json!({ "targetText": "Structured" })),
                error_code: None,
                error_message: None,
            })
            .expect("update");
        let detail = library
            .get(LibraryDocumentRequest {
                document_id: created.document_id.clone(),
            })
            .expect("detail");
        assert_eq!(detail.result.expect("result")["targetText"], "Structured");
        assert_eq!(
            library
                .list(LibraryListRequest::default())
                .expect("list")
                .len(),
            1
        );
        assert_eq!(
            library
                .load_source(LibraryDocumentRequest {
                    document_id: created.document_id.clone()
                })
                .expect("source")
                .bytes,
            b"pdf bytes"
        );
        library
            .delete(LibraryDocumentRequest {
                document_id: created.document_id,
            })
            .expect("delete");
        assert!(library
            .list(LibraryListRequest::default())
            .expect("list")
            .is_empty());
    }

    #[test]
    fn rejects_paths_and_invalid_document_ids() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        assert!(library
            .create_source(LibrarySourceInput {
                file_name: "../secret.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: vec![1]
            })
            .is_err());
        assert!(library
            .get(LibraryDocumentRequest {
                document_id: "../secret".into()
            })
            .is_err());
    }

    #[test]
    fn recovers_from_a_corrupt_primary_index_without_exposing_paths() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "recovery.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: vec![1],
            })
            .expect("source");
        library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id,
                capture_id: None,
                clear_capture_id: false,
                status: "failed".into(),
                stage: Some("failed".into()),
                raw: None,
                result: None,
                error_code: Some("expected".into()),
                error_message: Some("test".into()),
            })
            .expect("write backup");
        fs::write(
            directory.path().join("library").join(INDEX_FILE_NAME),
            b"not json",
        )
        .expect("corrupt primary");

        let reopened = LibraryStore::open(directory.path()).expect("recovered library");
        let listed = reopened.list(LibraryListRequest::default()).expect("list");
        assert_eq!(listed.len(), 1);
        assert!(!serde_json::to_string(&listed)
            .expect("serialized summaries")
            .contains("items"));
    }

    #[test]
    fn capture_identifier_is_preserved_until_explicitly_cleared() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "recovery.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: vec![1],
            })
            .expect("source");

        let linked = library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id.clone(),
                capture_id: Some("capture-1".into()),
                clear_capture_id: false,
                status: "processing".into(),
                stage: Some("extracting".into()),
                raw: None,
                result: None,
                error_code: None,
                error_message: None,
            })
            .expect("link capture");
        assert_eq!(linked.capture_id.as_deref(), Some("capture-1"));

        let preserved = library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id.clone(),
                capture_id: None,
                clear_capture_id: false,
                status: "recovery_required".into(),
                stage: Some("completed".into()),
                raw: None,
                result: None,
                error_code: Some("runtime_cleanup_failed".into()),
                error_message: Some("retry cleanup".into()),
            })
            .expect("preserve capture");
        assert_eq!(preserved.capture_id.as_deref(), Some("capture-1"));

        let cleared = library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id.clone(),
                capture_id: None,
                clear_capture_id: true,
                status: "completed".into(),
                stage: Some("completed".into()),
                raw: None,
                result: None,
                error_code: None,
                error_message: None,
            })
            .expect("clear capture");
        assert_eq!(cleared.capture_id, None);

        assert!(library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id,
                capture_id: Some("capture-2".into()),
                clear_capture_id: true,
                status: "processing".into(),
                stage: None,
                raw: None,
                result: None,
                error_code: None,
                error_message: None,
            })
            .is_err());
    }

    #[test]
    fn source_validation_matches_renderer_limits_and_allowlist() {
        for (media_type, file_name) in [
            ("application/pdf", "fixture.pdf"),
            ("image/png", "fixture.png"),
            ("image/jpeg", "fixture.jpg"),
            ("audio/wav", "fixture.wav"),
            ("audio/mpeg", "fixture.mp3"),
            ("audio/mp4", "fixture.m4a"),
        ] {
            assert!(validate_source_input(&LibrarySourceInput {
                file_name: file_name.into(),
                media_type: media_type.into(),
                bytes: vec![1],
            })
            .is_ok());
        }

        assert!(validate_source_input(&LibrarySourceInput {
            file_name: "limit.pdf".into(),
            media_type: "application/pdf".into(),
            bytes: vec![1; MAX_SOURCE_BYTES],
        })
        .is_ok());
        assert!(validate_source_input(&LibrarySourceInput {
            file_name: "empty.pdf".into(),
            media_type: "application/pdf".into(),
            bytes: Vec::new(),
        })
        .is_err());
        assert!(validate_source_input(&LibrarySourceInput {
            file_name: "large.pdf".into(),
            media_type: "application/pdf".into(),
            bytes: vec![1; MAX_SOURCE_BYTES + 1],
        })
        .is_err());
        for (media_type, file_name) in [("image/webp", "image.webp"), ("audio/ogg", "voice.ogg")] {
            assert!(validate_source_input(&LibrarySourceInput {
                file_name: file_name.into(),
                media_type: media_type.into(),
                bytes: vec![1],
            })
            .is_err());
        }
    }
}
