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
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(all(test, windows))]
use std::collections::HashMap;

#[cfg(windows)]
use std::cell::RefCell;

#[cfg(all(test, windows))]
use std::sync::{Mutex, OnceLock};

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

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
};

const JOURNAL_PREFIX: &str = "runtime-session-";
const JOURNAL_SUFFIX: &str = ".json";
const LOCK_SUFFIX: &str = ".lock";
const AUXILIARY_INDEX_PREFIX: &str = "runtime-ref-index-v1-";
const AUXILIARY_INDEX_SUFFIX: &str = ".json";
const TEMP_MARKER: &str = ".tmp-";
const REPARSE_POINT_ATTRIBUTE: u32 = 0x0000_0400;
const MAX_JOURNAL_BYTES: usize = 1024 * 1024;
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
// A replace fails while any other handle (antivirus, indexer, backup or an
// observer) has the destination open, even with FILE_SHARE_DELETE. Retry
// only those transient conflicts, within a bounded budget of about 0.75 s.
#[cfg(windows)]
const REPLACE_RETRY_ATTEMPTS: u32 = 12;
#[cfg(windows)]
const REPLACE_RETRY_MAX_INTERVAL: Duration = Duration::from_millis(100);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(all(test, windows))]
struct RunningLockContentionRegistration {
    signal: Arc<AtomicBool>,
    force_deadline_after_contention: bool,
}

#[cfg(all(test, windows))]
static RUNNING_LOCK_CONTENTION_SIGNALS: OnceLock<
    Mutex<HashMap<PathBuf, RunningLockContentionRegistration>>,
> = OnceLock::new();

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
    AdmissionCancelled,
    AdmissionDeadline,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunningCasError {
    Cancelled,
    Deadline,
    Conflict,
    Storage,
}

/// The result of one producer-owned journal admission.  The predecessor is
/// retained even when the operation fails before replacement; an attempted
/// candidate is retained only as an attempt and is never authority by itself.
/// This is the one value passed across the store/staging/process boundaries so
/// an ambiguous write cannot lose the owner or be mistaken for a later disk
/// snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnedCasResult {
    predecessor: RuntimeSessionJournalV1,
    attempt: Option<RuntimeSessionJournalV1>,
    disposition: CasDisposition,
    error: Option<JournalStoreError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CasDisposition {
    /// No replacement was attempted; `attempt` is always `None`.
    Prewrite,
    /// The replacement and complete durable readback were confirmed.
    Committed,
    /// Replacement may have happened, but durable full readback is unknown.
    AmbiguousWrite,
    /// The replacement and durability barriers were confirmed, but the
    /// caller's authority budget ended before authority could be issued.
    ConfirmedLate,
}

impl OwnedCasResult {
    pub(crate) fn predecessor(&self) -> &RuntimeSessionJournalV1 {
        &self.predecessor
    }

    pub(crate) fn attempt(&self) -> Option<&RuntimeSessionJournalV1> {
        self.attempt.as_ref()
    }

    pub(crate) fn disposition(&self) -> CasDisposition {
        self.disposition
    }

    pub(crate) fn error(&self) -> Option<&JournalStoreError> {
        self.error.as_ref()
    }

    fn prewrite(predecessor: RuntimeSessionJournalV1, error: JournalStoreError) -> Self {
        Self {
            predecessor,
            attempt: None,
            disposition: CasDisposition::Prewrite,
            error: Some(error),
        }
    }

    fn ambiguous(
        predecessor: RuntimeSessionJournalV1,
        attempt: RuntimeSessionJournalV1,
        error: JournalStoreError,
    ) -> Self {
        Self {
            predecessor,
            attempt: Some(attempt),
            disposition: CasDisposition::AmbiguousWrite,
            error: Some(error),
        }
    }

    fn committed(predecessor: RuntimeSessionJournalV1, candidate: RuntimeSessionJournalV1) -> Self {
        Self {
            predecessor,
            attempt: Some(candidate),
            disposition: CasDisposition::Committed,
            error: None,
        }
    }

    fn confirmed_late(
        predecessor: RuntimeSessionJournalV1,
        candidate: RuntimeSessionJournalV1,
    ) -> Self {
        Self {
            predecessor,
            attempt: Some(candidate),
            disposition: CasDisposition::ConfirmedLate,
            error: None,
        }
    }

    pub(crate) fn with_error(mut self, error: JournalStoreError) -> Self {
        self.error = Some(error);
        self
    }

    pub(crate) fn mark_ambiguous(mut self, error: JournalStoreError) -> Self {
        self.disposition = CasDisposition::AmbiguousWrite;
        self.error = Some(error);
        self
    }

    fn into_legacy_result(self) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        self.attempt.ok_or(JournalStoreError::CorruptJournal)
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingCasError {
    Cancelled,
    Deadline,
    Conflict,
    Storage,
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

#[cfg(windows)]
#[derive(Clone)]
struct RunningReadBudget {
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
}

#[cfg(windows)]
thread_local! {
    static RUNNING_READ_BUDGET: RefCell<Option<RunningReadBudget>> = const { RefCell::new(None) };
}

#[derive(Debug)]
enum AtomicWriteOutcome {
    Written,
    FailedBeforeReplace(JournalStoreError),
    FailedAfterReplace(JournalStoreError),
}

#[cfg(windows)]
pub(crate) struct RunningReadBudgetScope {
    previous: Option<RunningReadBudget>,
}

#[cfg(windows)]
pub(crate) fn install_running_read_budget(
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
) -> RunningReadBudgetScope {
    RUNNING_READ_BUDGET.with(|slot| RunningReadBudgetScope {
        previous: slot.replace(Some(RunningReadBudget {
            deadline,
            cancellation,
        })),
    })
}

#[cfg(windows)]
impl Drop for RunningReadBudgetScope {
    fn drop(&mut self) {
        RUNNING_READ_BUDGET.with(|slot| {
            slot.replace(self.previous.take());
        });
    }
}

/// The one absolute activation budget shared by journal/index reads and the
/// native owner.  The cancellation flag is consulted while acquiring or
/// validating resources; cleanup and its follow-up reconcile CAS use the same
/// deadline but deliberately do not turn cancellation into a second abort
/// while the owned Job is being closed.
#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct ActivationBudget {
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
}

#[cfg(windows)]
impl ActivationBudget {
    pub(crate) fn new(deadline: Instant, cancellation: Arc<AtomicBool>) -> Self {
        Self {
            deadline,
            cancellation,
        }
    }

    pub(crate) fn deadline(&self) -> Instant {
        self.deadline
    }

    pub(crate) fn cancellation(&self) -> &AtomicBool {
        self.cancellation.as_ref()
    }

    /// Clone the one cancellation source owned by the activation coordinator.
    /// Private phase adapters use this accessor so they cannot accidentally
    /// create an independent cancellation flag for a later phase.
    pub(crate) fn cancellation_arc(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancellation)
    }

    pub(crate) fn check(&self) -> Result<(), JournalStoreError> {
        check_running_admission_budget(self.deadline, self.cancellation.as_ref())
    }

    pub(crate) fn check_deadline(&self) -> Result<(), JournalStoreError> {
        if Instant::now() >= self.deadline {
            Err(JournalStoreError::AdmissionDeadline)
        } else {
            Ok(())
        }
    }

    pub(crate) fn install_read_scope(&self) -> RunningReadBudgetScope {
        install_running_read_budget(self.deadline, Arc::clone(&self.cancellation))
    }
}

/// The only journal mutation seam for the Running promotion.  The lock and
/// the expected Launching value stay together while the native owner performs
/// its final observations; callers cannot replace the journal command or
/// unlock/reopen the store between validation and the typed Running CAS.
#[cfg(windows)]
pub(crate) struct RunningCasAdmission {
    store: Arc<JournalStore>,
    plan: JournalPlanValue,
    expected: RuntimeSessionJournalV1,
    current: RuntimeSessionJournalV1,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    _lock: JournalFileLock,
}

#[cfg(windows)]
pub(crate) struct ClosingCasAdmission {
    store: Arc<JournalStore>,
    plan: JournalPlanValue,
    expected: CasSnapshot,
    expected_journal: RuntimeSessionJournalV1,
    current: RuntimeSessionJournalV1,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    _lock: JournalFileLock,
}

