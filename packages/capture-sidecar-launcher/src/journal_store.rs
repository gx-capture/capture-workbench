//! Private durable storage for the producer-owned runtime journal.
//!
//! The store derives its journal and lock names from the session/plan identity,
//! holds a real OS lock across read/validate/mutate/write, and replaces the
//! journal only after a complete validated record has been flushed. It is not
//! wired to launch or recovery yet; the later lifecycle owner supplies the
//! mutation facade.

#![allow(dead_code)]

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

#[cfg(test)]
use std::sync::atomic::AtomicBool;

use sha2::{Digest, Sha256};

use crate::journal::{
    CasSnapshot, JournalBinding, JournalError, JournalPlanValue, JournalState, ReconcileAttempt,
    RecoveryAuthorization, ResourceObservation, RuntimeSessionJournalV1, TerminalObservation,
    TerminalProof,
};

#[cfg(windows)]
use std::{
    iter,
    os::windows::{ffi::OsStrExt, fs::MetadataExt, io::AsRawHandle},
};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        LockFileEx, MoveFileExW, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    },
    System::IO::OVERLAPPED,
};

const JOURNAL_PREFIX: &str = "runtime-session-";
const JOURNAL_SUFFIX: &str = ".json";
const LOCK_SUFFIX: &str = ".lock";
const TEMP_MARKER: &str = ".tmp-";
const REPARSE_POINT_ATTRIBUTE: u32 = 0x0000_0400;
const MAX_JOURNAL_BYTES: usize = 1024 * 1024;
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JournalStoreError {
    InvalidConfig,
    PathSecurity,
    AlreadyExists,
    NotFound,
    Conflict,
    CorruptJournal,
    Journal(JournalError),
    Lock,
    LockTimeout,
    Io(&'static str),
    Durability(&'static str),
    AtomicReplace,
    Injected(&'static str),
    TooLarge,
    UnsupportedPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JournalStoreConfig {
    producer_root: PathBuf,
    session_nonce: String,
    plan_digest: String,
}

impl JournalStoreConfig {
    pub(crate) fn new(
        producer_root: PathBuf,
        session_nonce: String,
        plan_digest: String,
    ) -> Result<Self, JournalStoreError> {
        validate_identity(&session_nonce, false)?;
        validate_identity(&plan_digest, true)?;
        validate_producer_root(&producer_root)?;
        Ok(Self {
            producer_root,
            session_nonce,
            plan_digest,
        })
    }
}

#[derive(Debug)]
pub(crate) enum JournalStoreCommand {
    PrepareBound {
        binding: JournalBinding,
        timestamp: String,
    },
    Transition {
        next_state: JournalState,
        timestamp: String,
    },
    TransitionWithObservation {
        next_state: JournalState,
        observation: ResourceObservation,
        timestamp: String,
    },
    TerminalizeWithObservation {
        observation: TerminalObservation,
        timestamp: String,
    },
    TerminalizeNoResource {
        observation: TerminalObservation,
        timestamp: String,
    },
    ReconcileAttempt {
        attempt: ReconcileAttempt,
        proof: Option<TerminalProof>,
        timestamp: String,
    },
    ReconcileComplete {
        observation: TerminalObservation,
        timestamp: String,
    },
    RecoverManualReview {
        authorization: RecoveryAuthorization,
        timestamp: String,
    },
}

pub(crate) struct JournalStore {
    config: JournalStoreConfig,
    journal_path: PathBuf,
    lock_path: PathBuf,
    #[cfg(test)]
    faults: TestFaults,
}

#[cfg(test)]
#[derive(Default)]
struct TestFaults {
    fail_before_flush: AtomicBool,
    fail_before_replace: AtomicBool,
    fail_after_replace_before_flush: AtomicBool,
    fail_durability_recheck: AtomicBool,
    forced_temp_path: std::sync::Mutex<Option<PathBuf>>,
    forced_payload: std::sync::Mutex<Option<Vec<u8>>>,
}

impl JournalStore {
    pub(crate) fn new(config: JournalStoreConfig) -> Result<Self, JournalStoreError> {
        #[cfg(not(windows))]
        {
            let _ = config;
            return Err(JournalStoreError::UnsupportedPlatform);
        }
        #[cfg(windows)]
        {
            validate_producer_root(&config.producer_root)?;
            let identity = filename_identity(&config.session_nonce, &config.plan_digest);
            let stem = format!("{JOURNAL_PREFIX}{identity}");
            Ok(Self {
                journal_path: config.producer_root.join(format!("{stem}{JOURNAL_SUFFIX}")),
                lock_path: config.producer_root.join(format!("{stem}{LOCK_SUFFIX}")),
                config,
                #[cfg(test)]
                faults: TestFaults::default(),
            })
        }
    }

    pub(crate) fn create_initial(
        &self,
        plan: &JournalPlanValue,
        journal: &RuntimeSessionJournalV1,
    ) -> Result<(), JournalStoreError> {
        self.validate_plan_identity(plan)?;
        journal
            .validate_against_plan(plan)
            .map_err(JournalStoreError::Journal)?;
        if !matches!(journal.state, JournalState::PlannedUnbound)
            || journal.session_nonce != self.config.session_nonce
            || journal.plan_digest != self.config.plan_digest
        {
            return Err(JournalStoreError::Journal(JournalError::InvalidBinding(
                "initialJournal",
            )));
        }
        let bytes = journal
            .encode_private()
            .map_err(JournalStoreError::Journal)?;
        self.with_lock(|store| {
            if path_exists(&store.journal_path)? {
                return Err(JournalStoreError::AlreadyExists);
            }
            store.write_atomic_unlocked(&bytes, false)?;
            let read_back = store.read_unlocked(plan)?;
            if read_back != *journal {
                return Err(JournalStoreError::CorruptJournal);
            }
            Ok(())
        })
    }

    pub(crate) fn read(
        &self,
        plan: &JournalPlanValue,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        self.with_lock(|store| store.read_unlocked(plan))
    }

    pub(crate) fn compare_and_swap(
        &self,
        plan: &JournalPlanValue,
        expected: &CasSnapshot,
        command: JournalStoreCommand,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        self.with_lock(|store| {
            let mut current = store.read_unlocked(plan)?;
            if current.cas_snapshot() != *expected {
                return Err(JournalStoreError::Conflict);
            }
            apply_command(&mut current, plan, expected, command).map_err(|error| match error {
                JournalError::StaleCas => JournalStoreError::Conflict,
                error => JournalStoreError::Journal(error),
            })?;
            current
                .validate_against_plan(plan)
                .map_err(JournalStoreError::Journal)?;
            let bytes = current
                .encode_private()
                .map_err(JournalStoreError::Journal)?;
            if let Err(write_error) = store.write_atomic_unlocked(&bytes, true) {
                // The replacement may have happened before a durability error
                // was reported. Re-establish the final-file and directory
                // barriers while this same lock is held, then accept only an
                // exact complete candidate read-back. A stale/old record, a
                // corrupt record, or another candidate never becomes success.
                if let Ok(read_back) =
                    store.reestablish_candidate_durability_unlocked(plan, &current)
                {
                    return Ok(read_back);
                }
                return Err(write_error);
            }
            let read_back = store.read_unlocked(plan)?;
            if read_back != current {
                return Err(JournalStoreError::CorruptJournal);
            }
            Ok(current)
        })
    }

    fn validate_plan_identity(&self, plan: &JournalPlanValue) -> Result<(), JournalStoreError> {
        plan.validate().map_err(JournalStoreError::Journal)?;
        if plan.plan_digest != self.config.plan_digest {
            return Err(JournalStoreError::Journal(JournalError::InvalidBinding(
                "planDigest",
            )));
        }
        Ok(())
    }

    fn with_lock<T, F>(&self, operation: F) -> Result<T, JournalStoreError>
    where
        F: FnOnce(&Self) -> Result<T, JournalStoreError>,
    {
        validate_producer_root(&self.config.producer_root)?;
        let _lock = JournalFileLock::acquire(&self.lock_path)?;
        validate_producer_root(&self.config.producer_root)?;
        operation(self)
    }

    fn read_unlocked(
        &self,
        plan: &JournalPlanValue,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        ensure_regular_file(&self.journal_path)?;
        let file = File::open(&self.journal_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                JournalStoreError::NotFound
            } else {
                JournalStoreError::Io("openJournal")
            }
        })?;
        let file_length = file
            .metadata()
            .map_err(|_| JournalStoreError::Io("statJournal"))?
            .len();
        if file_length > MAX_JOURNAL_BYTES as u64 {
            return Err(JournalStoreError::TooLarge);
        }
        let mut bytes = Vec::with_capacity(file_length as usize);
        file.take((MAX_JOURNAL_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| JournalStoreError::Io("read"))?;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(JournalStoreError::TooLarge);
        }
        let journal = RuntimeSessionJournalV1::decode_private(&bytes)
            .map_err(|_| JournalStoreError::CorruptJournal)?;
        if journal.session_nonce != self.config.session_nonce
            || journal.plan_digest != self.config.plan_digest
        {
            return Err(JournalStoreError::CorruptJournal);
        }
        journal
            .validate_against_plan(plan)
            .map_err(JournalStoreError::Journal)?;
        Ok(journal)
    }

    fn reestablish_candidate_durability_unlocked(
        &self,
        plan: &JournalPlanValue,
        candidate: &RuntimeSessionJournalV1,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        let final_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.journal_path)
            .map_err(|_| JournalStoreError::AtomicReplace)?;
        #[cfg(test)]
        if self
            .faults
            .fail_durability_recheck
            .swap(false, Ordering::AcqRel)
        {
            return Err(JournalStoreError::Injected("durabilityRecheck"));
        }
        final_file
            .sync_all()
            .map_err(|_| JournalStoreError::Durability("recoveryFinalFlush"))?;
        sync_directory(&self.config.producer_root)?;
        let read_back = self.read_unlocked(plan)?;
        if read_back != *candidate {
            return Err(JournalStoreError::CorruptJournal);
        }
        Ok(read_back)
    }

    fn write_atomic_unlocked(
        &self,
        encoded: &[u8],
        replace_existing: bool,
    ) -> Result<(), JournalStoreError> {
        #[cfg(test)]
        let forced_payload = self.faults.forced_payload.lock().unwrap().take();
        #[cfg(test)]
        let bytes = forced_payload.as_deref().unwrap_or(encoded);
        #[cfg(not(test))]
        let bytes = encoded;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(JournalStoreError::TooLarge);
        }
        let temp_path = self.temp_path();
        let mut created_temp = false;
        let result = (|| {
            let mut file = match OpenOptions::new()
                .create_new(true)
                .write(true)
                .read(true)
                .open(&temp_path)
            {
                Ok(file) => {
                    created_temp = true;
                    file
                }
                Err(_) => return Err(JournalStoreError::Io("createTemp")),
            };
            file.write_all(bytes)
                .map_err(|_| JournalStoreError::Io("writeTemp"))?;
            #[cfg(test)]
            if self.faults.fail_before_flush.swap(false, Ordering::AcqRel) {
                return Err(JournalStoreError::Injected("beforeFlush"));
            }
            file.flush()
                .map_err(|_| JournalStoreError::Durability("tempFlush"))?;
            file.sync_all()
                .map_err(|_| JournalStoreError::Durability("tempSync"))?;
            drop(file);
            #[cfg(test)]
            if self
                .faults
                .fail_before_replace
                .swap(false, Ordering::AcqRel)
            {
                return Err(JournalStoreError::Injected("beforeReplace"));
            }
            atomic_move(&temp_path, &self.journal_path, replace_existing)?;
            let final_file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&self.journal_path)
                .map_err(|_| JournalStoreError::AtomicReplace)?;
            #[cfg(test)]
            if replace_existing
                && self
                    .faults
                    .fail_after_replace_before_flush
                    .swap(false, Ordering::AcqRel)
            {
                return Err(JournalStoreError::Injected("afterReplaceBeforeFlush"));
            }
            final_file
                .sync_all()
                .map_err(|_| JournalStoreError::Durability("finalFlush"))?;
            sync_directory(&self.config.producer_root)?;
            Ok(())
        })();
        if result.is_err() && created_temp {
            let _ = fs::remove_file(&temp_path);
        }
        result
    }

    fn temp_path(&self) -> PathBuf {
        #[cfg(test)]
        if let Some(path) = self.faults.forced_temp_path.lock().unwrap().take() {
            return path;
        }
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        self.temp_path_for(counter)
    }

    fn temp_path_for(&self, counter: u64) -> PathBuf {
        let file_name = self
            .journal_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("runtime-session");
        self.config.producer_root.join(format!(
            "{file_name}{TEMP_MARKER}{}-{counter}",
            std::process::id()
        ))
    }

    #[cfg(test)]
    fn fail_next_before_flush(&self) {
        self.faults.fail_before_flush.store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn fail_next_before_replace(&self) {
        self.faults
            .fail_before_replace
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_after_replace_before_flush(&self) {
        self.faults
            .fail_after_replace_before_flush
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_after_replace_and_durability_recheck(&self) {
        self.faults
            .fail_after_replace_before_flush
            .store(true, Ordering::Release);
        self.faults
            .fail_durability_recheck
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn force_next_temp_path(&self, path: PathBuf) {
        *self.faults.forced_temp_path.lock().unwrap() = Some(path);
    }

    #[cfg(test)]
    fn force_next_payload(&self, payload: Vec<u8>) {
        *self.faults.forced_payload.lock().unwrap() = Some(payload);
    }
}

fn apply_command(
    journal: &mut RuntimeSessionJournalV1,
    plan: &JournalPlanValue,
    expected: &CasSnapshot,
    command: JournalStoreCommand,
) -> Result<(), JournalError> {
    match command {
        JournalStoreCommand::PrepareBound { binding, timestamp } => {
            journal.cas_prepare_bound(plan, expected, binding, timestamp)
        }
        JournalStoreCommand::Transition {
            next_state,
            timestamp,
        } => journal.cas_transition(expected, next_state, None, timestamp),
        JournalStoreCommand::TransitionWithObservation {
            next_state,
            observation,
            timestamp,
        } => journal.cas_transition_with_observation(
            expected,
            next_state,
            None,
            observation,
            timestamp,
        ),
        JournalStoreCommand::TerminalizeWithObservation {
            observation,
            timestamp,
        } => journal.cas_terminalize_with_observation(expected, observation, timestamp),
        JournalStoreCommand::TerminalizeNoResource {
            observation,
            timestamp,
        } => journal.cas_terminalize_no_resource(expected, observation, timestamp),
        JournalStoreCommand::ReconcileAttempt {
            attempt,
            proof,
            timestamp,
        } => journal.cas_reconcile_attempt(expected, attempt, proof, timestamp),
        JournalStoreCommand::ReconcileComplete {
            observation,
            timestamp,
        } => journal.cas_reconcile_complete(expected, observation, timestamp),
        JournalStoreCommand::RecoverManualReview {
            mut authorization,
            timestamp,
        } => journal.cas_recover_manual_review(expected, &mut authorization, timestamp),
    }
}

fn validate_identity(value: &str, digest: bool) -> Result<(), JournalStoreError> {
    let valid = if digest {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    } else {
        !value.is_empty()
            && value.len() <= 256
            && value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
            })
    };
    if valid {
        Ok(())
    } else {
        Err(JournalStoreError::InvalidConfig)
    }
}

fn validate_producer_root(root: &Path) -> Result<(), JournalStoreError> {
    if !root.is_absolute()
        || root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(JournalStoreError::PathSecurity);
    }
    let metadata = fs::symlink_metadata(root).map_err(|_| JournalStoreError::InvalidConfig)?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(JournalStoreError::PathSecurity);
    }
    let mut current = root.to_path_buf();
    loop {
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| JournalStoreError::PathSecurity)?;
        if metadata_is_reparse(&metadata) {
            return Err(JournalStoreError::PathSecurity);
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), JournalStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            JournalStoreError::NotFound
        } else {
            JournalStoreError::Io("statFile")
        }
    })?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(JournalStoreError::PathSecurity);
    }
    Ok(())
}

