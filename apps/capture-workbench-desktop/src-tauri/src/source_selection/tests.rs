use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chosen.pdf");
    std::fs::write(&path, b"%PDF-1.7\nchosen bytes").unwrap();
    (dir, path)
}
#[test]
fn tokens_are_window_bound_single_use_and_expire() {
    let (_dir, path) = fixture();
    let clock = Arc::new(AtomicU64::new(0));
    let ticks = Arc::clone(&clock);
    let selections = SourceSelections {
        registry: Mutex::new(Registry::default()),
        clock: Box::new(move || Duration::from_secs(ticks.load(Ordering::SeqCst))),
    };
    let batch = selections
        .inspect_batch("main", vec![path.clone()], SourceSelectionKind::All)
        .unwrap();
    let token = &batch.selections[0].selection_token;
    assert_eq!(token.len(), 32);
    assert!(token
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    for forged in ["", "bad", &"g".repeat(32), &"0".repeat(32)] {
        assert_eq!(selections.take("main", forged).err().unwrap(), UNAVAILABLE);
    }
    assert_eq!(selections.take("other", token).err().unwrap(), UNAVAILABLE);
    clock.store(1799, Ordering::SeqCst);
    drop(selections.take("main", token).unwrap());
    assert_eq!(selections.take("main", token).err().unwrap(), UNAVAILABLE);
    let batch = selections
        .inspect_batch("main", vec![path], SourceSelectionKind::All)
        .unwrap();
    clock.store(3599, Ordering::SeqCst);
    assert_eq!(
        selections
            .take("main", &batch.selections[0].selection_token)
            .err()
            .unwrap(),
        UNAVAILABLE
    );
    assert!(selections.lock().unwrap().entries.is_empty());
}
#[test]
fn discard_destroy_and_capacity_release_handles() {
    let (_dir, path) = fixture();
    let selections = SourceSelections::default();
    let batch = selections
        .inspect_batch("main", vec![path; 65], SourceSelectionKind::All)
        .unwrap();
    assert_eq!(batch.selections.len(), 64);
    assert_eq!(batch.rejected, vec![SourceRejectionReason::LimitReached]);
    let token = batch.selections[0].selection_token.clone();
    selections.discard("other", &[token.clone()]).unwrap();
    assert_eq!(selections.lock().unwrap().entries.len(), 64);
    selections.discard("main", &[token.clone()]).unwrap();
    assert_eq!(selections.take("main", &token).err().unwrap(), UNAVAILABLE);
    assert_eq!(selections.lock().unwrap().entries.len(), 63);
    selections.destroy("main");
    assert!(selections.lock().unwrap().entries.is_empty());
}
#[test]
fn opened_identity_survives_replacement_and_truncation_is_rejected() {
    let (dir, path) = fixture();
    let selections = SourceSelections::default();
    let batch = selections
        .inspect_batch("main", vec![path.clone()], SourceSelectionKind::Documents)
        .unwrap();
    std::fs::rename(&path, dir.path().join("moved.pdf")).unwrap();
    std::fs::write(&path, b"%PDF-1.7\nreplacement").unwrap();
    let library = crate::library::LibraryStore::open(dir.path()).unwrap();
    let doc = selections
        .import(
            "main",
            LibraryImportSelectionRequest {
                selection_token: batch.selections[0].selection_token.clone(),
                capture_options: None,
            },
            &library,
        )
        .unwrap();
    assert_eq!(
        library
            .source_bytes(LibraryDocumentRequest {
                document_id: doc.document_id
            })
            .unwrap(),
        b"%PDF-1.7\nchosen bytes"
    );
    let source = inspect_source(&path, SourceSelectionKind::All).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(1)
        .unwrap();
    assert_eq!(
        library.import_opened(source, None).err().unwrap(),
        "Selected source changed during import."
    );
}
#[test]
fn inspection_and_request_boundary() {
    let (dir, path) = fixture();
    assert!(inspect_source(&path, SourceSelectionKind::Documents).is_ok());
    assert_eq!(
        inspect_source(dir.path(), SourceSelectionKind::All)
            .err()
            .unwrap(),
        SourceRejectionReason::NotRegularFile
    );
    std::fs::write(&path, b"").unwrap();
    assert_eq!(
        inspect_source(&path, SourceSelectionKind::All)
            .err()
            .unwrap(),
        SourceRejectionReason::Empty
    );
    std::fs::write(&path, b"ID3recording").unwrap();
    assert_eq!(
        inspect_source(&path, SourceSelectionKind::All)
            .err()
            .unwrap(),
        SourceRejectionReason::Unsupported
    );
    assert!(serde_json::from_value::<LibraryImportSelectionRequest>(
        serde_json::json!({"selectionToken":"abc", "sourcePath":"forbidden"})
    )
    .is_err());
}
#[test]
fn no_subscriber_does_not_inspect_or_admit() {
    let selections = Arc::new(SourceSelections::default());
    selections
        .process_drop("main", vec![PathBuf::from("missing")])
        .unwrap();
    assert!(selections.lock().unwrap().entries.is_empty());
}

#[test]
fn inspection_rejects_oversize_recordings_and_signature_changes() {
    let (dir, path) = fixture();
    let oversized = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    oversized
        .set_len(crate::library::RECORDING_MAX_SOURCE_BYTES + 1)
        .unwrap();
    drop(oversized);
    assert_eq!(
        inspect_source(&path, SourceSelectionKind::All)
            .err()
            .unwrap(),
        SourceRejectionReason::TooLarge
    );
    let recording = dir.path().join("recording.mp3");
    std::fs::write(&recording, b"ID3recording").unwrap();
    assert!(inspect_source(&recording, SourceSelectionKind::All).is_ok());
    assert_eq!(
        inspect_source(&recording, SourceSelectionKind::Documents)
            .err()
            .unwrap(),
        SourceRejectionReason::Unsupported
    );
    std::fs::write(&path, b"%PDF-1.7\nchosen bytes").unwrap();
    let source = inspect_source(&path, SourceSelectionKind::All).unwrap();
    std::fs::write(&path, b"not-a-pdf-chosen bytes").unwrap();
    let library = crate::library::LibraryStore::open(dir.path()).unwrap();
    assert_eq!(
        library.import_opened(source, None).err().unwrap(),
        "Selected source changed during import."
    );
    assert_eq!(
        std::fs::read_dir(dir.path().join("library/items"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn batches_expose_only_base_names_and_reason_codes() {
    let (dir, path) = fixture();
    let missing = dir.path().join("missing.pdf");
    let selections = SourceSelections::default();
    let batch = selections
        .inspect_batch("main", vec![path, missing], SourceSelectionKind::All)
        .unwrap();
    let value = serde_json::to_value(batch).unwrap();
    assert_eq!(value["selections"][0]["fileName"], "chosen.pdf");
    assert_eq!(value["rejected"], serde_json::json!(["unreadable"]));
    assert!(!value
        .to_string()
        .contains(&dir.path().to_string_lossy().to_string()));
    for request in [
        serde_json::json!({"kind":"all", "sourcePath":"forbidden"}),
        serde_json::json!({"kind":"unknown"}),
    ] {
        assert!(serde_json::from_value::<LibrarySelectSourcesRequest>(request).is_err());
    }
    assert!(serde_json::from_value::<LibraryDiscardSelectionsRequest>(
        serde_json::json!({"selectionTokens":[], "sourcePath":"forbidden"})
    )
    .is_err());
}

#[test]
fn destroying_a_window_removes_its_channel_and_blocks_inflight_admission() {
    let (_dir, path) = fixture();
    let selections = Arc::new(SourceSelections::default());
    selections.watch("main", Channel::new(|_| Ok(()))).unwrap();
    let guard = selections.begin_dialog("main").unwrap();
    assert_eq!(
        selections.begin_dialog("other").err().unwrap(),
        "A file dialog is already open."
    );
    selections.destroy("main");
    assert!(selections.lock().unwrap().channels.is_empty());
    assert_eq!(
        selections
            .inspect_batch("main", vec![path], SourceSelectionKind::All)
            .err()
            .unwrap(),
        UNAVAILABLE
    );
    drop(guard);
    assert!(selections.begin_dialog("other").is_ok());
}

#[test]
fn commands_cancel_serialize_drops_replace_channels_and_destroy() {
    let (_dir, path) = fixture();
    let selections = Arc::new(SourceSelections::default());
    let guard = selections.begin_dialog("main").unwrap();
    assert_eq!(
        selections.begin_dialog("other").err().unwrap(),
        "A file dialog is already open."
    );
    let batch = selections
        .inspect_batch("main", vec![], SourceSelectionKind::All)
        .unwrap();
    assert!(batch.selections.is_empty() && batch.rejected.is_empty());
    drop(guard);
    drop(selections.begin_dialog("main").unwrap());
    let first_channel = Channel::new(|_| panic!("replaced channel was called"));
    selections.watch("main", first_channel).unwrap();
    let messages = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&messages);
    let lifetime = Arc::new(());
    let weak = Arc::downgrade(&lifetime);
    selections
        .watch(
            "main",
            Channel::new(move |message| {
                let _keep_alive = &lifetime;
                let tauri::ipc::InvokeResponseBody::Json(value) = message else {
                    panic!("expected JSON batch");
                };
                received
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&value).unwrap());
                Ok(())
            }),
        )
        .unwrap();
    selections.process_drop("main", vec![path.clone()]).unwrap();
    let batches = messages.lock().unwrap();
    let selection = &batches[0]["selections"][0];
    assert_eq!(selection["fileName"], "chosen.pdf");
    assert_eq!(selection.as_object().unwrap().len(), 4);
    assert!(!serde_json::to_string(&batches[0])
        .unwrap()
        .contains(path.parent().unwrap().to_str().unwrap()));
    drop(batches);
    selections.destroy("main");
    assert!(
        weak.upgrade().is_none(),
        "destroy must release the channel callback"
    );
    assert!(selections.lock().unwrap().entries.is_empty());
    selections.process_drop("main", vec![path]).unwrap();
    assert_eq!(messages.lock().unwrap().len(), 1);
    assert!(selections.lock().unwrap().entries.is_empty());
}

#[test]
fn rejected_options_preserve_selection_and_index_and_import_errors_are_safe() {
    let (dir, path) = fixture();
    let library = crate::library::LibraryStore::open(dir.path()).unwrap();
    let selections = SourceSelections::default();
    let batch = selections
        .inspect_batch("main", vec![path.clone()], SourceSelectionKind::All)
        .unwrap();
    let token = batch.selections[0].selection_token.clone();
    let request = |options| LibraryImportSelectionRequest {
        selection_token: token.clone(),
        capture_options: options,
    };
    assert_eq!(
        selections
            .import(
                "main",
                request(Some(LibraryCaptureOptions {
                    pdf_page_count: Some(0)
                })),
                &library
            )
            .err()
            .unwrap(),
        "Capture PDF page selection is invalid."
    );
    assert_eq!(selections.lock().unwrap().entries.len(), 1);
    assert!(library
        .list(LibraryListRequest::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        selections
            .import("other", request(None), &library)
            .err()
            .unwrap(),
        UNAVAILABLE
    );
    assert_eq!(selections.lock().unwrap().entries.len(), 1);
    let doc = selections.import("main", request(None), &library).unwrap();
    assert_eq!(doc.file_name, "chosen.pdf");
    assert_eq!(
        selections
            .import("main", request(None), &library)
            .err()
            .unwrap(),
        UNAVAILABLE
    );
    assert_eq!(
        library.list(LibraryListRequest::default()).unwrap().len(),
        1
    );
}

#[test]
fn same_length_signature_mutation_is_rejected_without_publishing() {
    let (dir, path) = fixture();
    let selections = SourceSelections::default();
    let batch = selections
        .inspect_batch("main", vec![path.clone()], SourceSelectionKind::All)
        .unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] = b'!';
    std::fs::write(&path, bytes).unwrap();
    let library = crate::library::LibraryStore::open(dir.path()).unwrap();
    assert_eq!(
        selections
            .import(
                "main",
                LibraryImportSelectionRequest {
                    selection_token: batch.selections[0].selection_token.clone(),
                    capture_options: None
                },
                &library
            )
            .err()
            .unwrap(),
        "Selected source changed during import."
    );
    assert!(library
        .list(LibraryListRequest::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        std::fs::read_dir(dir.path().join("library/staging"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(windows)]
#[test]
fn consume_discard_expiry_and_destroy_close_the_os_handle() {
    use std::os::windows::fs::OpenOptionsExt;
    for action in ["consume", "discard", "expire", "destroy"] {
        let (dir, path) = fixture();
        let clock = Arc::new(AtomicU64::new(0));
        let ticks = Arc::clone(&clock);
        let selections = SourceSelections {
            registry: Mutex::new(Registry::default()),
            clock: Box::new(move || Duration::from_secs(ticks.load(Ordering::SeqCst))),
        };
        let batch = selections
            .inspect_batch("main", vec![path.clone()], SourceSelectionKind::All)
            .unwrap();
        let token = batch.selections[0].selection_token.clone();
        let exclusive = || {
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
        };
        assert!(
            exclusive().is_err(),
            "retained selection must own an open handle"
        );
        match action {
            "consume" => {
                let library = crate::library::LibraryStore::open(dir.path()).unwrap();
                selections
                    .import(
                        "main",
                        LibraryImportSelectionRequest {
                            selection_token: token,
                            capture_options: None,
                        },
                        &library,
                    )
                    .unwrap();
            }
            "discard" => {
                selections.discard("main", &[token.clone(), token]).unwrap();
            }
            "expire" => {
                clock.store(1800, Ordering::SeqCst);
                assert_eq!(selections.take("main", &token).err().unwrap(), UNAVAILABLE);
            }
            "destroy" => selections.destroy("main"),
            _ => unreachable!(),
        }
        drop(exclusive().expect("released selection must close the handle"));
    }
}

#[test]
fn failed_drop_delivery_releases_admitted_selections() {
    let (_dir, path) = fixture();
    let selections = SourceSelections::default();
    selections
        .watch(
            "main",
            Channel::new(|_| Err(std::io::Error::other("delivery unavailable").into())),
        )
        .unwrap();
    selections.process_drop("main", vec![path]).unwrap();
    assert!(selections.lock().unwrap().entries.is_empty());
}
#[test]
fn import_errors_keep_only_actionable_messages() {
    for message in [
        "Selected source changed during import.",
        crate::library::NOT_ENOUGH_DISK_SPACE,
    ] {
        assert_eq!(import_error(message.to_string()), message);
    }
    assert_eq!(
        import_error("Capture library index cannot be written: details".into()),
        "Selected source could not be imported."
    );
}