/// A read-only teardown admission.  The journal lock is intentionally held
/// while the native owner performs its destructive cleanup and listener
/// observation; a reconciler therefore cannot advance the Closing record
/// after preflight and leave an older owner acting on it.
#[cfg(windows)]
pub(crate) struct ClosingCleanupAdmission {
    store: Arc<JournalStore>,
    plan: JournalPlanValue,
    expected: CasSnapshot,
    expected_journal: RuntimeSessionJournalV1,
    current: RuntimeSessionJournalV1,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    _lock: JournalFileLock,
}

/// A typed, exact-candidate admission for recording that an activation
/// failure needs reconciliation.  It is intentionally narrower than the
/// general command enum: callers cannot supply a replacement journal or
/// bypass the full candidate comparison under the OS lock.
#[cfg(windows)]
pub(crate) struct ActivationReconcileAdmission {
    store: Arc<JournalStore>,
    plan: JournalPlanValue,
    expected: CasSnapshot,
    expected_journal: RuntimeSessionJournalV1,
    current: RuntimeSessionJournalV1,
    deadline: Instant,
    _lock: JournalFileLock,
}

#[cfg(windows)]
pub(crate) enum RunningCasResult {
    Committed(RuntimeSessionJournalV1),
    CommittedAfterBudget(RuntimeSessionJournalV1),
}

#[cfg(windows)]
pub(crate) enum ClosingCasResult {
    Committed(RuntimeSessionJournalV1),
    CommittedAfterBudget(RuntimeSessionJournalV1),
}

#[cfg(windows)]
pub(crate) enum TerminalCasResult {
    Committed(RuntimeSessionJournalV1),
    CommittedAfterBudget(RuntimeSessionJournalV1),
}

#[cfg(windows)]
pub(crate) enum ActivationReconcileCasResult {
    Committed(RuntimeSessionJournalV1),
    CommittedAfterBudget(RuntimeSessionJournalV1),
}

#[cfg(test)]
#[derive(Default)]
struct TestFaults {
    after_durable_read: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    fail_durable_read: AtomicBool,
    owned_cas_calls: std::sync::atomic::AtomicUsize,
    fail_before_flush: AtomicBool,
    fail_auxiliary_before_flush: AtomicBool,
    fail_before_replace: AtomicBool,
    fail_after_replace_before_flush: AtomicBool,
    fail_after_auxiliary_replace_before_flush: AtomicBool,
    fail_durability_recheck: AtomicBool,
    fail_auxiliary_durability_recheck: AtomicBool,
    forced_temp_path: std::sync::Mutex<Option<PathBuf>>,
    forced_payload: std::sync::Mutex<Option<Vec<u8>>>,
    cancel_before_running_replace: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    cancel_after_running_replace: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    cancel_before_closing_replace: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    cancel_after_closing_replace: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    cancel_after_closing_readback: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    cancel_before_terminal_replace: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    cancel_after_terminal_replace: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    #[cfg(all(test, windows))]
    expire_after_activation_reconcile_readback: AtomicBool,
    #[cfg(all(test, windows))]
    expire_after_running_readback: AtomicBool,
    #[cfg(all(test, windows))]
    expire_after_terminal_candidate_readback: AtomicBool,
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

    /// Re-establish both final-file and directory durability before parsing
    /// an exact retry value. A plain read is insufficient after a flush or
    /// replace error because it cannot prove the record survived the same
    /// durability barriers as the original admission.
    #[cfg(windows)]
    pub(crate) fn read_exact_durable(
        &self,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        expected
            .validate_against_plan(plan)
            .map_err(JournalStoreError::Journal)?;
        self.with_lock(|store| {
            let read_back = store.reestablish_candidate_durability_unlocked(plan, expected)?;
            if read_back != *expected {
                return Err(JournalStoreError::Conflict);
            }
            Ok(read_back)
        })
    }