fn path_exists(path: &Path) -> Result<bool, JournalStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata_is_reparse(&metadata) {
                Err(JournalStoreError::PathSecurity)
            } else {
                Ok(true)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(JournalStoreError::Io("statJournal")),
    }
}

fn metadata_is_reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn filename_identity(session_nonce: &str, plan_digest: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/journal-store/v1\0");
    hasher.update(session_nonce.as_bytes());
    hasher.update([0]);
    hasher.update(plan_digest.as_bytes());
    hex_lower(&hasher.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(windows)]
fn atomic_move(from: &Path, to: &Path, replace_existing: bool) -> Result<(), JournalStoreError> {
    let from = wide_path(from);
    let to = wide_path(to);
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace_existing {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } != 0;
    if moved {
        Ok(())
    } else {
        Err(JournalStoreError::AtomicReplace)
    }
}

#[cfg(not(windows))]
fn atomic_move(from: &Path, to: &Path, replace_existing: bool) -> Result<(), JournalStoreError> {
    if !replace_existing && path_exists(to)? {
        return Err(JournalStoreError::AlreadyExists);
    }
    fs::rename(from, to).map_err(|_| JournalStoreError::AtomicReplace)
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect()
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), JournalStoreError> {
    // MoveFileExW with MOVEFILE_WRITE_THROUGH is the Windows directory-entry
    // durability barrier. Opening a directory as a normal File is not
    // supported consistently across the Windows versions supported here.
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), JournalStoreError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| JournalStoreError::Durability("directorySync"))
}

