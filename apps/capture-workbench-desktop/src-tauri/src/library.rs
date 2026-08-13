use std::{
    fs::{self, File},
    io::{self, ErrorKind, Read},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::{
    LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest, LibraryDocumentSummary,
    LibraryExportFormat, LibraryExportPayload, LibraryExportRequest, LibraryImportSourceRequest,
    LibraryListRequest, LibrarySourceInput,
};

const INDEX_FILE_NAME: &str = "library-index-v1.json";
const INDEX_BACKUP_FILE_NAME: &str = "library-index-v1.backup.json";
const TRANSACTION_FILE_NAME: &str = "library-transaction-v1.json";
const INDEX_VERSION: u8 = 1;
pub(crate) const MAX_SOURCE_BYTES: usize = 50 * 1024 * 1024;
const SOURCE_FILE_NAME: &str = "source.bin";
const RAW_FILE_NAME: &str = "raw.json";
const RESULT_FILE_NAME: &str = "result.json";

#[cfg(test)]
thread_local! {
    static TRANSACTION_FAILURE_POINT: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_transaction_failure(point: &str) -> io::Result<()> {
    TRANSACTION_FAILURE_POINT.with(|configured| {
        let should_fail = configured.borrow().as_deref() == Some(point);
        if should_fail {
            configured.borrow_mut().take();
            Err(io::Error::other(format!(
                "injected transaction failure: {point}"
            )))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
fn inject_transaction_failure(_point: &str) -> io::Result<()> {
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
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
    #[serde(default)]
    recovery_code: Option<String>,
    #[serde(default)]
    recovery_message: Option<String>,
    #[serde(default)]
    recovery_client_request_id: Option<String>,
    #[serde(default)]
    recovery_ingestion_id: Option<String>,
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
            recovery_code: self.recovery_code.clone(),
            recovery_message: self.recovery_message.clone(),
            recovery_client_request_id: self.recovery_client_request_id.clone(),
            recovery_ingestion_id: self.recovery_ingestion_id.clone(),
        }
    }
}

/// Durable desktop-owned capture data. Runtime credentials and filesystem paths
/// never cross this boundary.
pub(crate) struct LibraryStore {
    root: PathBuf,
    index: Mutex<LibraryIndex>,
}

pub(crate) struct RuntimeSourceFile {
    pub(crate) file_name: String,
    pub(crate) media_type: String,
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
}

impl LibraryStore {
    pub(crate) fn open(app_data_dir: &Path) -> Result<Self, String> {
        let root = app_data_dir.join("library");
        if is_reparse_link(&root) {
            return Err("Capture library root must not be a symbolic link.".into());
        }
        if is_reparse_link(&root.join("items")) {
            return Err("Capture library items root must not be a symbolic link.".into());
        }
        fs::create_dir_all(root.join("items"))
            .map_err(|error| format!("Capture library cannot be created: {error}"))?;
        ensure_library_root_safe(&root)?;
        recover_library_transaction(&root)?;
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
        ensure_leaf_safe(&self.root, &document_directory.join(SOURCE_FILE_NAME))?;
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
            recovery_code: None,
            recovery_message: None,
            recovery_client_request_id: None,
            recovery_ingestion_id: None,
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

    pub(crate) fn import_source(
        &self,
        request: LibraryImportSourceRequest,
    ) -> Result<LibraryDocumentSummary, String> {
        let source = PathBuf::from(request.source_path);
        let source_metadata = fs::symlink_metadata(&source)
            .map_err(|_| "Selected source cannot be inspected.".to_string())?;
        if source_metadata.file_type().is_symlink() || !source_metadata.file_type().is_file() {
            return Err("Selected source must be a regular non-symlink file.".into());
        }
        if source_metadata.len() == 0 || source_metadata.len() > MAX_SOURCE_BYTES as u64 {
            return Err("Selected source exceeds the desktop library limit.".into());
        }

        let canonical = fs::canonicalize(&source)
            .map_err(|_| "Selected source cannot be resolved.".to_string())?;
        let canonical_metadata = fs::metadata(&canonical)
            .map_err(|_| "Selected source cannot be inspected.".to_string())?;
        if !canonical_metadata.is_file() || canonical_metadata.len() != source_metadata.len() {
            return Err("Selected source changed during import.".into());
        }
        let file_name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Selected source file name is invalid.".to_string())?
            .to_string();

        let mut reader =
            File::open(&canonical).map_err(|_| "Selected source cannot be opened.".to_string())?;
        let mut bytes = Vec::with_capacity(canonical_metadata.len() as usize);
        reader
            .by_ref()
            .take(MAX_SOURCE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Selected source cannot be read.".to_string())?;
        if bytes.len() as u64 != canonical_metadata.len() {
            return Err("Selected source changed during import.".into());
        }
        let media_type = verified_media_type(&file_name, &bytes)?;
        self.create_source(LibrarySourceInput {
            file_name,
            media_type: media_type.into(),
            bytes,
        })
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
        let position = index
            .documents
            .iter()
            .position(|candidate| candidate.document_id == update.document_id)
            .ok_or_else(|| "Capture library document was not found.".to_string())?;
        let mut next_index = index.clone();
        let document = &mut next_index.documents[position];
        let directory = self.document_directory(&document.document_id)?;
        if update.clear_capture_id {
            document.capture_id = None;
        } else if update.capture_id.is_some() {
            document.capture_id = update.capture_id;
        }
        document.status = update.status;
        document.stage = update.stage;
        document.error_code = update.error_code;
        document.error_message = update.error_message;
        let has_recovery_update = update.recovery_code.is_some()
            || update.recovery_message.is_some()
            || update.recovery_client_request_id.is_some()
            || update.recovery_ingestion_id.is_some();
        document.recovery_code = update.recovery_code;
        document.recovery_message = update.recovery_message;
        if has_recovery_update {
            if update.recovery_client_request_id.is_some() {
                document.recovery_client_request_id = update.recovery_client_request_id;
            }
            if update.recovery_ingestion_id.is_some() {
                document.recovery_ingestion_id = update.recovery_ingestion_id;
            }
        } else {
            document.recovery_client_request_id = None;
            document.recovery_ingestion_id = None;
        }
        document.updated_at_ms = now_ms()?;
        let summary = document.summary();

        let transaction_id = random_document_id()?;
        let mut prepared = Vec::new();
        if let Some(raw) = &update.raw {
            let raw_path = directory.join(RAW_FILE_NAME);
            ensure_leaf_safe(&self.root, &raw_path)?;
            prepared.push(prepare_transaction_entry(
                &self.root,
                &raw_path,
                &transaction_id,
                serde_json::to_vec_pretty(raw)
                    .map_err(|error| format!("Capture library JSON cannot be encoded: {error}"))?,
            )?);
        }
        if let Some(result) = &update.result {
            let result_path = directory.join(RESULT_FILE_NAME);
            ensure_leaf_safe(&self.root, &result_path)?;
            prepared.push(prepare_transaction_entry(
                &self.root,
                &result_path,
                &transaction_id,
                serde_json::to_vec_pretty(result)
                    .map_err(|error| format!("Capture library JSON cannot be encoded: {error}"))?,
            )?);
        }
        let index_path = self.root.join(INDEX_FILE_NAME);
        ensure_leaf_safe(&self.root, &index_path)?;
        prepared.push(prepare_transaction_entry(
            &self.root,
            &index_path,
            &transaction_id,
            serde_json::to_vec_pretty(&next_index)
                .map_err(|error| format!("Capture library index cannot be encoded: {error}"))?,
        )?);
        if index_path.exists() {
            let backup_path = self.root.join(INDEX_BACKUP_FILE_NAME);
            ensure_leaf_safe(&self.root, &backup_path)?;
            fs::copy(&index_path, &backup_path).map_err(|error| {
                format!("Capture library recovery copy cannot be written: {error}")
            })?;
        }
        commit_library_transaction(
            &self.root,
            LibraryTransaction {
                transaction_id,
                document_id: update.document_id,
                operation: "update_capture".into(),
                target_index_version: INDEX_VERSION,
                stage: TransactionStage::Prepared,
                applied_entries: 0,
                entries: prepared.iter().map(|entry| entry.journal.clone()).collect(),
            },
            prepared,
        )?;
        *index = next_index;
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
        ensure_leaf_safe(&self.root, &directory.join(RAW_FILE_NAME))?;
        ensure_leaf_safe(&self.root, &directory.join(RESULT_FILE_NAME))?;
        Ok(LibraryDocumentDetail {
            summary: document.summary(),
            raw: read_json_optional(&directory.join(RAW_FILE_NAME))?,
            result: read_json_optional(&directory.join(RESULT_FILE_NAME))?,
        })
    }

    pub(crate) fn runtime_source_file(
        &self,
        document_id: &str,
    ) -> Result<RuntimeSourceFile, String> {
        let document = self.find_document(document_id)?;
        let path = self
            .document_directory(&document.document_id)?
            .join(SOURCE_FILE_NAME);
        ensure_leaf_safe(&self.root, &path)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "Capture library source cannot be inspected.".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Err("Capture library source is not a regular file.".into());
        }
        if metadata.len() != document.byte_length || metadata.len() == 0 {
            return Err("Capture library source changed after import.".into());
        }
        let canonical_path = fs::canonicalize(&path)
            .map_err(|_| "Capture library source cannot be resolved.".to_string())?;
        Ok(RuntimeSourceFile {
            file_name: document.file_name,
            media_type: document.media_type,
            path: canonical_path,
            bytes: metadata.len(),
        })
    }

    pub(crate) fn export(
        &self,
        request: LibraryExportRequest,
    ) -> Result<LibraryExportPayload, String> {
        let document = self.find_document(&request.document_id)?;
        let directory = self.document_directory(&document.document_id)?;
        ensure_leaf_safe(&self.root, &directory.join(RESULT_FILE_NAME))?;
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
        if index.documents[position].capture_id.is_some() {
            return Err("Capture library document still owns an active runtime capture.".into());
        }
        let directory = self.document_directory(&request.document_id)?;
        let tombstone = directory.with_extension("deleting");
        ensure_leaf_safe(&self.root, &directory)?;
        ensure_leaf_safe(&self.root, &tombstone)?;
        fs::rename(&directory, &tombstone).map_err(|error| {
            format!("Capture library source cannot be prepared for deletion: {error}")
        })?;
        let removed = index.documents.remove(position);
        if let Err(error) = self.save_index(&index) {
            index.documents.insert(position, removed);
            ensure_leaf_safe(&self.root, &tombstone)?;
            ensure_leaf_safe(&self.root, &directory)?;
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
        let directory = self.root.join("items").join(document_id);
        ensure_library_root_safe(&self.root)?;
        ensure_no_symlink_ancestors(&self.root, &directory)?;
        ensure_canonical_within(&self.root, &directory)?;
        Ok(directory)
    }

    fn save_index(&self, index: &LibraryIndex) -> Result<(), String> {
        ensure_library_root_safe(&self.root)?;
        let bytes = serde_json::to_vec_pretty(index)
            .map_err(|error| format!("Capture library index cannot be encoded: {error}"))?;
        let index_path = self.root.join(INDEX_FILE_NAME);
        ensure_leaf_safe(&self.root, &index_path)?;
        if index_path.exists() {
            let backup_path = self.root.join(INDEX_BACKUP_FILE_NAME);
            ensure_leaf_safe(&self.root, &backup_path)?;
            fs::copy(&index_path, &backup_path).map_err(|error| {
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryTransaction {
    transaction_id: String,
    document_id: String,
    operation: String,
    target_index_version: u8,
    stage: TransactionStage,
    applied_entries: usize,
    entries: Vec<TransactionEntry>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransactionStage {
    Prepared,
    Replacing,
    Committed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionEntry {
    temporary_file_name: String,
    target_file_name: String,
    backup_file_name: String,
    had_target: bool,
}

struct PreparedTransactionEntry {
    journal: TransactionEntry,
    bytes: Vec<u8>,
}

fn verified_media_type(file_name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let media_type = if bytes.starts_with(b"%PDF-") {
        ("application/pdf", matches!(extension.as_str(), "pdf"))
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image/png", matches!(extension.as_str(), "png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ("image/jpeg", matches!(extension.as_str(), "jpg" | "jpeg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        ("audio/wav", matches!(extension.as_str(), "wav"))
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        ("audio/mpeg", matches!(extension.as_str(), "mp3"))
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        ("audio/mp4", matches!(extension.as_str(), "m4a" | "mp4"))
    } else {
        return Err("Selected source signature is unsupported.".into());
    };
    if !media_type.1 {
        return Err("Selected source extension does not match its signature.".into());
    }
    Ok(media_type.0)
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

fn is_reparse_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
        || fs::read_link(path).is_ok()
}

fn ensure_canonical_within(root: &Path, candidate: &Path) -> Result<(), String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| "Capture library root cannot be resolved.".to_string())?;
    let canonical = canonicalize_allowing_missing(candidate)?;
    if canonical != canonical_root && !canonical.starts_with(&canonical_root) {
        return Err("Capture library path escaped its root.".into());
    }
    Ok(())
}

fn canonicalize_allowing_missing(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|_| "Capture library path cannot be resolved.".to_string());
    }
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    while !current.exists() {
        let name = current
            .file_name()
            .ok_or_else(|| "Capture library path has no file name.".to_string())?
            .to_owned();
        missing.push(name);
        if !current.pop() {
            return Err("Capture library path has no resolvable ancestor.".into());
        }
    }
    let mut canonical = fs::canonicalize(&current)
        .map_err(|_| "Capture library path cannot be resolved.".to_string())?;
    for name in missing.iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

fn ensure_no_symlink_ancestors(root: &Path, candidate: &Path) -> Result<(), String> {
    let mut current = candidate.to_path_buf();
    loop {
        if is_reparse_link(&current) {
            return Err("Capture library path must not contain symbolic links.".into());
        }
        if current == root || !current.starts_with(root) {
            break;
        }
        if !current.pop() {
            break;
        }
    }
    Ok(())
}

fn ensure_library_root_safe(root: &Path) -> Result<(), String> {
    if is_reparse_link(root) {
        return Err("Capture library root must not be a symbolic link.".into());
    }
    let items = root.join("items");
    if is_reparse_link(&items) {
        return Err("Capture library items root must not be a symbolic link.".into());
    }
    ensure_canonical_within(root, &items)
}

fn ensure_leaf_safe(root: &Path, path: &Path) -> Result<(), String> {
    ensure_no_symlink_ancestors(root, path)?;
    ensure_canonical_within(root, path)
}

fn ensure_transaction_path_safe(root: &Path, path: &Path) -> Result<(), String> {
    ensure_library_root_safe(root)?;
    ensure_leaf_safe(root, path)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Capture library target has no parent.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Capture library target file name is invalid.".to_string())?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", random_document_id()?));
    let result = fs::write(&temporary, bytes)
        .map_err(|error| format!("Capture library cannot be written: {error}"))
        .and_then(|()| {
            fs::rename(&temporary, path)
                .map_err(|error| format!("Capture library cannot finalize data: {error}"))
        });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn prepare_transaction_entry(
    root: &Path,
    target: &Path,
    transaction_id: &str,
    bytes: Vec<u8>,
) -> Result<PreparedTransactionEntry, String> {
    ensure_transaction_path_safe(root, target)?;
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Capture library transaction target is invalid.".to_string())?;
    let temporary = target.with_file_name(format!("{file_name}.{transaction_id}.next"));
    let backup = target.with_file_name(format!("{file_name}.{transaction_id}.backup"));
    Ok(PreparedTransactionEntry {
        journal: TransactionEntry {
            temporary_file_name: relative_transaction_path(root, &temporary)?,
            target_file_name: relative_transaction_path(root, target)?,
            backup_file_name: relative_transaction_path(root, &backup)?,
            had_target: target.exists(),
        },
        bytes,
    })
}

fn relative_transaction_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| "Capture library transaction path is invalid.".to_string())
        .map(|relative| relative.to_string_lossy().into_owned())
}

fn transaction_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Capture library transaction path is invalid.".into());
    }
    Ok(root.join(relative))
}

fn write_transaction_journal(root: &Path, transaction: &LibraryTransaction) -> Result<(), String> {
    ensure_library_root_safe(root)?;
    ensure_leaf_safe(root, &root.join(TRANSACTION_FILE_NAME))?;
    let bytes = serde_json::to_vec_pretty(transaction)
        .map_err(|error| format!("Capture library transaction cannot be encoded: {error}"))?;
    atomic_write(&root.join(TRANSACTION_FILE_NAME), &bytes)
}

fn commit_library_transaction(
    root: &Path,
    mut transaction: LibraryTransaction,
    prepared: Vec<PreparedTransactionEntry>,
) -> Result<(), String> {
    ensure_library_root_safe(root)?;
    for (index, entry) in prepared.iter().enumerate() {
        let temporary = transaction_path(root, &entry.journal.temporary_file_name)?;
        ensure_transaction_path_safe(root, &temporary)?;
        if let Err(error) = inject_transaction_failure(&format!("stage-write-{index}"))
            .and_then(|()| fs::write(&temporary, &entry.bytes))
        {
            for cleanup in &prepared {
                let cleanup_path = transaction_path(root, &cleanup.journal.temporary_file_name)?;
                ensure_transaction_path_safe(root, &cleanup_path)?;
                let _ = remove_file_if_exists(&cleanup_path);
            }
            return Err(format!(
                "Capture library transaction data cannot be staged: {error}"
            ));
        }
    }
    write_transaction_journal(root, &transaction)?;
    transaction.stage = TransactionStage::Replacing;
    write_transaction_journal(root, &transaction)?;

    for (index, entry) in transaction.entries.iter().enumerate() {
        let target = transaction_path(root, &entry.target_file_name)?;
        let temporary = transaction_path(root, &entry.temporary_file_name)?;
        let backup = transaction_path(root, &entry.backup_file_name)?;
        ensure_transaction_path_safe(root, &target)?;
        ensure_transaction_path_safe(root, &temporary)?;
        ensure_transaction_path_safe(root, &backup)?;
        let replacement = (|| -> Result<(), String> {
            if entry.had_target {
                inject_transaction_failure(&format!("rename-{index}-backup"))
                    .and_then(|()| fs::rename(&target, &backup))
                    .map_err(|error| {
                        format!("Capture library transaction backup cannot be created: {error}")
                    })?;
            }
            inject_transaction_failure(&format!("rename-{index}-target"))
                .and_then(|()| fs::rename(&temporary, &target))
                .map_err(|error| {
                    format!("Capture library transaction data cannot be finalized: {error}")
                })?;
            Ok(())
        })();
        if let Err(error) = replacement {
            rollback_library_transaction(root, &transaction)?;
            return Err(error);
        }
        transaction.applied_entries += 1;
        write_transaction_journal(root, &transaction)?;
    }

    transaction.stage = TransactionStage::Committed;
    write_transaction_journal(root, &transaction)?;
    if finalize_library_transaction(root, &transaction).is_err() {
        // A committed journal is intentionally retained for `open()` to finish.
        return Ok(());
    }
    Ok(())
}

fn recover_library_transaction(root: &Path) -> Result<(), String> {
    ensure_library_root_safe(root)?;
    let journal_path = root.join(TRANSACTION_FILE_NAME);
    ensure_leaf_safe(root, &journal_path)?;
    let bytes = match fs::read(&journal_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Capture library transaction journal cannot be read: {error}"
            ))
        }
    };
    let transaction: LibraryTransaction = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Capture library transaction journal is invalid: {error}"))?;
    validate_transaction(&transaction)?;
    if transaction.stage == TransactionStage::Committed
        || transaction.applied_entries == transaction.entries.len()
    {
        finalize_library_transaction(root, &transaction)
    } else {
        rollback_library_transaction(root, &transaction)
    }
}

fn validate_transaction(transaction: &LibraryTransaction) -> Result<(), String> {
    validate_document_id(&transaction.document_id)?;
    validate_document_id(&transaction.transaction_id)?;
    if transaction.operation != "update_capture"
        || transaction.target_index_version != INDEX_VERSION
        || transaction.applied_entries > transaction.entries.len()
        || transaction.entries.is_empty()
    {
        return Err("Capture library transaction journal is unsupported.".into());
    }
    Ok(())
}

fn rollback_library_transaction(
    root: &Path,
    transaction: &LibraryTransaction,
) -> Result<(), String> {
    for entry in transaction.entries.iter().rev() {
        let target = transaction_path(root, &entry.target_file_name)?;
        let temporary = transaction_path(root, &entry.temporary_file_name)?;
        let backup = transaction_path(root, &entry.backup_file_name)?;
        ensure_transaction_path_safe(root, &target)?;
        ensure_transaction_path_safe(root, &temporary)?;
        ensure_transaction_path_safe(root, &backup)?;
        if backup.exists() {
            remove_file_if_exists(&target)?;
            fs::rename(&backup, &target).map_err(|error| {
                format!("Capture library transaction cannot be rolled back: {error}")
            })?;
        } else if !entry.had_target {
            remove_file_if_exists(&target)?;
        }
        remove_file_if_exists(&temporary)?;
    }
    let journal = root.join(TRANSACTION_FILE_NAME);
    ensure_transaction_path_safe(root, &journal)?;
    remove_file_if_exists(&journal)
}

fn finalize_library_transaction(
    root: &Path,
    transaction: &LibraryTransaction,
) -> Result<(), String> {
    for entry in &transaction.entries {
        let target = transaction_path(root, &entry.target_file_name)?;
        let temporary = transaction_path(root, &entry.temporary_file_name)?;
        let backup = transaction_path(root, &entry.backup_file_name)?;
        ensure_transaction_path_safe(root, &target)?;
        ensure_transaction_path_safe(root, &temporary)?;
        ensure_transaction_path_safe(root, &backup)?;
        if !target.exists() && temporary.exists() {
            fs::rename(&temporary, &target).map_err(|error| {
                format!("Capture library transaction cannot be completed: {error}")
            })?;
        }
        if !target.exists() {
            return Err("Capture library committed transaction is incomplete.".into());
        }
        remove_file_if_exists(&temporary)?;
        remove_file_if_exists(&backup)?;
    }
    let journal = root.join(TRANSACTION_FILE_NAME);
    ensure_transaction_path_safe(root, &journal)?;
    remove_file_if_exists(&journal)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if path.file_name().and_then(|name| name.to_str()) == Some(TRANSACTION_FILE_NAME) {
        inject_transaction_failure("cleanup-journal")
            .map_err(|error| format!("Capture library transaction cleanup failed: {error}"))?;
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Capture library transaction cleanup failed: {error}"
        )),
    }
}

fn load_backup_index(root: &Path) -> Result<LibraryIndex, String> {
    ensure_library_root_safe(root)?;
    let backup_path = root.join(INDEX_BACKUP_FILE_NAME);
    let bytes = fs::read(backup_path)
        .map_err(|error| format!("Capture library recovery copy cannot be read: {error}"))?;
    serde_json::from_slice::<LibraryIndex>(&bytes)
        .map_err(|error| format!("Capture library recovery copy is invalid: {error}"))
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
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};

    struct TransactionFailureGuard;

    impl TransactionFailureGuard {
        fn at(point: &str) -> Self {
            TRANSACTION_FAILURE_POINT.with(|configured| {
                assert!(configured.borrow().is_none());
                configured.replace(Some(point.to_string()));
            });
            Self
        }
    }

    impl Drop for TransactionFailureGuard {
        fn drop(&mut self) {
            TRANSACTION_FAILURE_POINT.with(|configured| {
                configured.take();
            });
        }
    }

    fn completed_update(document_id: &str, marker: &str) -> LibraryCaptureUpdate {
        LibraryCaptureUpdate {
            document_id: document_id.into(),
            capture_id: None,
            clear_capture_id: true,
            status: "completed".into(),
            stage: Some("completed".into()),
            raw: Some(serde_json::json!({ "sourceText": marker })),
            result: Some(serde_json::json!({ "targetText": marker })),
            error_code: None,
            error_message: None,
            recovery_code: None,
            recovery_message: None,
            recovery_client_request_id: None,
            recovery_ingestion_id: None,
        }
    }

    fn leave_replacing_transaction(
        library: &LibraryStore,
        document_id: &str,
        applied_entries: usize,
    ) {
        let transaction_id = format!("{:032x}", applied_entries + 2);
        let document_directory = library
            .document_directory(document_id)
            .expect("document directory");
        let mut next_index = library.lock_index().expect("index").clone();
        next_index.documents[0].status = "failed".into();
        let prepared = vec![
            prepare_transaction_entry(
                &library.root,
                &document_directory.join(RAW_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(&serde_json::json!({ "sourceText": "after" }))
                    .expect("raw"),
            )
            .expect("raw entry"),
            prepare_transaction_entry(
                &library.root,
                &document_directory.join(RESULT_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(&serde_json::json!({ "targetText": "after" }))
                    .expect("result"),
            )
            .expect("result entry"),
            prepare_transaction_entry(
                &library.root,
                &library.root.join(INDEX_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(&next_index).expect("index"),
            )
            .expect("index entry"),
        ];
        for entry in &prepared {
            fs::write(
                transaction_path(&library.root, &entry.journal.temporary_file_name)
                    .expect("temporary path"),
                &entry.bytes,
            )
            .expect("temporary bytes");
        }
        let mut transaction = LibraryTransaction {
            transaction_id,
            document_id: document_id.into(),
            operation: "update_capture".into(),
            target_index_version: INDEX_VERSION,
            stage: TransactionStage::Replacing,
            applied_entries: 0,
            entries: prepared.iter().map(|entry| entry.journal.clone()).collect(),
        };
        write_transaction_journal(&library.root, &transaction).expect("journal");
        for entry in transaction.entries.iter().take(applied_entries) {
            fs::rename(
                transaction_path(&library.root, &entry.target_file_name).expect("target"),
                transaction_path(&library.root, &entry.backup_file_name).expect("backup"),
            )
            .expect("backup");
            fs::rename(
                transaction_path(&library.root, &entry.temporary_file_name).expect("temporary"),
                transaction_path(&library.root, &entry.target_file_name).expect("target"),
            )
            .expect("replace");
            transaction.applied_entries += 1;
            write_transaction_journal(&library.root, &transaction).expect("advanced journal");
        }
    }

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
                capture_id: None,
                clear_capture_id: true,
                status: "completed".into(),
                stage: Some("completed".into()),
                raw: Some(serde_json::json!({ "sourceText": "OCR" })),
                result: Some(serde_json::json!({ "targetText": "Structured" })),
                error_code: None,
                error_message: None,
                recovery_code: None,
                recovery_message: None,
                recovery_client_request_id: None,
                recovery_ingestion_id: None,
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
    fn transaction_failures_preserve_index_raw_and_result_across_restart() {
        for failure_point in [
            "stage-write-0",
            "stage-write-1",
            "stage-write-2",
            "rename-0-backup",
            "rename-0-target",
            "rename-1-backup",
            "rename-1-target",
            "rename-2-backup",
            "rename-2-target",
        ] {
            let directory = tempfile::tempdir().expect("temporary app data");
            let library = LibraryStore::open(directory.path()).expect("library");
            let created = library
                .create_source(LibrarySourceInput {
                    file_name: "transaction.pdf".into(),
                    media_type: "application/pdf".into(),
                    bytes: b"pdf bytes".to_vec(),
                })
                .expect("source");
            library
                .update_capture(completed_update(&created.document_id, "before"))
                .expect("baseline");

            let guard = TransactionFailureGuard::at(failure_point);
            let error = library
                .update_capture(completed_update(&created.document_id, "after"))
                .expect_err("injected failure");
            drop(guard);
            assert!(
                error.contains("transaction"),
                "{failure_point} returned unexpected error: {error}"
            );

            let current = library
                .get(LibraryDocumentRequest {
                    document_id: created.document_id.clone(),
                })
                .expect("in-memory detail");
            assert_eq!(current.raw.expect("raw")["sourceText"], "before");
            assert_eq!(current.result.expect("result")["targetText"], "before");
            drop(library);

            let reopened = LibraryStore::open(directory.path()).expect("reopened");
            let recovered = reopened
                .get(LibraryDocumentRequest {
                    document_id: created.document_id,
                })
                .expect("recovered detail");
            assert_eq!(recovered.summary.status, "completed");
            assert_eq!(recovered.raw.expect("raw")["sourceText"], "before");
            assert_eq!(recovered.result.expect("result")["targetText"], "before");
            assert!(!reopened.root.join(TRANSACTION_FILE_NAME).exists());
        }
    }

    #[test]
    fn interrupted_replacing_transaction_rolls_back_on_open() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "interrupted.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        library
            .update_capture(completed_update(&created.document_id, "before"))
            .expect("baseline");

        let transaction_id = "1".repeat(32);
        let document_directory = library
            .document_directory(&created.document_id)
            .expect("document directory");
        let mut next_index = library.lock_index().expect("index").clone();
        next_index.documents[0].status = "failed".into();
        let prepared = vec![
            prepare_transaction_entry(
                &library.root,
                &document_directory.join(RAW_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(&serde_json::json!({ "sourceText": "after" }))
                    .expect("raw"),
            )
            .expect("raw entry"),
            prepare_transaction_entry(
                &library.root,
                &document_directory.join(RESULT_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(&serde_json::json!({ "targetText": "after" }))
                    .expect("result"),
            )
            .expect("result entry"),
            prepare_transaction_entry(
                &library.root,
                &library.root.join(INDEX_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(&next_index).expect("index"),
            )
            .expect("index entry"),
        ];
        for entry in &prepared {
            fs::write(
                transaction_path(&library.root, &entry.journal.temporary_file_name)
                    .expect("temporary path"),
                &entry.bytes,
            )
            .expect("temporary bytes");
        }
        let mut transaction = LibraryTransaction {
            transaction_id,
            document_id: created.document_id.clone(),
            operation: "update_capture".into(),
            target_index_version: INDEX_VERSION,
            stage: TransactionStage::Replacing,
            applied_entries: 0,
            entries: prepared.iter().map(|entry| entry.journal.clone()).collect(),
        };
        write_transaction_journal(&library.root, &transaction).expect("journal");
        let first = &transaction.entries[0];
        fs::rename(
            transaction_path(&library.root, &first.target_file_name).expect("target"),
            transaction_path(&library.root, &first.backup_file_name).expect("backup"),
        )
        .expect("backup first");
        fs::rename(
            transaction_path(&library.root, &first.temporary_file_name).expect("temporary"),
            transaction_path(&library.root, &first.target_file_name).expect("target"),
        )
        .expect("replace first");
        transaction.applied_entries = 1;
        write_transaction_journal(&library.root, &transaction).expect("advanced journal");
        drop(library);

        let reopened = LibraryStore::open(directory.path()).expect("recovered");
        let detail = reopened
            .get(LibraryDocumentRequest {
                document_id: created.document_id,
            })
            .expect("detail");
        assert_eq!(detail.summary.status, "completed");
        assert_eq!(detail.raw.expect("raw")["sourceText"], "before");
        assert_eq!(detail.result.expect("result")["targetText"], "before");
        assert!(!reopened.root.join(TRANSACTION_FILE_NAME).exists());
    }

    #[test]
    fn restart_recovers_every_replacing_transaction_stage() {
        for applied_entries in 0..=3 {
            let directory = tempfile::tempdir().expect("temporary app data");
            let library = LibraryStore::open(directory.path()).expect("library");
            let created = library
                .create_source(LibrarySourceInput {
                    file_name: "stage-restart.pdf".into(),
                    media_type: "application/pdf".into(),
                    bytes: b"pdf bytes".to_vec(),
                })
                .expect("source");
            library
                .update_capture(completed_update(&created.document_id, "before"))
                .expect("baseline");
            leave_replacing_transaction(&library, &created.document_id, applied_entries);
            drop(library);

            let reopened = LibraryStore::open(directory.path()).expect("recovered");
            let detail = reopened
                .get(LibraryDocumentRequest {
                    document_id: created.document_id,
                })
                .expect("detail");
            let expected = if applied_entries == 3 {
                "after"
            } else {
                "before"
            };
            let expected_status = if applied_entries == 3 {
                "failed"
            } else {
                "completed"
            };
            assert_eq!(detail.summary.status, expected_status);
            assert_eq!(detail.raw.expect("raw")["sourceText"], expected);
            assert_eq!(detail.result.expect("result")["targetText"], expected);
            assert!(!reopened.root.join(TRANSACTION_FILE_NAME).exists());
        }
    }

    #[test]
    fn committed_transaction_with_cleanup_failure_finishes_on_open() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "cleanup.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        library
            .update_capture(completed_update(&created.document_id, "before"))
            .expect("baseline");

        let guard = TransactionFailureGuard::at("cleanup-journal");
        library
            .update_capture(completed_update(&created.document_id, "after"))
            .expect("committed update");
        drop(guard);
        assert!(library.root.join(TRANSACTION_FILE_NAME).exists());
        drop(library);

        let reopened = LibraryStore::open(directory.path()).expect("recovered");
        let detail = reopened
            .get(LibraryDocumentRequest {
                document_id: created.document_id,
            })
            .expect("detail");
        assert_eq!(detail.raw.expect("raw")["sourceText"], "after");
        assert_eq!(detail.result.expect("result")["targetText"], "after");
        assert!(!reopened.root.join(TRANSACTION_FILE_NAME).exists());
    }

    #[test]
    fn commit_transaction_rejects_a_symlinked_target_before_rename() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "symlink-target.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        library
            .update_capture(completed_update(&created.document_id, "before"))
            .expect("baseline");
        let document_directory = library
            .document_directory(&created.document_id)
            .expect("document directory");
        let target = document_directory.join(RESULT_FILE_NAME);
        let transaction_id = "2".repeat(32);
        let prepared = vec![prepare_transaction_entry(
            &library.root,
            &target,
            &transaction_id,
            serde_json::to_vec_pretty(&serde_json::json!({ "targetText": "after" }))
                .expect("result"),
        )
        .expect("result entry")];
        let outside = directory.path().join("outside-result.json");
        fs::write(&outside, b"{}").expect("outside result");
        fs::remove_file(&target).expect("remove target");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&outside, &target);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &target);
        if symlink_result.is_ok() {
            let transaction = LibraryTransaction {
                transaction_id,
                document_id: created.document_id.clone(),
                operation: "update_capture".into(),
                target_index_version: INDEX_VERSION,
                stage: TransactionStage::Prepared,
                applied_entries: 0,
                entries: prepared.iter().map(|entry| entry.journal.clone()).collect(),
            };
            assert!(commit_library_transaction(&library.root, transaction, prepared).is_err());
            assert_eq!(fs::read_to_string(&outside).expect("outside result"), "{}");
        }
    }

    #[test]
    fn recovery_rejects_a_symlinked_transaction_target() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "recovery-symlink.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        library
            .update_capture(completed_update(&created.document_id, "before"))
            .expect("baseline");
        let document_directory = library
            .document_directory(&created.document_id)
            .expect("document directory");
        let target = document_directory.join(RESULT_FILE_NAME);
        let transaction_id = "3".repeat(32);
        let prepared = vec![prepare_transaction_entry(
            &library.root,
            &target,
            &transaction_id,
            serde_json::to_vec_pretty(&serde_json::json!({ "targetText": "after" }))
                .expect("result"),
        )
        .expect("result entry")];
        let outside = directory.path().join("outside-recovery.json");
        fs::write(&outside, b"{}").expect("outside result");
        fs::remove_file(&target).expect("remove target");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&outside, &target);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &target);
        if symlink_result.is_ok() {
            let transaction = LibraryTransaction {
                transaction_id,
                document_id: created.document_id.clone(),
                operation: "update_capture".into(),
                target_index_version: INDEX_VERSION,
                stage: TransactionStage::Replacing,
                applied_entries: 0,
                entries: prepared.iter().map(|entry| entry.journal.clone()).collect(),
            };
            write_transaction_journal(&library.root, &transaction).expect("journal");
            drop(library);

            assert!(LibraryStore::open(directory.path()).is_err());
            assert_eq!(fs::read_to_string(&outside).expect("outside result"), "{}");
        }
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
                recovery_code: None,
                recovery_message: None,
                recovery_client_request_id: None,
                recovery_ingestion_id: None,
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
                recovery_code: Some("capture_pending".into()),
                recovery_message: None,
                recovery_client_request_id: Some("capture-request-1".into()),
                recovery_ingestion_id: Some("ingestion-1".into()),
            })
            .expect("link capture");
        assert_eq!(linked.capture_id.as_deref(), Some("capture-1"));
        assert_eq!(
            linked.recovery_client_request_id.as_deref(),
            Some("capture-request-1")
        );
        assert_eq!(linked.recovery_ingestion_id.as_deref(), Some("ingestion-1"));

        let preserved = library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id.clone(),
                capture_id: None,
                clear_capture_id: false,
                status: "recovery_required".into(),
                stage: Some("completed".into()),
                raw: None,
                result: None,
                error_code: Some("runtime_terminal_failed".into()),
                error_message: Some("terminal evidence".into()),
                recovery_code: Some("runtime_cleanup_failed".into()),
                recovery_message: Some("retry cleanup".into()),
                recovery_client_request_id: None,
                recovery_ingestion_id: None,
            })
            .expect("preserve capture");
        assert_eq!(preserved.capture_id.as_deref(), Some("capture-1"));
        assert_eq!(
            preserved.error_code.as_deref(),
            Some("runtime_terminal_failed")
        );
        assert_eq!(
            preserved.recovery_code.as_deref(),
            Some("runtime_cleanup_failed")
        );
        assert_eq!(
            preserved.recovery_client_request_id.as_deref(),
            Some("capture-request-1")
        );
        assert_eq!(
            preserved.recovery_ingestion_id.as_deref(),
            Some("ingestion-1")
        );

        let cleared = library
            .update_capture(LibraryCaptureUpdate {
                document_id: created.document_id.clone(),
                capture_id: None,
                clear_capture_id: true,
                status: "failed".into(),
                stage: Some("failed".into()),
                raw: None,
                result: None,
                error_code: Some("runtime_terminal_failed".into()),
                error_message: Some("terminal evidence".into()),
                recovery_code: None,
                recovery_message: None,
                recovery_client_request_id: None,
                recovery_ingestion_id: None,
            })
            .expect("clear capture");
        assert_eq!(cleared.capture_id, None);
        assert_eq!(
            cleared.error_code.as_deref(),
            Some("runtime_terminal_failed")
        );
        assert_eq!(cleared.recovery_code, None);
        assert_eq!(cleared.recovery_client_request_id, None);
        assert_eq!(cleared.recovery_ingestion_id, None);

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
                recovery_code: None,
                recovery_message: None,
                recovery_client_request_id: None,
                recovery_ingestion_id: None,
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

    #[test]
    fn native_import_verifies_signature_and_redacts_paths() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let source = directory.path().join("private-source.pdf");
        fs::write(&source, b"%PDF-1.7\nfixture").expect("source");
        let library = LibraryStore::open(directory.path()).expect("library");

        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: source.to_string_lossy().into_owned(),
            })
            .expect("native import");
        let serialized = serde_json::to_string(&imported).expect("summary");
        assert_eq!(imported.file_name, "private-source.pdf");
        assert_eq!(imported.media_type, "application/pdf");
        assert!(!serialized.contains(&source.to_string_lossy().to_string()));

        let mismatch = directory.path().join("mismatch.png");
        fs::write(&mismatch, b"%PDF-1.7\nfixture").expect("mismatch");
        let error = library
            .import_source(LibraryImportSourceRequest {
                source_path: mismatch.to_string_lossy().into_owned(),
            })
            .expect_err("signature mismatch");
        assert!(!error.contains(&mismatch.to_string_lossy().to_string()));
    }

    #[test]
    fn native_import_accepts_exact_limit_and_rejects_oversize_before_copy() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let exact = directory.path().join("exact.pdf");
        let mut exact_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&exact)
            .expect("exact source");
        exact_file.write_all(b"%PDF-").expect("signature");
        exact_file
            .seek(SeekFrom::Start(MAX_SOURCE_BYTES as u64 - 1))
            .expect("seek");
        exact_file.write_all(&[0]).expect("limit byte");
        drop(exact_file);

        let library = LibraryStore::open(directory.path()).expect("library");
        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: exact.to_string_lossy().into_owned(),
            })
            .expect("exact limit");
        assert_eq!(imported.byte_length, MAX_SOURCE_BYTES as u64);

        let oversized = directory.path().join("oversized.pdf");
        let mut oversized_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&oversized)
            .expect("oversized source");
        oversized_file.write_all(b"%PDF-").expect("signature");
        oversized_file
            .set_len(MAX_SOURCE_BYTES as u64 + 1)
            .expect("oversized length");
        drop(oversized_file);
        let error = library
            .import_source(LibraryImportSourceRequest {
                source_path: oversized.to_string_lossy().into_owned(),
            })
            .expect_err("oversized rejected");
        assert!(error.contains("limit"));
        assert!(!library
            .root
            .join("items")
            .read_dir()
            .expect("items")
            .any(|entry| {
                entry
                    .ok()
                    .and_then(|item| fs::metadata(item.path()).ok())
                    .is_some_and(|metadata| metadata.len() > MAX_SOURCE_BYTES as u64)
            }));
    }

    #[test]
    fn library_path_guards_reject_external_canonical_paths() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let root = directory.path().join("library");
        fs::create_dir_all(root.join("items")).expect("items");

        assert!(ensure_canonical_within(&root, &root.join("items")).is_ok());
        assert!(ensure_canonical_within(&root, &directory.path().join("outside")).is_err());
    }

    #[test]
    fn document_directory_rejects_symlinked_items_root() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let items = directory.path().join("library").join("items");
        let outside = directory.path().join("outside-items");
        fs::create_dir(&outside).expect("outside");
        fs::remove_dir_all(&items).expect("remove items");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_dir(&outside, &items);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &items);
        if symlink_result.is_ok() {
            let document_id = "a".repeat(32);
            assert!(library.document_directory(&document_id).is_err());
        }
    }

    #[test]
    fn document_access_rejects_symlinked_document_directory() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "notes.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        let document_directory = library
            .document_directory(&created.document_id)
            .expect("document directory");
        let outside = directory.path().join("outside-document");
        fs::create_dir(&outside).expect("outside");
        fs::remove_dir_all(&document_directory).expect("remove document");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_dir(&outside, &document_directory);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &document_directory);
        if symlink_result.is_ok() {
            assert!(library
                .get(LibraryDocumentRequest {
                    document_id: created.document_id,
                })
                .is_err());
        }
    }

    #[test]
    fn document_read_rejects_symlinked_result_leaf() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "notes.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        let result_path = library
            .document_directory(&created.document_id)
            .expect("document directory")
            .join(RESULT_FILE_NAME);
        let outside = directory.path().join("outside-result.json");
        fs::write(&outside, b"{}").expect("outside result");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&outside, &result_path);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &result_path);
        if symlink_result.is_ok() {
            assert!(library
                .get(LibraryDocumentRequest {
                    document_id: created.document_id,
                })
                .is_err());
        }
    }

    #[test]
    fn native_import_rejects_directories_and_symlinks() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        assert!(library
            .import_source(LibraryImportSourceRequest {
                source_path: directory.path().to_string_lossy().into_owned(),
            })
            .is_err());

        let target = directory.path().join("target.pdf");
        let link = directory.path().join("linked.pdf");
        fs::write(&target, b"%PDF-1.7\nfixture").expect("target");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&target, &link);
        if symlink_result.is_ok() {
            assert!(library
                .import_source(LibraryImportSourceRequest {
                    source_path: link.to_string_lossy().into_owned(),
                })
                .is_err());
        }
    }
}