    #[cfg(windows)]
    pub(crate) fn read_durable(
        &self,
        plan: &JournalPlanValue,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        let current = self.with_lock(|store| {
            #[cfg(test)]
            if store.faults.fail_durable_read.swap(false, Ordering::AcqRel) {
                return Err(JournalStoreError::Durability("retryFinalFlush"));
            }
            let final_file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&store.journal_path)
                .map_err(|_| JournalStoreError::AtomicReplace)?;
            final_file
                .sync_all()
                .map_err(|_| JournalStoreError::Durability("retryFinalFlush"))?;
            sync_directory(&store.config.producer_root)?;
            store.read_unlocked(plan)
        })?;
        #[cfg(test)]
        if let Some(action) = self.faults.after_durable_read.lock().unwrap().take() {
            action();
        }
        Ok(current)
    }

    #[cfg(all(test, windows))]
    pub(crate) fn after_durable_read_for_test(&self, action: impl FnOnce() + Send + 'static) {
        *self.faults.after_durable_read.lock().unwrap() = Some(Box::new(action));
    }

    #[cfg(all(test, windows))]
    pub(crate) fn fail_exact_durability_for_test(&self) {
        self.faults
            .fail_durability_recheck
            .store(true, Ordering::Release);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn fail_durable_read_for_test(&self) {
        self.faults.fail_durable_read.store(true, Ordering::Release);
    }

    pub(crate) fn create_or_read_immutable_auxiliary(
        &self,
        address_key: &str,
        encoded: &[u8],
    ) -> Result<Vec<u8>, JournalStoreError> {
        let index_path = auxiliary_index_path(&self.config.producer_root, address_key)?;
        let index_lock_path = auxiliary_lock_path(&self.config.producer_root, address_key)?;
        self.with_lock(|store| {
            let _index_lock = acquire_scoped_lock(&index_lock_path)?;
            if path_exists(&index_path)? {
                // An existing index is immutable.  Re-apply the final-file and
                // directory barriers before handing its bytes to the codec so
                // an exact replay also re-establishes durability.
                return store.reestablish_existing_record_durability_unlocked(&index_path);
            }
            match store.write_atomic_at_unlocked(&index_path, encoded, false) {
                Ok(()) => store.read_bounded_record_unlocked(&index_path),
                Err(write_error) => {
                    if let Ok(read_back) =
                        store.reestablish_record_durability_unlocked(&index_path, encoded)
                    {
                        return Ok(read_back);
                    }
                    Err(write_error)
                }
            }
        })
    }

    pub(crate) fn read_immutable_auxiliary(
        producer_root: &Path,
        address_key: &str,
    ) -> Result<Vec<u8>, JournalStoreError> {
        validate_producer_root(producer_root)?;
        let index_path = auxiliary_index_path(producer_root, address_key)?;
        let index_lock_path = auxiliary_lock_path(producer_root, address_key)?;
        let _index_lock = acquire_scoped_lock(&index_lock_path)?;
        validate_producer_root(producer_root)?;
        read_bounded_record_path(&index_path)
    }

    /// Lock and retain the exact phase value that cleanup observed.  The
    /// cancellation flag is intentionally not an input: once the native
    /// owner has been closed, this bounded bookkeeping step should still make
    /// the durable reconcile intent when time remains.  A later journal value
    /// is never accepted as a substitute for the retained candidate.
    #[cfg(windows)]
    pub(crate) fn begin_activation_reconcile(
        self: &Arc<Self>,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
    ) -> Result<ActivationReconcileAdmission, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        expected
            .validate_against_plan(plan)
            .map_err(JournalStoreError::Journal)?;
        if !matches!(
            expected.state,
            JournalState::PreparedBound
                | JournalState::Ready
                | JournalState::Launching
                | JournalState::Running
        ) {
            return Err(JournalStoreError::Conflict);
        }
        if expected.session_nonce != self.config.session_nonce
            || expected.plan_digest != self.config.plan_digest
        {
            return Err(JournalStoreError::Conflict);
        }
        if Instant::now() >= deadline {
            return Err(JournalStoreError::AdmissionDeadline);
        }
        validate_producer_root(&self.config.producer_root)?;
        // Cleanup has already honoured cancellation.  Use a local false flag
        // here so a requested cancellation cannot strand a valid reconcile
        // transition, while the absolute deadline still bounds lock wait.
        let no_cancellation = AtomicBool::new(false);
        let lock = JournalFileLock::acquire_until(&self.lock_path, deadline, &no_cancellation)?;
        validate_producer_root(&self.config.producer_root)?;
        let current = self.read_unlocked(plan)?;
        if current != *expected || current.cas_snapshot() != expected.cas_snapshot() {
            return Err(JournalStoreError::Conflict);
        }
        if Instant::now() >= deadline {
            return Err(JournalStoreError::AdmissionDeadline);
        }
        Ok(ActivationReconcileAdmission {
            store: Arc::clone(self),
            plan: plan.clone(),
            expected: expected.cas_snapshot(),
            expected_journal: expected.clone(),
            current,
            deadline,
            _lock: lock,
        })
    }

    /// Acquire the journal lock for the private Running admission.  The
    /// expected Launching value is read while that lock is held and retained
    /// in the guard until the typed Running command commits.  This lets the
    /// native owner repeat its final checks after lock contention without a
    /// read-then-write gap.
    #[cfg(windows)]
    pub(crate) fn begin_running_admission(
        self: &Arc<Self>,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<RunningCasAdmission, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        check_running_admission_budget(deadline, cancellation.as_ref())?;
        validate_producer_root(&self.config.producer_root)?;
        let lock =
            JournalFileLock::acquire_until(&self.lock_path, deadline, cancellation.as_ref())?;
        validate_producer_root(&self.config.producer_root)?;
        let current = self.read_unlocked(plan)?;
        if current != *expected {
            return Err(JournalStoreError::Conflict);
        }
        check_running_admission_budget(deadline, cancellation.as_ref())?;
        Ok(RunningCasAdmission {
            store: Arc::clone(self),
            plan: plan.clone(),
            expected: expected.clone(),
            current,
            deadline,
            cancellation,
            _lock: lock,
        })
    }

    /// Acquire the journal lock for the private Running -> Closing admission.
    /// The complete retained Running value is checked while the lock is held;
    /// the close command therefore cannot turn a stale or partially changed
    /// resource tuple into teardown intent.
    #[cfg(windows)]
    pub(crate) fn begin_closing_admission(
        self: &Arc<Self>,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<ClosingCasAdmission, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        if expected.state != JournalState::Running {
            return Err(JournalStoreError::Conflict);
        }
        check_running_admission_budget(deadline, cancellation.as_ref())?;
        validate_producer_root(&self.config.producer_root)?;
        let lock =
            JournalFileLock::acquire_until(&self.lock_path, deadline, cancellation.as_ref())?;
        validate_producer_root(&self.config.producer_root)?;
        let current = self.read_unlocked(plan)?;
        if current != *expected || current.cas_snapshot() != expected.cas_snapshot() {
            return Err(JournalStoreError::Conflict);
        }
        check_running_admission_budget(deadline, cancellation.as_ref())?;
        Ok(ClosingCasAdmission {
            store: Arc::clone(self),
            plan: plan.clone(),
            expected: expected.cas_snapshot(),
            expected_journal: expected.clone(),
            current,
            deadline,
            cancellation,
            _lock: lock,
        })
    }

    /// Acquire the journal lock and retain the exact Closing value for the
    /// entire native cleanup observation.  The caller validates the immutable
    /// address index before entering this method; this method is the single
    /// full journal snapshot check under the lock and performs no nested read.
    #[cfg(windows)]
    pub(crate) fn begin_closing_cleanup_admission(
        self: &Arc<Self>,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<ClosingCleanupAdmission, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        expected
            .validate_against_plan(plan)
            .map_err(JournalStoreError::Journal)?;
        if expected.state != JournalState::Closing
            || expected.session_nonce != self.config.session_nonce
            || expected.plan_digest != self.config.plan_digest
        {
            return Err(JournalStoreError::Conflict);
        }
        check_running_admission_budget(deadline, cancellation.as_ref())?;
        validate_producer_root(&self.config.producer_root)?;
        let lock =
            JournalFileLock::acquire_until(&self.lock_path, deadline, cancellation.as_ref())?;
        validate_producer_root(&self.config.producer_root)?;
        let current = self.read_unlocked(plan)?;
        if current != *expected || current.cas_snapshot() != expected.cas_snapshot() {
            return Err(JournalStoreError::Conflict);
        }
        check_running_admission_budget(deadline, cancellation.as_ref())?;
        Ok(ClosingCleanupAdmission {
            store: Arc::clone(self),
            plan: plan.clone(),
            expected: current.cas_snapshot(),
            expected_journal: current.clone(),
            current,
            deadline,
            cancellation,
            _lock: lock,
        })
    }

    #[cfg(all(test, windows))]
    pub(crate) fn lock_for_test(&self) -> Result<JournalFileLock, JournalStoreError> {
        JournalFileLock::acquire(&self.lock_path)
    }

    #[cfg(all(test, windows))]
    pub(crate) fn set_running_lock_contention_signal_for_test(
        &self,
        signal: Option<Arc<AtomicBool>>,
    ) {
        self.set_running_lock_contention_signal_for_path_for_test(self.lock_path.clone(), signal);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn set_running_auxiliary_contention_signal_for_test(
        &self,
        address_key: &str,
        signal: Option<Arc<AtomicBool>>,
    ) {
        let path = auxiliary_lock_path(&self.config.producer_root, address_key)
            .expect("valid auxiliary lock path");
        self.set_running_lock_contention_signal_for_path_for_test(path, signal);
    }

    #[cfg(all(test, windows))]
    fn set_running_lock_contention_signal_for_path_for_test(
        &self,
        path: PathBuf,
        signal: Option<Arc<AtomicBool>>,
    ) {
        let slot = RUNNING_LOCK_CONTENTION_SIGNALS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut registrations = slot.lock().unwrap();
        match signal {
            Some(signal) => {
                registrations.insert(
                    path,
                    RunningLockContentionRegistration {
                        signal,
                        force_deadline_after_contention: false,
                    },
                );
            }
            None => {
                registrations.remove(&path);
            }
        }
    }

    #[cfg(all(test, windows))]
    pub(crate) fn set_running_lock_deadline_after_contention_for_test(
        &self,
        signal: Arc<AtomicBool>,
    ) {
        let slot = RUNNING_LOCK_CONTENTION_SIGNALS.get_or_init(|| Mutex::new(HashMap::new()));
        slot.lock().unwrap().insert(
            self.lock_path.clone(),
            RunningLockContentionRegistration {
                signal,
                force_deadline_after_contention: true,
            },
        );
    }

    pub(crate) fn compare_and_swap(
        &self,
        plan: &JournalPlanValue,
        expected: &CasSnapshot,
        command: JournalStoreCommand,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        self.validate_plan_identity(plan)?;
        self.with_lock(|store| {
            let predecessor = store.read_unlocked(plan)?;
            if predecessor.cas_snapshot() != *expected {
                return Err(JournalStoreError::Conflict);
            }
            store
                .compare_and_swap_owned_locked(plan, &predecessor, command)
                .into_legacy_result()
        })
    }

    /// The production CAS seam.  The complete predecessor and attempted
    /// candidate travel together through every post-readback branch, so a
    /// caller can retain its owner without inferring a phase from a later
    /// journal read.  Validation/lock failures are represented as a Prewrite
    /// result with the caller's exact predecessor.
    pub(crate) fn compare_and_swap_owned(
        &self,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
        command: JournalStoreCommand,
    ) -> OwnedCasResult {
        if let Err(error) = self.validate_plan_identity(plan) {
            return OwnedCasResult::prewrite(expected.clone(), error);
        }
        match self
            .with_lock(|store| Ok(store.compare_and_swap_owned_locked(plan, expected, command)))
        {
            Ok(result) => result,
            Err(error) => OwnedCasResult::prewrite(expected.clone(), error),
        }
    }

    fn compare_and_swap_owned_locked(
        &self,
        plan: &JournalPlanValue,
        expected: &RuntimeSessionJournalV1,
        command: JournalStoreCommand,
    ) -> OwnedCasResult {
        let predecessor = match self.read_unlocked(plan) {
            Ok(current) => current,
            Err(error) => return OwnedCasResult::prewrite(expected.clone(), error),
        };
        if predecessor != *expected || predecessor.cas_snapshot() != expected.cas_snapshot() {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Conflict);
        }
        let mut candidate = predecessor.clone();
        if let Err(error) = apply_command(&mut candidate, plan, &expected.cas_snapshot(), command)
            .map_err(|error| match error {
                JournalError::StaleCas => JournalStoreError::Conflict,
                error => JournalStoreError::Journal(error),
            })
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        if let Err(error) = candidate.validate_against_plan(plan) {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Journal(error));
        }
        self.write_candidate_with_readback_unlocked(plan, predecessor, candidate, None, None)
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
        let _lock = acquire_scoped_lock(&self.lock_path)?;
        validate_producer_root(&self.config.producer_root)?;
        operation(self)
    }

    fn read_unlocked(
        &self,
        plan: &JournalPlanValue,
    ) -> Result<RuntimeSessionJournalV1, JournalStoreError> {
        let bytes = self.read_bounded_record_unlocked(&self.journal_path)?;
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
        #[cfg(all(test, windows))]
        if self
            .faults
            .expire_after_terminal_candidate_readback
            .swap(false, Ordering::AcqRel)
        {
            RUNNING_READ_BUDGET.with(|slot| {
                if let Some(budget) = slot.borrow().clone() {
                    let remaining = budget.deadline.saturating_duration_since(Instant::now());
                    if !remaining.is_zero() {
                        thread::sleep(remaining);
                    }
                }
            });
        }
        Ok(journal)
    }

    fn read_bounded_record_unlocked(&self, path: &Path) -> Result<Vec<u8>, JournalStoreError> {
        read_bounded_record_path(path)
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

    /// Write one fully validated candidate and perform the complete
    /// final-file, directory, and journal readback sequence.  `None` budget
    /// is used by the legacy/generic seam; typed lifecycle admissions pass
    /// their caller-owned deadline and cancellation source.
    fn write_candidate_with_readback_unlocked(
        &self,
        plan: &JournalPlanValue,
        predecessor: RuntimeSessionJournalV1,
        candidate: RuntimeSessionJournalV1,
        deadline: Option<Instant>,
        cancellation: Option<&AtomicBool>,
    ) -> OwnedCasResult {
        let bytes = match candidate.encode_private() {
            Ok(bytes) => bytes,
            Err(error) => {
                return OwnedCasResult::prewrite(predecessor, JournalStoreError::Journal(error))
            }
        };
        let outcome = self.write_atomic_at_outcome_unlocked(&self.journal_path, &bytes, true);
        let read_back = match outcome {
            AtomicWriteOutcome::Written => match self.read_unlocked(plan) {
                Ok(read_back) => read_back,
                Err(error) => {
                    return OwnedCasResult::ambiguous(predecessor, candidate, error);
                }
            },
            AtomicWriteOutcome::FailedBeforeReplace(error) => {
                return OwnedCasResult::prewrite(predecessor, error);
            }
            AtomicWriteOutcome::FailedAfterReplace(_write_error) => {
                // The write path reports the actual replacement stage.  Only
                // this branch may attempt the durability recovery; a failed
                // pre-replacement write must retain the predecessor with no
                // candidate authority.
                match self.reestablish_candidate_durability_unlocked(plan, &candidate) {
                    Ok(read_back) => read_back,
                    Err(error) => {
                        return OwnedCasResult::ambiguous(predecessor, candidate, error);
                    }
                }
            }
        };
        if read_back != candidate {
            return OwnedCasResult::ambiguous(
                predecessor,
                candidate,
                JournalStoreError::CorruptJournal,
            );
        }
        if let (Some(deadline), Some(cancellation)) = (deadline, cancellation) {
            if cancellation_requested(cancellation) || Instant::now() >= deadline {
                return OwnedCasResult::confirmed_late(predecessor, read_back);
            }
        }
        OwnedCasResult::committed(predecessor, read_back)
    }

    fn reestablish_record_durability_unlocked(
        &self,
        path: &Path,
        expected: &[u8],
    ) -> Result<Vec<u8>, JournalStoreError> {
        let final_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|_| JournalStoreError::AtomicReplace)?;
        #[cfg(test)]
        if self
            .faults
            .fail_auxiliary_durability_recheck
            .swap(false, Ordering::AcqRel)
        {
            return Err(JournalStoreError::Injected("auxiliaryDurabilityRecheck"));
        }
        final_file
            .sync_all()
            .map_err(|_| JournalStoreError::Durability("recoveryFinalFlush"))?;
        sync_directory(&self.config.producer_root)?;
        let read_back = self.read_bounded_record_unlocked(path)?;
        if read_back != expected {
            return Err(JournalStoreError::CorruptJournal);
        }
        Ok(read_back)
    }

    fn reestablish_existing_record_durability_unlocked(
        &self,
        path: &Path,
    ) -> Result<Vec<u8>, JournalStoreError> {
        let final_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|_| JournalStoreError::AtomicReplace)?;
        final_file
            .sync_all()
            .map_err(|_| JournalStoreError::Durability("recoveryFinalFlush"))?;
        sync_directory(&self.config.producer_root)?;
        self.read_bounded_record_unlocked(path)
    }

    fn write_atomic_unlocked(
        &self,
        encoded: &[u8],
        replace_existing: bool,
    ) -> Result<(), JournalStoreError> {
        self.write_atomic_at_unlocked(&self.journal_path, encoded, replace_existing)
    }

    fn write_atomic_at_unlocked(
        &self,
        target_path: &Path,
        encoded: &[u8],
        replace_existing: bool,
    ) -> Result<(), JournalStoreError> {
        match self.write_atomic_at_outcome_unlocked(target_path, encoded, replace_existing) {
            AtomicWriteOutcome::Written => Ok(()),
            AtomicWriteOutcome::FailedBeforeReplace(error)
            | AtomicWriteOutcome::FailedAfterReplace(error) => Err(error),
        }
    }

    fn write_atomic_at_outcome_unlocked(
        &self,
        target_path: &Path,
        encoded: &[u8],
        replace_existing: bool,
    ) -> AtomicWriteOutcome {
        #[cfg(test)]
        let forced_payload = self.faults.forced_payload.lock().unwrap().take();
        #[cfg(test)]
        let bytes = forced_payload.as_deref().unwrap_or(encoded);
        #[cfg(not(test))]
        let bytes = encoded;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return AtomicWriteOutcome::FailedBeforeReplace(JournalStoreError::TooLarge);
        }
        let temp_path = self.temp_path_for_target(target_path);
        let mut created_temp = false;
        let mut replace_attempted = false;
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
            if (target_path == self.journal_path.as_path()
                && self.faults.fail_before_flush.swap(false, Ordering::AcqRel))
                || (target_path != self.journal_path.as_path()
                    && self
                        .faults
                        .fail_auxiliary_before_flush
                        .swap(false, Ordering::AcqRel))
            {
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
            replace_attempted = true;
            atomic_move(&temp_path, target_path, replace_existing)?;
            let final_file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(target_path)
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
            #[cfg(test)]
            if target_path != self.journal_path.as_path()
                && self
                    .faults
                    .fail_after_auxiliary_replace_before_flush
                    .swap(false, Ordering::AcqRel)
            {
                return Err(JournalStoreError::Injected(
                    "auxiliaryAfterReplaceBeforeFlush",
                ));
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
        match result {
            Ok(()) => AtomicWriteOutcome::Written,
            Err(error) if replace_attempted => AtomicWriteOutcome::FailedAfterReplace(error),
            Err(error) => AtomicWriteOutcome::FailedBeforeReplace(error),
        }
    }

    fn temp_path(&self) -> PathBuf {
        self.temp_path_for_target(&self.journal_path)
    }

    fn temp_path_for_target(&self, target_path: &Path) -> PathBuf {
        #[cfg(test)]
        if let Some(path) = self.faults.forced_temp_path.lock().unwrap().take() {
            return path;
        }
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        self.temp_path_for(target_path, counter)
    }

    fn temp_path_for(&self, target_path: &Path, counter: u64) -> PathBuf {
        let file_name = target_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("runtime-session");
        target_path
            .parent()
            .unwrap_or(&self.config.producer_root)
            .join(format!(
                "{file_name}{TEMP_MARKER}{}-{counter}",
                std::process::id()
            ))
    }

    #[cfg(test)]
    fn fail_next_before_flush(&self) {
        self.faults.fail_before_flush.store(true, Ordering::Release);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn owned_cas_calls_for_test(&self) -> usize {
        self.faults.owned_cas_calls.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn fail_next_before_replace_for_test(&self) {
        self.faults
            .fail_before_replace
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn replace_journal_for_test(&self, journal: &RuntimeSessionJournalV1) {
        let bytes = journal.encode_private().expect("valid test journal");
        fs::write(&self.journal_path, bytes).expect("replace test journal");
    }

    #[cfg(all(test, windows))]
    pub(crate) fn remove_journal_for_test(&self) {
        fs::remove_file(&self.journal_path).expect("remove test journal");
    }

    #[cfg(all(test, windows))]
    pub(crate) fn corrupt_journal_for_test(&self) {
        fs::write(&self.journal_path, b"corrupt-test-journal").expect("corrupt test journal");
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

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_before_running_replace_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_before_running_replace.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_after_running_replace_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_after_running_replace.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_before_closing_replace_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_before_closing_replace.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_after_closing_replace_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_after_closing_replace.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_after_closing_readback_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_after_closing_readback.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_before_terminal_replace_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_before_terminal_replace.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_after_terminal_replace_for_test(&self, cancellation: Arc<AtomicBool>) {
        *self.faults.cancel_after_terminal_replace.lock().unwrap() = Some(cancellation);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn expire_after_activation_reconcile_readback_for_test(&self) {
        self.faults
            .expire_after_activation_reconcile_readback
            .store(true, Ordering::Release);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn expire_after_running_readback_for_test(&self) {
        self.faults
            .expire_after_running_readback
            .store(true, Ordering::Release);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn expire_after_terminal_candidate_readback_for_test(&self) {
        self.faults
            .expire_after_terminal_candidate_readback
            .store(true, Ordering::Release);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn take_cancel_after_closing_readback_for_test(&self) -> Option<Arc<AtomicBool>> {
        self.faults
            .cancel_after_closing_readback
            .lock()
            .unwrap()
            .take()
    }

    #[cfg(test)]
    pub(crate) fn fail_auxiliary_after_replace_and_durability_recheck(&self) {
        self.faults
            .fail_after_auxiliary_replace_before_flush
            .store(true, Ordering::Release);
        self.faults
            .fail_auxiliary_durability_recheck
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_auxiliary_after_replace_before_flush(&self) {
        self.faults
            .fail_after_auxiliary_replace_before_flush
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_auxiliary_before_flush(&self) {
        self.faults
            .fail_auxiliary_before_flush
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

#[cfg(windows)]
fn acquire_scoped_lock(path: &Path) -> Result<JournalFileLock, JournalStoreError> {
    RUNNING_READ_BUDGET.with(|slot| {
        let budget = slot.borrow().clone();
        match budget {
            Some(budget) => {
                JournalFileLock::acquire_until(path, budget.deadline, budget.cancellation.as_ref())
            }
            None => JournalFileLock::acquire(path),
        }
    })
}

#[cfg(not(windows))]
fn acquire_scoped_lock(path: &Path) -> Result<JournalFileLock, JournalStoreError> {
    JournalFileLock::acquire(path)
}

#[cfg(all(test, windows))]
fn signal_running_lock_contention_for_test(path: &Path) -> bool {
    let Some(slot) = RUNNING_LOCK_CONTENTION_SIGNALS.get() else {
        return false;
    };
    slot.lock()
        .unwrap()
        .get(path)
        .map(|registration| {
            registration.signal.store(true, Ordering::Release);
            registration.force_deadline_after_contention
        })
        .unwrap_or(false)
}

#[cfg(windows)]
impl RunningCasAdmission {
    pub(crate) fn current(&self) -> &RuntimeSessionJournalV1 {
        &self.current
    }

    /// Apply only the canonical Launching -> Running transition while the
    /// admission lock is still held.  The deadline/cancellation check directly
    /// before the replacement is intentionally duplicated after encoding: it
    /// closes the last pre-write window without changing other journal APIs.
    pub(crate) fn commit_running(
        self,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<RunningCasResult, JournalStoreError> {
        let result = self.commit_running_owned(observation, timestamp);
        match result.disposition() {
            CasDisposition::Committed => Ok(RunningCasResult::Committed(
                result.attempt().cloned().expect("committed candidate"),
            )),
            CasDisposition::ConfirmedLate => Ok(RunningCasResult::CommittedAfterBudget(
                result.attempt().cloned().expect("late candidate"),
            )),
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => Err(result
                .error()
                .cloned()
                .unwrap_or(JournalStoreError::CorruptJournal)),
        }
    }

    pub(crate) fn commit_running_owned(
        mut self,
        observation: ResourceObservation,
        timestamp: String,
    ) -> OwnedCasResult {
        let predecessor = self.current.clone();
        if let Err(error) =
            check_running_admission_budget(self.deadline, self.cancellation.as_ref())
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        if self.current != self.expected {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Conflict);
        }
        if let Err(error) = apply_command(
            &mut self.current,
            &self.plan,
            &self.expected.cas_snapshot(),
            JournalStoreCommand::TransitionWithObservation {
                next_state: JournalState::Running,
                observation,
                timestamp,
            },
        )
        .map_err(|error| match error {
            JournalError::StaleCas => JournalStoreError::Conflict,
            error => JournalStoreError::Journal(error),
        }) {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let candidate = self.current.clone();
        if let Err(error) = candidate.validate_against_plan(&self.plan) {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Journal(error));
        }
        #[cfg(test)]
        if let Some(cancellation) = self
            .store
            .faults
            .cancel_before_running_replace
            .lock()
            .unwrap()
            .take()
        {
            cancellation.store(true, Ordering::Release);
        }
        if let Err(error) =
            check_running_admission_budget(self.deadline, self.cancellation.as_ref())
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let mut result = self.store.write_candidate_with_readback_unlocked(
            &self.plan,
            predecessor,
            candidate,
            Some(self.deadline),
            Some(self.cancellation.as_ref()),
        );
        #[cfg(all(test, windows))]
        if matches!(result.disposition(), CasDisposition::Committed)
            && self
                .store
                .faults
                .expire_after_running_readback
                .swap(false, Ordering::AcqRel)
        {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if !remaining.is_zero() {
                std::thread::sleep(remaining);
            }
        }
        #[cfg(test)]
        if let Some(cancellation) = self
            .store
            .faults
            .cancel_after_running_replace
            .lock()
            .unwrap()
            .take()
        {
            cancellation.store(true, Ordering::Release);
        }
        if matches!(result.disposition(), CasDisposition::Committed)
            && (cancellation_requested(self.cancellation.as_ref())
                || Instant::now() >= self.deadline)
        {
            let predecessor = result.predecessor().clone();
            let candidate = result.attempt().cloned().expect("committed candidate");
            result = OwnedCasResult::confirmed_late(predecessor, candidate);
        }
        result
    }
}

#[cfg(windows)]
impl ActivationReconcileAdmission {
    pub(crate) fn current(&self) -> &RuntimeSessionJournalV1 {
        &self.current
    }

    /// Convert the retained exact phase to ReconcileRequired while the same
    /// journal lock remains held.  This keeps the resource tuple, binding,
    /// attempt and recovery epoch unchanged; a stale or ambiguous candidate
    /// returns an error and never issues a reconcile authority.
    pub(crate) fn commit_reconcile_required(
        self,
        timestamp: String,
    ) -> Result<ActivationReconcileCasResult, JournalStoreError> {
        let result = self.commit_reconcile_required_owned(timestamp);
        match result.disposition() {
            CasDisposition::Committed => Ok(ActivationReconcileCasResult::Committed(
                result.attempt().cloned().expect("reconcile candidate"),
            )),
            CasDisposition::ConfirmedLate => {
                Ok(ActivationReconcileCasResult::CommittedAfterBudget(
                    result.attempt().cloned().expect("late reconcile candidate"),
                ))
            }
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => Err(result
                .error()
                .cloned()
                .unwrap_or(JournalStoreError::CorruptJournal)),
        }
    }

    pub(crate) fn commit_reconcile_required_owned(mut self, timestamp: String) -> OwnedCasResult {
        #[cfg(test)]
        self.store
            .faults
            .owned_cas_calls
            .fetch_add(1, Ordering::AcqRel);
        let predecessor = self.current.clone();
        if let Err(error) = check_running_admission_budget(self.deadline, &AtomicBool::new(false)) {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        if self.current != self.expected_journal || self.current.cas_snapshot() != self.expected {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Conflict);
        }
        if let Err(error) = apply_command(
            &mut self.current,
            &self.plan,
            &self.expected,
            JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp,
            },
        )
        .map_err(|error| match error {
            JournalError::StaleCas => JournalStoreError::Conflict,
            error => JournalStoreError::Journal(error),
        }) {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let candidate = self.current.clone();
        if let Err(error) = candidate.validate_against_plan(&self.plan) {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Journal(error));
        }
        if let Err(error) = check_running_admission_budget(self.deadline, &AtomicBool::new(false)) {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let mut result = self.store.write_candidate_with_readback_unlocked(
            &self.plan,
            predecessor,
            candidate,
            Some(self.deadline),
            None,
        );
        #[cfg(all(test, windows))]
        let test_expired = self
            .store
            .faults
            .expire_after_activation_reconcile_readback
            .swap(false, Ordering::AcqRel);
        #[cfg(not(all(test, windows)))]
        let test_expired = false;
        if matches!(result.disposition(), CasDisposition::Committed)
            && (test_expired || Instant::now() >= self.deadline)
        {
            let predecessor = result.predecessor().clone();
            let candidate = result.attempt().cloned().expect("reconcile candidate");
            result = OwnedCasResult::confirmed_late(predecessor, candidate);
        }
        result
    }
}

#[cfg(windows)]
impl ClosingCasAdmission {
    pub(crate) fn current(&self) -> &RuntimeSessionJournalV1 {
        &self.current
    }

    /// Apply only the canonical Running -> Closing transition while the
    /// admission lock remains held.  Closing is teardown intent: it retains
    /// the observed readiness/resource tuple and does not query liveness,
    /// listeners, commands, or staging.
    pub(crate) fn commit_closing(
        self,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<ClosingCasResult, JournalStoreError> {
        let result = self.commit_closing_owned(observation, timestamp);
        match result.disposition() {
            CasDisposition::Committed => Ok(ClosingCasResult::Committed(
                result.attempt().cloned().expect("closing candidate"),
            )),
            CasDisposition::ConfirmedLate => Ok(ClosingCasResult::CommittedAfterBudget(
                result.attempt().cloned().expect("late closing candidate"),
            )),
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => Err(result
                .error()
                .cloned()
                .unwrap_or(JournalStoreError::CorruptJournal)),
        }
    }

    pub(crate) fn commit_closing_owned(
        mut self,
        observation: ResourceObservation,
        timestamp: String,
    ) -> OwnedCasResult {
        #[cfg(test)]
        self.store
            .faults
            .owned_cas_calls
            .fetch_add(1, Ordering::AcqRel);
        let predecessor = self.current.clone();
        if let Err(error) =
            check_running_admission_budget(self.deadline, self.cancellation.as_ref())
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        if self.current != self.expected_journal || self.current.cas_snapshot() != self.expected {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Conflict);
        }
        if let Err(error) = apply_command(
            &mut self.current,
            &self.plan,
            &self.expected,
            JournalStoreCommand::TransitionWithObservation {
                next_state: JournalState::Closing,
                observation,
                timestamp,
            },
        )
        .map_err(|error| match error {
            JournalError::StaleCas => JournalStoreError::Conflict,
            error => JournalStoreError::Journal(error),
        }) {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let candidate = self.current.clone();
        if let Err(error) = candidate.validate_against_plan(&self.plan) {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Journal(error));
        }
        #[cfg(test)]
        if let Some(cancellation) = self
            .store
            .faults
            .cancel_before_closing_replace
            .lock()
            .unwrap()
            .take()
        {
            cancellation.store(true, Ordering::Release);
        }
        if let Err(error) =
            check_running_admission_budget(self.deadline, self.cancellation.as_ref())
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let mut result = self.store.write_candidate_with_readback_unlocked(
            &self.plan,
            predecessor,
            candidate,
            Some(self.deadline),
            Some(self.cancellation.as_ref()),
        );
        #[cfg(test)]
        if let Some(cancellation) = self
            .store
            .faults
            .cancel_after_closing_replace
            .lock()
            .unwrap()
            .take()
        {
            cancellation.store(true, Ordering::Release);
        }
        if matches!(result.disposition(), CasDisposition::Committed)
            && (cancellation_requested(self.cancellation.as_ref())
                || Instant::now() >= self.deadline)
        {
            let predecessor = result.predecessor().clone();
            let candidate = result.attempt().cloned().expect("closing candidate");
            result = OwnedCasResult::confirmed_late(predecessor, candidate);
        }
        result
    }
}

#[cfg(windows)]
impl ClosingCleanupAdmission {
    pub(crate) fn current(&self) -> &RuntimeSessionJournalV1 {
        &self.current
    }

    pub(crate) fn check_budget(&self) -> Result<(), JournalStoreError> {
        check_running_admission_budget(self.deadline, self.cancellation.as_ref())
    }

    /// Apply only the canonical Closing -> Terminal transition while this
    /// exact Closing snapshot remains under the journal lock.  The caller has
    /// already completed native and staging cleanup; this method performs no
    /// resource operation and accepts only the typed terminal observation.
    pub(crate) fn commit_terminal(
        self,
        observation: TerminalObservation,
        timestamp: String,
    ) -> Result<TerminalCasResult, JournalStoreError> {
        let result = self.commit_terminal_owned(observation, timestamp);
        match result.disposition() {
            CasDisposition::Committed => Ok(TerminalCasResult::Committed(
                result.attempt().cloned().expect("terminal candidate"),
            )),
            CasDisposition::ConfirmedLate => Ok(TerminalCasResult::CommittedAfterBudget(
                result.attempt().cloned().expect("late terminal candidate"),
            )),
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => Err(result
                .error()
                .cloned()
                .unwrap_or(JournalStoreError::CorruptJournal)),
        }
    }

    pub(crate) fn commit_terminal_owned(
        mut self,
        observation: TerminalObservation,
        timestamp: String,
    ) -> OwnedCasResult {
        #[cfg(test)]
        self.store
            .faults
            .owned_cas_calls
            .fetch_add(1, Ordering::AcqRel);
        let predecessor = self.current.clone();
        if let Err(error) =
            check_running_admission_budget(self.deadline, self.cancellation.as_ref())
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        if self.current != self.expected_journal
            || self.current.state != JournalState::Closing
            || self.current.cas_snapshot() != self.expected
        {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Conflict);
        }
        if let Err(error) = apply_command(
            &mut self.current,
            &self.plan,
            &self.expected,
            JournalStoreCommand::TerminalizeWithObservation {
                observation,
                timestamp,
            },
        )
        .map_err(|error| match error {
            JournalError::StaleCas => JournalStoreError::Conflict,
            error => JournalStoreError::Journal(error),
        }) {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let candidate = self.current.clone();
        if let Err(error) = candidate.validate_against_plan(&self.plan) {
            return OwnedCasResult::prewrite(predecessor, JournalStoreError::Journal(error));
        }
        #[cfg(test)]
        if let Some(cancellation) = self
            .store
            .faults
            .cancel_before_terminal_replace
            .lock()
            .unwrap()
            .take()
        {
            cancellation.store(true, Ordering::Release);
        }
        if let Err(error) =
            check_running_admission_budget(self.deadline, self.cancellation.as_ref())
        {
            return OwnedCasResult::prewrite(predecessor, error);
        }
        let mut result = self.store.write_candidate_with_readback_unlocked(
            &self.plan,
            predecessor,
            candidate,
            Some(self.deadline),
            Some(self.cancellation.as_ref()),
        );
        #[cfg(test)]
        if let Some(cancellation) = self
            .store
            .faults
            .cancel_after_terminal_replace
            .lock()
            .unwrap()
            .take()
        {
            cancellation.store(true, Ordering::Release);
        }
        if matches!(result.disposition(), CasDisposition::Committed)
            && (cancellation_requested(self.cancellation.as_ref())
                || Instant::now() >= self.deadline)
        {
            let predecessor = result.predecessor().clone();
            let candidate = result.attempt().cloned().expect("terminal candidate");
            result = OwnedCasResult::confirmed_late(predecessor, candidate);
        }
        result
    }
}

#[cfg(windows)]
fn cancellation_requested(cancellation: &AtomicBool) -> bool {
    cancellation.load(Ordering::Acquire)
}

#[cfg(windows)]
fn check_running_admission_budget(
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<(), JournalStoreError> {
    if cancellation_requested(cancellation) {
        return Err(JournalStoreError::AdmissionCancelled);
    }
    if Instant::now() >= deadline {
        return Err(JournalStoreError::AdmissionDeadline);
    }
    Ok(())
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

fn read_bounded_record_path(path: &Path) -> Result<Vec<u8>, JournalStoreError> {
    ensure_regular_file(path)?;
    let file = File::open(path).map_err(|_| JournalStoreError::Io("openRecord"))?;
    let length = file
        .metadata()
        .map_err(|_| JournalStoreError::Io("statRecord"))?
        .len();
    if length > MAX_JOURNAL_BYTES as u64 {
        return Err(JournalStoreError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_JOURNAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| JournalStoreError::Io("readRecord"))?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err(JournalStoreError::TooLarge);
    }
    Ok(bytes)
}

fn validate_address_key(value: &str) -> Result<(), JournalStoreError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(JournalStoreError::InvalidConfig)
    }
}

fn auxiliary_index_path(root: &Path, address_key: &str) -> Result<PathBuf, JournalStoreError> {
    validate_producer_root(root)?;
    validate_address_key(address_key)?;
    Ok(root.join(format!(
        "{AUXILIARY_INDEX_PREFIX}{address_key}{AUXILIARY_INDEX_SUFFIX}"
    )))
}

fn auxiliary_lock_path(root: &Path, address_key: &str) -> Result<PathBuf, JournalStoreError> {
    validate_producer_root(root)?;
    validate_address_key(address_key)?;
    Ok(root.join(format!(
        "{AUXILIARY_INDEX_PREFIX}{address_key}{LOCK_SUFFIX}"
    )))
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
    let mut interval = Duration::from_millis(5);
    for attempt in 1..=REPLACE_RETRY_ATTEMPTS {
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } != 0 {
            return Ok(());
        }
        let error = unsafe { GetLastError() };
        let transient = matches!(
            error,
            ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION
        );
        if !transient || attempt == REPLACE_RETRY_ATTEMPTS {
            break;
        }
        thread::sleep(interval);
        interval = (interval * 2).min(REPLACE_RETRY_MAX_INTERVAL);
    }
    Err(JournalStoreError::AtomicReplace)
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

pub(crate) struct JournalFileLock {
    file: File,
    #[cfg(windows)]
    overlapped: OVERLAPPED,
}

impl JournalFileLock {
    #[cfg(windows)]
    fn acquire(path: &Path) -> Result<Self, JournalStoreError> {
        match Self::acquire_until(path, Instant::now() + LOCK_TIMEOUT, &AtomicBool::new(false)) {
            Err(JournalStoreError::AdmissionDeadline) => Err(JournalStoreError::LockTimeout),
            result => result,
        }
    }

    #[cfg(windows)]
    fn acquire_until(
        path: &Path,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<Self, JournalStoreError> {
        if path_exists(path)? {
            ensure_regular_file(path)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|_| JournalStoreError::Lock)?;
        loop {
            if cancellation_requested(cancellation) {
                return Err(JournalStoreError::AdmissionCancelled);
            }
            if Instant::now() >= deadline {
                return Err(JournalStoreError::AdmissionDeadline);
            }
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
            #[cfg(all(test, windows))]
            if unsafe { GetLastError() } == ERROR_LOCK_VIOLATION {
                if signal_running_lock_contention_for_test(path) {
                    return Err(JournalStoreError::AdmissionDeadline);
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            thread::sleep(LOCK_RETRY_INTERVAL.min(remaining));
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
        sync::{
            atomic::AtomicBool,
            mpsc::{channel, TryRecvError},
            Arc, Barrier,
        },
        thread,
        time::{Duration, Instant},
    };

    use tempfile::tempdir;

    use super::*;
    use crate::journal::{
        BoundRoot, CreationIdentity, JobBinding, JobSetupState, JournalBinding, JournalPlanValue,
        JournalRoot, JournalState, PlannedRoot, ReconcileAttempt, ResourceObservation, RootState,
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

    fn running_observation(readiness: Option<&str>, state: RootState) -> ResourceObservation {
        ResourceObservation {
            job_binding: JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: "job-1".into(),
            },
            staging_binding: None,
            roots: vec![JournalRoot {
                ordinal: 0,
                role: "capture".into(),
                root_ref_digest: ROOT_DIGEST.into(),
                root_generation: 1,
                root_nonce: "root-1".into(),
                pid: 1234,
                creation_identity: CreationIdentity {
                    kind: "windows-process-creation".into(),
                    value: "creation-1".into(),
                },
                state,
                reserved_listener_identity: "listener-0".into(),
                loopback_port: 43123,
                live_listener_readiness: readiness.map(str::to_owned),
                started_at: "2026-09-11T00:00:01Z".into(),
            }],
        }
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
        store.fail_next_before_replace_for_test();
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
    fn activation_reconcile_commits_only_the_retained_full_candidate() {
        let directory = tempdir().expect("tempdir");
        let plan = plan();
        let store = Arc::new(JournalStore::new(config(directory.path())).expect("store"));
        let initial = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        store
            .create_initial(&plan, &initial)
            .expect("initial journal");
        let prepared = store
            .compare_and_swap(
                &plan,
                &initial.cas_snapshot(),
                JournalStoreCommand::PrepareBound {
                    binding: large_binding(&plan),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("prepared journal");

        let reconciled = store
            .begin_activation_reconcile(&plan, &prepared, Instant::now() + Duration::from_secs(5))
            .expect("exact prepared candidate admission")
            .commit_reconcile_required("2026-09-11T00:00:02Z".into())
            .expect("reconcile transition");
        let reconciled = match reconciled {
            ActivationReconcileCasResult::Committed(journal) => journal,
            ActivationReconcileCasResult::CommittedAfterBudget(_) => {
                panic!("reconcile transition exceeded its test budget")
            }
        };
        assert_eq!(reconciled.state, JournalState::ReconcileRequired);
        assert_eq!(reconciled.journal_revision, prepared.journal_revision + 1);
        assert_eq!(reconciled.binding, prepared.binding);
        assert_eq!(reconciled.attempt, prepared.attempt);
        assert_eq!(reconciled.recovery_epoch, prepared.recovery_epoch);
        assert_eq!(store.read(&plan).expect("reconciled journal"), reconciled);
    }

    #[test]
    fn activation_reconcile_rejects_stale_or_full_candidate_drift_without_mutation() {
        let directory = tempdir().expect("tempdir");
        let plan = plan();
        let store = Arc::new(JournalStore::new(config(directory.path())).expect("store"));
        let initial = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        store
            .create_initial(&plan, &initial)
            .expect("initial journal");
        let prepared = store
            .compare_and_swap(
                &plan,
                &initial.cas_snapshot(),
                JournalStoreCommand::PrepareBound {
                    binding: large_binding(&plan),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("prepared journal");
        let ready = store
            .compare_and_swap(
                &plan,
                &prepared.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Ready,
                    observation: running_observation(None, RootState::Suspended),
                    timestamp: "2026-09-11T00:00:02Z".into(),
                },
            )
            .expect("ready journal");
        let mut drifted = ready.clone();
        drifted.updated_at = "2026-09-11T00:00:03Z".into();
        assert_eq!(drifted.cas_snapshot(), ready.cas_snapshot());
        assert!(matches!(
            store.begin_activation_reconcile(
                &plan,
                &drifted,
                Instant::now() + Duration::from_secs(5),
            ),
            Err(JournalStoreError::Conflict)
        ));
        assert_eq!(
            store.read(&plan).expect("full drift remains foreign"),
            ready
        );

        assert!(matches!(
            store.begin_activation_reconcile(
                &plan,
                &prepared,
                Instant::now() + Duration::from_secs(5),
            ),
            Err(JournalStoreError::Conflict)
        ));
        assert_eq!(store.read(&plan).expect("stale record remains"), ready);
    }

    #[test]
    fn closing_admission_rejects_resource_drift_even_when_cas_snapshot_is_unchanged() {
        let directory = tempdir().expect("tempdir");
        let plan = plan();
        let store = Arc::new(JournalStore::new(config(directory.path())).expect("store"));
        let initial = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        store
            .create_initial(&plan, &initial)
            .expect("initial journal");
        let prepared = store
            .compare_and_swap(
                &plan,
                &initial.cas_snapshot(),
                JournalStoreCommand::PrepareBound {
                    binding: large_binding(&plan),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("prepared journal");
        let ready = store
            .compare_and_swap(
                &plan,
                &prepared.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Ready,
                    observation: running_observation(None, RootState::Suspended),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Ready journal");
        let launching = store
            .compare_and_swap(
                &plan,
                &ready.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Launching,
                    observation: running_observation(None, RootState::Suspended),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Launching journal");
        let running = store
            .compare_and_swap(
                &plan,
                &launching.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Running,
                    observation: running_observation(
                        Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
                        RootState::Running,
                    ),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Running journal");
        let expected_snapshot = running.cas_snapshot();
        let mut drifted = running.clone();
        drifted.roots[0].live_listener_readiness =
            Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into());
        assert_eq!(drifted.cas_snapshot(), expected_snapshot);
        fs::write(
            &store.journal_path,
            drifted.encode_private().expect("drifted journal encoding"),
        )
        .expect("inject valid resource drift");

        assert!(matches!(
            store.begin_closing_admission(
                &plan,
                &running,
                Instant::now() + Duration::from_secs(5),
                Arc::new(AtomicBool::new(false)),
            ),
            Err(JournalStoreError::Conflict)
        ));
        assert_eq!(store.read(&plan).expect("foreign drift remains"), drifted);
    }

    #[test]
    fn closing_cleanup_admission_holds_journal_lock_for_destructive_window() {
        let directory = tempdir().expect("tempdir");
        let plan = plan();
        let store = Arc::new(JournalStore::new(config(directory.path())).expect("store"));
        let initial = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        store
            .create_initial(&plan, &initial)
            .expect("initial journal");
        let prepared = store
            .compare_and_swap(
                &plan,
                &initial.cas_snapshot(),
                JournalStoreCommand::PrepareBound {
                    binding: large_binding(&plan),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("prepared journal");
        let ready = store
            .compare_and_swap(
                &plan,
                &prepared.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Ready,
                    observation: running_observation(None, RootState::Suspended),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Ready journal");
        let launching = store
            .compare_and_swap(
                &plan,
                &ready.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Launching,
                    observation: running_observation(None, RootState::Suspended),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Launching journal");
        let running = store
            .compare_and_swap(
                &plan,
                &launching.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Running,
                    observation: running_observation(
                        Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
                        RootState::Running,
                    ),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Running journal");
        let closing = store
            .compare_and_swap(
                &plan,
                &running.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Closing,
                    observation: running_observation(
                        Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
                        RootState::Closing,
                    ),
                    timestamp: "2026-09-11T00:00:01Z".into(),
                },
            )
            .expect("Closing journal");

        let contention = Arc::new(AtomicBool::new(false));
        store.set_running_lock_contention_signal_for_test(Some(Arc::clone(&contention)));
        let admission = store
            .begin_closing_cleanup_admission(
                &plan,
                &closing,
                Instant::now() + Duration::from_secs(5),
                Arc::new(AtomicBool::new(false)),
            )
            .expect("cleanup admission");
        let (result_sender, result_receiver) = channel();
        let contender_store = Arc::clone(&store);
        let contender = thread::spawn(move || {
            let result = contender_store.lock_for_test();
            let _ = result_sender.send(result.is_ok());
            result.map(drop)
        });
        let contention_deadline = Instant::now() + Duration::from_secs(2);
        while !contention.load(Ordering::Acquire) && Instant::now() < contention_deadline {
            thread::yield_now();
        }
        assert!(
            contention.load(Ordering::Acquire),
            "a concurrent writer must observe the held cleanup lock"
        );
        assert!(matches!(
            result_receiver.try_recv(),
            Err(TryRecvError::Empty)
        ));
        drop(admission);
        assert_eq!(
            result_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("contender result"),
            true
        );
        contender
            .join()
            .expect("contender must terminate")
            .expect("lock acquired");
        store.set_running_lock_contention_signal_for_test(None);
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
    fn running_read_budget_bounds_journal_and_index_contention_and_restores_scope() {
        let directory = tempdir().expect("tempdir");
        let store = store(directory.path());
        create_initial(&store);

        let contention = Arc::new(AtomicBool::new(false));
        store.set_running_lock_contention_signal_for_test(Some(Arc::clone(&contention)));
        let journal_holder = JournalFileLock::acquire(&store.lock_path).expect("journal holder");
        {
            let _budget = install_running_read_budget(
                Instant::now() + Duration::from_millis(100),
                Arc::new(AtomicBool::new(false)),
            );
            assert_eq!(
                store.read(&plan()),
                Err(JournalStoreError::AdmissionDeadline)
            );
        }
        assert!(
            contention.swap(false, Ordering::AcqRel),
            "bounded journal read did not observe ERROR_LOCK_VIOLATION"
        );
        drop(journal_holder);
        assert_eq!(
            store.read(&plan()).expect("journal after scope").state,
            JournalState::PlannedUnbound
        );

        store
            .create_or_read_immutable_auxiliary(DIGEST_B, b"index")
            .expect("index record");
        let index_lock_path = auxiliary_lock_path(directory.path(), DIGEST_B).expect("index lock");
        let index_holder = JournalFileLock::acquire(&index_lock_path).expect("index holder");
        store.set_running_auxiliary_contention_signal_for_test(
            DIGEST_B,
            Some(Arc::clone(&contention)),
        );
        {
            let _budget = install_running_read_budget(
                Instant::now() + Duration::from_millis(100),
                Arc::new(AtomicBool::new(false)),
            );
            assert_eq!(
                JournalStore::read_immutable_auxiliary(directory.path(), DIGEST_B),
                Err(JournalStoreError::AdmissionDeadline)
            );
        }
        assert!(
            contention.swap(false, Ordering::AcqRel),
            "bounded index read did not observe ERROR_LOCK_VIOLATION"
        );
        drop(index_holder);
        assert_eq!(
            JournalStore::read_immutable_auxiliary(directory.path(), DIGEST_B)
                .expect("index after scope"),
            b"index"
        );
        store.set_running_auxiliary_contention_signal_for_test(DIGEST_B, None);
        store.set_running_lock_contention_signal_for_test(None);
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

    #[test]
    fn atomic_replace_waits_for_a_transient_reader_to_close() {
        let root = tempdir().expect("temporary root");
        let target = root.path().join("runtime-session-a.json");
        let source = root.path().join("runtime-session-a.json.tmp-1");
        fs::write(&target, b"old").expect("target");
        fs::write(&source, b"new").expect("source");
        // Rust opens with FILE_SHARE_READ | WRITE | DELETE; a replace still
        // fails with ERROR_ACCESS_DENIED while this handle is open.
        let reader = fs::File::open(&target).expect("transient reader");
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(40));
            drop(reader);
        });
        atomic_move(&source, &target, true).expect("replace after the reader closes");
        release.join().expect("reader thread");
        assert_eq!(fs::read(&target).expect("replaced target"), b"new");
        assert!(!source.exists());
    }

    #[test]
    fn atomic_replace_fails_closed_when_a_reader_outlasts_the_retry_budget() {
        let root = tempdir().expect("temporary root");
        let target = root.path().join("runtime-session-b.json");
        let source = root.path().join("runtime-session-b.json.tmp-1");
        fs::write(&target, b"old").expect("target");
        fs::write(&source, b"new").expect("source");
        let reader = fs::File::open(&target).expect("persistent reader");
        let started = Instant::now();
        assert_eq!(
            atomic_move(&source, &target, true),
            Err(JournalStoreError::AtomicReplace)
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(reader);
        assert_eq!(fs::read(&target).expect("preserved target"), b"old");
        assert_eq!(fs::read(&source).expect("preserved source"), b"new");
    }

    #[test]
    fn atomic_create_does_not_retry_an_existing_destination() {
        let root = tempdir().expect("temporary root");
        let target = root.path().join("runtime-session-c.json");
        let source = root.path().join("runtime-session-c.json.tmp-1");
        fs::write(&target, b"old").expect("target");
        fs::write(&source, b"new").expect("source");
        let started = Instant::now();
        assert!(atomic_move(&source, &target, false).is_err());
        assert!(started.elapsed() < Duration::from_millis(50));
        assert_eq!(fs::read(&target).expect("preserved target"), b"old");
    }
}