struct JournalFileLock {
    file: File,
    #[cfg(windows)]
    overlapped: OVERLAPPED,
}

impl JournalFileLock {
    #[cfg(windows)]
    fn acquire(path: &Path) -> Result<Self, JournalStoreError> {
        if path_exists(path)? {
            ensure_regular_file(path)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|_| JournalStoreError::Lock)?;
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            let mut overlapped = OVERLAPPED::default();
            let locked = unsafe {
                LockFileEx(
                    file.as_raw_handle() as HANDLE,
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    u32::MAX,
                    u32::MAX,
                    &mut overlapped,
                )
            } != 0;
            if locked {
                return Ok(Self { file, overlapped });
            }
            if Instant::now() >= deadline {
                return Err(JournalStoreError::LockTimeout);
            }
            thread::sleep(LOCK_RETRY_INTERVAL);
        }
    }

    #[cfg(not(windows))]
    fn acquire(_path: &Path) -> Result<Self, JournalStoreError> {
        Err(JournalStoreError::UnsupportedPlatform)
    }
}

impl Drop for JournalFileLock {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = UnlockFileEx(
                self.file.as_raw_handle() as HANDLE,
                0,
                u32::MAX,
                u32::MAX,
                &mut self.overlapped,
            );
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        env, fs,
        path::Path,
        process::Command,
        sync::{Arc, Barrier},
        thread,
        time::{Duration, Instant},
    };

    use tempfile::tempdir;

    use super::*;
    use crate::journal::{
        BoundRoot, JournalBinding, JournalPlanValue, JournalState, PlannedRoot, ReconcileAttempt,
        RuntimeSessionJournalV1,
    };

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ROOT_DIGEST: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const SPEC_DIGEST: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const LARGE_ROOT_COUNT: u32 = 5_000;

    fn plan() -> JournalPlanValue {
        JournalPlanValue {
            plan_digest: DIGEST_A.into(),
            group_ref_digest: DIGEST_B.into(),
            group_generation: 4,
            roots: vec![PlannedRoot {
                ordinal: 0,
                role: "capture".into(),
                root_ref_digest: ROOT_DIGEST.into(),
                root_generation: 1,
                spec_digest: SPEC_DIGEST.into(),
                reserved_listener_identity: "listener-0".into(),
            }],
        }
    }

    fn config(root: &Path) -> JournalStoreConfig {
        JournalStoreConfig::new(root.to_path_buf(), "session-1".into(), DIGEST_A.into())
            .expect("store config")
    }

    fn store(root: &Path) -> JournalStore {
        JournalStore::new(config(root)).expect("store")
    }

    fn initial_journal() -> RuntimeSessionJournalV1 {
        RuntimeSessionJournalV1::planned(&plan(), "session-1".into(), "2026-09-11T00:00:00Z".into())
            .expect("planned journal")
    }

    fn create_initial(store: &JournalStore) {
        store
            .create_initial(&plan(), &initial_journal())
            .expect("initial journal");
    }

    fn large_plan() -> JournalPlanValue {
        let mut plan = plan();
        plan.roots = (0..LARGE_ROOT_COUNT)
            .map(|ordinal| PlannedRoot {
                ordinal,
                role: format!("capture-{ordinal}"),
                root_ref_digest: ROOT_DIGEST.into(),
                root_generation: 1,
                spec_digest: SPEC_DIGEST.into(),
                reserved_listener_identity: format!("listener-{ordinal}"),
            })
            .collect();
        plan
    }

    fn large_binding(plan: &JournalPlanValue) -> JournalBinding {
        JournalBinding::Bound {
            binding_attempt_id: "attempt-1".into(),
            group_ref_digest: plan.group_ref_digest.clone(),
            group_generation: plan.group_generation,
            root_bindings: plan
                .roots
                .iter()
                .map(|root| BoundRoot {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    spec_digest: root.spec_digest.clone(),
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                })
                .collect(),
            activation_receipt_digest: DIGEST_A.into(),
        }
    }

    fn advance_to_reconcile(store: &JournalStore) -> RuntimeSessionJournalV1 {
        let current = store.read(&plan()).expect("read planned");
        store
            .compare_and_swap(
                &plan(),
                &current.cas_snapshot(),
                JournalStoreCommand::Transition {
                    next_state: JournalState::ReconcileRequired,
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("reconcile transition")
    }

    #[test]
    fn initial_create_is_exclusive_and_filename_is_identity_derived() {
        let directory = tempdir().expect("tempdir");
        let first = store(directory.path());
        create_initial(&first);
        let second = JournalStore::new(config(directory.path())).expect("reopen store");
        assert_eq!(
            second.read(&plan()).expect("reopen read"),
            initial_journal()
        );
        assert_eq!(
            second.create_initial(&plan(), &initial_journal()),
            Err(JournalStoreError::AlreadyExists)
        );
        let filename = first
            .journal_path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("journal filename");
        assert!(filename.starts_with(JOURNAL_PREFIX));
        assert!(!filename.contains("session-1"));
        assert!(filename.ends_with(JOURNAL_SUFFIX));
    }

    #[test]
    fn plan_identity_is_bound_before_initial_persist() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        let mut wrong_plan = plan();
        wrong_plan.plan_digest = DIGEST_B.into();
        let journal = RuntimeSessionJournalV1::planned(
            &wrong_plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("wrong plan journal");
        assert!(matches!(
            store.create_initial(&wrong_plan, &journal),
            Err(JournalStoreError::Journal(JournalError::InvalidBinding(
                "planDigest"
            )))
        ));
        assert_eq!(store.read(&plan()), Err(JournalStoreError::NotFound));
    }

    #[test]
    fn independent_instances_have_one_cas_winner_under_os_lock() {
        let directory = tempdir().expect("tempdir");
        let first = Arc::new(store(directory.path()));
        create_initial(&first);
        let second = Arc::new(JournalStore::new(config(directory.path())).expect("second store"));
        let expected = first.read(&plan()).expect("read expected").cas_snapshot();
        let barrier = Arc::new(Barrier::new(2));
        let first_thread = {
            let first = Arc::clone(&first);
            let barrier = Arc::clone(&barrier);
            let expected = expected.clone();
            thread::spawn(move || {
                barrier.wait();
                first.compare_and_swap(
                    &plan(),
                    &expected,
                    JournalStoreCommand::Transition {
                        next_state: JournalState::ReconcileRequired,
                        timestamp: "2026-09-11T00:00:01Z".into(),
                    },
                )
            })
        };
        let second_thread = {
            let second = Arc::clone(&second);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                second.compare_and_swap(
                    &plan(),
                    &expected,
                    JournalStoreCommand::Transition {
                        next_state: JournalState::ReconcileRequired,
                        timestamp: "2026-09-11T00:00:01Z".into(),
                    },
                )
            })
        };
        let first_result = first_thread.join().expect("first CAS thread");
        let second_result = second_thread.join().expect("second CAS thread");
        let first_won = first_result.is_ok();
        let second_won = second_result.is_ok();
        let winners = [first_won, second_won]
            .into_iter()
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        assert!(matches!(
            if first_won {
                second_result
            } else {
                first_result
            },
            Err(JournalStoreError::Conflict)
        ));
        assert_eq!(
            first.read(&plan()).expect("winner read").state,
            JournalState::ReconcileRequired
        );
    }

    #[test]
    fn failure_before_flush_or_replace_keeps_previous_complete_record() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);

        let before_flush = advance_to_reconcile(&store);
        store.fail_next_before_flush();
        assert_eq!(
            store.compare_and_swap(
                &plan(),
                &before_flush.cas_snapshot(),
                JournalStoreCommand::ReconcileAttempt {
                    attempt: ReconcileAttempt::Failed,
                    proof: None,
                    timestamp: "2026-09-11T00:00:02Z".into(),
                },
            ),
            Err(JournalStoreError::Injected("beforeFlush"))
        );
        assert_eq!(store.read(&plan()).expect("old record"), before_flush);

        let before_replace = store.read(&plan()).expect("read before replace");
        store.fail_next_before_replace();
        assert_eq!(
            store.compare_and_swap(
                &plan(),
                &before_replace.cas_snapshot(),
                JournalStoreCommand::ReconcileAttempt {
                    attempt: ReconcileAttempt::Failed,
                    proof: None,
                    timestamp: "2026-09-11T00:00:02Z".into(),
                },
            ),
            Err(JournalStoreError::Injected("beforeReplace"))
        );
        assert_eq!(store.read(&plan()).expect("old record"), before_replace);

        let current = store.read(&plan()).expect("read current");
        let committed = store
            .compare_and_swap(
                &plan(),
                &current.cas_snapshot(),
                JournalStoreCommand::ReconcileAttempt {
                    attempt: ReconcileAttempt::Failed,
                    proof: None,
                    timestamp: "2026-09-11T00:00:02Z".into(),
                },
            )
            .expect("complete replacement");
        assert_eq!(store.read(&plan()).expect("new record"), committed);
    }

    #[test]
    fn typed_commands_reject_stale_or_illegal_mutations_without_disk_change() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);
        let before = store.read(&plan()).expect("initial record");

        let mut stale = before.cas_snapshot();
        stale.journal_revision += 1;
        assert_eq!(
            store.compare_and_swap(
                &plan(),
                &stale,
                JournalStoreCommand::Transition {
                    next_state: JournalState::ReconcileRequired,
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            ),
            Err(JournalStoreError::Conflict)
        );
        assert_eq!(
            store.read(&plan()).expect("stale rejection is unchanged"),
            before
        );

        assert_eq!(
            store.compare_and_swap(
                &plan(),
                &before.cas_snapshot(),
                JournalStoreCommand::Transition {
                    next_state: JournalState::Running,
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            ),
            Err(JournalStoreError::Journal(JournalError::InvalidTransition))
        );
        assert_eq!(
            store.read(&plan()).expect("illegal rejection is unchanged"),
            before
        );
    }

    #[test]
    fn foreign_temps_and_collision_files_are_never_deleted() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);

        let journal_name = store
            .journal_path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("journal name");
        let foreign_prefix = directory
            .path()
            .join(format!("{journal_name}{TEMP_MARKER}foreign"));
        fs::write(&foreign_prefix, b"foreign orphan").expect("foreign temp");

        let collision = directory
            .path()
            .join(format!("{journal_name}{TEMP_MARKER}collision"));
        fs::write(&collision, b"foreign collision").expect("collision temp");
        store.force_next_temp_path(collision.clone());
        let current = store.read(&plan()).expect("current record");
        assert_eq!(
            store.compare_and_swap(
                &plan(),
                &current.cas_snapshot(),
                JournalStoreCommand::Transition {
                    next_state: JournalState::ReconcileRequired,
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            ),
            Err(JournalStoreError::Io("createTemp"))
        );
        assert_eq!(
            fs::read(&collision).expect("collision retained"),
            b"foreign collision"
        );
        assert_eq!(
            fs::read(&foreign_prefix).expect("foreign orphan retained"),
            b"foreign orphan"
        );
    }

    #[test]
    fn replacement_flush_failure_is_reflushed_before_success() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);
        let before = store.read(&plan()).expect("initial record");
        store.fail_next_after_replace_before_flush();
        let result = store.compare_and_swap(
            &plan(),
            &before.cas_snapshot(),
            JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp: "2026-09-11T00:00:01Z".into(),
            },
        );
        assert_eq!(
            result.as_ref().map(|journal| journal.state),
            Ok(JournalState::ReconcileRequired)
        );
        let after = store.read(&plan()).expect("complete replacement");
        assert_eq!(after.state, JournalState::ReconcileRequired);
        assert_eq!(after.journal_revision, before.journal_revision + 1);
    }

    #[test]
    fn oversized_record_is_rejected_before_unbounded_read() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);
        fs::write(&store.journal_path, vec![b'x'; MAX_JOURNAL_BYTES + 1]).expect("large record");
        assert_eq!(store.read(&plan()), Err(JournalStoreError::TooLarge));
    }

    #[test]
    fn public_create_initial_rejects_oversized_payload_before_creating_journal() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        store.force_next_payload(vec![b'x'; MAX_JOURNAL_BYTES + 1]);
        assert_eq!(
            store.create_initial(&plan(), &initial_journal()),
            Err(JournalStoreError::TooLarge)
        );
        assert!(
            !store.journal_path.exists(),
            "oversized create left a journal"
        );
        assert!(
            fs::read_dir(directory.path())
                .expect("producer root")
                .all(|entry| {
                    let name = entry
                        .expect("directory entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned();
                    !name.contains(TEMP_MARKER)
                }),
            "oversized create left a temp file"
        );
    }

    #[test]
    fn public_cas_rejects_legal_large_binding_before_replacing_original() {
        let directory = tempdir().expect("tempdir");
        let large_plan = large_plan();
        let store = JournalStore::new(
            JournalStoreConfig::new(
                directory.path().to_path_buf(),
                "session-1".into(),
                large_plan.plan_digest.clone(),
            )
            .expect("large store config"),
        )
        .expect("large store");
        let initial = RuntimeSessionJournalV1::planned(
            &large_plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("large plan journal");
        store
            .create_initial(&large_plan, &initial)
            .expect("large plan initial journal");
        let original = fs::read(&store.journal_path).expect("original bytes");
        let binding = large_binding(&large_plan);
        let mut candidate = initial.clone();
        candidate
            .cas_prepare_bound(
                &large_plan,
                &initial.cas_snapshot(),
                binding.clone(),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("legal large candidate");
        assert!(
            candidate
                .encode_private()
                .expect("candidate encoding")
                .len()
                > MAX_JOURNAL_BYTES,
            "fixture did not exceed the store limit"
        );
        assert_eq!(
            store.compare_and_swap(
                &large_plan,
                &initial.cas_snapshot(),
                JournalStoreCommand::PrepareBound {
                    binding,
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            ),
            Err(JournalStoreError::TooLarge)
        );
        assert_eq!(
            fs::read(&store.journal_path).expect("original bytes retained"),
            original
        );
        assert_eq!(store.read(&large_plan).expect("original record"), initial);
    }

    #[test]
    fn public_read_times_out_under_live_lock_and_releases_holder() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);
        let holder = JournalFileLock::acquire(&store.lock_path).expect("lock holder");
        let contender = JournalStore::new(config(directory.path())).expect("contender store");
        let started = Instant::now();
        let thread = thread::spawn(move || contender.read(&plan()));
        let result = thread.join().expect("contender thread");
        let elapsed = started.elapsed();
        drop(holder);
        assert_eq!(result, Err(JournalStoreError::LockTimeout));
        assert!(
            elapsed >= LOCK_TIMEOUT,
            "contender did not actually wait for timeout"
        );
        assert!(
            elapsed < LOCK_TIMEOUT + Duration::from_secs(5),
            "lock timeout exceeded bounded upper limit: {elapsed:?}"
        );
        assert_eq!(
            store.read(&plan()).expect("holder cleanup read").state,
            JournalState::PlannedUnbound
        );
    }

    #[test]
    fn corrupt_or_torn_record_fails_closed_without_reset() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);
        fs::write(&store.journal_path, br#"{"schemaVersion":"#).expect("inject torn record");
        assert_eq!(store.read(&plan()), Err(JournalStoreError::CorruptJournal));
        assert_eq!(
            store.compare_and_swap(
                &plan(),
                &initial_journal().cas_snapshot(),
                JournalStoreCommand::Transition {
                    next_state: JournalState::ReconcileRequired,
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            ),
            Err(JournalStoreError::CorruptJournal)
        );
        assert_eq!(
            fs::read(&store.journal_path).expect("torn bytes"),
            br#"{"schemaVersion":"#
        );
    }

    #[test]
    fn journal_store_process_worker() {
        let Ok(root) = env::var("CAPTURE_JOURNAL_STORE_WORKER_ROOT") else {
            return;
        };
        let index = env::var("CAPTURE_JOURNAL_STORE_WORKER_INDEX").expect("worker index");
        let root = Path::new(&root);
        let store = store(root);
        let expected = store.read(&plan()).expect("worker read").cas_snapshot();
        fs::write(root.join(format!("worker-{index}.ready")), b"ready").expect("ready marker");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("worker.start").exists() {
            assert!(Instant::now() < deadline, "parent did not release workers");
            thread::sleep(Duration::from_millis(10));
        }

        let result = store.compare_and_swap(
            &plan(),
            &expected,
            JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp: "2026-09-11T00:00:01Z".into(),
            },
        );
        let outcome = match result {
            Ok(_) => "winner",
            Err(JournalStoreError::Conflict) => "conflict",
            Err(error) => panic!("unexpected worker result: {error:?}"),
        };
        fs::write(
            root.join(format!("worker-{index}.outcome")),
            outcome.as_bytes(),
        )
        .expect("outcome marker");
    }

    #[test]
    fn independent_processes_have_one_cas_winner() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);
        let executable = env::current_exe().expect("test executable");
        let mut children = Vec::new();
        for index in 0..2 {
            children.push(
                Command::new(&executable)
                    .arg("journal_store::tests::journal_store_process_worker")
                    .arg("--exact")
                    .arg("--nocapture")
                    .env("CAPTURE_JOURNAL_STORE_WORKER_ROOT", directory.path())
                    .env("CAPTURE_JOURNAL_STORE_WORKER_INDEX", index.to_string())
                    .spawn()
                    .expect("spawn worker"),
            );
        }
        let ready_deadline = Instant::now() + Duration::from_secs(5);
        while !(0..2).all(|index| {
            directory
                .path()
                .join(format!("worker-{index}.ready"))
                .exists()
        }) {
            assert!(
                Instant::now() < ready_deadline,
                "workers did not become ready"
            );
            thread::sleep(Duration::from_millis(10));
        }
        fs::write(directory.path().join("worker.start"), b"go").expect("release workers");

        for child in &mut children {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().expect("poll worker") {
                    assert!(status.success(), "worker exited unsuccessfully: {status}");
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "worker exceeded bounded test timeout"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
        let mut outcomes = (0..2)
            .map(|index| {
                fs::read_to_string(directory.path().join(format!("worker-{index}.outcome")))
                    .expect("worker outcome")
            })
            .collect::<Vec<_>>();
        outcomes.sort();
        assert_eq!(outcomes, vec!["conflict", "winner"]);
        assert_eq!(
            store.read(&plan()).expect("winner record").state,
            JournalState::ReconcileRequired
        );
    }

    #[test]
    fn producer_root_rejects_traversal_and_non_directory_paths() {
        let directory = tempdir().expect("tempdir");
        let file_path = directory.path().join("root-file");
        fs::write(&file_path, b"private root").expect("file");
        assert_eq!(
            JournalStoreConfig::new(file_path, "session-1".into(), DIGEST_A.into()),
            Err(JournalStoreError::PathSecurity)
        );
        let traversal = directory.path().join("child").join("..");
        assert_eq!(
            JournalStoreConfig::new(traversal, "session-1".into(), DIGEST_A.into()),
            Err(JournalStoreError::PathSecurity)
        );
    }
}
