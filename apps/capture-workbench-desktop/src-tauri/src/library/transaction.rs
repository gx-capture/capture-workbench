use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    atomic_write, inject_transaction_failure, remove_file_if_exists, validate_document_id,
    INDEX_VERSION, TRANSACTION_FILE_NAME,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryTransaction {
    pub(super) transaction_id: String,
    pub(super) document_id: String,
    pub(super) operation: String,
    pub(super) target_index_version: u8,
    pub(super) stage: TransactionStage,
    pub(super) applied_entries: usize,
    pub(super) entries: Vec<TransactionEntry>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransactionStage {
    Prepared,
    Replacing,
    Committed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransactionEntry {
    pub(super) temporary_file_name: String,
    pub(super) target_file_name: String,
    pub(super) backup_file_name: String,
    pub(super) had_target: bool,
}

pub(crate) struct PreparedTransactionEntry {
    pub(super) journal: TransactionEntry,
    pub(super) bytes: Vec<u8>,
}

pub(crate) fn prepare_transaction_entry(
    root: &Path,
    target: &Path,
    transaction_id: &str,
    bytes: Vec<u8>,
) -> Result<PreparedTransactionEntry, String> {
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

pub(crate) fn transaction_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
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

pub(crate) fn write_transaction_journal(
    root: &Path,
    transaction: &LibraryTransaction,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(transaction)
        .map_err(|error| format!("Capture library transaction cannot be encoded: {error}"))?;
    atomic_write(&root.join(TRANSACTION_FILE_NAME), &bytes)
}

pub(crate) fn commit_library_transaction(
    root: &Path,
    mut transaction: LibraryTransaction,
    prepared: Vec<PreparedTransactionEntry>,
) -> Result<(), String> {
    for (index, entry) in prepared.iter().enumerate() {
        let temporary = transaction_path(root, &entry.journal.temporary_file_name)?;
        if let Err(error) = inject_transaction_failure(&format!("stage-write-{index}"))
            .and_then(|()| fs::write(&temporary, &entry.bytes))
        {
            for cleanup in &prepared {
                let _ = remove_file_if_exists(&transaction_path(
                    root,
                    &cleanup.journal.temporary_file_name,
                )?);
            }
            return Err(format!(
                "Capture library transaction data cannot be staged: {error}"
            ));
        }
    }
    write_transaction_journal(root, &transaction)?;
    transaction.stage = TransactionStage::Replacing;
    inject_transaction_failure("replacing-journal")
        .map_err(|_| "Capture library transaction stage cannot be written.".to_string())?;
    write_transaction_journal(root, &transaction)?;

    for (index, entry) in transaction.entries.iter().enumerate() {
        let target = transaction_path(root, &entry.target_file_name)?;
        let temporary = transaction_path(root, &entry.temporary_file_name)?;
        let backup = transaction_path(root, &entry.backup_file_name)?;
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
        inject_transaction_failure(&format!("progress-journal-{index}"))
            .map_err(|_| "Capture library transaction progress cannot be written.".to_string())?;
        write_transaction_journal(root, &transaction)?;
    }

    transaction.stage = TransactionStage::Committed;
    inject_transaction_failure("committed-journal")
        .map_err(|_| "Capture library transaction stage cannot be written.".to_string())?;
    write_transaction_journal(root, &transaction)?;
    if finalize_library_transaction(root, &transaction).is_err() {
        // A committed journal is intentionally retained for `open()` to finish.
        return Ok(());
    }
    Ok(())
}

/// Unknown or invalid journals must never cause a speculative index reload, and
/// neither may a roll-forward whose targets are not all in place yet (reading a
/// missing index would show an empty library).
pub(crate) fn pending_transaction_rolls_forward(root: &Path) -> Option<bool> {
    let bytes = fs::read(root.join(TRANSACTION_FILE_NAME)).ok()?;
    let transaction: LibraryTransaction = serde_json::from_slice(&bytes).ok()?;
    validate_transaction(&transaction).ok()?;
    let mut targets_in_place = true;
    for entry in &transaction.entries {
        let target = transaction_path(root, &entry.target_file_name).ok()?;
        transaction_path(root, &entry.temporary_file_name).ok()?;
        transaction_path(root, &entry.backup_file_name).ok()?;
        targets_in_place &= target.is_file();
    }
    let rolls_forward = transaction.stage == TransactionStage::Committed
        || transaction.applied_entries == transaction.entries.len();
    if rolls_forward && !targets_in_place {
        return None;
    }
    Some(rolls_forward)
}

pub(crate) fn recover_library_transaction(root: &Path) -> Result<(), String> {
    let journal_path = root.join(TRANSACTION_FILE_NAME);
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
    inject_transaction_failure("rollback")
        .map_err(|_| "Capture library transaction cannot be rolled back.".to_string())?;
    for entry in transaction.entries.iter().rev() {
        let target = transaction_path(root, &entry.target_file_name)?;
        let temporary = transaction_path(root, &entry.temporary_file_name)?;
        let backup = transaction_path(root, &entry.backup_file_name)?;
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
    remove_file_if_exists(&root.join(TRANSACTION_FILE_NAME))
}

fn finalize_library_transaction(
    root: &Path,
    transaction: &LibraryTransaction,
) -> Result<(), String> {
    for entry in &transaction.entries {
        let target = transaction_path(root, &entry.target_file_name)?;
        let temporary = transaction_path(root, &entry.temporary_file_name)?;
        let backup = transaction_path(root, &entry.backup_file_name)?;
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
    remove_file_if_exists(&root.join(TRANSACTION_FILE_NAME))
}
