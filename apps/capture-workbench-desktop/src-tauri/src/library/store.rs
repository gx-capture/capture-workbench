#[cfg(any(test, feature = "model-smoke-app-data"))]
use super::RECORDING_MAX_SOURCE_BYTES;
use super::{
    max_source_bytes, DOCUMENT_MAX_SOURCE_BYTES, IMPORT_FREE_SPACE_MARGIN, NOT_ENOUGH_DISK_SPACE,
};
#[cfg(any(test, feature = "model-smoke-app-data"))]
use crate::contracts::LibraryImportSourceRequest;
use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::random_id::random_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::{
    LibraryCaptureOptions, LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest,
    LibraryDocumentSummary, LibraryExportFormat, LibraryExportPayload, LibraryExportRequest,
    LibraryListRequest, LibrarySourcePayload,
};

use super::transaction::{
    pending_transaction_rolls_forward, prepare_transaction_entry, LibraryTransaction,
    TransactionStage,
};
use super::{
    atomic_write, commit_library_transaction, inject_transaction_failure, load_backup_index,
    read_json_optional, recover_library_transaction, stem, validate_document_id, validate_status,
    INDEX_BACKUP_FILE_NAME, INDEX_FILE_NAME, INDEX_VERSION, RAW_FILE_NAME, RESULT_FILE_NAME,
    SOURCE_FILE_NAME,
};

/// Test fixture input for `LibraryStore::create_source`.
#[cfg(test)]
pub(crate) struct LibrarySourceInput {
    pub(crate) file_name: String,
    pub(crate) media_type: String,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryIndex {
    #[serde(skip)]
    recovery_pending: bool,
    pub(super) version: u8,
    pub(super) documents: Vec<StoredDocument>,
    /// Set for good once the index came from the recovery copy (or was missing) while
    /// item directories existed: that index may omit published documents, and every
    /// later save carries the flag, so a restart never treats those as crash orphans.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) orphan_cleanup_disabled: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) ocr_evidence: Option<crate::contracts::OcrEvidenceV1>,
    /// Absent on indexes written before a file could wait with options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) capture_options: Option<LibraryCaptureOptions>,
}

impl StoredDocument {
    fn summary(&self, has_raw: bool) -> LibraryDocumentSummary {
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
            capture_options: self.capture_options.clone(),
            has_raw,
        }
    }
}

/// Durable desktop-owned capture data. Runtime credentials and filesystem paths
/// never cross this boundary.
pub(crate) struct LibraryStore {
    pub(super) root: PathBuf,
    pub(super) index: Mutex<LibraryIndex>,
}

struct StagedSource {
    file_name: String,
    media_type: String,
    byte_length: u64,
    path: PathBuf,
}

pub(crate) struct RuntimeSourceFile {
    pub(crate) file_name: String,
    pub(crate) media_type: String,
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
}

impl LibraryStore {
    pub(crate) fn open(app_data_dir: &Path) -> Result<Self, String> {
        Self::open_at(app_data_dir, SystemTime::now())
    }

    fn open_at(app_data_dir: &Path, now: SystemTime) -> Result<Self, String> {
        let root = app_data_dir.join("library");
        fs::create_dir_all(root.join("items"))
            .map_err(|error| format!("Capture library cannot be created: {error}"))?;
        let staging_dir = root.join("staging");
        clean_staging_directory(&staging_dir, now);
        recover_library_transaction(&root)?;
        let (index, primary_index) = Self::read_index(&root)?;
        // Only an index read from its primary file, and never since restored from the
        // recovery copy, lists every item; otherwise unreferenced directories stay.
        if primary_index && !index.orphan_cleanup_disabled {
            clean_orphan_item_directories(&root.join("items"), &index, now);
        }
        Ok(Self {
            root,
            index: Mutex::new(index),
        })
    }

