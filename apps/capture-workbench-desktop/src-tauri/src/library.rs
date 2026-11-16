use std::io;

#[cfg(test)]
use std::fs;

#[cfg(test)]
use crate::contracts::{
    LibraryCaptureOptions, LibraryCaptureUpdate, LibraryDocumentRequest, LibraryDocumentSummary,
    LibraryImportSourceRequest, LibraryListRequest, OcrEvidenceV1,
};

const INDEX_FILE_NAME: &str = "library-index-v1.json";
const INDEX_BACKUP_FILE_NAME: &str = "library-index-v1.backup.json";
const TRANSACTION_FILE_NAME: &str = "library-transaction-v1.json";
const INDEX_VERSION: u8 = 1;
/// PDF and image sources; also the largest source the app loads for playback.
pub(crate) const DOCUMENT_MAX_SOURCE_BYTES: u64 = 50 * 1024 * 1024;
/// Recordings: audio, and video whose audio track is transcribed (issue #155).
pub(crate) const RECORDING_MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const IMPORT_FREE_SPACE_MARGIN: u64 = 512 * 1024 * 1024;
pub(crate) const NOT_ENOUGH_DISK_SPACE: &str = "Not enough free disk space to import this file.";
const SOURCE_FILE_NAME: &str = "source.bin";
const RAW_FILE_NAME: &str = "raw.json";
const EDITS_FILE_NAME: &str = "edits.json";
const RESULT_FILE_NAME: &str = "result.json";

pub(crate) fn max_source_bytes(media_type: &str) -> u64 {
    if validation::RECORDING_MEDIA_TYPES.contains(&media_type) {
        RECORDING_MAX_SOURCE_BYTES
    } else {
        DOCUMENT_MAX_SOURCE_BYTES
    }
}

