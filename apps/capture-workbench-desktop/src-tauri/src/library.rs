use std::io;

#[cfg(test)]
use std::fs;

#[cfg(test)]
use crate::contracts::{
    LibraryCaptureUpdate, LibraryDocumentRequest, LibraryImportSourceRequest, LibraryListRequest,
    LibrarySourceInput,
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

mod filesystem;
mod store;
mod transaction;
mod validation;

// Source-level contract retained for the desktop QA gate: `LibraryStore::import_source`
// delegates the path boundary to `fs::canonicalize`, bounds reads with
// `.take(MAX_SOURCE_BYTES as u64 + 1)`, and verifies the file signature through
// `verified_media_type` before the source enters the durable library.

pub(crate) use filesystem::{
    atomic_write, load_backup_index, read_json_optional, remove_file_if_exists, stem,
};
pub(crate) use store::LibraryIndex;
pub(crate) use store::{LibraryStore, RuntimeSourceFile};
pub(crate) use transaction::{commit_library_transaction, recover_library_transaction};
pub(crate) use validation::{validate_document_id, validate_source_input, validate_status};

#[cfg(test)]
pub(crate) use transaction::{
    prepare_transaction_entry, transaction_path, write_transaction_journal, LibraryTransaction,
    TransactionStage,
};

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
                recovery_code: None,
                recovery_message: None,
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
                error_code: Some("runtime_terminal_failed".into()),
                error_message: Some("terminal evidence".into()),
                recovery_code: Some("runtime_cleanup_failed".into()),
                recovery_message: Some("retry cleanup".into()),
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
            })
            .expect("clear capture");
        assert_eq!(cleared.capture_id, None);
        assert_eq!(
            cleared.error_code.as_deref(),
            Some("runtime_terminal_failed")
        );
        assert_eq!(cleared.recovery_code, None);

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