    /// The index and whether it was read from its primary file.
    fn read_index(root: &Path) -> Result<(LibraryIndex, bool), String> {
        let index_path = root.join(INDEX_FILE_NAME);
        let (mut index, primary_index) = match fs::read(&index_path) {
            Ok(bytes) => match serde_json::from_slice::<LibraryIndex>(&bytes) {
                Ok(index) => (index, true),
                Err(primary_error) => (load_backup_index(root).map_err(|backup_error| {
                    format!(
                        "Capture library index is invalid ({primary_error}); recovery copy is unavailable: {backup_error}"
                    )
                })?, false),
            },
            Err(error) if error.kind() == ErrorKind::NotFound => (LibraryIndex {
                recovery_pending: false,
                version: INDEX_VERSION,
                documents: Vec::new(),
                orphan_cleanup_disabled: false,
            }, false),
            Err(error) => return Err(format!("Capture library index cannot be read: {error}")),
        };
        if index.version != INDEX_VERSION {
            return Err("Capture library version is unsupported.".into());
        }
        for evidence in index
            .documents
            .iter()
            .filter_map(|document| document.ocr_evidence.as_ref())
        {
            evidence.validate()?;
        }
        if !primary_index && has_item_directories(&root.join("items")) {
            index.orphan_cleanup_disabled = true;
        }
        Ok((index, primary_index))
    }

    fn publish_source(
        &self,
        mut index: std::sync::MutexGuard<'_, LibraryIndex>,
        source: StagedSource,
        capture_options: Option<LibraryCaptureOptions>,
    ) -> Result<LibraryDocumentSummary, String> {
        let StagedSource {
            file_name,
            media_type,
            byte_length,
            path: staged_path,
        } = source;
        let now = now_ms()?;
        let document_id = random_id()?;
        let document_directory = self.document_directory(&document_id)?;
        if let Err(error) = fs::create_dir_all(&document_directory) {
            let _ = fs::remove_file(&staged_path);
            return Err(format!(
                "Capture library source directory cannot be created: {error}"
            ));
        }
        let source_path = document_directory.join(SOURCE_FILE_NAME);
        if let Err(error) = fs::rename(&staged_path, &source_path) {
            let _ = fs::remove_file(&staged_path);
            let _ = fs::remove_dir_all(&document_directory);
            return Err(format!("Capture library source cannot be placed: {error}"));
        }
        let document = StoredDocument {
            document_id,
            file_name,
            media_type,
            byte_length,
            created_at_ms: now,
            updated_at_ms: now,
            status: "queued".into(),
            stage: Some("uploading".into()),
            capture_id: None,
            error_code: None,
            error_message: None,
            recovery_code: None,
            recovery_message: None,
            ocr_evidence: None,
            capture_options,
        };
        let summary = document.summary(false);
        index.documents.insert(0, document);
        if let Err(error) = self.save_index(&index) {
            index.documents.remove(0);
            let _ = fs::remove_dir_all(document_directory);
            return Err(error);
        }
        Ok(summary)
    }