#[cfg(test)]
thread_local! {
    static TRANSACTION_FAILURE_POINT: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_transaction_failure(point: &str) -> io::Result<()> {
    TRANSACTION_FAILURE_POINT.with(|configured| {
        // Comma-separated failures allow a one-shot commit fault followed by a
        // persistent recovery fault (a trailing `*`), scoped to this test thread.
        let mut configured = configured.borrow_mut();
        let points: Vec<_> = configured.as_deref().unwrap_or("").split(',').collect();
        let should_fail = points
            .iter()
            .any(|candidate| candidate.trim_end_matches('*') == point);
        if should_fail {
            *configured = Some(
                points
                    .into_iter()
                    .filter(|candidate| *candidate != point)
                    .collect::<Vec<_>>()
                    .join(","),
            );
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

mod export;
mod filesystem;
mod store;
mod transaction;
pub(crate) mod validation;

pub(crate) use filesystem::{
    atomic_write, load_backup_index, read_json_optional, remove_file_if_exists, stem,
};
pub(crate) use store::LibraryIndex;
pub(crate) use store::{LibraryStore, RuntimeSourceFile};
pub(crate) use transaction::{commit_library_transaction, recover_library_transaction};
pub(crate) use validation::{
    validate_document_id, validate_spoken_language, validate_status, RECORDING_MEDIA_TYPES,
};

#[cfg(test)]
use store::LibrarySourceInput;

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

    fn page_edit(text: &str) -> crate::contracts::LibraryEditMaps {
        crate::contracts::LibraryEditMaps {
            ocr_pages: [("3".into(), text.into())].into(),
            ..Default::default()
        }
    }

    #[test]
    fn edits_round_trip_restore_and_failed_replace_preserve_recognition_and_index() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        assert!(library
            .save_edits(&id, page_edit("edit"))
            .unwrap_err()
            .contains("raw"));
        assert!(library
            .save_edits(&"f".repeat(32), page_edit("edit"))
            .is_err());
        library
            .update_capture(completed_update(&id, "recognized"))
            .unwrap();
        let item = library.root.join("items").join(&id);
        let index_before = fs::read(library.root.join(INDEX_FILE_NAME)).unwrap();
        fs::write(item.join("edits.tmp"), b"crashed write").unwrap();
        let mut maps = page_edit("edited");
        maps.transcript_lines
            .insert("segment".into(), "line edit".into());
        maps.speaker_names.insert("speaker".into(), " Name ".into());
        let saved = library.save_edits(&id, maps).unwrap();
        assert_eq!(saved.speaker_names["speaker"], "Name");
        assert!(saved.updated_at_ms > 0);
        assert!(!item.join("edits.tmp").exists());
        assert_eq!(
            fs::read(library.root.join(INDEX_FILE_NAME)).unwrap(),
            index_before
        );
        let request = || LibraryDocumentRequest {
            document_id: id.clone(),
        };
        assert_eq!(library.get(request()).unwrap().edits, Some(saved.clone()));
        let previous = fs::read(item.join(EDITS_FILE_NAME)).unwrap();
        let mut invalid = page_edit("private edit text");
        invalid
            .ocr_pages
            .insert("01".into(), "private edit text".into());
        assert_eq!(
            library.save_edits(&id, invalid).unwrap_err(),
            "edits ocrPages is out of bounds."
        );
        assert_eq!(fs::read(item.join(EDITS_FILE_NAME)).unwrap(), previous);
        {
            let _guard = TransactionFailureGuard::at("atomic-rename");
            assert_eq!(
                library.save_edits(&id, page_edit("new")).unwrap_err(),
                "edits could not be saved."
            );
        }
        assert_eq!(fs::read(item.join(EDITS_FILE_NAME)).unwrap(), previous);
        assert_eq!(
            library.get(request()).unwrap().raw.unwrap()["sourceText"],
            "recognized"
        );
        library
            .save_edits(&id, page_edit("next save overwrites leftover"))
            .unwrap();
        assert!(!item.join("edits.tmp").exists());
        assert!(library
            .save_edits(&id, Default::default())
            .unwrap()
            .is_empty());
        assert!(!item.join(EDITS_FILE_NAME).exists());
        assert!(library.get(request()).unwrap().edits.is_none());
    }

    #[test]
    fn unreadable_edits_leave_document_readable_and_file_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        library
            .update_capture(completed_update(&id, "recognized"))
            .unwrap();
        let path = library.root.join("items").join(&id).join(EDITS_FILE_NAME);
        for bytes in [
            b"{broken".to_vec(),
            serde_json::to_vec(&crate::contracts::LibraryEdits::new(
                crate::contracts::LibraryEditMaps {
                    ocr_pages: [("01".into(), "private".into())].into(),
                    ..Default::default()
                },
                1,
            ))
            .unwrap(),
            vec![b' '; crate::contracts::MAX_EDITS_BYTES + 1],
        ] {
            fs::write(&path, &bytes).unwrap();
            let detail = library
                .get(LibraryDocumentRequest {
                    document_id: id.clone(),
                })
                .unwrap();
            assert!(detail.edits_unreadable);
            assert!(detail.edits.is_none());
            assert_eq!(detail.raw.unwrap()["sourceText"], "recognized");
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }

        // An unreadable file does not leave the document uneditable: the next
        // save replaces it, and saving empty edits removes it.
        let saved = library
            .save_edits(
                &id,
                crate::contracts::LibraryEditMaps {
                    ocr_pages: [("1".into(), "edited".into())].into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let detail = library
            .get(LibraryDocumentRequest {
                document_id: id.clone(),
            })
            .unwrap();
        assert!(!detail.edits_unreadable);
        assert_eq!(detail.edits, Some(saved));
        fs::write(&path, b"{broken").unwrap();
        library
            .save_edits(&id, crate::contracts::LibraryEditMaps::default())
            .unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn edits_survive_backup_index_restore_and_are_deleted_with_item() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        library
            .update_capture(completed_update(&id, "recognized"))
            .unwrap();
        let edits = library.save_edits(&id, page_edit("edited")).unwrap();
        fs::copy(
            library.root.join(INDEX_FILE_NAME),
            library.root.join(INDEX_BACKUP_FILE_NAME),
        )
        .unwrap();
        fs::write(library.root.join(INDEX_FILE_NAME), b"broken").unwrap();
        drop(library);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(
            reopened
                .get(LibraryDocumentRequest {
                    document_id: id.clone()
                })
                .unwrap()
                .edits,
            Some(edits)
        );
        reopened
            .delete(LibraryDocumentRequest {
                document_id: id.clone(),
            })
            .unwrap();
        assert!(!reopened.root.join("items").join(id).exists());
    }

    #[test]
    fn repeated_raw_preserves_edits_even_when_json_formatting_differs() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        let raw =
            serde_json::json!({ "sourceText": "recognized", "metadata": { "language": "zh" } });
        let update = || LibraryCaptureUpdate {
            raw: Some(raw.clone()),
            ..completed_update(&id, "recognized")
        };
        library.update_capture(update()).unwrap();
        let saved = library.save_edits(&id, page_edit("edited")).unwrap();
        let item = library.root.join("items").join(&id);
        let edits_before = fs::read(item.join(EDITS_FILE_NAME)).unwrap();
        for reformat_raw in [false, true] {
            if reformat_raw {
                fs::write(
                    item.join(RAW_FILE_NAME),
                    br#"{ "sourceText":"recognized", "metadata": {"language":"zh"} }"#,
                )
                .unwrap();
            }
            library.update_capture(update()).unwrap();
            assert_eq!(fs::read(item.join(EDITS_FILE_NAME)).unwrap(), edits_before);
            assert_eq!(
                library
                    .get(LibraryDocumentRequest {
                        document_id: id.clone()
                    })
                    .unwrap()
                    .edits,
                Some(saved.clone())
            );
        }
    }

    #[test]
    fn replacing_unreadable_raw_clears_edits() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        library
            .update_capture(completed_update(&id, "recognized"))
            .unwrap();
        library.save_edits(&id, page_edit("edited")).unwrap();
        let item = library.root.join("items").join(&id);
        fs::write(item.join(RAW_FILE_NAME), b"{broken").unwrap();
        library
            .update_capture(completed_update(&id, "recognized"))
            .unwrap();
        assert!(!item.join(EDITS_FILE_NAME).exists());
        assert!(library
            .get(LibraryDocumentRequest { document_id: id })
            .unwrap()
            .edits
            .is_none());
    }

    #[test]
    fn saving_edits_requires_a_raw_file_without_parsing_it() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        let item = library.root.join("items").join(&id);
        let raw_path = item.join(RAW_FILE_NAME);
        assert_eq!(
            library.save_edits(&id, page_edit("edited")).unwrap_err(),
            "edits require a raw result."
        );
        fs::create_dir(&raw_path).unwrap();
        assert_eq!(
            library.save_edits(&id, page_edit("edited")).unwrap_err(),
            "edits require a raw result."
        );
        fs::remove_dir(&raw_path).unwrap();
        fs::write(&raw_path, b"{broken").unwrap();
        let saved = library.save_edits(&id, page_edit("edited")).unwrap();
        let stored: crate::contracts::LibraryEdits =
            serde_json::from_slice(&fs::read(item.join(EDITS_FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored, saved);
        assert_eq!(fs::read(raw_path).unwrap(), b"{broken");
    }

    #[test]
    fn rerun_edits_tombstone_rolls_back_or_forward_with_raw() {
        for fault in [
            "rename-1-target",
            "progress-journal-0",
            "progress-journal-0,rollback*",
            "progress-journal-3",
            "cleanup-journal*",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let library = LibraryStore::open(directory.path()).unwrap();
            let id = recovery_source(&library).document_id;
            library
                .update_capture(completed_update(&id, "old"))
                .unwrap();
            library.save_edits(&id, page_edit("old edit")).unwrap();
            let guard = TransactionFailureGuard::at(fault);
            let _ = library.update_capture(completed_update(&id, "new"));
            // Every mutation, including edits, must refuse a journal whose cleanup still fails.
            if fault == "cleanup-journal*" {
                assert!(library.save_edits(&id, page_edit("blocked")).is_err());
            }
            drop(guard);
            drop(library);
            let reopened = LibraryStore::open(directory.path()).unwrap();
            let detail = reopened
                .get(LibraryDocumentRequest {
                    document_id: id.clone(),
                })
                .unwrap();
            if detail.raw.unwrap()["sourceText"] == "new" {
                assert!(detail.edits.is_none());
            } else {
                assert_eq!(detail.edits.unwrap().ocr_pages["3"], "old edit");
            }
            // Saving recovers any pending transaction before touching edits.
            reopened.save_edits(&id, page_edit("current edit")).unwrap();
        }
    }

    #[test]
    fn saving_edits_recovers_an_unfinished_rerun_before_writing() {
        let directory = tempfile::tempdir().unwrap();
        let library = LibraryStore::open(directory.path()).unwrap();
        let id = recovery_source(&library).document_id;
        library
            .update_capture(completed_update(&id, "old"))
            .unwrap();
        library.save_edits(&id, page_edit("old edit")).unwrap();
        let guard = TransactionFailureGuard::at("progress-journal-1,rollback*");
        assert!(library
            .update_capture(completed_update(&id, "new"))
            .is_err());
        assert!(library.save_edits(&id, page_edit("blocked")).is_err());
        drop(guard);
        library
            .save_edits(&id, page_edit("after recovery"))
            .unwrap();
        let detail = library
            .get(LibraryDocumentRequest { document_id: id })
            .unwrap();
        assert_eq!(detail.raw.unwrap()["sourceText"], "old");
        assert_eq!(detail.edits.unwrap().ocr_pages["3"], "after recovery");
        assert!(!library.root.join(TRANSACTION_FILE_NAME).exists());
    }

    #[test]
    fn recording_import_and_playback_have_separate_limits() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let path = directory.path().join("recording.mp3");
        fs::write(&path, b"ID3recording").expect("recording");
        OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("source")
            .set_len(DOCUMENT_MAX_SOURCE_BYTES + 1)
            .expect("sparse length");
        let source = crate::source_selection::inspect::inspect_source(
            &path,
            crate::contracts::SourceSelectionKind::All,
        )
        .expect("recording above document limit");
        let imported = library
            .import_opened_with_free_space(source, None, |_| Ok(Some(u64::MAX)))
            .expect("large recording import");
        assert_eq!(imported.byte_length, DOCUMENT_MAX_SOURCE_BYTES + 1);
        let request = LibraryDocumentRequest {
            document_id: imported.document_id.clone(),
        };
        let started = std::time::Instant::now();
        assert_eq!(
            library.source_bytes(request.clone()).unwrap_err(),
            "This recording is too large to play in the app."
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        // A stale small index entry must not bypass the file metadata guard.
        library.lock_index().unwrap().documents[0].byte_length = 12;
        let stored = library
            .document_directory(&imported.document_id)
            .unwrap()
            .join(SOURCE_FILE_NAME);
        OpenOptions::new()
            .write(true)
            .open(&stored)
            .unwrap()
            .set_len(RECORDING_MAX_SOURCE_BYTES)
            .unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            library.source_bytes(request.clone()).unwrap_err(),
            "This recording is too large to play in the app."
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        fs::write(&stored, b"ID3recording").unwrap();
        assert_eq!(library.source_bytes(request).unwrap(), b"ID3recording");
    }

    #[test]
    fn disk_budget_is_checked_before_staging_or_publication() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let path = directory.path().join("recording.mp3");
        fs::write(&path, b"ID3recording").unwrap();
        let inspect = || {
            crate::source_selection::inspect::inspect_source(
                &path,
                crate::contracts::SourceSelectionKind::All,
            )
            .unwrap()
        };
        let size = inspect().byte_length;
        let required = 2 * size + 512 * 1024 * 1024;
        let error = library
            .import_opened_with_free_space(inspect(), None, |volume| {
                assert_eq!(volume, library.root);
                Ok(Some(required - 1))
            })
            .unwrap_err();
        assert_eq!(error, "Not enough free disk space to import this file.");
        assert_eq!(
            fs::read_dir(library.staging_directory()).unwrap().count(),
            0
        );
        assert_eq!(fs::read_dir(library.root.join("items")).unwrap().count(), 0);
        assert!(library
            .list(LibraryListRequest::default())
            .unwrap()
            .is_empty());
        let imported = library
            .import_opened_with_free_space(inspect(), None, |_| Ok(Some(required)))
            .unwrap();
        assert_eq!(imported.byte_length, size);
        assert_eq!(
            fs::read_dir(library.staging_directory()).unwrap().count(),
            0
        );
        assert_eq!(fs::read_dir(library.root.join("items")).unwrap().count(), 1);
    }

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
            ocr_evidence: None,
            capture_options: None,
        }
    }

    /// Builds evidence from JSON and seals it with the digest the host itself
    /// computes. A fixture therefore never carries a hand-computed digest, and
    /// any of its fields can change without recomputing one. The frozen,
    /// cross-language sample is `test-fixtures/ocr-evidence-v1-golden.json`.
    fn sealed_evidence(mut value: serde_json::Value) -> OcrEvidenceV1 {
        value["digest"] = serde_json::json!("0".repeat(64));
        let mut evidence: OcrEvidenceV1 =
            serde_json::from_value(value).expect("evidence fixture json");
        evidence.digest = evidence.content_digest().expect("evidence fixture digest");
        evidence
    }

    fn completed_evidence() -> OcrEvidenceV1 {
        sealed_evidence(serde_json::json!({
            "schemaVersion": 1,
            "captureId": "capture-1",
            "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "status": "completed",
            "pageCount": 1,
            "pages": [{
                "page": 1,
                "status": "recognized",
                "raster": { "width": 1200, "height": 800 },
                "normalizedCharCount": 5,
                "boxCount": 0,
                "confidence": 0.0,
                "confidenceSummary": {
                    "scoreState": "none",
                    "numericCount": 0,
                    "min": null,
                    "max": null,
                    "mean": null
                }
            }],
            "summary": {
                "normalizedCharCount": 5,
                "boxCount": 0,
                "confidenceSummary": {
                    "scoreState": "none",
                    "numericCount": 0,
                    "min": null,
                    "max": null,
                    "mean": null
                }
            },
            "provenance": {
                "status": "resolved",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "contractSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "engine": "windowsml-ocr",
                "model": "pp-ocrv6-medium-windowsml",
                "modelDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "device": "GPU",
                "profileId": "profile-1",
                "profileSpecSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "workerSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            }
        }))
    }

    fn failed_zero_page_evidence() -> OcrEvidenceV1 {
        sealed_evidence(serde_json::json!({
            "schemaVersion": 1,
            "captureId": "capture-failed",
            "sourceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "status": "failed",
            "pageCount": 0,
            "pages": [],
            "summary": {
                "normalizedCharCount": 0,
                "boxCount": 0,
                "confidenceSummary": {
                    "scoreState": "none",
                    "numericCount": 0,
                    "min": null,
                    "max": null,
                    "mean": null
                }
            },
            "provenance": {
                "status": "unavailable",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "contractSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "profileId": "profile-1",
                "profileSpecSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "workerSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            },
            "failure": { "code": "ocr_worker_failed", "message": "OCR failure: ocr_worker_failed." }
        }))
    }

    fn evidence_update(
        document_id: &str,
        status: &str,
        evidence: Option<OcrEvidenceV1>,
    ) -> LibraryCaptureUpdate {
        LibraryCaptureUpdate {
            document_id: document_id.into(),
            capture_id: None,
            clear_capture_id: false,
            status: status.into(),
            stage: Some(status.into()),
            raw: None,
            result: None,
            error_code: None,
            error_message: None,
            recovery_code: None,
            recovery_message: None,
            ocr_evidence: evidence,
            capture_options: None,
        }
    }

    fn update_value(evidence: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "documentId": "document-1",
            "captureId": null,
            "clearCaptureId": false,
            "status": "completed",
            "stage": "completed",
            "raw": null,
            "result": null,
            "errorCode": null,
            "errorMessage": null,
            "recoveryCode": null,
            "recoveryMessage": null,
            "ocrEvidence": evidence
        })
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
                ocr_evidence: None,
                capture_options: None,
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
    fn legacy_index_without_ocr_evidence_reopens_with_none() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "legacy.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        let index_path = directory.path().join("library").join(INDEX_FILE_NAME);
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_path).expect("index")).expect("json");
        index["documents"][0]
            .as_object_mut()
            .expect("document object")
            .remove("ocrEvidence");
        fs::write(
            &index_path,
            serde_json::to_vec_pretty(&index).expect("legacy index"),
        )
        .expect("legacy index write");
        drop(library);

        let reopened = LibraryStore::open(directory.path()).expect("reopened library");
        let detail = reopened
            .get(LibraryDocumentRequest {
                document_id: created.document_id,
            })
            .expect("detail");
        assert_eq!(detail.ocr_evidence, None);
    }

    #[test]
    fn completed_and_failed_ocr_evidence_roundtrip_across_restart() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let completed = library
            .create_source(LibrarySourceInput {
                file_name: "completed.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("completed source");
        let completed_evidence = completed_evidence();
        library
            .update_capture(evidence_update(
                &completed.document_id,
                "completed",
                Some(completed_evidence.clone()),
            ))
            .expect("completed evidence update");

        let failed = library
            .create_source(LibrarySourceInput {
                file_name: "failed.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("failed source");
        let failed_evidence = failed_zero_page_evidence();
        library
            .update_capture(evidence_update(
                &failed.document_id,
                "failed",
                Some(failed_evidence.clone()),
            ))
            .expect("failed evidence update");
        drop(library);

        let reopened = LibraryStore::open(directory.path()).expect("reopened library");
        assert_eq!(
            reopened
                .get(LibraryDocumentRequest {
                    document_id: completed.document_id,
                })
                .expect("completed detail")
                .ocr_evidence,
            Some(completed_evidence)
        );
        assert_eq!(
            reopened
                .get(LibraryDocumentRequest {
                    document_id: failed.document_id,
                })
                .expect("failed detail")
                .ocr_evidence,
            Some(failed_evidence)
        );
    }

    #[test]
    fn omitted_follow_up_update_retains_ocr_evidence() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "retained.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        let evidence = completed_evidence();
        library
            .update_capture(evidence_update(
                &created.document_id,
                "completed",
                Some(evidence.clone()),
            ))
            .expect("evidence update");
        library
            .update_capture(evidence_update(&created.document_id, "processing", None))
            .expect("omitted evidence update");

        assert_eq!(
            library
                .get(LibraryDocumentRequest {
                    document_id: created.document_id,
                })
                .expect("detail")
                .ocr_evidence,
            Some(evidence)
        );
    }

    #[test]
    fn different_second_ocr_evidence_fails_closed() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let created = library
            .create_source(LibrarySourceInput {
                file_name: "conflict.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        library
            .update_capture(evidence_update(
                &created.document_id,
                "completed",
                Some(completed_evidence()),
            ))
            .expect("first evidence update");
        let mut second: serde_json::Value =
            serde_json::to_value(completed_evidence()).expect("evidence json");
        second["captureId"] = serde_json::json!("capture-2");
        let second = sealed_evidence(second);
        let error = library
            .update_capture(evidence_update(
                &created.document_id,
                "completed",
                Some(second),
            ))
            .expect_err("evidence conflict");
        assert!(error.contains("OCR evidence"));
        assert_eq!(
            library
                .get(LibraryDocumentRequest {
                    document_id: created.document_id,
                })
                .expect("detail")
                .ocr_evidence
                .expect("evidence")
                .capture_id,
            "capture-1"
        );
    }

    #[test]
    fn numeric_confidence_summary_is_accepted() {
        let mut value = serde_json::to_value(completed_evidence()).expect("evidence json");
        value["captureId"] = serde_json::json!("capture-numeric");
        value["pages"][0]["boxCount"] = serde_json::json!(1);
        value["pages"][0]["confidence"] = serde_json::json!(0.9);
        value["pages"][0]["confidenceSummary"] = serde_json::json!({
            "scoreState": "numeric",
            "numericCount": 1,
            "min": 0.9,
            "max": 0.9,
            "mean": 0.9
        });
        value["summary"]["boxCount"] = serde_json::json!(1);
        value["summary"]["confidenceSummary"] = value["pages"][0]["confidenceSummary"].clone();
        let evidence = sealed_evidence(value);
        evidence.validate().expect("numeric evidence is valid");
    }

    #[test]
    fn evidence_changed_after_its_digest_was_recorded_is_rejected() {
        // The frozen sample carries a digest recorded by the TypeScript builder,
        // so this does not depend on the host's own digest function.
        let mut recorded: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test-fixtures/ocr-evidence-v1-golden.json"
        ))
        .expect("TS builder golden evidence");
        recorded["captureId"] = serde_json::json!("capture-changed");
        let recorded: OcrEvidenceV1 = serde_json::from_value(recorded).expect("changed evidence");
        assert_eq!(
            recorded.validate().expect_err("changed evidence"),
            "OCR evidence digest does not match its content."
        );

        let mut sealed = completed_evidence();
        sealed.capture_id = "capture-changed".into();
        assert_eq!(
            sealed.validate().expect_err("changed sealed evidence"),
            "OCR evidence digest does not match its content."
        );
    }

    #[test]
    fn ts_builder_golden_evidence_is_native_validated() {
        let evidence: OcrEvidenceV1 = serde_json::from_str(include_str!(
            "../../../../test-fixtures/ocr-evidence-v1-golden.json"
        ))
        .expect("TS builder golden evidence");
        evidence
            .validate()
            .expect("TS builder golden evidence is valid");
        assert_eq!(evidence.capture_id, "capture-中文-😀");
        assert_eq!(evidence.page_count, 4);
        assert_eq!(evidence.pages[0].confidence, Some(0.0));
        assert_eq!(evidence.pages[1].confidence, Some(1.0));
        assert_eq!(evidence.pages[2].confidence, Some(0.9));
        assert_eq!(evidence.pages[3].confidence, Some(0.0001));
    }

    #[test]
    fn non_canonical_confidence_values_are_rejected_by_native_mirror() {
        for value in [
            serde_json::json!(-0.0),
            serde_json::json!(0.00001),
            serde_json::json!(1e-7),
        ] {
            let mut evidence = serde_json::to_value(completed_evidence()).expect("evidence json");
            evidence["pages"][0]["confidence"] = value;
            let evidence: OcrEvidenceV1 = serde_json::from_value(evidence).expect("typed evidence");
            assert!(
                evidence.validate().is_err(),
                "non-canonical value was accepted"
            );
        }
    }

    #[test]
    fn non_canonical_confidence_summary_values_are_rejected_by_native_mirror() {
        for value in [
            serde_json::json!(-0.0),
            serde_json::json!(0.00001),
            serde_json::json!(1e-7),
        ] {
            let mut evidence = serde_json::to_value(completed_evidence()).expect("evidence json");
            let summary = serde_json::json!({
                "scoreState": "numeric",
                "numericCount": 1,
                "min": value,
                "max": value,
                "mean": value
            });
            evidence["pages"][0]["boxCount"] = serde_json::json!(1);
            evidence["pages"][0]["confidenceSummary"] = summary.clone();
            evidence["pages"][0]["confidence"] = serde_json::json!(0.9);
            evidence["summary"]["boxCount"] = serde_json::json!(1);
            evidence["summary"]["confidenceSummary"] = summary;
            let evidence: OcrEvidenceV1 = serde_json::from_value(evidence).expect("typed evidence");
            assert!(
                evidence.validate().is_err(),
                "non-canonical summary value was accepted"
            );
        }
    }

    #[test]
    fn malformed_ocr_evidence_is_rejected_at_library_update_seam() {
        let cases = [
            ("schemaVersion", serde_json::json!(2)),
            ("digest", serde_json::json!("not-a-sha")),
            ("pageCount", serde_json::json!(2)),
        ];
        for (field, value) in cases {
            let mut evidence = serde_json::to_value(completed_evidence()).expect("evidence json");
            evidence[field] = value;
            let update: LibraryCaptureUpdate =
                serde_json::from_value(update_value(evidence)).expect("typed update");
            let directory = tempfile::tempdir().expect("temporary app data");
            let library = LibraryStore::open(directory.path()).expect("library");
            let created = library
                .create_source(LibrarySourceInput {
                    file_name: "malformed.pdf".into(),
                    media_type: "application/pdf".into(),
                    bytes: b"pdf bytes".to_vec(),
                })
                .expect("source");
            let update = LibraryCaptureUpdate {
                document_id: created.document_id,
                ..update
            };
            let error = library
                .update_capture(update)
                .expect_err("malformed evidence rejected");
            assert!(error.contains("OCR evidence"), "{field}: {error}");
        }

        let mut evidence = serde_json::to_value(completed_evidence()).expect("evidence json");
        evidence["pages"][0]["text"] = serde_json::json!("raw secret");
        assert!(serde_json::from_value::<LibraryCaptureUpdate>(update_value(evidence)).is_err());

        let sealed_pages = |page_numbers: &[u64]| -> OcrEvidenceV1 {
            let mut evidence = serde_json::to_value(completed_evidence()).expect("evidence json");
            let template_page = evidence["pages"][0].clone();
            let pages: Vec<_> = page_numbers
                .iter()
                .map(|page| {
                    let mut entry = template_page.clone();
                    entry["page"] = serde_json::json!(page);
                    entry
                })
                .collect();
            evidence["pageCount"] = serde_json::json!(pages.len());
            evidence["pages"] = serde_json::Value::Array(pages);
            evidence["summary"]["normalizedCharCount"] =
                serde_json::json!(5 * page_numbers.len() as u64);
            sealed_evidence(evidence)
        };

        let gapped = sealed_pages(&[2, 5]);
        gapped.validate().expect("gapped ascending pages are valid");
        sealed_pages(&[u64::from(u32::MAX)])
            .validate()
            .expect("u32 max page is valid");

        for invalid_pages in [
            vec![0],
            vec![u64::from(u32::MAX) + 1],
            vec![2, 2],
            vec![5, 2],
        ] {
            let evidence = sealed_pages(&invalid_pages);
            assert_eq!(
                evidence
                    .validate()
                    .expect_err("non-ascending or out-of-range pages rejected"),
                "OCR evidence pages must be in ascending order."
            );
        }

        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");

        let unordered_doc = library
            .create_source(LibrarySourceInput {
                file_name: "unordered.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        assert_eq!(
            library
                .update_capture(evidence_update(
                    &unordered_doc.document_id,
                    "completed",
                    Some(sealed_pages(&[5, 2])),
                ))
                .expect_err("unordered pages rejected"),
            "OCR evidence pages must be in ascending order."
        );

        let no_options_doc = library
            .create_source(LibrarySourceInput {
                file_name: "gapped-without-options.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source");
        assert_eq!(
            library
                .update_capture(evidence_update(
                    &no_options_doc.document_id,
                    "completed",
                    Some(gapped),
                ))
                .expect_err("gapped pages without options rejected"),
            "OCR evidence pages do not match the requested pages."
        );

        let scoped_path = directory.path().join("scoped.pdf");
        fs::write(&scoped_path, b"%PDF-1.7\nscoped").expect("scoped pdf");
        let scoped_doc = library
            .import_source(LibraryImportSourceRequest {
                source_path: scoped_path.to_string_lossy().into_owned(),
                capture_options: Some(LibraryCaptureOptions {
                    pdf_page_count: Some(3),
                    ..Default::default()
                }),
            })
            .expect("scoped source");
        assert_eq!(
            library
                .update_capture(evidence_update(
                    &scoped_doc.document_id,
                    "completed",
                    Some(sealed_pages(&[1, 2])),
                ))
                .expect_err("prefix shorter than pdf_page_count rejected"),
            "OCR evidence pages do not match the requested pages."
        );
        library
            .update_capture(evidence_update(
                &scoped_doc.document_id,
                "completed",
                Some(sealed_pages(&[1, 2, 3])),
            ))
            .expect("exact prefix accepted for pdf_page_count");

        let list_path = directory.path().join("page-list.pdf");
        fs::write(&list_path, b"%PDF-1.7\nlist").expect("list pdf");
        let list_doc = library
            .import_source(LibraryImportSourceRequest {
                source_path: list_path.to_string_lossy().into_owned(),
                capture_options: Some(LibraryCaptureOptions {
                    pdf_page_numbers: Some(vec![2, 5]),
                    ..Default::default()
                }),
            })
            .expect("pdf_page_numbers source");
        assert_eq!(
            list_doc.capture_options.as_ref().and_then(|o| o.pdf_page_numbers.as_deref()),
            Some(&[2, 5][..])
        );
        assert_eq!(
            library
                .update_capture(evidence_update(
                    &list_doc.document_id,
                    "completed",
                    Some(sealed_pages(&[1, 2])),
                ))
                .expect_err("non-matching evidence rejected for pdf_page_numbers"),
            "OCR evidence pages do not match the requested pages."
        );
        library
            .update_capture(evidence_update(
                &list_doc.document_id,
                "completed",
                Some(sealed_pages(&[2, 5])),
            ))
            .expect("matching evidence accepted for pdf_page_numbers");

        for invalid_options in [
            LibraryCaptureOptions {
                pdf_page_numbers: Some(vec![]),
                ..Default::default()
            },
            LibraryCaptureOptions {
                pdf_page_numbers: Some(vec![5, 2]),
                ..Default::default()
            },
            LibraryCaptureOptions {
                pdf_page_count: Some(2),
                pdf_page_numbers: Some(vec![1, 2]),
                ..Default::default()
            },
        ] {
            assert_eq!(
                library
                    .import_source(LibraryImportSourceRequest {
                        source_path: list_path.to_string_lossy().into_owned(),
                        capture_options: Some(invalid_options),
                    })
                    .expect_err("invalid page options rejected"),
                "Capture PDF page selection is invalid."
            );
        }
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
            "replacing-journal",
            "progress-journal-0",
            "progress-journal-1",
            "progress-journal-2",
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

    fn library_snapshot(root: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
        fn visit(
            root: &std::path::Path,
            path: &std::path::Path,
            files: &mut Vec<(std::path::PathBuf, Vec<u8>)>,
        ) {
            for entry in fs::read_dir(path).expect("directory") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    files.push((path.strip_prefix(root).unwrap().to_owned(), Vec::new()));
                    visit(root, &path, files);
                } else {
                    files.push((
                        path.strip_prefix(root).unwrap().to_owned(),
                        fs::read(&path).unwrap(),
                    ));
                }
            }
        }
        let mut files = Vec::new();
        visit(root, root, &mut files);
        files.sort();
        files
    }

    fn recovery_source(library: &LibraryStore) -> LibraryDocumentSummary {
        library
            .create_source(LibrarySourceInput {
                file_name: "recovery.pdf".into(),
                media_type: "application/pdf".into(),
                bytes: b"pdf bytes".to_vec(),
            })
            .expect("source")
    }

    #[test]
    fn failed_progress_after_index_replacement_recovers_before_next_import() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).unwrap();
        let created = recovery_source(&library);
        library
            .update_capture(completed_update(&created.document_id, "before"))
            .unwrap();
        let guard = TransactionFailureGuard::at("progress-journal-2");
        library
            .update_capture(completed_update(&created.document_id, "after"))
            .expect_err("progress failure");
        assert!(!library.root.join(TRANSACTION_FILE_NAME).exists());
        let original_list = library.list(LibraryListRequest::default()).unwrap();
        drop(guard);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(
            serde_json::to_value(original_list).unwrap(),
            serde_json::to_value(reopened.list(LibraryListRequest::default()).unwrap()).unwrap(),
        );
        let imported = recovery_source(&library);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(
            reopened.list(LibraryListRequest::default()).unwrap().len(),
            2
        );
        reopened
            .get(LibraryDocumentRequest {
                document_id: imported.document_id,
            })
            .unwrap();
    }

    #[test]
    fn pending_recovery_refuses_writes_without_changes_and_allows_reads() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).unwrap();
        let created = recovery_source(&library);
        library
            .update_capture(completed_update(&created.document_id, "before"))
            .unwrap();
        let guard = TransactionFailureGuard::at("progress-journal-2,rollback*");
        library
            .update_capture(completed_update(&created.document_id, "after"))
            .expect_err("progress failure");
        let source = directory.path().join("refused.pdf");
        fs::write(&source, b"%PDF-1.7\nfixture").unwrap();
        let before = library_snapshot(&library.root);
        let request = || LibraryDocumentRequest {
            document_id: created.document_id.clone(),
        };
        let errors = [
            library
                .import_source(LibraryImportSourceRequest {
                    source_path: source.to_string_lossy().into_owned(),
                    ..Default::default()
                })
                .unwrap_err(),
            library
                .create_source(LibrarySourceInput {
                    file_name: "refused.pdf".into(),
                    media_type: "application/pdf".into(),
                    bytes: vec![1],
                })
                .unwrap_err(),
            library
                .update_capture(completed_update(&created.document_id, "refused"))
                .unwrap_err(),
            library.delete(request()).unwrap_err(),
        ];
        for error in errors {
            assert_eq!(error, "The document library needs recovery; restart Capture Workbench or free disk space and try again.");
        }
        assert_eq!(before, library_snapshot(&library.root));
        assert_eq!(
            library.list(LibraryListRequest::default()).unwrap().len(),
            1
        );
        library.get(request()).expect("read detail while pending");
        assert_eq!(library.source_bytes(request()).unwrap(), b"pdf bytes");
        library
            .export(crate::contracts::LibraryExportRequest {
                document_id: created.document_id.clone(),
                format: crate::contracts::LibraryExportFormat::Text,
                page_label: None,
            })
            .expect("export while pending");
        drop(guard);
        let imported = recovery_source(&library);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        reopened
            .get(LibraryDocumentRequest {
                document_id: imported.document_id,
            })
            .unwrap();
        assert_eq!(
            reopened.get(request()).unwrap().result.unwrap()["targetText"],
            "before"
        );
    }

    #[test]
    fn retained_committed_journal_blocks_writes_until_finalized() {
        for fault in ["cleanup-journal*", "committed-journal,cleanup-journal*"] {
            let directory = tempfile::tempdir().expect("app data");
            let library = LibraryStore::open(directory.path()).unwrap();
            let created = recovery_source(&library);
            let guard = TransactionFailureGuard::at(fault);
            let result =
                library.update_capture(completed_update(&created.document_id, "committed"));
            assert_eq!(result.is_err(), fault.starts_with("committed-journal"));
            let before = library_snapshot(&library.root);
            assert!(library
                .delete(LibraryDocumentRequest {
                    document_id: created.document_id.clone(),
                })
                .unwrap_err()
                .contains("needs recovery"));
            assert_eq!(before, library_snapshot(&library.root));
            assert_eq!(
                library.list(LibraryListRequest::default()).unwrap().len(),
                1
            );
            let in_memory = library.list(LibraryListRequest::default()).unwrap();
            assert_eq!(in_memory[0].status, "completed");
            drop(guard);
            let recovered = LibraryStore::open(directory.path()).unwrap();
            assert_eq!(
                serde_json::to_value(&in_memory).unwrap(),
                serde_json::to_value(recovered.list(LibraryListRequest::default()).unwrap())
                    .unwrap(),
            );
            recovery_source(&library);
            let reopened = LibraryStore::open(directory.path()).unwrap();
            assert_eq!(
                reopened
                    .get(LibraryDocumentRequest {
                        document_id: created.document_id,
                    })
                    .unwrap()
                    .result
                    .unwrap()["targetText"],
                "committed"
            );
            assert_eq!(
                reopened.list(LibraryListRequest::default()).unwrap().len(),
                2
            );
        }
    }

    #[test]
    fn failed_roll_forward_with_missing_target_keeps_the_loaded_index() {
        let directory = tempfile::tempdir().expect("app data");
        let library = LibraryStore::open(directory.path()).unwrap();
        let created = recovery_source(&library);
        let guard = TransactionFailureGuard::at("committed-journal,cleanup-journal*");
        library
            .update_capture(completed_update(&created.document_id, "committed"))
            .expect_err("committed journal write failure");
        // The retained journal rolls forward, but its index target is now gone, so
        // recovery fails; reading the missing index would show an empty library.
        fs::remove_file(library.root.join(INDEX_FILE_NAME)).unwrap();
        assert!(library
            .delete(LibraryDocumentRequest {
                document_id: created.document_id.clone(),
            })
            .unwrap_err()
            .contains("needs recovery"));
        let listed = library.list(LibraryListRequest::default()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].document_id, created.document_id);
        drop(guard);
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

        let guard = TransactionFailureGuard::at("cleanup-journal*");
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
    fn rejects_invalid_document_ids() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
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
                ocr_evidence: None,
                capture_options: None,
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
                ocr_evidence: None,
                capture_options: None,
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
                ocr_evidence: None,
                capture_options: None,
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
                ocr_evidence: None,
                capture_options: None,
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
                ocr_evidence: None,
                capture_options: None,
            })
            .is_err());
    }

    #[test]
    fn recordings_are_recognized_by_signature_whatever_their_recording_extension() {
        use super::validation::verified_media_type;

        let mut transport_stream = vec![0u8; 200];
        transport_stream[0] = 0x47;
        transport_stream[188] = 0x47;
        for (file_name, bytes, media_type) in [
            ("interview.m4a", b"\0\0\0\x18ftyp3gp4".to_vec(), "audio/mp4"),
            ("interview.3gp", b"\0\0\0\x18ftyp3gp4".to_vec(), "audio/mp4"),
            (
                "call.webm",
                vec![0x1a, 0x45, 0xdf, 0xa3, 0x01],
                "video/x-matroska",
            ),
            (
                "dictation.wma",
                vec![0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11],
                "video/x-ms-asf",
            ),
            ("memo.amr", b"#!AMR\n".to_vec(), "audio/amr"),
            ("memo.aac", vec![0xff, 0xf1, 0x50, 0x80], "audio/aac"),
            ("memo.mp3", vec![0xff, 0xfb, 0x90, 0x00], "audio/mpeg"),
            ("voice.opus", b"OggS\0".to_vec(), "audio/ogg"),
            ("broadcast.ts", transport_stream, "video/mp2t"),
        ] {
            assert_eq!(
                verified_media_type(file_name, &bytes),
                Ok(media_type),
                "{file_name}"
            );
        }

        assert!(verified_media_type("lease.mp4", b"%PDF-1.7").is_err());
        assert!(verified_media_type("memo.txt", b"OggS\0").is_err());
        assert!(verified_media_type("notes.m4a", b"plain text").is_err());
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
                ..Default::default()
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
                ..Default::default()
            })
            .expect_err("signature mismatch");
        assert!(!error.contains(&mismatch.to_string_lossy().to_string()));
        assert_eq!(
            error,
            "Selected source extension does not match its signature."
        );

        let unsupported = directory.path().join("unsupported.pdf");
        fs::write(&unsupported, b"not a supported signature").expect("unsupported");
        let error = library
            .import_source(LibraryImportSourceRequest {
                source_path: unsupported.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect_err("unsupported signature");
        assert_eq!(error, "Selected source signature is unsupported.");

        let empty = directory.path().join("empty.pdf");
        fs::write(&empty, b"").expect("empty");
        let error = library
            .import_source(LibraryImportSourceRequest {
                source_path: empty.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect_err("empty file");
        assert_eq!(error, "Selected source exceeds the desktop library limit.");

        let nested_dir = directory.path().join("nested");
        fs::create_dir(&nested_dir).expect("nested dir");
        let relative_source = nested_dir.join("..").join("private-source.pdf");
        let canonical_imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: relative_source.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect("canonical path import");
        assert_eq!(canonical_imported.file_name, "private-source.pdf");
    }

    #[test]
    fn streaming_import_accepts_source_larger_than_copy_buffer_byte_for_byte() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let source_path = directory.path().join("large-audio.mp3");

        let total_size = 3 * 1024 * 1024 + 17;
        let mut content = Vec::with_capacity(total_size);
        content.extend_from_slice(b"ID3\x03\x00\x00\x00\x00\x00\x00");
        while content.len() < total_size {
            let next_byte = ((content.len() * 37 + 13) % 251) as u8;
            content.push(next_byte);
        }
        assert_eq!(content.len(), total_size);
        fs::write(&source_path, &content).expect("write large audio source");

        let library = LibraryStore::open(directory.path()).expect("library");
        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: source_path.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect("streaming import");

        assert_eq!(imported.file_name, "large-audio.mp3");
        assert_eq!(imported.media_type, "audio/mpeg");
        assert_eq!(imported.byte_length, total_size as u64);

        let stored_bytes = library
            .source_bytes(LibraryDocumentRequest {
                document_id: imported.document_id,
            })
            .expect("source bytes");
        assert_eq!(stored_bytes, content);

        let staging_entries = fs::read_dir(library.root.join("staging"))
            .expect("staging dir")
            .count();
        assert_eq!(
            staging_entries, 0,
            "staging directory must be empty after import"
        );
    }

    #[test]
    fn import_with_injected_small_limit_accepts_boundary_and_cleans_on_rejection() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let small_limit = 1024usize;

        let exact_path = directory.path().join("exact.mp3");
        let mut exact_bytes = Vec::with_capacity(small_limit);
        exact_bytes.extend_from_slice(b"ID3\x03\x00\x00\x00\x00\x00\x00");
        exact_bytes.resize(small_limit, 0x5a);
        fs::write(&exact_path, &exact_bytes).expect("exact source");

        let imported = library
            .import_source_bounded(
                LibraryImportSourceRequest {
                    source_path: exact_path.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                small_limit,
            )
            .expect("exact limit accepted");
        assert_eq!(imported.byte_length, small_limit as u64);

        let oversized_path = directory.path().join("oversized.mp3");
        let mut oversized_bytes = Vec::with_capacity(small_limit + 1);
        oversized_bytes.extend_from_slice(b"ID3\x03\x00\x00\x00\x00\x00\x00");
        oversized_bytes.resize(small_limit + 1, 0x5a);
        fs::write(&oversized_path, &oversized_bytes).expect("oversized source");

        let error = library
            .import_source_bounded(
                LibraryImportSourceRequest {
                    source_path: oversized_path.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                small_limit,
            )
            .expect_err("oversized must be rejected");
        assert_eq!(error, "Selected source exceeds the desktop library limit.");

        let staging_count = fs::read_dir(library.root.join("staging"))
            .expect("staging dir")
            .count();
        assert_eq!(staging_count, 0);

        let item_dirs: Vec<_> = fs::read_dir(library.root.join("items"))
            .expect("items dir")
            .filter_map(|entry| entry.ok())
            .collect();
        assert_eq!(item_dirs.len(), 1);
        assert_eq!(
            item_dirs[0].file_name().to_string_lossy(),
            imported.document_id
        );
    }

    #[test]
    fn copy_to_staging_fails_and_cleans_staging_file_on_length_mismatch() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let staging_file = directory.path().join("staging-mismatch.bin");

        let data_10 = b"0123456789";
        let error_overflow = LibraryStore::copy_to_staging(&data_10[..], &staging_file, 5)
            .expect_err("copy must fail when stream yields more than expected");
        assert_eq!(error_overflow, "Selected source changed during import.");
        assert!(
            !staging_file.exists(),
            "staged file must be removed after overflow error"
        );

        let data_5 = b"01234";
        let error_underflow = LibraryStore::copy_to_staging(&data_5[..], &staging_file, 10)
            .expect_err("copy must fail when stream ends early");
        assert_eq!(error_underflow, "Selected source changed during import.");
        assert!(
            !staging_file.exists(),
            "staged file must be removed after early end error"
        );
    }

    #[test]
    fn failed_index_publication_rolls_back_staging_item_and_index() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let source_path = directory.path().join("source.wav");
        let mut wav_bytes = Vec::new();
        wav_bytes.extend_from_slice(b"RIFF\x24\x00\x00\x00WAVEfmt ");
        wav_bytes.resize(100, 0);
        fs::write(&source_path, &wav_bytes).expect("source wav");

        let library = LibraryStore::open(directory.path()).expect("library");

        let _guard = TransactionFailureGuard::at("save-index");
        let error = library
            .import_source(LibraryImportSourceRequest {
                source_path: source_path.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect_err("save index failure");
        assert!(error.contains("injected transaction failure: save-index"));

        let items_count = fs::read_dir(library.root.join("items"))
            .expect("items dir")
            .count();
        assert_eq!(
            items_count, 0,
            "no item directory should remain after save failure"
        );

        let staging_count = fs::read_dir(library.root.join("staging"))
            .expect("staging dir")
            .count();
        assert_eq!(
            staging_count, 0,
            "no staged file should remain after save failure"
        );

        let listed = library
            .list(LibraryListRequest::default())
            .expect("list documents");
        assert!(
            listed.is_empty(),
            "index must not contain the rolled back document"
        );
    }

    #[test]
    fn startup_removes_only_abandoned_staging_entries_and_keeps_items_and_index() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let source_path = directory.path().join("good.pdf");
        fs::write(&source_path, b"%PDF-1.7\nvalid content").expect("good source");

        let library = LibraryStore::open(directory.path()).expect("open library first time");
        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: source_path.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect("import document");

        let staging_dir = library.root.join("staging");
        let abandoned_file = staging_dir.join("abandoned-file");
        fs::write(&abandoned_file, b"leftover data").expect("abandoned file");
        let abandoned_directory = staging_dir.join("abandoned-directory");
        fs::create_dir(&abandoned_directory).expect("abandoned directory");
        fs::write(abandoned_directory.join("inner"), b"inner").expect("inner file");
        // What another running instance is importing right now.
        let active_file = staging_dir.join("active-file");
        fs::write(&active_file, b"being imported").expect("active file");

        drop(library);

        // Opening again at once removes nothing: every entry is fresh.
        let reopened = LibraryStore::open(directory.path()).expect("reopen library");
        assert!(abandoned_file.exists());
        assert!(abandoned_directory.exists());
        assert!(active_file.exists());

        // Later, the entries nobody touched are abandoned; one that is still
        // being written is not.
        let later = std::time::SystemTime::now() + store::STAGING_ABANDONED_AFTER;
        fs::OpenOptions::new()
            .write(true)
            .open(&active_file)
            .expect("active file handle")
            .set_modified(later)
            .expect("touch active file");
        store::clean_staging_directory(&staging_dir, later);
        assert!(!abandoned_file.exists());
        assert!(!abandoned_directory.exists());
        assert!(active_file.exists());

        let listed = reopened
            .list(LibraryListRequest::default())
            .expect("list documents");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].document_id, imported.document_id);

        let item_path = reopened
            .root
            .join("items")
            .join(&imported.document_id)
            .join("source.bin");
        assert!(item_path.exists());
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
            .seek(SeekFrom::Start(DOCUMENT_MAX_SOURCE_BYTES - 1))
            .expect("seek");
        exact_file.write_all(&[0]).expect("limit byte");
        drop(exact_file);

        let library = LibraryStore::open(directory.path()).expect("library");
        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: exact.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect("exact limit");
        assert_eq!(imported.byte_length, DOCUMENT_MAX_SOURCE_BYTES);

        let oversized = directory.path().join("oversized.pdf");
        let mut oversized_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&oversized)
            .expect("oversized source");
        oversized_file.write_all(b"%PDF-").expect("signature");
        oversized_file
            .set_len(DOCUMENT_MAX_SOURCE_BYTES + 1)
            .expect("oversized length");
        drop(oversized_file);
        let error = library
            .import_source(LibraryImportSourceRequest {
                source_path: oversized.to_string_lossy().into_owned(),
                ..Default::default()
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
                    .is_some_and(|metadata| metadata.len() > DOCUMENT_MAX_SOURCE_BYTES)
            }));
    }

    #[test]
    fn native_import_rejects_directories_and_symlinks() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let dir_err = library
            .import_source(LibraryImportSourceRequest {
                source_path: directory.path().to_string_lossy().into_owned(),
                ..Default::default()
            })
            .expect_err("directory rejected");
        assert_eq!(
            dir_err,
            "Selected source must be a regular non-symlink file."
        );

        let target = directory.path().join("target.pdf");
        let link = directory.path().join("linked.pdf");
        fs::write(&target, b"%PDF-1.7\nfixture").expect("target");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&target, &link);
        if symlink_result.is_ok() {
            let link_err = library
                .import_source(LibraryImportSourceRequest {
                    source_path: link.to_string_lossy().into_owned(),
                    ..Default::default()
                })
                .expect_err("symlink rejected");
            assert_eq!(
                link_err,
                "Selected source must be a regular non-symlink file."
            );
        }
    }

    #[test]
    fn path_import_keeps_a_file_queued_with_its_page_count() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let source = directory.path().join("charge.pdf");
        fs::write(&source, b"%PDF-1.7\ncharge").expect("source");
        let library = LibraryStore::open(directory.path()).expect("library");
        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: source.to_string_lossy().into_owned(),
                capture_options: Some(LibraryCaptureOptions {
                    pdf_page_count: Some(3),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .expect("path import");
        assert_eq!(imported.status, "queued");
        assert_eq!(imported.capture_id, None);
        assert!(!imported.has_raw);
        let options = imported.capture_options.expect("options");
        assert_eq!(options.pdf_page_count, Some(3));

        let preserved = library
            .update_capture(LibraryCaptureUpdate {
                document_id: imported.document_id.clone(),
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
                ocr_evidence: None,
                capture_options: None,
            })
            .expect("update without options");
        let preserved_options = preserved.capture_options.expect("options kept");
        assert_eq!(preserved_options.pdf_page_count, Some(3));

        let with_raw = library
            .update_capture(LibraryCaptureUpdate {
                document_id: imported.document_id,
                capture_id: None,
                clear_capture_id: true,
                status: "awaiting_confirmation".into(),
                stage: Some("completed".into()),
                raw: Some(serde_json::json!({ "sourceText": "第一頁" })),
                result: None,
                error_code: None,
                error_message: None,
                recovery_code: None,
                recovery_message: None,
                ocr_evidence: None,
                capture_options: None,
            })
            .expect("raw");
        assert!(with_raw.has_raw);
    }

    #[test]
    fn path_import_rejects_an_invalid_page_count() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library = LibraryStore::open(directory.path()).expect("library");
        let pages = library
            .import_source(LibraryImportSourceRequest {
                source_path: directory
                    .path()
                    .join("charge.pdf")
                    .to_string_lossy()
                    .into_owned(),
                capture_options: Some(LibraryCaptureOptions {
                    pdf_page_count: Some(0),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .expect_err("page count");
        assert_eq!(pages, "Capture PDF page selection is invalid.");

        let missing = library
            .import_source(LibraryImportSourceRequest::default())
            .expect_err("empty path");
        assert_eq!(missing, "Selected source cannot be inspected.");
    }

    #[test]
    fn old_index_without_capture_options_still_opens() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let library_root = directory.path().join("library");
        fs::create_dir_all(library_root.join("items")).expect("items");
        let document_id = "ab".repeat(16);
        fs::write(
            library_root.join(INDEX_FILE_NAME),
            format!(
                r#"{{
                    "version": 1,
                    "documents": [{{
                        "documentId": "{document_id}",
                        "fileName": "old.pdf",
                        "mediaType": "application/pdf",
                        "byteLength": 1,
                        "createdAtMs": 1,
                        "updatedAtMs": 1,
                        "status": "queued",
                        "stage": "uploading",
                        "captureId": null,
                        "errorCode": null,
                        "errorMessage": null
                    }}]
                }}"#
            ),
        )
        .expect("old index");

        let library = LibraryStore::open(directory.path()).expect("old index opens");
        let listed = library.list(LibraryListRequest::default()).expect("list");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].capture_options.is_none());
        assert!(!listed[0].has_raw);
    }

    #[test]
    fn spoken_language_options_serialize_and_reject_invalid_values() {
        let with_lang = LibraryCaptureOptions {
            spoken_language: Some("ja".into()),
            identify_speakers: Some(true),
            ..Default::default()
        };
        let encoded = serde_json::to_value(&with_lang).expect("encode with spokenLanguage");
        assert_eq!(encoded["spokenLanguage"], "ja");
        assert_eq!(encoded["identifySpeakers"], true);
        assert!(encoded.get("pdfPageCount").is_none());

        let without_lang = LibraryCaptureOptions::default();
        let encoded_empty =
            serde_json::to_value(&without_lang).expect("encode without spokenLanguage");
        assert!(encoded_empty.get("spokenLanguage").is_none());

        let directory = tempfile::tempdir().expect("temporary app data");
        let recording = directory.path().join("meeting.mp3");
        fs::write(&recording, b"ID3recording").expect("recording");
        let library = LibraryStore::open(directory.path()).expect("library");

        let imported = library
            .import_source(LibraryImportSourceRequest {
                source_path: recording.to_string_lossy().into_owned(),
                capture_options: Some(with_lang),
                ..Default::default()
            })
            .expect("valid spokenLanguage accepted");
        let opts = imported.capture_options.expect("stored options");
        assert_eq!(opts.spoken_language.as_deref(), Some("ja"));
        assert_eq!(opts.identify_speakers, Some(true));

        let secret_path = directory
            .path()
            .join("secret-dir")
            .to_string_lossy()
            .into_owned();
        for bad in ["", "tlh", "zh-TW", secret_path.as_str()] {
            let error = library
                .import_source(LibraryImportSourceRequest {
                    source_path: recording.to_string_lossy().into_owned(),
                    capture_options: Some(LibraryCaptureOptions {
                        spoken_language: Some(bad.into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .expect_err("invalid spokenLanguage rejected");
            assert_eq!(error, "Capture spoken language is invalid.");
            assert!(!error.contains("secret-dir"));
        }
    }
}
