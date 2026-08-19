use std::{
    fs::{self, File},
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::{
    LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest, LibraryDocumentSummary,
    LibraryExportFormat, LibraryExportPayload, LibraryExportRequest, LibraryImportSourceRequest,
    LibraryListRequest, LibrarySourceInput, LibrarySourcePayload,
};

use super::transaction::{prepare_transaction_entry, LibraryTransaction, TransactionStage};
use super::{
    atomic_write, commit_library_transaction, load_backup_index, read_json_optional,
    recover_library_transaction, stem, validate_document_id, validate_source_input,
    validate_status, INDEX_BACKUP_FILE_NAME, INDEX_FILE_NAME, INDEX_VERSION, MAX_SOURCE_BYTES,
    RAW_FILE_NAME, RESULT_FILE_NAME, SOURCE_FILE_NAME,
};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryIndex {
    pub(super) version: u8,
    pub(super) documents: Vec<StoredDocument>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredDocument {
    pub(super) document_id: String,
    pub(super) file_name: String,
    pub(super) media_type: String,
    pub(super) byte_length: u64,
    pub(super) created_at_ms: u64,
    pub(super) updated_at_ms: u64,
    pub(super) status: String,
    pub(super) stage: Option<String>,
    pub(super) capture_id: Option<String>,
    pub(super) error_code: Option<String>,
    pub(super) error_message: Option<String>,
    #[serde(default)]
    pub(super) recovery_code: Option<String>,
    #[serde(default)]
    pub(super) recovery_message: Option<String>,
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
        }
    }
}

/// Durable desktop-owned capture data. Runtime credentials and filesystem paths
/// never cross this boundary.
pub(crate) struct LibraryStore {
    pub(super) root: PathBuf,
    pub(super) index: Mutex<LibraryIndex>,
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
        fs::create_dir_all(root.join("items"))
            .map_err(|error| format!("Capture library cannot be created: {error}"))?;
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
        let media_type = super::validation::verified_media_type(&file_name, &bytes)?;
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
        document.recovery_code = update.recovery_code;
        document.recovery_message = update.recovery_message;
        document.updated_at_ms = now_ms()?;
        let summary = document.summary();

        let transaction_id = random_document_id()?;
        let mut prepared = Vec::new();
        if let Some(raw) = &update.raw {
            prepared.push(prepare_transaction_entry(
                &self.root,
                &directory.join(RAW_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(raw)
                    .map_err(|error| format!("Capture library JSON cannot be encoded: {error}"))?,
            )?);
        }
        if let Some(result) = &update.result {
            prepared.push(prepare_transaction_entry(
                &self.root,
                &directory.join(RESULT_FILE_NAME),
                &transaction_id,
                serde_json::to_vec_pretty(result)
                    .map_err(|error| format!("Capture library JSON cannot be encoded: {error}"))?,
            )?);
        }
        let index_path = self.root.join(INDEX_FILE_NAME);
        prepared.push(prepare_transaction_entry(
            &self.root,
            &index_path,
            &transaction_id,
            serde_json::to_vec_pretty(&next_index)
                .map_err(|error| format!("Capture library index cannot be encoded: {error}"))?,
        )?);
        if index_path.exists() {
            fs::copy(&index_path, self.root.join(INDEX_BACKUP_FILE_NAME)).map_err(|error| {
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

    pub(crate) fn runtime_source_file(
        &self,
        document_id: &str,
    ) -> Result<RuntimeSourceFile, String> {
        let document = self.find_document(document_id)?;
        let path = self
            .document_directory(&document.document_id)?
            .join(SOURCE_FILE_NAME);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "Capture library source cannot be inspected.".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Err("Capture library source is not a regular file.".into());
        }
        if metadata.len() != document.byte_length || metadata.len() == 0 {
            return Err("Capture library source changed after import.".into());
        }
        Ok(RuntimeSourceFile {
            file_name: document.file_name,
            media_type: document.media_type,
            path,
            bytes: metadata.len(),
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
        if index.documents[position].capture_id.is_some() {
            return Err("Capture library document still owns an active runtime capture.".into());
        }
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

    pub(super) fn lock_index(&self) -> Result<std::sync::MutexGuard<'_, LibraryIndex>, String> {
        self.index
            .lock()
            .map_err(|_| "Capture library state is unavailable.".to_string())
    }

    pub(super) fn document_directory(&self, document_id: &str) -> Result<PathBuf, String> {
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