    pub(super) fn staging_directory(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub(super) fn copy_to_staging(
        mut reader: impl Read,
        staging_path: &Path,
        expected_length: u64,
    ) -> Result<(), String> {
        let mut file = File::create(staging_path)
            .map_err(|error| format!("Capture library staging file cannot be created: {error}"))?;
        const COPY_BUFFER_BYTES: usize = 1024 * 1024;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        let mut total_copied: u64 = 0;

        let copy_result: Result<(), String> = (|| {
            loop {
                let bytes_read = reader
                    .read(&mut buffer)
                    .map_err(|_| "Selected source cannot be read.".to_string())?;
                if bytes_read == 0 {
                    break;
                }
                total_copied += bytes_read as u64;
                if total_copied > expected_length {
                    return Err("Selected source changed during import.".into());
                }
                file.write_all(&buffer[..bytes_read])
                    .map_err(|error| format!("Capture library cannot be written: {error}"))?;
            }
            if total_copied != expected_length {
                return Err("Selected source changed during import.".into());
            }
            file.flush()
                .map_err(|error| format!("Capture library cannot be written: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Capture library cannot be written: {error}"))?;
            Ok(())
        })();

        drop(file);

        if let Err(error) = copy_result {
            let _ = fs::remove_file(staging_path);
            return Err(error);
        }
        Ok(())
    }

    /// Test fixture: a document whose source is the given bytes.
    #[cfg(test)]
    pub(crate) fn create_source(
        &self,
        input: LibrarySourceInput,
    ) -> Result<LibraryDocumentSummary, String> {
        self.create_source_with_options(input, None)
    }

    #[cfg(test)]
    pub(crate) fn create_source_with_options(
        &self,
        input: LibrarySourceInput,
        capture_options: Option<LibraryCaptureOptions>,
    ) -> Result<LibraryDocumentSummary, String> {
        if let Some(options) = &capture_options {
            super::validation::validate_capture_options(options)?;
        }
        // Refuse before staging; the index lock is not held while the source is copied.
        drop(self.lock_index_for_write()?);
        let staging_dir = self.staging_directory();
        fs::create_dir_all(&staging_dir).map_err(|error| {
            format!("Capture library staging directory cannot be created: {error}")
        })?;
        let staging_path = staging_dir.join(random_id()?);
        let byte_length = input.bytes.len() as u64;
        Self::copy_to_staging(&input.bytes[..], &staging_path, byte_length)?;
        let index = self.lock_index_for_publish(&staging_path)?;
        self.publish_source(
            index,
            StagedSource {
                file_name: input.file_name,
                media_type: input.media_type,
                byte_length,
                path: staging_path,
            },
            capture_options,
        )
    }

    #[cfg(any(test, feature = "model-smoke-app-data"))]
    pub(crate) fn import_source(
        &self,
        request: LibraryImportSourceRequest,
    ) -> Result<LibraryDocumentSummary, String> {
        self.import_source_bounded(request, RECORDING_MAX_SOURCE_BYTES as usize)
    }

    #[cfg(any(test, feature = "model-smoke-app-data"))]
    pub(super) fn import_source_bounded(
        &self,
        request: LibraryImportSourceRequest,
        max_bytes: usize,
    ) -> Result<LibraryDocumentSummary, String> {
        if let Some(options) = &request.capture_options {
            super::validation::validate_capture_options(options)?;
        }
        let source = crate::source_selection::inspect::inspect_source_for_fixture(
            Path::new(&request.source_path),
            max_bytes,
        )?;
        self.import_opened(source, request.capture_options)
    }

    pub(crate) fn import_opened(
        &self,
        source: crate::source_selection::inspect::OpenedSource,
        capture_options: Option<LibraryCaptureOptions>,
    ) -> Result<LibraryDocumentSummary, String> {
        self.import_opened_with_free_space(source, capture_options, available_space)
    }

    pub(super) fn import_opened_with_free_space(
        &self,
        mut source: crate::source_selection::inspect::OpenedSource,
        capture_options: Option<LibraryCaptureOptions>,
        free_space: impl FnOnce(&Path) -> Result<Option<u64>, String>,
    ) -> Result<LibraryDocumentSummary, String> {
        if let Some(options) = &capture_options {
            super::validation::validate_capture_options(options)?;
        }
        if source.byte_length == 0 || source.byte_length > max_source_bytes(&source.media_type) {
            return Err("Selected source exceeds the desktop library limit.".into());
        }
        // Room for the library copy, the runtime's ingestion copy on the same
        // volume, and a margin for everything else that writes there.
        let required = 2 * source.byte_length + IMPORT_FREE_SPACE_MARGIN;
        if free_space(&self.root)?.is_some_and(|free| free < required) {
            return Err(NOT_ENOUGH_DISK_SPACE.into());
        }
        let changed = || "Selected source changed during import.".to_string();
        if source.handle.metadata().map_err(|_| changed())?.len() != source.byte_length {
            return Err(changed());
        }
        source
            .handle
            .seek(SeekFrom::Start(0))
            .map_err(|_| changed())?;
        let mut prefix = vec![0; source.byte_length.min(512) as usize];
        source
            .handle
            .read_exact(&mut prefix)
            .map_err(|_| changed())?;
        let media_type = super::validation::verified_media_type(&source.file_name, &prefix)
            .map_err(|_| changed())?;
        if media_type != source.media_type {
            return Err(changed());
        }
        source
            .handle
            .seek(SeekFrom::Start(0))
            .map_err(|_| changed())?;
        // Refuse before staging; the index lock is not held while a large source
        // (up to 2 GiB) is copied, so reads stay responsive during the copy.
        drop(self.lock_index_for_write()?);
        let staging_dir = self.staging_directory();
        fs::create_dir_all(&staging_dir)
            .map_err(|_| "Capture library staging directory cannot be created.".to_string())?;
        let staging_path = staging_dir.join(random_id()?);
        Self::copy_to_staging(source.handle, &staging_path, source.byte_length)?;
        let index = self.lock_index_for_publish(&staging_path)?;
        self.publish_source(
            index,
            StagedSource {
                file_name: source.file_name,
                media_type: source.media_type,
                byte_length: source.byte_length,
                path: staging_path,
            },
            capture_options,
        )
    }

    pub(crate) fn update_capture(
        &self,
        update: LibraryCaptureUpdate,
    ) -> Result<LibraryDocumentSummary, String> {
        validate_document_id(&update.document_id)?;
        validate_status(&update.status)?;
        if let Some(options) = &update.capture_options {
            super::validation::validate_capture_options(options)?;
        }
        if update.clear_capture_id && update.capture_id.is_some() {
            return Err(
                "Capture library update cannot set and clear a runtime identifier together.".into(),
            );
        }
        let mut index = self.lock_index_for_write()?;
        let position = index
            .documents
            .iter()
            .position(|candidate| candidate.document_id == update.document_id)
            .ok_or_else(|| "Capture library document was not found.".to_string())?;
        let mut next_index = index.clone();
        let document = &mut next_index.documents[position];
        let directory = self.document_directory(&document.document_id)?;
        if let Some(evidence) = &update.ocr_evidence {
            evidence.validate()?;
            if evidence.status != update.status {
                return Err("OCR evidence status must match the terminal library update.".into());
            }
            if let Some(existing) = &document.ocr_evidence {
                if existing != evidence {
                    return Err(
                        "OCR evidence is write-once and conflicts with existing evidence.".into(),
                    );
                }
            } else {
                document.ocr_evidence = Some(evidence.clone());
            }
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
        document.recovery_code = update.recovery_code;
        document.recovery_message = update.recovery_message;
        if update.capture_options.is_some() {
            document.capture_options = update.capture_options.clone();
        }
        document.updated_at_ms = now_ms()?;
        let has_raw = update.raw.is_some() || directory.join(RAW_FILE_NAME).is_file();
        let summary = document.summary(has_raw);

        let transaction_id = random_id()?;
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
        let committed = commit_library_transaction(
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
        );
        if let Err(error) = committed {
            // Every commit exit is covered, including failed progress writes and
            // failed rollback. Keep reads available if disk recovery still fails.
            index.recovery_pending = true;
            let _ = self.recover_index(&mut index);
            return Err(error);
        }
        *index = next_index;
        // Even Committed journals block writes until cleanup succeeds: they cannot
        // roll back, but a later transaction must not overwrite their journal.
        if self
            .root
            .join(super::TRANSACTION_FILE_NAME)
            .try_exists()
            .unwrap_or(true)
        {
            index.recovery_pending = true;
            let _ = self.recover_index(&mut index);
        }
        Ok(summary)
    }

    pub(crate) fn list(
        &self,
        request: LibraryListRequest,
    ) -> Result<Vec<LibraryDocumentSummary>, String> {
        let query = request.query.unwrap_or_default().trim().to_lowercase();
        let status = request.status.unwrap_or_default().trim().to_lowercase();
        let documents = self.lock_index()?.documents.clone();
        let mut summaries = Vec::new();
        for document in documents.into_iter().filter(|document| {
            (query.is_empty() || document.file_name.to_lowercase().contains(&query))
                && (status.is_empty() || document.status == status)
        }) {
            let has_raw = self
                .document_directory(&document.document_id)?
                .join(RAW_FILE_NAME)
                .is_file();
            summaries.push(document.summary(has_raw));
        }
        Ok(summaries)
    }

    pub(crate) fn get(
        &self,
        request: LibraryDocumentRequest,
    ) -> Result<LibraryDocumentDetail, String> {
        let document = self.find_document(&request.document_id)?;
        let directory = self.document_directory(&document.document_id)?;
        let raw = read_json_optional(&directory.join(RAW_FILE_NAME))?;
        Ok(LibraryDocumentDetail {
            summary: document.summary(raw.is_some()),
            raw,
            result: read_json_optional(&directory.join(RESULT_FILE_NAME))?,
            ocr_evidence: document.ocr_evidence,
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
        const PLAYBACK_TOO_LARGE: &str = "This recording is too large to play in the app.";
        if document.byte_length > DOCUMENT_MAX_SOURCE_BYTES {
            return Err(PLAYBACK_TOO_LARGE.into());
        }
        let mut source = File::open(source_path)
            .map_err(|_| "Capture library source cannot be read.".to_string())?;
        let metadata = source
            .metadata()
            .map_err(|_| "Capture library source cannot be inspected.".to_string())?;
        if metadata.len() > DOCUMENT_MAX_SOURCE_BYTES {
            return Err(PLAYBACK_TOO_LARGE.into());
        }
        // Bound the read as well: a source can grow after its metadata was checked.
        let mut bytes = Vec::new();
        (&mut source)
            .take(DOCUMENT_MAX_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Capture library source cannot be read.".to_string())?;
        if bytes.len() as u64 > DOCUMENT_MAX_SOURCE_BYTES {
            return Err(PLAYBACK_TOO_LARGE.into());
        }
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
                let content = export_text(&result)
                    .ok_or_else(|| "Capture result has no exportable text.".to_string())?;
                Ok(LibraryExportPayload {
                    file_name: format!("{}.txt", stem(&document.file_name)),
                    media_type: "text/plain;charset=utf-8".into(),
                    content,
                })
            }
        }
    }

    /// The stored source file, for playing a speaker's sample in the window.
    pub(crate) fn source_bytes(&self, request: LibraryDocumentRequest) -> Result<Vec<u8>, String> {
        Ok(self.load_source(request)?.bytes)
    }

    pub(crate) fn delete(&self, request: LibraryDocumentRequest) -> Result<(), String> {
        validate_document_id(&request.document_id)?;
        let mut index = self.lock_index_for_write()?;
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

    fn recover_index(&self, index: &mut LibraryIndex) -> Result<(), String> {
        let recovery = recover_library_transaction(&self.root);
        if recovery.is_err() && pending_transaction_rolls_forward(&self.root) == Some(true) {
            // Durable replacements remain authoritative even if cleanup must retry.
            if let Ok((recovered, _)) = Self::read_index(&self.root) {
                *index = recovered;
            }
        }
        let recovered =
            recovery.and_then(|()| Self::read_index(&self.root).map(|(index, _)| index));
        match recovered {
            Ok(recovered) => {
                *index = recovered;
                Ok(())
            }
            Err(_) => {
                index.recovery_pending = true;
                Err("The document library needs recovery; restart Capture Workbench or free disk space and try again.".into())
            }
        }
    }

    /// Write lock for publishing a staged source; a refusal removes the staged copy.
    fn lock_index_for_publish(
        &self,
        staged: &Path,
    ) -> Result<std::sync::MutexGuard<'_, LibraryIndex>, String> {
        self.lock_index_for_write().inspect_err(|_| {
            let _ = fs::remove_file(staged);
        })
    }

    fn lock_index_for_write(&self) -> Result<std::sync::MutexGuard<'_, LibraryIndex>, String> {
        let mut index = self.lock_index()?;
        if index.recovery_pending
            || self
                .root
                .join(super::TRANSACTION_FILE_NAME)
                .try_exists()
                .unwrap_or(true)
        {
            index.recovery_pending = true;
            self.recover_index(&mut index)?;
        }
        Ok(index)
    }

    pub(super) fn document_directory(&self, document_id: &str) -> Result<PathBuf, String> {
        validate_document_id(document_id)?;
        Ok(self.root.join("items").join(document_id))
    }

    fn save_index(&self, index: &LibraryIndex) -> Result<(), String> {
        inject_transaction_failure("save-index")
            .map_err(|error| format!("Capture library index cannot be written: {error}"))?;
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

/// How long a staging entry must be untouched before startup treats it as
/// abandoned. An import in progress writes to its entry all the time and
/// publishes it right after the copy, so an entry this old has no owner.
pub(super) const STAGING_ABANDONED_AFTER: Duration = Duration::from_secs(60 * 60);

/// Finishes what a crash interrupted in `items/`: a publish that placed its
/// source but did not save the index, and a delete (`<id>` renamed to
/// `<id>.deleting` before the index is saved). Only a primary index proves
/// that an old item has no owner. Unknown entries and links are kept; failures
/// are retried at the next open.
/// Whether `items/` holds anything. An unreadable directory counts as non-empty, so
/// a doubtful case disables orphan cleanup rather than allowing it.
fn has_item_directories(items_dir: &Path) -> bool {
    match fs::read_dir(items_dir) {
        Ok(mut entries) => entries.next().is_some(),
        Err(error) => error.kind() != ErrorKind::NotFound,
    }
}

fn clean_orphan_item_directories(items_dir: &Path, index: &LibraryIndex, now: SystemTime) {
    let Ok(entries) = fs::read_dir(items_dir) else {
        return;
    };
    let indexed = |document_id: &str| {
        index.documents.iter().any(|document| {
            // Windows resolves hexadecimal directory names without case sensitivity.
            document.document_id == document_id
                || (cfg!(windows) && document.document_id.eq_ignore_ascii_case(document_id))
        })
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let (document_id, tombstone) = match name.strip_suffix(".deleting") {
            Some(document_id) => (document_id, true),
            None => (name, false),
        };
        if validate_document_id(document_id).is_err() {
            continue;
        }
        let listed = indexed(document_id);
        if !tombstone && listed {
            continue;
        }
        let path = entry.path();
        if !abandoned_directory(&path, now) {
            continue;
        }
        if tombstone && listed {
            // The delete stopped before its index was saved: the document is
            // still listed, so it gets its directory back.
            let restored = items_dir.join(document_id);
            if !restored.exists() {
                let _ = fs::rename(&path, restored);
            }
        } else {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// A real directory (not a link) untouched for longer than another running
/// instance of the application could still be working on it.
fn abandoned_directory(path: &Path, now: SystemTime) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT: junctions and other links are never followed.
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age > STAGING_ABANDONED_AFTER)
}

/// Removes what an interrupted import left behind. Only entries older than
/// `STAGING_ABANDONED_AFTER` go: another running instance of the application
/// shares this directory and may be importing right now. Best effort: an entry
/// that cannot be read or removed is tried again at the next start, and must
/// not keep the library from opening.
pub(super) fn clean_staging_directory(staging_dir: &Path, now: SystemTime) {
    if fs::create_dir_all(staging_dir).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(staging_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let abandoned = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STAGING_ABANDONED_AFTER);
        if !abandoned {
            continue;
        }
        let path = entry.path();
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "Capture library clock is invalid.".into())
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Text of a result. A transcript with speakers reads "name: what they said",
/// using the name a person gave the speaker when there is one.
fn export_text(result: &Value) -> Option<String> {
    let plain = || {
        result
            .get("targetText")
            .or_else(|| result.get("sourceText"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let speakers = match result.get("speakers").and_then(Value::as_array) {
        Some(speakers) if !speakers.is_empty() => speakers,
        _ => return plain(),
    };
    let (Some(blocks), Some(segments)) = (
        result.get("blocks").and_then(Value::as_array),
        result.get("rawSegments").and_then(Value::as_array),
    ) else {
        return plain();
    };
    let names: std::collections::HashMap<&str, &str> = speakers
        .iter()
        .filter_map(|speaker| {
            let id = text_of(speaker, "speakerId")?;
            let name = text_of(speaker, "displayName")
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            Some((id, name))
        })
        .collect();
    let speaker_of: std::collections::HashMap<&str, &str> = segments
        .iter()
        .filter_map(|segment| Some((text_of(segment, "segmentId")?, text_of(segment, "speaker")?)))
        .collect();
    let lines: Vec<String> = blocks
        .iter()
        .filter_map(|block| {
            let text = text_of(block, "targetText")?;
            let name = text_of(block, "sourceSegmentId")
                .and_then(|segment| speaker_of.get(segment))
                .and_then(|speaker| names.get(speaker));
            Some(match name {
                Some(name) => format!("{name}: {text}"),
                None => text.to_owned(),
            })
        })
        .collect();
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn old_item(items: &Path, id: &str) -> PathBuf {
        let path = items.join(id);
        fs::create_dir_all(&path).expect("item directory");
        fs::write(path.join(SOURCE_FILE_NAME), b"interrupted import").expect("source");
        path
    }

    fn after_abandonment(path: &Path) -> SystemTime {
        fs::metadata(path)
            .expect("metadata")
            .modified()
            .expect("modified time")
            + STAGING_ABANDONED_AFTER
            + Duration::from_secs(1)
    }

    #[test]
    fn orphan_cleanup_preserves_recent_indexed_and_unknown_entries() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let document = library
            .create_source(LibrarySourceInput {
                file_name: "kept.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"indexed source".to_vec(),
            })
            .expect("indexed source");
        let items = library.root.join("items");
        let orphan = old_item(&items, "11111111111111111111111111111111");
        let recent = old_item(&items, "22222222222222222222222222222222");
        let unknown = old_item(&items, "not-an-id");
        let stray = items.join("33333333333333333333333333333333");
        fs::write(&stray, b"stray file").expect("stray file");
        let index = library.lock_index().expect("index").clone();
        // At the exact age limit, an item is still retained.
        let recent_modified = fs::metadata(&recent).unwrap().modified().unwrap();
        clean_orphan_item_directories(&items, &index, recent_modified);
        assert!(recent.is_dir());
        clean_orphan_item_directories(
            &items,
            &index,
            fs::metadata(&orphan).unwrap().modified().unwrap() + STAGING_ABANDONED_AFTER,
        );
        assert!(orphan.is_dir());
        // Give the recent item a future timestamp without sleeping.
        let now = after_abandonment(&orphan);
        #[cfg(windows)]
        let recent_handle = {
            use std::os::windows::fs::OpenOptionsExt;
            File::options()
                .access_mode(0x100) // FILE_WRITE_ATTRIBUTES
                .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS
                .open(&recent)
                .expect("directory handle")
        };
        #[cfg(not(windows))]
        let recent_handle = File::open(&recent).expect("directory handle");
        recent_handle.set_modified(now).expect("recent timestamp");
        clean_orphan_item_directories(&items, &index, now);
        assert!(!orphan.exists());
        assert!(recent.is_dir());
        assert!(items.join(document.document_id).is_dir());
        assert!(unknown.is_dir());
        assert!(stray.is_file());
    }

    #[test]
    fn open_preserves_items_without_a_primary_index() {
        for backup in [false, true] {
            let directory = tempfile::tempdir().expect("app data");
            let root = directory.path().join("library");
            let orphan = old_item(&root.join("items"), "11111111111111111111111111111111");
            if backup {
                fs::write(root.join(INDEX_FILE_NAME), b"invalid index").expect("primary");
                fs::write(
                    root.join(INDEX_BACKUP_FILE_NAME),
                    serde_json::to_vec(&LibraryIndex {
                        version: INDEX_VERSION,
                        documents: Vec::new(),
                        ..Default::default()
                    })
                    .unwrap(),
                )
                .expect("backup");
            }
            LibraryStore::open_at(directory.path(), after_abandonment(&orphan))
                .expect("open conservatively");
            assert!(orphan.join(SOURCE_FILE_NAME).is_file());
        }
    }

    #[test]
    fn a_backup_recovery_disables_orphan_cleanup_for_good() {
        let directory = tempfile::tempdir().expect("app data");
        let root = directory.path().join("library");
        // B was published but the recovery copy predates it.
        let omitted = old_item(&root.join("items"), "22222222222222222222222222222222");
        fs::write(root.join(INDEX_FILE_NAME), b"invalid index").expect("primary");
        fs::write(
            root.join(INDEX_BACKUP_FILE_NAME),
            serde_json::to_vec(&LibraryIndex {
                version: INDEX_VERSION,
                documents: Vec::new(),
                ..Default::default()
            })
            .unwrap(),
        )
        .expect("backup");
        let now = after_abandonment(&omitted);
        let recovered = LibraryStore::open_at(directory.path(), now).expect("open from backup");
        // A write saves the incomplete index as the primary file.
        recovered
            .create_source(LibrarySourceInput {
                file_name: "new.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"new source".to_vec(),
            })
            .expect("import after recovery");
        drop(recovered);
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(INDEX_FILE_NAME)).unwrap()).unwrap();
        assert_eq!(saved["orphanCleanupDisabled"], true);
        let reopened = LibraryStore::open_at(directory.path(), now).expect("reopen");
        assert!(omitted.join(SOURCE_FILE_NAME).is_file());
        assert_eq!(
            reopened.list(LibraryListRequest::default()).unwrap().len(),
            1
        );
    }

    #[test]
    fn a_normal_library_keeps_its_index_format() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        library
            .create_source(LibrarySourceInput {
                file_name: "kept.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"indexed source".to_vec(),
            })
            .expect("indexed source");
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(library.root.join(INDEX_FILE_NAME)).unwrap()).unwrap();
        assert!(saved.get("orphanCleanupDisabled").is_none());
    }

    #[test]
    fn open_cleans_an_interrupted_publish_and_keeps_indexed_sources_readable() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let document = library
            .create_source(LibrarySourceInput {
                file_name: "kept.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"indexed source".to_vec(),
            })
            .expect("indexed source");
        let orphan = old_item(
            &library.root.join("items"),
            "11111111111111111111111111111111",
        );
        let now = after_abandonment(&orphan);
        // Lookups cannot perform cleanup, even for an unindexed source.
        assert!(library
            .find_document("11111111111111111111111111111111")
            .is_err());
        assert!(orphan.is_dir());
        drop(library);
        let reopened = LibraryStore::open_at(directory.path(), now).expect("reopen");
        assert!(!orphan.exists());
        let request = LibraryDocumentRequest {
            document_id: document.document_id,
        };
        assert_eq!(
            reopened.get(request.clone()).unwrap().summary.file_name,
            "kept.pdf"
        );
        assert_eq!(
            reopened.load_source(request).unwrap().bytes,
            b"indexed source"
        );
    }

    #[test]
    fn open_finishes_an_interrupted_delete_either_way() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let listed = library
            .create_source(LibrarySourceInput {
                file_name: "listed.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"still listed".to_vec(),
            })
            .expect("listed source");
        let items = library.root.join("items");
        // The crash came before the index was saved: the document is still listed.
        let listed_directory = items.join(&listed.document_id);
        let listed_tombstone = listed_directory.with_extension("deleting");
        fs::rename(&listed_directory, &listed_tombstone).expect("tombstone");
        // The crash came after the index was saved: nothing lists it any more.
        let removed_tombstone = old_item(&items, "11111111111111111111111111111111.deleting");
        drop(library);

        // A recent tombstone may belong to a delete that is still running.
        LibraryStore::open(directory.path()).expect("reopen");
        assert!(listed_tombstone.is_dir() && removed_tombstone.is_dir());

        let now = after_abandonment(&listed_tombstone).max(after_abandonment(&removed_tombstone));
        let reopened = LibraryStore::open_at(directory.path(), now).expect("reopen later");
        assert!(!listed_tombstone.exists() && !removed_tombstone.exists());
        assert_eq!(
            reopened
                .load_source(LibraryDocumentRequest {
                    document_id: listed.document_id,
                })
                .unwrap()
                .bytes,
            b"still listed"
        );
    }

    fn spoken(speakers: serde_json::Value) -> serde_json::Value {
        json!({
            "targetText": "Good morning\nHello there\nmm",
            "speakers": speakers,
            "rawSegments": [
                {"segmentId": "segment-1", "speaker": "SPEAKER_00"},
                {"segmentId": "segment-2", "speaker": "SPEAKER_01"},
                {"segmentId": "segment-3", "speaker": null}
            ],
            "blocks": [
                {"sourceSegmentId": "segment-1", "targetText": "Good morning"},
                {"sourceSegmentId": "segment-2", "targetText": "Hello there"},
                {"sourceSegmentId": "segment-3", "targetText": "mm"}
            ]
        })
    }

    #[test]
    fn transcript_lines_carry_the_given_name_or_the_anonymous_label() {
        let result = spoken(json!([
            {"speakerId": "SPEAKER_00", "displayName": " Ms. Lin "},
            {"speakerId": "SPEAKER_01", "displayName": null}
        ]));
        assert_eq!(
            export_text(&result).as_deref(),
            Some("Ms. Lin: Good morning\nSPEAKER_01: Hello there\nmm")
        );
    }

    #[test]
    fn a_result_without_speakers_exports_its_plain_text() {
        assert_eq!(
            export_text(&spoken(json!([]))).as_deref(),
            Some("Good morning\nHello there\nmm")
        );
        assert_eq!(
            export_text(&json!({"sourceText": "page one"})).as_deref(),
            Some("page one")
        );
        assert_eq!(export_text(&json!({})), None);
    }
}

#[cfg(windows)]
fn available_space(directory: &Path) -> Result<Option<u64>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let path: Vec<u16> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0;
    // The library already exists; Windows resolves its containing volume.
    let success = unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        return Err("Free disk space cannot be checked.".into());
    }
    Ok(Some(free))
}

#[cfg(not(windows))]
fn available_space(_directory: &Path) -> Result<Option<u64>, String> {
    Ok(None)
}
