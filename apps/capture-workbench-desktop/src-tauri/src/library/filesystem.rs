use std::{fs, io::ErrorKind, path::Path};

use serde_json::Value;

use super::{LibraryIndex, INDEX_BACKUP_FILE_NAME, TRANSACTION_FILE_NAME};

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Capture library cannot be written: {error}"))?;
    fs::rename(temporary, path)
        .map_err(|error| format!("Capture library cannot finalize data: {error}"))
}

pub(crate) fn load_backup_index(root: &Path) -> Result<LibraryIndex, String> {
    let backup_path = root.join(INDEX_BACKUP_FILE_NAME);
    let bytes = fs::read(backup_path)
        .map_err(|error| format!("Capture library recovery copy cannot be read: {error}"))?;
    serde_json::from_slice::<LibraryIndex>(&bytes)
        .map_err(|error| format!("Capture library recovery copy is invalid: {error}"))
}

pub(crate) fn read_json_optional(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("Capture library JSON is invalid: {error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Capture library JSON cannot be read: {error}")),
    }
}

pub(crate) fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if path.file_name().and_then(|name| name.to_str()) == Some(TRANSACTION_FILE_NAME) {
        super::inject_transaction_failure("cleanup-journal")
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

pub(crate) fn stem(file_name: &str) -> &str {
    Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("capture")
}
