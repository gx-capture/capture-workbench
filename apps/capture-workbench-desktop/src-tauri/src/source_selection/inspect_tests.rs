use super::*;

#[test]
fn kinds_signatures_and_lengths_are_inspected_before_admission() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.pdf");
    let bytes = b"%PDF-1.7\nfixture";
    fs::write(&source, bytes).unwrap();
    let opened = inspect_source(&source, SourceSelectionKind::Documents).unwrap();
    assert_eq!(opened.file_name, "source.pdf");
    assert_eq!(opened.media_type, "application/pdf");
    assert_eq!(opened.byte_length, bytes.len() as u64);
    drop(opened);
    fs::write(&source, b"").unwrap();
    assert_eq!(
        inspect_source(&source, SourceSelectionKind::All)
            .err()
            .unwrap(),
        Reason::Empty
    );
    fs::write(&source, b"ID3recording").unwrap();
    assert_eq!(
        inspect_source(&source, SourceSelectionKind::All)
            .err()
            .unwrap(),
        Reason::Unsupported
    );
    assert_eq!(
        inspect_source(dir.path(), SourceSelectionKind::All)
            .err()
            .unwrap(),
        Reason::NotRegularFile
    );
    assert_eq!(
        inspect_source(&dir.path().join("missing.pdf"), SourceSelectionKind::All)
            .err()
            .unwrap(),
        Reason::Unreadable
    );
    let recording = dir.path().join("source.mp3");
    fs::write(&recording, b"ID3recording").unwrap();
    assert!(inspect_source(&recording, SourceSelectionKind::All).is_ok());
    assert_eq!(
        inspect_source(&recording, SourceSelectionKind::Documents)
            .err()
            .unwrap(),
        Reason::Unsupported
    );
}

#[test]
fn sparse_oversize_is_rejected_without_reading_it() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("large.pdf");
    File::create(&source)
        .unwrap()
        .set_len(MAX_SOURCE_BYTES as u64 + 1)
        .unwrap();
    assert_eq!(
        inspect_source(&source, SourceSelectionKind::All)
            .err()
            .unwrap(),
        Reason::TooLarge
    );
}

#[test]
fn symlinks_are_never_opened() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.pdf");
    let link = dir.path().join("link.pdf");
    fs::write(&target, b"%PDF-1.7\nfixture").unwrap();
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(&target, &link);
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(&target, &link);
    if let Err(error) = result {
        #[cfg(windows)]
        if error.raw_os_error() == Some(1314) {
            return;
        }
        panic!("symlink fixture creation failed: {:?}", error.kind());
    }
    assert_eq!(
        inspect_source(&link, SourceSelectionKind::All)
            .err()
            .unwrap(),
        Reason::NotRegularFile
    );
}

#[cfg(windows)]
#[test]
fn only_a_canonical_verbatim_disk_prefix_is_local() {
    assert_eq!(
        local_drive(Path::new(r"\\?\C:\sources\chosen.pdf")),
        Some(b'C')
    );
    for source in [
        r"C:\sources\chosen.pdf",
        r"\\server\share\chosen.pdf",
        r"\\?\UNC\server\share\chosen.pdf",
        r"\\.\PhysicalDrive0",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\chosen.pdf",
    ] {
        assert_eq!(local_drive(Path::new(source)), None);
        assert!(!is_local(Path::new(source)));
    }
}

#[test]
fn canonical_local_paths_are_accepted() {
    let directory = tempfile::tempdir().unwrap();
    assert!(is_local(&fs::canonicalize(directory.path()).unwrap()));
    assert!(!is_local(Path::new("relative.pdf")));
}
