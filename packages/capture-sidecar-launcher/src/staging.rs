//! Private pre-native run-staging owner.
//!
//! This module materializes only the producer-planned directory scope after
//! durable preparation.  It does not acquire a listener, process, model, or
//! other runtime resource.  The owner is deliberately move-only and is kept
//! in every error after the group directory is created so a later lifecycle
//! owner can retry cleanup without rediscovering paths.
//!
//! The filesystem checks and directory creation are deliberately sequential;
//! the live owner does not claim hostile concurrent path confinement.  File
//! contents are flushed and read back, and the private restart observer can
//! report an exact V2 scope observation, but neither path establishes native
//! cleanup or terminal proof.  A later activation owner must consume the live
//! value and perform the native cleanup proof before final journal
//! terminalization.

#![allow(dead_code)]

use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

#[cfg(test)]
use std::cell::Cell;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    journal::{
        JournalPlanValue, JournalState, ResourceObservation, RuntimeSessionJournalV1,
        StagingBinding,
    },
    journal_store::JournalStoreCommand,
    prepare::ValidatedActivationContext,
};

#[cfg(windows)]
use crate::journal_store::{
    install_running_read_budget, ClosingCasAdmission, ClosingCasError, ClosingCasResult,
    ClosingCleanupAdmission, RunningCasAdmission, RunningCasError, RunningCasResult,
};

const MARKER_FILE_NAME: &str = ".capture-run-staging-v1";
const MARKER_SCHEMA_VERSION: &str = "RunStagingMarkerV1";
const MARKER_PRODUCER: &str = "capture-runtime";
// Kept aligned with the descriptor's private staging root; the descriptor
// constant is intentionally private to launcher.rs.
const PRIVATE_RUN_STAGING_DIRECTORY: &str = "private-run-staging";
// Keep marker reads bounded by the journal record ceiling used by the store.
const MAX_MARKER_BYTES: usize = 1024 * 1024;
const MAX_RELEASE_TREE_ENTRIES: usize = 8 * 1024;
const MAX_RELEASE_TREE_DEPTH: usize = 32;
#[cfg(windows)]
const MAX_RESTART_STAGING_CANDIDATES: usize = 64;

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_MARKER_FLUSH: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_PARTIAL_WRITE: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_READBACK: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_ROOT_MKDIR: Cell<u32> = const { Cell::new(u32::MAX) };
    static CANCEL_RESTART_AFTER_MARKER: Cell<bool> = const { Cell::new(false) };
    static CANCEL_MATERIALIZE_AFTER_GROUP_MKDIR: Cell<bool> = const { Cell::new(false) };
    static CANCEL_MATERIALIZE_AFTER_MARKER: Cell<bool> = const { Cell::new(false) };
    static CANCEL_AFTER_READY_CAS: Cell<bool> = const { Cell::new(false) };
    static CANCEL_AFTER_LAUNCHING_CAS: Cell<bool> = const { Cell::new(false) };
}

/// The private result used by the later terminal CAS.  It does not claim
/// native cleanup; this slice only proves that this exact owned run scope was
/// released.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct StagingReleasedObservation {
    session_nonce: String,
    plan_digest: String,
    group_staging_identity: String,
}

impl StagingReleasedObservation {
    pub(crate) fn staging_released_matches(&self, activation: &ValidatedActivationContext) -> bool {
        self.matches_activation(activation)
    }

    fn matches_activation(&self, activation: &ValidatedActivationContext) -> bool {
        self.session_nonce == activation.descriptor.session_nonce()
            && self.plan_digest == activation.journal_plan.plan_digest
            && self.group_staging_identity == activation.descriptor.group_staging_identity()
    }

    pub(crate) fn matches_identity(
        &self,
        session_nonce: &str,
        plan_digest: &str,
        group_staging_identity: &str,
    ) -> bool {
        self.session_nonce == session_nonce
            && self.plan_digest == plan_digest
            && self.group_staging_identity == group_staging_identity
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagingFailureKind {
    InvalidActivation,
    JournalChanged,
    SharedParent,
    GroupCollision,
    MarkerCollision,
    MarkerWrite,
    MarkerReadBack,
    RootCollision,
    RootIdentity,
    Reparse,
    Durability,
    CleanupRequired,
    Cancelled,
    Deadline,
}

/// A failure before group ownership exists is safe to return as a normal
/// error.  Once the group directory has been created, the error carries the
/// exact owner so callers cannot accidentally discard cleanup authority.
pub(crate) enum StagingFailure {
    // Dropping the consumed context here intentionally invalidates the
    // one-use activation handoff.  No group or native resource is owned on
    // this path, and no permit can be reissued from the rejected value.
    BeforeOwnership(StagingFailureKind),
    Owned {
        owner: RunStagingOwner,
        kind: StagingFailureKind,
    },
}

/// A private budgeted journal failure.  `committed_candidate` is populated
/// only when the exact CAS returned a durable candidate and a later budget
/// check failed.  An ambiguous write never supplies a journal value for a
/// caller to bless from a subsequent read.
#[derive(Debug)]
pub(crate) struct StagingBudgetFailure {
    kind: StagingFailureKind,
    detail: String,
    committed_candidate: Option<RuntimeSessionJournalV1>,
}

impl StagingBudgetFailure {
    fn new(kind: StagingFailureKind, detail: String) -> Self {
        Self {
            kind,
            detail,
            committed_candidate: None,
        }
    }

    fn with_committed_candidate(
        kind: StagingFailureKind,
        detail: String,
        committed_candidate: RuntimeSessionJournalV1,
    ) -> Self {
        Self {
            kind,
            detail,
            committed_candidate: Some(committed_candidate),
        }
    }

    pub(crate) fn kind(&self) -> StagingFailureKind {
        self.kind
    }

    pub(crate) fn into_parts(
        self,
    ) -> (StagingFailureKind, String, Option<RuntimeSessionJournalV1>) {
        (self.kind, self.detail, self.committed_candidate)
    }
}

impl fmt::Debug for StagingFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BeforeOwnership(kind) => formatter
                .debug_tuple("BeforeOwnership")
                .field(kind)
                .finish(),
            Self::Owned { kind, .. } => formatter.debug_tuple("Owned").field(kind).finish(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagingCleanupError {
    Cancelled,
    Deadline,
    TraversalBound,
    JournalChanged,
    OwnershipUnknown,
    Reparse,
    IdentityChanged,
    ForeignEntry,
    HardLink,
    NonEmpty,
    DeleteFailed,
}

/// Sanitized failure reasons for the read-only restart staging observer.  No
/// path, native identifier, or storage diagnostic crosses this boundary.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartStagingObservationReason {
    InvalidRecord,
    RecordUnavailable,
    MissingStaging,
    AmbiguousStaging,
    TraversalBound,
    Reparse,
    IdentityChanged,
    ForeignEntry,
    HardLink,
    Cancelled,
    Deadline,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    first: u64,
    second: u64,
}

impl fmt::Debug for FileIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FileIdentity(REDACTED)")
    }
}

struct OwnedDirectory {
    path: PathBuf,
    identity: Option<FileIdentity>,
}

struct OwnedMarker {
    path: PathBuf,
    identity: Option<FileIdentity>,
    bytes: Vec<u8>,
}

struct ReleaseNode {
    path: PathBuf,
    parent: PathBuf,
    parent_identity: FileIdentity,
    identity: FileIdentity,
    is_directory: bool,
}

/// Exact filesystem evidence from one read-only restart observation.  The
/// fields remain private so this value cannot become cleanup or activation
/// authority by construction.  The identities and bounded marker bytes are
/// retained for a later owner to revalidate immediately before any CAS or
/// destructive operation.
#[cfg(windows)]
pub(crate) struct RestartStagingObservation {
    group_path: PathBuf,
    group_staging_identity: String,
    binding: StagingBinding,
    producer_root_identity: FileIdentity,
    shared_parent_identity: FileIdentity,
    group_identity: FileIdentity,
    marker_identity: FileIdentity,
    marker_bytes: Vec<u8>,
    root_identities: Vec<FileIdentity>,
}

#[cfg(windows)]
impl RestartStagingObservation {
    pub(crate) fn binding(&self) -> &StagingBinding {
        &self.binding
    }

    pub(crate) fn group_path(&self) -> &Path {
        &self.group_path
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StagingScopeState {
    Partial,
    Complete,
    Released,
}

/// Move-only pre-native owner.  The activation context is consumed here and
/// is never supplied by a cleanup caller.
pub(crate) struct RunStagingOwner {
    activation: ValidatedActivationContext,
    producer_root: OwnedDirectory,
    shared_parent: OwnedDirectory,
    group: OwnedDirectory,
    marker: Option<OwnedMarker>,
    roots: Vec<OwnedDirectory>,
    expected_root_paths: Vec<PathBuf>,
    scope_state: StagingScopeState,
    released_roots: Vec<bool>,
    marker_released: bool,
    released_observation: Option<StagingReleasedObservation>,
    #[cfg(test)]
    journal_drift_before_root: Cell<Option<usize>>,
    #[cfg(test)]
    journal_drift_before_ready: Cell<bool>,
    #[cfg(test)]
    release_delete_failure_at: Cell<Option<usize>>,
    #[cfg(test)]
    release_cancel_after_delete_at: Cell<Option<usize>>,
    #[cfg(test)]
    release_entry_limit: Cell<Option<usize>>,
    #[cfg(test)]
    release_depth_limit: Cell<Option<usize>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunStagingMarkerV1 {
    schema_version: String,
    producer: String,
    session_nonce: String,
    plan_digest: String,
    group_staging_identity: String,
    roots: Vec<RunStagingMarkerRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunStagingMarkerRoot {
    ordinal: u32,
    root_identity_digest: String,
}

/// The legacy staging entrypoints use an unbounded budget, while activation
/// passes one absolute deadline and cancellation flag through this private
/// seam.  Keeping the gate here prevents a budgeted caller from accidentally
/// restarting a per-operation timeout.
struct StagingBudget {
    deadline: Option<Instant>,
    cancellation: Option<Arc<AtomicBool>>,
}

impl StagingBudget {
    fn unbounded() -> Self {
        Self {
            deadline: None,
            cancellation: None,
        }
    }

    fn bounded(deadline: Instant, cancellation: Arc<AtomicBool>) -> Self {
        Self {
            deadline: Some(deadline),
            cancellation: Some(cancellation),
        }
    }

    fn check(&self) -> Result<(), StagingFailureKind> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(StagingFailureKind::Cancelled);
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(StagingFailureKind::Deadline);
        }
        Ok(())
    }

    #[cfg(test)]
    fn cancel_after_group_mkdir_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_MATERIALIZE_AFTER_GROUP_MKDIR.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    fn cancel_after_group_mkdir_if_requested(&self) {}

    #[cfg(test)]
    fn cancel_after_marker_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_MATERIALIZE_AFTER_MARKER.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    fn cancel_after_marker_if_requested(&self) {}

    #[cfg(test)]
    fn cancel_after_ready_cas_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_AFTER_READY_CAS.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    fn cancel_after_ready_cas_if_requested(&self) {}

    #[cfg(test)]
    fn cancel_after_launching_cas_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_AFTER_LAUNCHING_CAS.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    fn cancel_after_launching_cas_if_requested(&self) {}
}

fn staging_budget_error(kind: StagingFailureKind) -> String {
    match kind {
        StagingFailureKind::Cancelled => "Capture runtime staging operation was cancelled.".into(),
        StagingFailureKind::Deadline => {
            "Capture runtime staging operation exceeded its deadline.".into()
        }
        _ => "Capture runtime staging budget was invalid.".into(),
    }
}

/// Consume the validated activation handoff and materialize its producer-
/// planned, empty directory scope.  The journal snapshot is read while the
/// tree is still untouched, immediately before the first mkdir.
pub(crate) fn materialize(
    activation: ValidatedActivationContext,
) -> Result<RunStagingOwner, StagingFailure> {
    materialize_impl(activation, &StagingBudget::unbounded())
}

/// Budgeted pre-native materialization for the activation coordinator.  The
/// journal/index reads use the same scoped budget as the filesystem checks;
/// this function never acquires native resources or returns a success after
/// the deadline/cancellation boundary.
#[cfg(windows)]
pub(crate) fn materialize_with_budget(
    activation: ValidatedActivationContext,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
) -> Result<RunStagingOwner, StagingFailure> {
    let _read_budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
    let budget = StagingBudget::bounded(deadline, cancellation);
    materialize_impl(activation, &budget)
}

fn materialize_impl(
    activation: ValidatedActivationContext,
    budget: &StagingBudget,
) -> Result<RunStagingOwner, StagingFailure> {
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    let producer_root_path = activation.descriptor.producer_root().to_path_buf();
    let expected_root_paths = activation
        .descriptor
        .planned_root_staging_paths()
        .collect::<Vec<_>>();
    if expected_root_paths.is_empty()
        || expected_root_paths.iter().any(|path| {
            path.parent().is_none() || path.file_name().is_none() || !path.is_absolute()
        })
    {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    let expected_root_paths = expected_root_paths
        .into_iter()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    let group_path = activation.descriptor.planned_group_staging_path();
    if expected_root_paths.first().and_then(|path| path.parent()) != Some(group_path.as_path()) {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    match journal_is_exactly_prepared_with_budget(&activation, budget) {
        Ok(true) => {}
        Ok(false) => {
            return Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::JournalChanged,
            ));
        }
        Err(kind) => return Err(StagingFailure::BeforeOwnership(kind)),
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    // Verify every executable before creating even the shared staging
    // directory.  A later per-root check rechecks the artifact before each
    // spawn; this does not eliminate path/content TOCTOU.
    if activation.descriptor.checked_commands().is_err() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if validate_safe_chain(&producer_root_path).is_err() {
        return Err(StagingFailure::BeforeOwnership(StagingFailureKind::Reparse));
    }

    let shared_parent = group_path.parent().ok_or(StagingFailure::BeforeOwnership(
        StagingFailureKind::InvalidActivation,
    ))?;
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if ensure_existing_directory(shared_parent).is_err() {
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::BeforeOwnership(kind));
        }
        if let Err(error) = fs::create_dir(shared_parent) {
            if let Err(kind) = budget.check() {
                return Err(StagingFailure::BeforeOwnership(kind));
            }
            if error.kind() != std::io::ErrorKind::AlreadyExists
                || ensure_existing_directory(shared_parent).is_err()
            {
                return Err(StagingFailure::BeforeOwnership(
                    StagingFailureKind::SharedParent,
                ));
            }
        }
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if path_is_reparse(shared_parent).unwrap_or(true) {
        return Err(StagingFailure::BeforeOwnership(StagingFailureKind::Reparse));
    }
    let producer_root_identity = capture_directory_identity(&producer_root_path).ok();
    let shared_parent_identity = capture_directory_identity(shared_parent).ok();
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if producer_root_identity.is_none() || shared_parent_identity.is_none() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::RootIdentity,
        ));
    }

    if ensure_path_absent_and_safe(&group_path).is_err() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::GroupCollision,
        ));
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if let Err(error) = fs::create_dir(&group_path) {
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::BeforeOwnership(kind));
        }
        return Err(StagingFailure::BeforeOwnership(
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                StagingFailureKind::GroupCollision
            } else {
                StagingFailureKind::Durability
            },
        ));
    }
    let group_identity = capture_directory_identity(&group_path).ok();
    let mut owner = RunStagingOwner {
        activation,
        producer_root: OwnedDirectory {
            path: producer_root_path,
            identity: producer_root_identity,
        },
        shared_parent: OwnedDirectory {
            path: shared_parent.to_path_buf(),
            identity: shared_parent_identity,
        },
        group: OwnedDirectory {
            path: group_path.clone(),
            identity: group_identity,
        },
        marker: None,
        roots: Vec::new(),
        expected_root_paths,
        scope_state: StagingScopeState::Partial,
        released_roots: Vec::new(),
        marker_released: false,
        released_observation: None,
        #[cfg(test)]
        journal_drift_before_root: Cell::new(None),
        #[cfg(test)]
        journal_drift_before_ready: Cell::new(false),
        #[cfg(test)]
        release_delete_failure_at: Cell::new(None),
        #[cfg(test)]
        release_cancel_after_delete_at: Cell::new(None),
        #[cfg(test)]
        release_entry_limit: Cell::new(None),
        #[cfg(test)]
        release_depth_limit: Cell::new(None),
    };
    budget.cancel_after_group_mkdir_if_requested();
    if owner.group.identity.is_none() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::RootIdentity,
        });
    }
    if !owner.scope_chain_is_owned() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::Reparse,
        });
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }

    let marker_path = group_path.join(MARKER_FILE_NAME);
    if ensure_path_absent_and_safe(&marker_path).is_err() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::MarkerCollision,
        });
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }
    let marker_bytes = match marker_bytes(&owner) {
        Ok(bytes) => bytes,
        Err(kind) => {
            return Err(StagingFailure::Owned { owner, kind });
        }
    };
    let marker = match create_marker(&marker_path, &marker_bytes, budget) {
        Ok(marker) => marker,
        Err((kind, identity, bytes)) => {
            if identity.is_some() {
                owner.marker = Some(OwnedMarker {
                    path: marker_path,
                    identity,
                    bytes,
                });
            }
            return Err(StagingFailure::Owned { owner, kind });
        }
    };
    owner.marker = Some(marker);
    budget.cancel_after_marker_if_requested();
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }

    for (_ordinal, root_path) in owner.expected_root_paths.clone().into_iter().enumerate() {
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::Owned { owner, kind });
        }
        if validate_safe_chain(&group_path).is_err()
            || ensure_existing_directory(&group_path).is_err()
            || path_is_reparse(&group_path).unwrap_or(true)
            || !same_identity(&group_path, owner.group.identity)
        {
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::Reparse,
            });
        }
        if ensure_path_absent_and_safe(&root_path).is_err() {
            if let Err(kind) = budget.check() {
                return Err(StagingFailure::Owned { owner, kind });
            }
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::RootCollision,
            });
        }
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::Owned { owner, kind });
        }
        #[cfg(test)]
        if FAIL_NEXT_ROOT_MKDIR.with(|fault| {
            if fault.get() == _ordinal as u32 {
                fault.set(u32::MAX);
                true
            } else {
                false
            }
        }) {
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::Durability,
            });
        }
        if let Err(error) = fs::create_dir(&root_path) {
            if let Err(kind) = budget.check() {
                return Err(StagingFailure::Owned { owner, kind });
            }
            return Err(StagingFailure::Owned {
                owner,
                kind: if error.kind() == std::io::ErrorKind::AlreadyExists {
                    StagingFailureKind::RootCollision
                } else {
                    StagingFailureKind::Durability
                },
            });
        }
        let identity = capture_directory_identity(&root_path).ok();
        owner.roots.push(OwnedDirectory {
            path: root_path,
            identity,
        });
        owner.released_roots.push(false);
        if owner.roots.last().and_then(|root| root.identity).is_none() {
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::RootIdentity,
            });
        }
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::Owned { owner, kind });
        }
    }
    owner.scope_state = StagingScopeState::Complete;
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }
    Ok(owner)
}

impl RunStagingOwner {
    /// Revalidate all frozen commands after staging ownership exists and
    /// before the native Job is created.
    pub(crate) fn checked_commands(&self) -> Result<Vec<Command>, String> {
        self.validate_complete_materialized_scope()
            .map_err(|error| format!("Capture runtime staging admission failed: {error:?}."))?;
        self.activation.descriptor.checked_commands()
    }

    pub(crate) fn journal_is_still_prepared(&self) -> bool {
        journal_is_exactly_prepared(&self.activation)
    }

    pub(crate) fn validate_ready_journal(
        &self,
        journal: &RuntimeSessionJournalV1,
    ) -> Result<(), String> {
        journal
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| {
                "Capture runtime Ready journal did not match its immutable plan.".to_string()
            })?;
        if journal.state != JournalState::Ready
            || journal.session_nonce != self.activation.descriptor.session_nonce()
            || journal.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err("Capture runtime retained journal was not the exact Ready binding.".into());
        }
        Ok(())
    }

    pub(crate) fn revalidate_ready_snapshot(
        &self,
        expected: &RuntimeSessionJournalV1,
    ) -> Result<(), String> {
        self.validate_ready_journal(expected)?;
        let current = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
            .map_err(|_| "Capture runtime Ready journal could not be re-read.".to_string())?;
        if current != *expected {
            return Err("Capture runtime Ready journal changed before Launching.".into());
        }
        Ok(())
    }

    pub(crate) fn validate_launching_journal(
        &self,
        journal: &RuntimeSessionJournalV1,
    ) -> Result<(), String> {
        journal
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| {
                "Capture runtime Launching journal did not match its immutable plan.".to_string()
            })?;
        if journal.state != JournalState::Launching
            || journal.session_nonce != self.activation.descriptor.session_nonce()
            || journal.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(
                "Capture runtime retained journal was not the exact Launching binding.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn revalidate_launching_snapshot(
        &self,
        expected: &RuntimeSessionJournalV1,
    ) -> Result<(), String> {
        self.validate_launching_journal(expected)?;
        let current = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
            .map_err(|_| "Capture runtime Launching journal could not be re-read.".to_string())?;
        if current != *expected {
            return Err("Capture runtime Launching journal changed before Running.".into());
        }
        Ok(())
    }

    pub(crate) fn activation_descriptor(&self) -> Arc<crate::launcher::FrozenActivationDescriptor> {
        Arc::clone(&self.activation.descriptor)
    }

    pub(crate) fn planned_roots(&self) -> &[crate::journal::PlannedRoot] {
        &self.activation.journal_plan.roots
    }

    pub(crate) fn planned_root_port(&self, ordinal: usize) -> Option<u16> {
        self.activation.descriptor.planned_root_port(ordinal)
    }

    pub(crate) fn next_timestamp(&self) -> Result<String, String> {
        self.activation.next_timestamp()
    }

    pub(crate) fn revalidate_address_index(&self) -> Result<(), String> {
        self.activation.revalidate_address_index()
    }

    #[cfg(windows)]
    pub(crate) fn revalidate_address_index_for_running(
        &self,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let _budget = install_running_read_budget(deadline, cancellation);
        self.activation.revalidate_address_index()
    }

    /// Revalidate the immutable plan/index and the complete retained Running
    /// journal without consulting native liveness or the staging filesystem.
    /// Closing is teardown intent, so dead roots and missing listeners remain
    /// eligible; their cleanup proof belongs to a later owner.
    #[cfg(windows)]
    pub(crate) fn revalidate_running_snapshot_for_closing(
        &self,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        expected
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| {
                "Capture runtime Running journal was invalid before Closing.".to_string()
            })?;
        if expected.state != JournalState::Running
            || expected.session_nonce != self.activation.descriptor.session_nonce()
            || expected.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(
                "Capture runtime retained journal was not the exact Running binding.".into(),
            );
        }
        let _budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
        self.activation.revalidate_address_index()?;
        let current = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
            .map_err(|_| "Capture runtime Running journal could not be re-read.".to_string())?;
        if current != *expected {
            return Err("Capture runtime Running journal changed before Closing CAS.".into());
        }
        Ok(())
    }

    /// Revalidate the immutable address index and its journal binding before
    /// the destructive Closing admission.  The full journal snapshot is
    /// checked again under the admission lock, so this preflight does not
    /// create a read-then-cleanup authority gap of its own.
    #[cfg(windows)]
    pub(crate) fn revalidate_closing_index_for_cleanup(
        &self,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        expected
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| {
                "Capture runtime Closing journal was invalid before native cleanup.".to_string()
            })?;
        if expected.state != JournalState::Closing
            || expected.session_nonce != self.activation.descriptor.session_nonce()
            || expected.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(
                "Capture runtime retained journal was not the exact Closing binding.".into(),
            );
        }
        let _budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
        self.activation.revalidate_address_index()
    }

    #[cfg(windows)]
    pub(crate) fn begin_closing_cleanup_admission(
        &self,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<ClosingCleanupAdmission, ClosingCasError> {
        self.activation
            .context
            .store
            .begin_closing_cleanup_admission(
                &self.activation.journal_plan,
                expected,
                deadline,
                cancellation,
            )
            .map_err(map_closing_cas_error)
    }

    pub(crate) fn checked_commands_for_running(&self) -> Result<Vec<Command>, String> {
        self.validate_running_scope()?;
        self.activation.descriptor.checked_commands()
    }

    pub(crate) fn staging_binding_for_ready(&self) -> Result<StagingBinding, String> {
        self.validate_complete_materialized_scope()
            .map_err(|error| format!("Capture runtime staging admission failed: {error:?}."))?;
        self.staging_binding_from_owned_scope()
    }

    pub(crate) fn staging_binding_for_running(&self) -> Result<StagingBinding, String> {
        self.validate_running_scope()?;
        self.staging_binding_from_owned_scope()
    }

    fn staging_binding_from_owned_scope(&self) -> Result<StagingBinding, String> {
        let marker = self
            .marker
            .as_ref()
            .ok_or_else(|| "Capture runtime staging marker was not complete.".to_string())?;
        let producer_root_identity =
            required_file_identity(self.producer_root.identity, "producer root")?;
        let shared_parent_identity =
            required_file_identity(self.shared_parent.identity, "staging parent")?;
        let group_identity = required_file_identity(self.group.identity, "staging group")?;
        let marker_identity = required_file_identity(marker.identity, "staging marker")?;
        let root_identities = self
            .roots
            .iter()
            .enumerate()
            .map(|(ordinal, root)| {
                required_file_identity(root.identity, &format!("staging root {ordinal}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let root_digest = run_staging_scope_digest(
            producer_root_identity,
            shared_parent_identity,
            group_identity,
            marker_identity,
            self.activation.descriptor.group_staging_identity(),
            &marker.bytes,
            &root_identities,
        );
        Ok(StagingBinding {
            run_nonce: self.activation.descriptor.session_nonce().to_owned(),
            root_digest,
            scope: "run".into(),
        })
    }

    pub(crate) fn persist_ready(
        &self,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<crate::journal::RuntimeSessionJournalV1, String> {
        self.persist_ready_impl(observation, timestamp, &StagingBudget::unbounded())
            .map_err(|error| error.detail)
    }

    /// Persist Ready under one absolute activation budget.  The old string
    /// error seam is retained for legacy callers; cancellation and deadline
    /// remain distinguishable by their stable error text.
    #[cfg(windows)]
    pub(crate) fn persist_ready_with_budget(
        &self,
        observation: ResourceObservation,
        timestamp: String,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<crate::journal::RuntimeSessionJournalV1, StagingBudgetFailure> {
        let _read_budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
        let budget = StagingBudget::bounded(deadline, cancellation);
        self.persist_ready_impl(observation, timestamp, &budget)
    }

    fn persist_ready_impl(
        &self,
        observation: ResourceObservation,
        timestamp: String,
        budget: &StagingBudget,
    ) -> Result<crate::journal::RuntimeSessionJournalV1, StagingBudgetFailure> {
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        match journal_is_exactly_prepared_with_budget(&self.activation, budget) {
            Ok(true) => {}
            Ok(false) => {
                return Err(StagingBudgetFailure::new(
                    StagingFailureKind::JournalChanged,
                    "Capture runtime prepared binding changed before Ready CAS.".into(),
                ))
            }
            Err(kind) => return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind))),
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        let expected_revision = self
            .activation
            .expected
            .journal_revision
            .checked_add(1)
            .ok_or_else(|| {
                StagingBudgetFailure::new(
                    StagingFailureKind::Durability,
                    "Capture runtime journal revision overflowed.".into(),
                )
            })?;
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        #[cfg(test)]
        self.maybe_inject_journal_drift_before_ready();
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        let ready = self
            .activation
            .context
            .store
            .compare_and_swap(
                &self.activation.journal_plan,
                &self.activation.expected,
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Ready,
                    observation: observation.clone(),
                    timestamp,
                },
            )
            .map_err(|error| {
                map_staging_budget_failure(error, "Capture runtime Ready journal CAS failed.")
            })?;
        budget.cancel_after_ready_cas_if_requested();
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_committed_candidate(
                kind,
                staging_budget_error(kind),
                ready.clone(),
            ));
        }
        if ready.state != JournalState::Ready
            || ready.journal_revision != expected_revision
            || ready.binding != self.activation.binding
            || ready.job_binding.as_ref() != Some(&observation.job_binding)
            || ready.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || ready.roots != observation.roots
        {
            return Err(StagingBudgetFailure::new(
                StagingFailureKind::JournalChanged,
                "Capture runtime Ready journal read-back was not exact.".into(),
            ));
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_committed_candidate(
                kind,
                staging_budget_error(kind),
                ready.clone(),
            ));
        }
        Ok(ready)
    }

    /// Persist the exact Ready-to-Launching transition for this owner.  The
    /// retained Ready value is checked both before and inside the store CAS;
    /// an error never gets upgraded by reading whichever record happens to be
    /// on disk after an atomic replacement.
    pub(crate) fn persist_launching(
        &self,
        expected_ready: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<RuntimeSessionJournalV1, String> {
        self.persist_launching_impl(
            expected_ready,
            observation,
            timestamp,
            &StagingBudget::unbounded(),
        )
        .map_err(|error| error.detail)
    }

    /// Persist Launching under one absolute activation budget.  If the
    /// atomic CAS completed just before the budget expired, this returns a
    /// budget error so the caller retains its owner and reopens the journal;
    /// it never reports a late success as if the transition were rolled back.
    #[cfg(windows)]
    pub(crate) fn persist_launching_with_budget(
        &self,
        expected_ready: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<RuntimeSessionJournalV1, StagingBudgetFailure> {
        let _read_budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
        let budget = StagingBudget::bounded(deadline, cancellation);
        self.persist_launching_impl(expected_ready, observation, timestamp, &budget)
    }

    fn persist_launching_impl(
        &self,
        expected_ready: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
        budget: &StagingBudget,
    ) -> Result<RuntimeSessionJournalV1, StagingBudgetFailure> {
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        expected_ready
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| {
                StagingBudgetFailure::new(
                    StagingFailureKind::JournalChanged,
                    "Capture runtime Ready journal was invalid.".into(),
                )
            })?;
        if expected_ready.state != JournalState::Ready
            || expected_ready.session_nonce != self.activation.descriptor.session_nonce()
            || expected_ready.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(StagingBudgetFailure::new(
                StagingFailureKind::JournalChanged,
                "Capture runtime Ready journal identity was invalid before Launching CAS.".into(),
            ));
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        let current = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
            .map_err(|error| {
                map_staging_budget_failure(
                    error,
                    "Capture runtime Ready journal could not be revalidated.",
                )
            })?;
        if current != *expected_ready {
            return Err(StagingBudgetFailure::new(
                StagingFailureKind::JournalChanged,
                "Capture runtime Ready journal changed before Launching CAS.".into(),
            ));
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        let expected_revision =
            expected_ready
                .journal_revision
                .checked_add(1)
                .ok_or_else(|| {
                    StagingBudgetFailure::new(
                        StagingFailureKind::Durability,
                        "Capture runtime journal revision overflowed.".into(),
                    )
                })?;
        let expected_updated_at = timestamp.clone();
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::new(kind, staging_budget_error(kind)));
        }
        let launching = self
            .activation
            .context
            .store
            .compare_and_swap(
                &self.activation.journal_plan,
                &expected_ready.cas_snapshot(),
                JournalStoreCommand::TransitionWithObservation {
                    next_state: JournalState::Launching,
                    observation: observation.clone(),
                    timestamp,
                },
            )
            .map_err(|error| {
                map_staging_budget_failure(error, "Capture runtime Launching journal CAS failed.")
            })?;
        budget.cancel_after_launching_cas_if_requested();
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_committed_candidate(
                kind,
                staging_budget_error(kind),
                launching.clone(),
            ));
        }
        if launching.state != JournalState::Launching
            || launching.journal_revision != expected_revision
            || launching.schema_version != expected_ready.schema_version
            || launching.producer != expected_ready.producer
            || launching.session_nonce != expected_ready.session_nonce
            || launching.plan_digest != expected_ready.plan_digest
            || launching.created_at != expected_ready.created_at
            || launching.updated_at != expected_updated_at
            || launching.attempt != expected_ready.attempt
            || launching.recovery_epoch != expected_ready.recovery_epoch
            || launching.binding != expected_ready.binding
            || launching.job_binding.as_ref() != Some(&observation.job_binding)
            || launching.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || launching.roots != observation.roots
            || launching.proof.is_some()
        {
            return Err(StagingBudgetFailure::new(
                StagingFailureKind::JournalChanged,
                "Capture runtime Launching journal read-back was not exact.".into(),
            ));
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_committed_candidate(
                kind,
                staging_budget_error(kind),
                launching.clone(),
            ));
        }
        Ok(launching)
    }

    #[cfg(windows)]
    pub(crate) fn begin_running_admission(
        &self,
        expected_launching: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<RunningCasAdmission, RunningCasError> {
        self.activation
            .context
            .store
            .begin_running_admission(
                &self.activation.journal_plan,
                &expected_launching.cas_snapshot(),
                deadline,
                cancellation,
            )
            .map_err(|error| match error {
                crate::journal_store::JournalStoreError::AdmissionCancelled => {
                    RunningCasError::Cancelled
                }
                crate::journal_store::JournalStoreError::AdmissionDeadline => {
                    RunningCasError::Deadline
                }
                crate::journal_store::JournalStoreError::Conflict => RunningCasError::Conflict,
                _ => RunningCasError::Storage,
            })
    }

    #[cfg(windows)]
    pub(crate) fn begin_closing_admission(
        &self,
        expected_running: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<ClosingCasAdmission, ClosingCasError> {
        self.activation
            .context
            .store
            .begin_closing_admission(
                &self.activation.journal_plan,
                expected_running,
                deadline,
                cancellation,
            )
            .map_err(map_closing_cas_error)
    }

    #[cfg(windows)]
    pub(crate) fn persist_running_admission(
        &self,
        admission: RunningCasAdmission,
        expected_launching: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<RunningCasResult, RunningCasError> {
        let result = admission
            .commit_running(observation.clone(), timestamp.clone())
            .map_err(|error| match error {
                crate::journal_store::JournalStoreError::AdmissionCancelled => {
                    RunningCasError::Cancelled
                }
                crate::journal_store::JournalStoreError::AdmissionDeadline => {
                    RunningCasError::Deadline
                }
                crate::journal_store::JournalStoreError::Conflict => RunningCasError::Conflict,
                _ => RunningCasError::Storage,
            })?;
        let running = match &result {
            RunningCasResult::Committed(journal)
            | RunningCasResult::CommittedAfterBudget(journal) => journal,
        };
        let expected_revision = expected_launching
            .journal_revision
            .checked_add(1)
            .ok_or(RunningCasError::Storage)?;
        let expected_updated_at = timestamp;
        if running.state != JournalState::Running
            || running.journal_revision != expected_revision
            || running.schema_version != expected_launching.schema_version
            || running.producer != expected_launching.producer
            || running.session_nonce != expected_launching.session_nonce
            || running.plan_digest != expected_launching.plan_digest
            || running.created_at != expected_launching.created_at
            || running.updated_at != expected_updated_at
            || running.attempt != expected_launching.attempt
            || running.recovery_epoch != expected_launching.recovery_epoch
            || running.binding != expected_launching.binding
            || running.job_binding.as_ref() != Some(&observation.job_binding)
            || running.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || running.roots != observation.roots
            || running.proof.is_some()
        {
            return Err(RunningCasError::Storage);
        }
        Ok(result)
    }

    #[cfg(windows)]
    pub(crate) fn persist_closing_admission(
        &self,
        admission: ClosingCasAdmission,
        expected_running: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<ClosingCasResult, ClosingCasError> {
        let result = admission
            .commit_closing(observation.clone(), timestamp.clone())
            .map_err(map_closing_cas_error)?;
        let closing = match &result {
            ClosingCasResult::Committed(journal)
            | ClosingCasResult::CommittedAfterBudget(journal) => journal,
        };
        let expected_revision = expected_running
            .journal_revision
            .checked_add(1)
            .ok_or(ClosingCasError::Storage)?;
        if closing.state != JournalState::Closing
            || closing.journal_revision != expected_revision
            || closing.schema_version != expected_running.schema_version
            || closing.producer != expected_running.producer
            || closing.session_nonce != expected_running.session_nonce
            || closing.plan_digest != expected_running.plan_digest
            || closing.created_at != expected_running.created_at
            || closing.updated_at != timestamp
            || closing.attempt != expected_running.attempt
            || closing.recovery_epoch != expected_running.recovery_epoch
            || closing.binding != expected_running.binding
            || closing.job_binding.as_ref() != Some(&observation.job_binding)
            || closing.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || closing.roots != observation.roots
            || closing.proof.is_some()
        {
            return Err(ClosingCasError::Storage);
        }
        #[cfg(test)]
        if let Some(cancellation) = self
            .activation
            .context
            .store
            .take_cancel_after_closing_readback_for_test()
        {
            // This test-only rendezvous is deliberately after the complete
            // candidate readback and wrapper validation.  The process owner
            // must still perform its final egress check before issuing a
            // Closing authority.
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(result)
    }

    /// Revalidate the journal and replace the command with a freshly checked
    /// frozen command immediately before the native spawn call.
    pub(crate) fn check_before_root_spawn(
        &self,
        ordinal: usize,
        command: &mut Command,
    ) -> Result<(), String> {
        #[cfg(test)]
        self.maybe_inject_journal_drift_before_root(ordinal);
        self.validate_complete_materialized_scope()
            .map_err(|error| format!("Capture runtime staging admission failed: {error:?}."))?;
        if !journal_is_exactly_prepared(&self.activation) {
            return Err("Capture runtime prepared binding changed before root spawn.".into());
        }
        *command = self.activation.descriptor.checked_command(ordinal)?;
        Ok(())
    }

    /// Validate and remove only the complete owned empty scope.  No deletion
    /// occurs until every entry, identity, and reparse check has succeeded.
    pub(crate) fn cleanup_pre_native(
        &mut self,
    ) -> Result<StagingReleasedObservation, StagingCleanupError> {
        if self.scope_state == StagingScopeState::Released {
            return Err(StagingCleanupError::OwnershipUnknown);
        }
        if !journal_is_exactly_prepared(&self.activation) {
            return Err(StagingCleanupError::JournalChanged);
        }
        self.validate_empty_scope()?;

        while let Some(root) = self.roots.pop() {
            if !self.scope_chain_is_owned() {
                self.roots.push(root);
                return Err(StagingCleanupError::IdentityChanged);
            }
            if fs::remove_dir(&root.path).is_err() {
                self.roots.push(root);
                return Err(StagingCleanupError::DeleteFailed);
            }
        }
        if let Some(marker) = &self.marker {
            if !self.scope_chain_is_owned() {
                return Err(StagingCleanupError::IdentityChanged);
            }
            fs::remove_file(&marker.path).map_err(|_| StagingCleanupError::DeleteFailed)?;
            self.marker = None;
        }
        if !self.scope_chain_is_owned() {
            return Err(StagingCleanupError::IdentityChanged);
        }
        fs::remove_dir(&self.group.path).map_err(|_| StagingCleanupError::DeleteFailed)?;
        self.scope_state = StagingScopeState::Released;
        Ok(StagingReleasedObservation {
            session_nonce: self.activation.descriptor.session_nonce().to_owned(),
            plan_digest: self.activation.journal_plan.plan_digest.clone(),
            group_staging_identity: self
                .activation
                .descriptor
                .group_staging_identity()
                .to_owned(),
        })
    }

    /// Release the producer-owned run subtree after the exact native and
    /// listener proofs have already been established by the Closing owner.
    /// This method only performs filesystem teardown; the caller holds the
    /// Closing journal admission while it invokes this seam and observes the
    /// listener again afterwards.
    #[cfg(windows)]
    pub(crate) fn cleanup_after_closing(
        &mut self,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<StagingReleasedObservation, StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        expected
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| StagingCleanupError::JournalChanged)?;
        if expected.state != JournalState::Closing
            || expected.session_nonce != self.activation.descriptor.session_nonce()
            || expected.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(StagingCleanupError::JournalChanged);
        }

        if self.scope_state == StagingScopeState::Released {
            let observation = self
                .released_observation
                .clone()
                .ok_or(StagingCleanupError::OwnershipUnknown)?;
            self.validate_released_scope()?;
            if !observation.matches_activation(&self.activation) {
                return Err(StagingCleanupError::IdentityChanged);
            }
            return Ok(observation);
        }

        if !path_exists(&self.group.path) {
            return Err(StagingCleanupError::OwnershipUnknown);
        }

        let trees = self.preflight_release_scope(deadline, cancellation)?;
        let mut mutation_index = 0_usize;
        for index in (0..self.expected_root_paths.len()).rev() {
            check_staging_release_budget(deadline, cancellation)?;
            if self.released_roots[index] {
                continue;
            }
            for node in &trees[index] {
                check_staging_release_budget(deadline, cancellation)?;
                self.validate_release_node(node, deadline, cancellation)?;
                self.before_release_delete(mutation_index)?;
                remove_release_node(node)?;
                // Only a successful remove establishes deletion progress.  A
                // failed or interrupted attempt must remain unknown on retry.
                self.after_release_delete(mutation_index, cancellation);
                mutation_index = mutation_index.saturating_add(1);
            }
            check_staging_release_budget(deadline, cancellation)?;
            self.validate_scope_chain()?;
            let root = &self.roots[index];
            if root.path != self.expected_root_paths[index]
                || !same_identity(&root.path, root.identity)
                || !ensure_existing_directory(&root.path).is_ok()
                || !is_empty_directory(&root.path)?
            {
                return Err(StagingCleanupError::IdentityChanged);
            }
            self.before_release_delete(mutation_index)?;
            match fs::remove_dir(&root.path) {
                Ok(()) => self.released_roots[index] = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(StagingCleanupError::OwnershipUnknown);
                }
                Err(_) => return Err(StagingCleanupError::DeleteFailed),
            }
            self.after_release_delete(mutation_index, cancellation);
            mutation_index = mutation_index.saturating_add(1);
        }

        check_staging_release_budget(deadline, cancellation)?;
        if !self.marker_released {
            let marker = self
                .marker
                .as_ref()
                .ok_or(StagingCleanupError::OwnershipUnknown)?;
            self.validate_release_marker(marker, deadline, cancellation)?;
            self.before_release_delete(mutation_index)?;
            match fs::remove_file(&marker.path) {
                Ok(()) => self.marker_released = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(StagingCleanupError::OwnershipUnknown);
                }
                Err(_) => return Err(StagingCleanupError::DeleteFailed),
            }
            self.after_release_delete(mutation_index, cancellation);
            mutation_index = mutation_index.saturating_add(1);
        }

        check_staging_release_budget(deadline, cancellation)?;
        self.validate_scope_chain()?;
        if !is_empty_directory(&self.group.path)? {
            return Err(StagingCleanupError::ForeignEntry);
        }
        self.before_release_delete(mutation_index)?;
        match fs::remove_dir(&self.group.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(StagingCleanupError::OwnershipUnknown);
            }
            Err(_) => return Err(StagingCleanupError::DeleteFailed),
        }
        // The group removal completed; all prior removal progress is already
        // recorded, so this is the first point at which the whole scope can
        // become a released observation.
        self.scope_state = StagingScopeState::Released;
        let observation = self.released_observation_for_activation();
        self.released_observation = Some(observation.clone());
        self.after_release_delete(mutation_index, cancellation);
        self.validate_released_scope()?;
        Ok(observation)
    }

    #[cfg(windows)]
    fn preflight_release_scope(
        &mut self,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<Vec<Vec<ReleaseNode>>, StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        if self.scope_state != StagingScopeState::Complete
            || self.marker.is_none()
            || self.roots.len() != self.expected_root_paths.len()
            || self.released_roots.len() != self.expected_root_paths.len()
        {
            return Err(StagingCleanupError::OwnershipUnknown);
        }
        self.validate_scope_chain()?;
        check_staging_release_budget(deadline, cancellation)?;
        let marker_path = self.group.path.join(MARKER_FILE_NAME);
        let marker = self.marker.as_ref().expect("marker checked above");
        if marker.path != marker_path {
            return Err(StagingCleanupError::IdentityChanged);
        }
        if self.marker_released {
            if path_exists(&marker.path) {
                return Err(StagingCleanupError::ForeignEntry);
            }
        } else if !path_exists(&marker.path) {
            return Err(StagingCleanupError::OwnershipUnknown);
        } else {
            self.validate_release_marker(marker, deadline, cancellation)
                .map_err(|error| match error {
                    StagingCleanupError::Cancelled | StagingCleanupError::Deadline => error,
                    _ => StagingCleanupError::OwnershipUnknown,
                })?;
        }

        let mut entry_budget = {
            #[cfg(test)]
            {
                self.release_entry_limit
                    .take()
                    .unwrap_or(MAX_RELEASE_TREE_ENTRIES)
            }
            #[cfg(not(test))]
            {
                MAX_RELEASE_TREE_ENTRIES
            }
        };
        let depth_limit = {
            #[cfg(test)]
            {
                self.release_depth_limit
                    .take()
                    .unwrap_or(MAX_RELEASE_TREE_DEPTH)
            }
            #[cfg(not(test))]
            {
                MAX_RELEASE_TREE_DEPTH
            }
        };
        let mut top_entries =
            read_release_entries(&self.group.path, deadline, cancellation, &mut entry_budget)?;
        top_entries.sort_by_key(|entry| entry.path());
        for entry in top_entries {
            check_staging_release_budget(deadline, cancellation)?;
            let path = entry.path();
            let allowed = path == marker_path
                || self
                    .expected_root_paths
                    .iter()
                    .any(|expected| *expected == path);
            if !allowed {
                return Err(StagingCleanupError::ForeignEntry);
            }
            if path_is_reparse(&path).unwrap_or(true) {
                return Err(StagingCleanupError::Reparse);
            }
        }

        let mut trees = Vec::with_capacity(self.expected_root_paths.len());
        for index in 0..self.expected_root_paths.len() {
            check_staging_release_budget(deadline, cancellation)?;
            let root_path = &self.expected_root_paths[index];
            if self.released_roots[index] {
                if path_exists(root_path) {
                    return Err(StagingCleanupError::ForeignEntry);
                }
                trees.push(Vec::new());
                continue;
            }
            let root = &self.roots[index];
            if root.path != *root_path {
                return Err(StagingCleanupError::IdentityChanged);
            }
            let metadata = match fs::symlink_metadata(root_path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(StagingCleanupError::OwnershipUnknown);
                }
                Err(_) => return Err(StagingCleanupError::IdentityChanged),
            };
            if !metadata.is_dir()
                || metadata_is_reparse(&metadata)
                || !same_identity(root_path, root.identity)
            {
                return Err(StagingCleanupError::IdentityChanged);
            }
            let root_identity = root.identity.ok_or(StagingCleanupError::IdentityChanged)?;
            let mut nodes = Vec::new();
            let mut entries =
                read_release_entries(root_path, deadline, cancellation, &mut entry_budget)?;
            entries.sort_by_key(|entry| entry.path());
            for entry in entries {
                collect_release_nodes(
                    &entry.path(),
                    root_identity,
                    1,
                    depth_limit,
                    &mut nodes,
                    deadline,
                    cancellation,
                    &mut entry_budget,
                )?;
            }
            trees.push(nodes);
        }
        Ok(trees)
    }

    #[cfg(windows)]
    fn validate_release_node(
        &self,
        node: &ReleaseNode,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        self.validate_scope_chain()?;
        check_staging_release_budget(deadline, cancellation)?;
        if !same_identity(&node.parent, Some(node.parent_identity))
            || path_is_reparse(&node.parent).unwrap_or(true)
        {
            return Err(StagingCleanupError::IdentityChanged);
        }
        check_staging_release_budget(deadline, cancellation)?;
        let metadata =
            fs::symlink_metadata(&node.path).map_err(|_| StagingCleanupError::DeleteFailed)?;
        if metadata_is_reparse(&metadata)
            || metadata.is_dir() != node.is_directory
            || metadata.is_file() == node.is_directory
            || capture_any_identity(&node.path).ok() != Some(node.identity)
        {
            return Err(StagingCleanupError::IdentityChanged);
        }
        if !node.is_directory && has_multiple_hard_links(&node.path, &metadata) {
            return Err(StagingCleanupError::HardLink);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn validate_release_marker(
        &self,
        marker: &OwnedMarker,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        self.validate_scope_chain()?;
        check_staging_release_budget(deadline, cancellation)?;
        let metadata = fs::symlink_metadata(&marker.path)
            .map_err(|_| StagingCleanupError::OwnershipUnknown)?;
        if !metadata.is_file()
            || metadata_is_reparse(&metadata)
            || capture_any_identity(&marker.path).ok() != marker.identity
        {
            return Err(StagingCleanupError::ForeignEntry);
        }
        if has_multiple_hard_links(&marker.path, &metadata) {
            return Err(StagingCleanupError::HardLink);
        }
        check_staging_release_budget(deadline, cancellation)?;
        if read_bounded(&marker.path).map_err(|_| StagingCleanupError::ForeignEntry)?
            != marker.bytes
        {
            return Err(StagingCleanupError::ForeignEntry);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn before_release_delete(&self, mutation_index: usize) -> Result<(), StagingCleanupError> {
        #[cfg(test)]
        if self.release_delete_failure_at.get() == Some(mutation_index) {
            self.release_delete_failure_at.set(None);
            return Err(StagingCleanupError::DeleteFailed);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn after_release_delete(&self, mutation_index: usize, cancellation: &AtomicBool) {
        #[cfg(test)]
        if self.release_cancel_after_delete_at.get() == Some(mutation_index) {
            self.release_cancel_after_delete_at.set(None);
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        }
    }

    #[cfg(windows)]
    fn validate_released_scope(&self) -> Result<(), StagingCleanupError> {
        for directory in [&self.producer_root, &self.shared_parent] {
            if validate_safe_chain(&directory.path).is_err()
                || !same_identity(&directory.path, directory.identity)
                || path_is_reparse(&directory.path).unwrap_or(true)
            {
                return Err(StagingCleanupError::Reparse);
            }
        }
        if path_exists(&self.group.path)
            || self
                .expected_root_paths
                .iter()
                .any(|path| path_exists(path))
        {
            return Err(StagingCleanupError::ForeignEntry);
        }
        Ok(())
    }

    /// Recheck the already released scope before the terminal CAS.  This is
    /// observation only: terminalization never recreates or deletes staging.
    #[cfg(windows)]
    pub(crate) fn revalidate_released_scope_for_terminal(
        &self,
        expected: &StagingReleasedObservation,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), String> {
        check_staging_release_budget(deadline, cancellation).map_err(|error| {
            format!("Capture runtime released staging budget ended: {error:?}.")
        })?;
        if self.scope_state != StagingScopeState::Released
            || self.released_observation.as_ref() != Some(expected)
            || !expected.matches_activation(&self.activation)
        {
            return Err(
                "Capture runtime released staging observation was not the exact owner.".into(),
            );
        }
        self.validate_released_scope().map_err(|error| {
            format!("Capture runtime released staging scope changed: {error:?}.")
        })?;
        check_staging_release_budget(deadline, cancellation).map_err(|error| {
            format!("Capture runtime released staging budget ended: {error:?}.")
        })?;
        Ok(())
    }

    #[cfg(windows)]
    fn released_observation_for_activation(&self) -> StagingReleasedObservation {
        StagingReleasedObservation {
            session_nonce: self.activation.descriptor.session_nonce().to_owned(),
            plan_digest: self.activation.journal_plan.plan_digest.clone(),
            group_staging_identity: self
                .activation
                .descriptor
                .group_staging_identity()
                .to_owned(),
        }
    }

    fn validate_complete_materialized_scope(&self) -> Result<(), StagingCleanupError> {
        if self.scope_state != StagingScopeState::Complete {
            return Err(StagingCleanupError::OwnershipUnknown);
        }
        if self.marker.is_none() || self.roots.len() != self.expected_root_paths.len() {
            return Err(StagingCleanupError::OwnershipUnknown);
        }
        for (root, expected_path) in self.roots.iter().zip(&self.expected_root_paths) {
            if root.path != *expected_path
                || root.identity.is_none()
                || !path_exists(expected_path)
                || !same_identity(expected_path, root.identity)
                || path_is_reparse(expected_path).unwrap_or(true)
            {
                return Err(StagingCleanupError::IdentityChanged);
            }
        }
        self.validate_empty_scope()
    }

    fn validate_running_scope(&self) -> Result<(), String> {
        if self.scope_state != StagingScopeState::Complete {
            return Err("Capture runtime staging scope was not completely materialized.".into());
        }
        if self.marker.is_none() || self.roots.len() != self.expected_root_paths.len() {
            return Err("Capture runtime staging scope ownership was incomplete.".into());
        }
        self.validate_scope_chain()
            .map_err(|error| format!("Capture runtime staging scope changed: {error:?}."))?;
        let marker = self.marker.as_ref().expect("marker checked above");
        if !path_exists(&marker.path)
            || !same_identity(&marker.path, marker.identity)
            || path_is_reparse(&marker.path).unwrap_or(true)
            || read_bounded(&marker.path)
                .map_err(|_| "Capture runtime staging marker could not be read.".to_string())?
                != marker.bytes
        {
            return Err("Capture runtime staging marker identity changed.".into());
        }
        for (root, expected_path) in self.roots.iter().zip(&self.expected_root_paths) {
            if root.path != *expected_path
                || root.identity.is_none()
                || !path_exists(expected_path)
                || !same_identity(expected_path, root.identity)
                || path_is_reparse(expected_path).unwrap_or(true)
                || !ensure_existing_directory(expected_path).is_ok()
            {
                return Err("Capture runtime staging root identity changed.".into());
            }
        }
        Ok(())
    }

    fn validate_empty_scope(&self) -> Result<(), StagingCleanupError> {
        self.validate_scope_chain()?;
        for root_path in &self.expected_root_paths {
            let created = self.roots.iter().find(|root| root.path == *root_path);
            match (created, path_exists(root_path)) {
                (Some(root), true) => {
                    if !same_identity(&root.path, root.identity)
                        || path_is_reparse(&root.path).unwrap_or(true)
                    {
                        return Err(StagingCleanupError::IdentityChanged);
                    }
                    if !is_empty_directory(&root.path)? {
                        return Err(StagingCleanupError::NonEmpty);
                    }
                }
                (Some(_), false) => return Err(StagingCleanupError::IdentityChanged),
                (None, true) => return Err(StagingCleanupError::ForeignEntry),
                (None, false) => {}
            }
        }
        let marker_path = self.group.path.join(MARKER_FILE_NAME);
        match (&self.marker, path_exists(&marker_path)) {
            (Some(marker), true) => {
                if !same_identity(&marker.path, marker.identity)
                    || path_is_reparse(&marker.path).unwrap_or(true)
                {
                    return Err(StagingCleanupError::IdentityChanged);
                }
                if read_bounded(&marker.path).map_err(|_| StagingCleanupError::ForeignEntry)?
                    != marker.bytes
                {
                    return Err(StagingCleanupError::ForeignEntry);
                }
            }
            (Some(_), false) => return Err(StagingCleanupError::IdentityChanged),
            (None, true) => return Err(StagingCleanupError::ForeignEntry),
            (None, false) => {}
        }
        let entries =
            fs::read_dir(&self.group.path).map_err(|_| StagingCleanupError::ForeignEntry)?;
        let marker_path = self.group.path.join(MARKER_FILE_NAME);
        for entry in entries {
            let entry = entry.map_err(|_| StagingCleanupError::ForeignEntry)?;
            let path = entry.path();
            if path != marker_path && !self.expected_root_paths.iter().any(|root| root == &path) {
                return Err(StagingCleanupError::ForeignEntry);
            }
        }
        Ok(())
    }

    fn scope_chain_is_owned(&self) -> bool {
        self.validate_scope_chain().is_ok()
    }

    fn validate_scope_chain(&self) -> Result<(), StagingCleanupError> {
        for directory in [&self.producer_root, &self.shared_parent, &self.group] {
            if validate_safe_chain(&directory.path).is_err()
                || !same_identity(&directory.path, directory.identity)
                || path_is_reparse(&directory.path).unwrap_or(true)
            {
                return Err(if directory.path == self.group.path {
                    StagingCleanupError::IdentityChanged
                } else {
                    StagingCleanupError::Reparse
                });
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn group_path(&self) -> &Path {
        &self.group.path
    }

    #[cfg(test)]
    fn expected_root_paths(&self) -> &[PathBuf] {
        &self.expected_root_paths
    }

    #[cfg(test)]
    pub(crate) fn inject_release_delete_failure_at_for_test(&self, mutation: usize) {
        self.release_delete_failure_at.set(Some(mutation));
    }

    #[cfg(test)]
    pub(crate) fn inject_release_cancel_after_delete_at_for_test(&self, mutation: usize) {
        self.release_cancel_after_delete_at.set(Some(mutation));
    }

    #[cfg(test)]
    pub(crate) fn inject_release_entry_limit_for_test(&self, limit: usize) {
        self.release_entry_limit.set(Some(limit));
    }

    #[cfg(test)]
    pub(crate) fn inject_release_depth_limit_for_test(&self, limit: usize) {
        self.release_depth_limit.set(Some(limit));
    }

    #[cfg(test)]
    pub(crate) fn inject_journal_drift_before_root_for_test(
        &self,
        ordinal: usize,
    ) -> Result<(), String> {
        self.journal_drift_before_root.set(Some(ordinal));
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn inject_journal_drift_before_ready_for_test(&self) {
        self.journal_drift_before_ready.set(true);
    }

    #[cfg(test)]
    fn maybe_inject_journal_drift_before_root(&self, ordinal: usize) {
        if self.journal_drift_before_root.get() != Some(ordinal) {
            return;
        }
        self.journal_drift_before_root.set(None);
        let Ok(current) = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
        else {
            return;
        };
        let _ = self.activation.context.store.compare_and_swap(
            &self.activation.journal_plan,
            &current.cas_snapshot(),
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp: current.updated_at,
            },
        );
    }

    #[cfg(test)]
    fn maybe_inject_journal_drift_before_ready(&self) {
        if !self.journal_drift_before_ready.replace(false) {
            return;
        }
        let Ok(current) = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
        else {
            return;
        };
        let _ = self.activation.context.store.compare_and_swap(
            &self.activation.journal_plan,
            &current.cas_snapshot(),
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp: current.updated_at,
            },
        );
    }
}

fn journal_is_exactly_prepared(activation: &ValidatedActivationContext) -> bool {
    let Ok(journal) = activation.context.store.read(&activation.journal_plan) else {
        return false;
    };
    journal.state == JournalState::PreparedBound
        && journal.cas_snapshot() == activation.expected
        && journal.session_nonce == activation.descriptor.session_nonce()
        && journal.plan_digest == activation.journal_plan.plan_digest
}

fn journal_is_exactly_prepared_with_budget(
    activation: &ValidatedActivationContext,
    budget: &StagingBudget,
) -> Result<bool, StagingFailureKind> {
    budget.check()?;
    let journal = activation
        .context
        .store
        .read(&activation.journal_plan)
        .map_err(|error| match error {
            crate::journal_store::JournalStoreError::AdmissionCancelled => {
                StagingFailureKind::Cancelled
            }
            crate::journal_store::JournalStoreError::AdmissionDeadline => {
                StagingFailureKind::Deadline
            }
            _ => StagingFailureKind::JournalChanged,
        })?;
    budget.check()?;
    Ok(journal.state == JournalState::PreparedBound
        && journal.cas_snapshot() == activation.expected
        && journal.session_nonce == activation.descriptor.session_nonce()
        && journal.plan_digest == activation.journal_plan.plan_digest)
}

fn map_staging_budget_failure(
    error: crate::journal_store::JournalStoreError,
    fallback: &str,
) -> StagingBudgetFailure {
    match error {
        crate::journal_store::JournalStoreError::AdmissionCancelled => StagingBudgetFailure::new(
            StagingFailureKind::Cancelled,
            staging_budget_error(StagingFailureKind::Cancelled),
        ),
        crate::journal_store::JournalStoreError::AdmissionDeadline => StagingBudgetFailure::new(
            StagingFailureKind::Deadline,
            staging_budget_error(StagingFailureKind::Deadline),
        ),
        _ => StagingBudgetFailure::new(StagingFailureKind::Durability, fallback.to_string()),
    }
}

#[cfg(windows)]
fn map_closing_cas_error(error: crate::journal_store::JournalStoreError) -> ClosingCasError {
    match error {
        crate::journal_store::JournalStoreError::AdmissionCancelled => ClosingCasError::Cancelled,
        crate::journal_store::JournalStoreError::AdmissionDeadline => ClosingCasError::Deadline,
        crate::journal_store::JournalStoreError::Conflict => ClosingCasError::Conflict,
        _ => ClosingCasError::Storage,
    }
}

fn marker_bytes(owner: &RunStagingOwner) -> Result<Vec<u8>, StagingFailureKind> {
    let descriptor = &owner.activation.descriptor;
    let roots = owner
        .activation
        .journal_plan
        .roots
        .iter()
        .map(|root| RunStagingMarkerRoot {
            ordinal: root.ordinal,
            root_identity_digest: root_identity_digest(
                descriptor.group_staging_identity(),
                root.ordinal,
                root,
            ),
        })
        .collect::<Vec<_>>();
    let marker = RunStagingMarkerV1 {
        schema_version: MARKER_SCHEMA_VERSION.into(),
        producer: MARKER_PRODUCER.into(),
        session_nonce: descriptor.session_nonce().into(),
        plan_digest: owner.activation.journal_plan.plan_digest.clone(),
        group_staging_identity: descriptor.group_staging_identity().into(),
        roots,
    };
    let encoded = serde_json::to_vec(&marker).map_err(|_| StagingFailureKind::MarkerWrite)?;
    if encoded.len() > MAX_MARKER_BYTES {
        return Err(StagingFailureKind::MarkerWrite);
    }
    Ok(encoded)
}

fn root_identity_digest(
    group_staging_identity: &str,
    ordinal: u32,
    root: &crate::journal::PlannedRoot,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/run-staging-root/v1\0");
    put_string(&mut hasher, group_staging_identity);
    hasher.update(ordinal.to_be_bytes());
    put_string(&mut hasher, &root.role);
    hasher.update(root.root_generation.to_be_bytes());
    put_string(&mut hasher, &root.root_ref_digest);
    put_string(&mut hasher, &root.spec_digest);
    put_string(&mut hasher, &root.reserved_listener_identity);
    hex_lower(&hasher.finalize())
}

/// V2 intentionally cannot validate the prior V1 staging commitment.  The
/// durable field remains the same private `rootDigest`, but a restarted
/// observer must treat a V1 value as unknown instead of silently adopting it.
fn run_staging_scope_digest(
    producer_root_identity: FileIdentity,
    shared_parent_identity: FileIdentity,
    group_identity: FileIdentity,
    marker_identity: FileIdentity,
    group_staging_identity: &str,
    marker_bytes: &[u8],
    root_identities: &[FileIdentity],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/run-staging-scope/v2\0");
    put_string_field(&mut hasher, "groupStagingIdentity", group_staging_identity);
    put_bytes_field(&mut hasher, "markerBytes", marker_bytes);
    put_file_identity_field(
        &mut hasher,
        "producerRootFileIdentity",
        producer_root_identity,
    );
    put_file_identity_field(
        &mut hasher,
        "sharedParentFileIdentity",
        shared_parent_identity,
    );
    put_file_identity_field(&mut hasher, "groupFileIdentity", group_identity);
    put_file_identity_field(&mut hasher, "markerFileIdentity", marker_identity);
    put_string(&mut hasher, "rootCount");
    hasher.update((root_identities.len() as u64).to_be_bytes());
    for (ordinal, identity) in root_identities.iter().copied().enumerate() {
        put_string(&mut hasher, "rootFileIdentity");
        hasher.update((ordinal as u64).to_be_bytes());
        put_file_identity_payload(&mut hasher, identity);
    }
    hex_lower(&hasher.finalize())
}

/// Reopen one producer-owned run scope without turning the observed paths into
/// cleanup authority.  The journal supplies the immutable session/plan
/// binding; the marker supplies the otherwise undiscoverable staging nonce;
/// every filesystem identity is captured again before the V2 digest is
/// compared with the durable binding.
#[cfg(windows)]
pub(crate) fn observe_restart_staging(
    producer_root: &Path,
    plan: &JournalPlanValue,
    journal: &RuntimeSessionJournalV1,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<RestartStagingObservation, RestartStagingObservationReason> {
    check_restart_staging_budget(deadline, cancellation)?;
    journal
        .validate_against_plan(plan)
        .map_err(|_| RestartStagingObservationReason::InvalidRecord)?;
    let has_allowed_state = matches!(
        journal.state,
        JournalState::Ready
            | JournalState::Launching
            | JournalState::Running
            | JournalState::Closing
    ) || (journal.state == JournalState::ReconcileRequired
        && has_complete_restart_resources(journal, plan));
    if !has_allowed_state {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    if plan.roots.is_empty() || plan.roots.len() > MAX_RELEASE_TREE_ENTRIES {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    if journal.roots.len() != plan.roots.len() {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    let binding = journal
        .staging_binding
        .as_ref()
        .ok_or(RestartStagingObservationReason::MissingStaging)?
        .clone();
    if binding.run_nonce != journal.session_nonce || binding.scope != "run" {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }

    if validate_safe_chain(producer_root).is_err() {
        return Err(RestartStagingObservationReason::Reparse);
    }
    let producer_root_identity = restart_directory_identity(producer_root, deadline, cancellation)?;
    let shared_parent = producer_root.join(PRIVATE_RUN_STAGING_DIRECTORY);
    if validate_safe_chain(&shared_parent).is_err() {
        return Err(RestartStagingObservationReason::Reparse);
    }
    let shared_parent_identity =
        restart_directory_identity(&shared_parent, deadline, cancellation)?;

    let mut remaining_entries = MAX_RELEASE_TREE_ENTRIES;
    let mut candidate_count = 0_usize;
    let mut candidate = None;
    let mut parent_entries = read_release_entries(
        &shared_parent,
        deadline,
        cancellation,
        &mut remaining_entries,
    )
    .map_err(map_restart_staging_cleanup_error)?;
    parent_entries.sort_by_key(|entry| entry.path());
    for entry in parent_entries {
        check_restart_staging_budget(deadline, cancellation)?;
        let group_path = entry.path();
        if group_path.parent() != Some(shared_parent.as_path()) {
            return Err(RestartStagingObservationReason::ForeignEntry);
        }
        let group_identity = restart_directory_identity(&group_path, deadline, cancellation)?;
        candidate_count = candidate_count
            .checked_add(1)
            .ok_or(RestartStagingObservationReason::TraversalBound)?;
        if candidate_count > MAX_RESTART_STAGING_CANDIDATES {
            return Err(RestartStagingObservationReason::TraversalBound);
        }
        let group_name = group_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(RestartStagingObservationReason::InvalidRecord)?;
        let marker_path = group_path.join(MARKER_FILE_NAME);
        let (marker_bytes, marker_identity) =
            read_restart_marker(&marker_path, deadline, cancellation, &mut remaining_entries)?;
        let marker = decode_restart_marker(&marker_bytes)?;
        validate_restart_marker_header(&marker, group_name)?;
        if marker.session_nonce != journal.session_nonce || marker.plan_digest != plan.plan_digest {
            continue;
        }
        validate_restart_marker_against_plan(&marker, plan)?;
        if candidate.is_some() {
            return Err(RestartStagingObservationReason::AmbiguousStaging);
        }
        candidate = Some((
            group_path,
            group_identity,
            marker,
            marker_bytes,
            marker_identity,
        ));
    }

    let (
        group_path,
        candidate_group_identity,
        marker,
        candidate_marker_bytes,
        candidate_marker_identity,
    ) = candidate.ok_or(RestartStagingObservationReason::MissingStaging)?;
    if validate_safe_chain(&group_path).is_err() {
        return Err(RestartStagingObservationReason::Reparse);
    }
    let group_identity = restart_directory_identity(&group_path, deadline, cancellation)?;
    if group_identity != candidate_group_identity {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    let marker_path = group_path.join(MARKER_FILE_NAME);
    let mut group_entries =
        read_release_entries(&group_path, deadline, cancellation, &mut remaining_entries)
            .map_err(map_restart_staging_cleanup_error)?;
    group_entries.sort_by_key(|entry| entry.path());
    let mut saw_marker = false;
    let mut saw_roots = vec![false; plan.roots.len()];
    for entry in group_entries {
        check_restart_staging_budget(deadline, cancellation)?;
        let path = entry.path();
        if path.parent() != Some(group_path.as_path()) {
            return Err(RestartStagingObservationReason::ForeignEntry);
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| RestartStagingObservationReason::IdentityChanged)?;
        if metadata_is_reparse(&metadata) {
            return Err(RestartStagingObservationReason::Reparse);
        }
        if path == marker_path {
            if saw_marker || !metadata.is_file() {
                return Err(RestartStagingObservationReason::ForeignEntry);
            }
            saw_marker = true;
            continue;
        }
        let ordinal = parse_restart_root_ordinal(&path)?;
        if ordinal >= plan.roots.len() || saw_roots[ordinal] || !metadata.is_dir() {
            return Err(if metadata.is_dir() {
                RestartStagingObservationReason::ForeignEntry
            } else {
                RestartStagingObservationReason::IdentityChanged
            });
        }
        saw_roots[ordinal] = true;
    }
    if !saw_marker || saw_roots.iter().any(|seen| !seen) {
        return Err(RestartStagingObservationReason::MissingStaging);
    }
    if has_multiple_hard_links(
        &marker_path,
        &fs::symlink_metadata(&marker_path)
            .map_err(|_| RestartStagingObservationReason::IdentityChanged)?,
    ) {
        return Err(RestartStagingObservationReason::HardLink);
    }

    let (marker_bytes, marker_identity) =
        read_restart_marker(&marker_path, deadline, cancellation, &mut remaining_entries)?;
    if marker_bytes != candidate_marker_bytes || marker_identity != candidate_marker_identity {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    validate_restart_marker_against_plan(&marker, plan)?;

    let mut root_identities = Vec::with_capacity(plan.roots.len());
    for ordinal in 0..plan.roots.len() {
        check_restart_staging_budget(deadline, cancellation)?;
        let root_path = group_path.join(format!("root-{ordinal:08}"));
        let root_identity = restart_directory_identity(&root_path, deadline, cancellation)?;
        let mut descendants = Vec::new();
        collect_release_nodes(
            &root_path,
            root_identity,
            1,
            MAX_RELEASE_TREE_DEPTH,
            &mut descendants,
            deadline,
            cancellation,
            &mut remaining_entries,
        )
        .map_err(map_restart_staging_cleanup_error)?;
        let reread_root_identity = restart_directory_identity(&root_path, deadline, cancellation)?;
        if reread_root_identity != root_identity {
            return Err(RestartStagingObservationReason::IdentityChanged);
        }
        root_identities.push(root_identity);
    }

    let reread_group_identity = restart_directory_identity(&group_path, deadline, cancellation)?;
    let reread_shared_parent_identity =
        restart_directory_identity(&shared_parent, deadline, cancellation)?;
    let reread_producer_root_identity =
        restart_directory_identity(producer_root, deadline, cancellation)?;
    if reread_group_identity != group_identity
        || reread_shared_parent_identity != shared_parent_identity
        || reread_producer_root_identity != producer_root_identity
    {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    check_restart_staging_budget(deadline, cancellation)?;
    let actual_digest = run_staging_scope_digest(
        producer_root_identity,
        shared_parent_identity,
        group_identity,
        marker_identity,
        &marker.group_staging_identity,
        &marker_bytes,
        &root_identities,
    );
    if actual_digest != binding.root_digest {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    Ok(RestartStagingObservation {
        group_path,
        group_staging_identity: marker.group_staging_identity,
        binding,
        producer_root_identity,
        shared_parent_identity,
        group_identity,
        marker_identity,
        marker_bytes,
        root_identities,
    })
}

#[cfg(windows)]
fn has_complete_restart_resources(
    journal: &RuntimeSessionJournalV1,
    plan: &JournalPlanValue,
) -> bool {
    journal.attempt < 3
        && matches!(
            journal.job_binding.as_ref(),
            Some(crate::journal::JobBinding {
                setup_state: crate::journal::JobSetupState::Committed,
                ..
            })
        )
        && journal.staging_binding.is_some()
        && journal.roots.len() == plan.roots.len()
        && journal
            .roots
            .iter()
            .enumerate()
            .all(|(ordinal, root)| root.ordinal == ordinal as u32)
}

#[cfg(windows)]
fn check_restart_staging_budget(
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<(), RestartStagingObservationReason> {
    check_staging_release_budget(deadline, cancellation).map_err(map_restart_staging_cleanup_error)
}

#[cfg(windows)]
fn map_restart_staging_cleanup_error(
    error: StagingCleanupError,
) -> RestartStagingObservationReason {
    match error {
        StagingCleanupError::Cancelled => RestartStagingObservationReason::Cancelled,
        StagingCleanupError::Deadline => RestartStagingObservationReason::Deadline,
        StagingCleanupError::TraversalBound => RestartStagingObservationReason::TraversalBound,
        StagingCleanupError::Reparse => RestartStagingObservationReason::Reparse,
        StagingCleanupError::HardLink => RestartStagingObservationReason::HardLink,
        StagingCleanupError::ForeignEntry => RestartStagingObservationReason::ForeignEntry,
        StagingCleanupError::IdentityChanged
        | StagingCleanupError::JournalChanged
        | StagingCleanupError::OwnershipUnknown
        | StagingCleanupError::NonEmpty
        | StagingCleanupError::DeleteFailed => RestartStagingObservationReason::IdentityChanged,
    }
}

#[cfg(windows)]
fn consume_restart_entry(
    remaining_entries: &mut usize,
) -> Result<(), RestartStagingObservationReason> {
    if *remaining_entries == 0 {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    *remaining_entries -= 1;
    Ok(())
}

#[cfg(windows)]
fn restart_directory_identity(
    path: &Path,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<FileIdentity, RestartStagingObservationReason> {
    check_restart_staging_budget(deadline, cancellation)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RestartStagingObservationReason::RecordUnavailable
        } else {
            RestartStagingObservationReason::ForeignEntry
        }
    })?;
    if metadata_is_reparse(&metadata) {
        return Err(RestartStagingObservationReason::Reparse);
    }
    if !metadata.is_dir() {
        return Err(RestartStagingObservationReason::ForeignEntry);
    }
    check_restart_staging_budget(deadline, cancellation)?;
    let identity = capture_directory_identity(path)
        .map_err(|_| RestartStagingObservationReason::IdentityChanged)?;
    check_restart_staging_budget(deadline, cancellation)?;
    Ok(identity)
}

#[cfg(windows)]
fn read_restart_marker(
    path: &Path,
    deadline: Instant,
    cancellation: &AtomicBool,
    remaining_entries: &mut usize,
) -> Result<(Vec<u8>, FileIdentity), RestartStagingObservationReason> {
    check_restart_staging_budget(deadline, cancellation)?;
    consume_restart_entry(remaining_entries)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RestartStagingObservationReason::MissingStaging
        } else {
            RestartStagingObservationReason::ForeignEntry
        }
    })?;
    if !metadata.is_file() {
        return Err(RestartStagingObservationReason::ForeignEntry);
    }
    if metadata_is_reparse(&metadata) {
        return Err(RestartStagingObservationReason::Reparse);
    }
    if has_multiple_hard_links(path, &metadata) {
        return Err(RestartStagingObservationReason::HardLink);
    }
    if metadata.len() > MAX_MARKER_BYTES as u64 {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    let file = File::open(path).map_err(|_| RestartStagingObservationReason::ForeignEntry)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| RestartStagingObservationReason::ForeignEntry)?;
    check_restart_staging_budget(deadline, cancellation)?;
    if bytes.len() > MAX_MARKER_BYTES {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    let identity = capture_file_identity(path)
        .map_err(|_| RestartStagingObservationReason::IdentityChanged)?;
    #[cfg(test)]
    if CANCEL_RESTART_AFTER_MARKER.with(|fault| fault.replace(false)) {
        cancellation.store(true, std::sync::atomic::Ordering::Release);
    }
    check_restart_staging_budget(deadline, cancellation)?;
    Ok((bytes, identity))
}

#[cfg(windows)]
fn decode_restart_marker(
    bytes: &[u8],
) -> Result<RunStagingMarkerV1, RestartStagingObservationReason> {
    let marker = serde_json::from_slice::<RunStagingMarkerV1>(bytes)
        .map_err(|_| RestartStagingObservationReason::InvalidRecord)?;
    let canonical =
        serde_json::to_vec(&marker).map_err(|_| RestartStagingObservationReason::InvalidRecord)?;
    if canonical != bytes {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    Ok(marker)
}

#[cfg(windows)]
fn validate_restart_marker_header(
    marker: &RunStagingMarkerV1,
    group_name: &str,
) -> Result<(), RestartStagingObservationReason> {
    if marker.schema_version != MARKER_SCHEMA_VERSION
        || marker.producer != MARKER_PRODUCER
        || !is_restart_opaque(&marker.session_nonce)
        || !is_restart_digest(&marker.plan_digest)
        || !is_restart_private_nonce(&marker.group_staging_identity)
        || marker.group_staging_identity != group_name
    {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    Ok(())
}

#[cfg(windows)]
fn validate_restart_marker_against_plan(
    marker: &RunStagingMarkerV1,
    plan: &JournalPlanValue,
) -> Result<(), RestartStagingObservationReason> {
    if marker.roots.len() != plan.roots.len() || marker.roots.len() > MAX_RELEASE_TREE_ENTRIES {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    for (ordinal, (actual, planned)) in marker.roots.iter().zip(&plan.roots).enumerate() {
        if actual.ordinal != ordinal as u32
            || !is_restart_digest(&actual.root_identity_digest)
            || actual.root_identity_digest
                != root_identity_digest(&marker.group_staging_identity, actual.ordinal, planned)
        {
            return Err(RestartStagingObservationReason::InvalidRecord);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn parse_restart_root_ordinal(path: &Path) -> Result<usize, RestartStagingObservationReason> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(RestartStagingObservationReason::ForeignEntry)?;
    let Some(suffix) = name.strip_prefix("root-") else {
        return Err(RestartStagingObservationReason::ForeignEntry);
    };
    if suffix.len() != 8 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RestartStagingObservationReason::ForeignEntry);
    }
    suffix
        .parse::<usize>()
        .map_err(|_| RestartStagingObservationReason::ForeignEntry)
}

#[cfg(windows)]
fn is_restart_private_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(windows)]
fn is_restart_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

#[cfg(windows)]
fn is_restart_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn required_file_identity(
    identity: Option<FileIdentity>,
    name: &str,
) -> Result<FileIdentity, String> {
    identity.ok_or_else(|| format!("Capture runtime {name} identity was missing."))
}

fn put_string_field(hasher: &mut Sha256, field: &str, value: &str) {
    put_string(hasher, field);
    put_string(hasher, value);
}

fn put_bytes_field(hasher: &mut Sha256, field: &str, value: &[u8]) {
    put_string(hasher, field);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn put_file_identity_field(hasher: &mut Sha256, field: &str, identity: FileIdentity) {
    put_string(hasher, field);
    put_file_identity_payload(hasher, identity);
}

fn put_file_identity_payload(hasher: &mut Sha256, identity: FileIdentity) {
    hasher.update(identity.first.to_be_bytes());
    hasher.update(identity.second.to_be_bytes());
}

fn put_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn create_marker(
    path: &Path,
    bytes: &[u8],
    budget: &StagingBudget,
) -> Result<OwnedMarker, (StagingFailureKind, Option<FileIdentity>, Vec<u8>)> {
    if let Err(kind) = budget.check() {
        return Err((kind, None, Vec::new()));
    }
    let mut file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(path)
    {
        Ok(file) => file,
        Err(_) => {
            if let Err(kind) = budget.check() {
                return Err((kind, None, Vec::new()));
            }
            return Err((StagingFailureKind::MarkerCollision, None, Vec::new()));
        }
    };
    let identity = capture_file_identity(path).ok();
    if identity.is_none() {
        if let Err(kind) = budget.check() {
            return Err((kind, None, Vec::new()));
        }
        return Err((StagingFailureKind::MarkerWrite, identity, Vec::new()));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, Vec::new()));
    }
    #[cfg(test)]
    let write_result = if FAIL_NEXT_MARKER_PARTIAL_WRITE.with(|fault| fault.replace(0)) != 0 {
        let mut writer = PartialMarkerWriter {
            file: &mut file,
            remaining: 4,
        };
        write_confirmed_prefix_with_budget(&mut writer, bytes, budget)
    } else {
        write_confirmed_prefix_with_budget(&mut file, bytes, budget)
    };
    #[cfg(not(test))]
    let write_result = write_confirmed_prefix_with_budget(&mut file, bytes, budget);
    let (confirmed, write_complete) = match write_result {
        Ok(result) => result,
        Err((kind, confirmed)) => return Err((kind, identity, confirmed)),
    };
    if !write_complete {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    if file.flush().is_err() {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    #[cfg(test)]
    if FAIL_NEXT_MARKER_FLUSH.with(|fault| fault.replace(0)) != 0 {
        return Err((StagingFailureKind::Durability, identity, confirmed.clone()));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    if file.sync_all().is_err() {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    drop(file);
    #[cfg(test)]
    if FAIL_NEXT_MARKER_READBACK.with(|fault| fault.replace(0)) != 0 {
        // Simulate a post-write foreign mutation before the read-back check.
        // The bytes retained in the owner must still be the write-confirmed
        // value, never this observation.
        let _ = fs::write(path, b"foreign-marker-bytes");
    }
    if capture_file_identity(path).ok() != identity {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    let read_back = match read_bounded(path) {
        Ok(read_back) => read_back,
        Err(()) => {
            if let Err(kind) = budget.check() {
                return Err((kind, identity, confirmed));
            }
            return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
        }
    };
    if read_back != bytes || serde_json::from_slice::<RunStagingMarkerV1>(&read_back).is_err() {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    Ok(OwnedMarker {
        path: path.to_path_buf(),
        identity,
        bytes: confirmed,
    })
}

fn write_confirmed_prefix<W: Write>(writer: &mut W, bytes: &[u8]) -> (Vec<u8>, bool) {
    let mut offset = 0;
    while offset < bytes.len() {
        match writer.write(&bytes[offset..]) {
            Ok(0) => return (bytes[..offset].to_vec(), false),
            Ok(count) if count <= bytes.len() - offset => offset += count,
            Ok(_) => return (bytes[..offset].to_vec(), false),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return (bytes[..offset].to_vec(), false),
        }
    }
    (bytes.to_vec(), true)
}

fn write_confirmed_prefix_with_budget<W: Write>(
    writer: &mut W,
    bytes: &[u8],
    budget: &StagingBudget,
) -> Result<(Vec<u8>, bool), (StagingFailureKind, Vec<u8>)> {
    let mut offset = 0;
    while offset < bytes.len() {
        if let Err(kind) = budget.check() {
            return Err((kind, bytes[..offset].to_vec()));
        }
        match writer.write(&bytes[offset..]) {
            Ok(0) => return Ok((bytes[..offset].to_vec(), false)),
            Ok(count) if count <= bytes.len() - offset => offset += count,
            Ok(_) => return Ok((bytes[..offset].to_vec(), false)),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok((bytes[..offset].to_vec(), false)),
        }
    }
    Ok((bytes.to_vec(), true))
}

#[cfg(test)]
struct PartialMarkerWriter<'file> {
    file: &'file mut File,
    remaining: usize,
}

#[cfg(test)]
impl Write for PartialMarkerWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected partial marker write failure",
            ));
        }
        let count = self.remaining.min(bytes.len());
        let written = self.file.write(&bytes[..count])?;
        self.remaining = self.remaining.saturating_sub(written);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

fn ensure_existing_directory(path: &Path) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.is_dir() && !metadata_is_reparse(&metadata) {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(windows)]
fn check_staging_release_budget(
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<(), StagingCleanupError> {
    if cancellation.load(std::sync::atomic::Ordering::Acquire) {
        return Err(StagingCleanupError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(StagingCleanupError::Deadline);
    }
    Ok(())
}

#[cfg(windows)]
fn read_release_entries(
    path: &Path,
    deadline: Instant,
    cancellation: &AtomicBool,
    remaining_entries: &mut usize,
) -> Result<Vec<fs::DirEntry>, StagingCleanupError> {
    check_staging_release_budget(deadline, cancellation)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| StagingCleanupError::ForeignEntry)? {
        check_staging_release_budget(deadline, cancellation)?;
        if *remaining_entries == 0 {
            return Err(StagingCleanupError::TraversalBound);
        }
        *remaining_entries -= 1;
        entries.push(entry.map_err(|_| StagingCleanupError::ForeignEntry)?);
    }
    Ok(entries)
}

#[cfg(windows)]
fn collect_release_nodes(
    path: &Path,
    parent_identity: FileIdentity,
    depth: usize,
    depth_limit: usize,
    nodes: &mut Vec<ReleaseNode>,
    deadline: Instant,
    cancellation: &AtomicBool,
    remaining_entries: &mut usize,
) -> Result<(), StagingCleanupError> {
    check_staging_release_budget(deadline, cancellation)?;
    if depth > depth_limit {
        return Err(StagingCleanupError::TraversalBound);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| StagingCleanupError::ForeignEntry)?;
    if metadata_is_reparse(&metadata) {
        return Err(StagingCleanupError::Reparse);
    }
    let identity = capture_any_identity(path).map_err(|_| StagingCleanupError::IdentityChanged)?;
    check_staging_release_budget(deadline, cancellation)?;
    if metadata.is_dir() {
        let mut entries = read_release_entries(path, deadline, cancellation, remaining_entries)?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect_release_nodes(
                &entry.path(),
                identity,
                depth + 1,
                depth_limit,
                nodes,
                deadline,
                cancellation,
                remaining_entries,
            )?;
        }
        nodes.push(ReleaseNode {
            path: path.to_path_buf(),
            parent: path
                .parent()
                .ok_or(StagingCleanupError::IdentityChanged)?
                .to_path_buf(),
            parent_identity,
            identity,
            is_directory: true,
        });
    } else if metadata.is_file() {
        if has_multiple_hard_links(path, &metadata) {
            return Err(StagingCleanupError::HardLink);
        }
        nodes.push(ReleaseNode {
            path: path.to_path_buf(),
            parent: path
                .parent()
                .ok_or(StagingCleanupError::IdentityChanged)?
                .to_path_buf(),
            parent_identity,
            identity,
            is_directory: false,
        });
    } else {
        return Err(StagingCleanupError::ForeignEntry);
    }
    Ok(())
}

#[cfg(windows)]
fn remove_release_node(node: &ReleaseNode) -> Result<(), StagingCleanupError> {
    if node.is_directory {
        fs::remove_dir(&node.path).map_err(|_| StagingCleanupError::DeleteFailed)
    } else {
        fs::remove_file(&node.path).map_err(|_| StagingCleanupError::DeleteFailed)
    }
}

fn has_multiple_hard_links(path: &Path, metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        let _ = metadata;
        windows_file_link_count(path).map_or(true, |count| count > 1)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        metadata.nlink() > 1
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        let _ = metadata;
        false
    }
}

fn ensure_path_absent_and_safe(path: &Path) -> Result<(), ()> {
    if let Some(parent) = path.parent() {
        ensure_existing_directory(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(_) => Err(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

fn validate_safe_chain(path: &Path) -> Result<(), ()> {
    let mut current = path;
    loop {
        let metadata = fs::symlink_metadata(current).map_err(|_| ())?;
        if metadata_is_reparse(&metadata) {
            return Err(());
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn is_empty_directory(path: &Path) -> Result<bool, StagingCleanupError> {
    let mut entries = fs::read_dir(path).map_err(|_| StagingCleanupError::ForeignEntry)?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|_| StagingCleanupError::ForeignEntry)?
        .is_none())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file()
        || metadata_is_reparse(&metadata)
        || metadata.len() > MAX_MARKER_BYTES as u64
    {
        return Err(());
    }
    let file = File::open(path).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > MAX_MARKER_BYTES {
        Err(())
    } else {
        Ok(bytes)
    }
}

fn same_identity(path: &Path, expected: Option<FileIdentity>) -> bool {
    expected.is_some() && capture_any_identity(path).ok() == expected
}

fn capture_directory_identity(path: &Path) -> Result<FileIdentity, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(());
    }
    capture_path_identity(path, &metadata)
}

fn capture_file_identity(path: &Path) -> Result<FileIdentity, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(());
    }
    capture_path_identity(path, &metadata)
}

fn capture_any_identity(path: &Path) -> Result<FileIdentity, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata_is_reparse(&metadata) {
        return Err(());
    }
    capture_path_identity(path, &metadata)
}

fn capture_path_identity(path: &Path, metadata: &fs::Metadata) -> Result<FileIdentity, ()> {
    #[cfg(windows)]
    {
        let _ = metadata;
        capture_windows_identity(path)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(FileIdentity {
            first: metadata.dev(),
            second: metadata.ino(),
        })
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        let _ = metadata;
        Err(())
    }
}

#[cfg(windows)]
fn capture_windows_identity(path: &Path) -> Result<FileIdentity, ()> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr::null_mut};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        return Err(());
    }
    Ok(FileIdentity {
        first: information.dwVolumeSerialNumber as u64,
        second: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

#[cfg(windows)]
fn windows_file_link_count(path: &Path) -> Result<u32, ()> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr::null_mut};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        Err(())
    } else {
        Ok(information.nNumberOfLinks)
    }
}

fn path_is_reparse(path: &Path) -> Result<bool, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    Ok(metadata_is_reparse(&metadata))
}

fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;
        metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
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

#[cfg(test)]
pub(crate) fn fail_next_marker_flush_for_test() {
    FAIL_NEXT_MARKER_FLUSH.with(|fault| fault.set(1));
}

#[cfg(test)]
pub(crate) fn fail_next_marker_partial_write_for_test() {
    FAIL_NEXT_MARKER_PARTIAL_WRITE.with(|fault| fault.set(1));
}

#[cfg(test)]
pub(crate) fn fail_next_marker_readback_for_test() {
    FAIL_NEXT_MARKER_READBACK.with(|fault| fault.set(1));
}

#[cfg(test)]
pub(crate) fn fail_next_root_mkdir_for_test(ordinal: u32) {
    FAIL_NEXT_ROOT_MKDIR.with(|fault| fault.set(ordinal));
}

#[cfg(test)]
pub(crate) fn cancel_restart_after_marker_for_test() {
    CANCEL_RESTART_AFTER_MARKER.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_materialize_after_group_mkdir_for_test() {
    CANCEL_MATERIALIZE_AFTER_GROUP_MKDIR.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_materialize_after_marker_for_test() {
    CANCEL_MATERIALIZE_AFTER_MARKER.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_after_ready_cas_for_test() {
    CANCEL_AFTER_READY_CAS.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_after_launching_cas_for_test() {
    CANCEL_AFTER_LAUNCHING_CAS.with(|fault| fault.set(true));
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::{
        process::Command,
        sync::atomic::AtomicBool,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use super::*;

    #[cfg(windows)]
    use crate::{
        journal::{
            BoundRoot, CreationIdentity, JobBinding, JobSetupState, JournalBinding, JournalRoot,
            JournalState, ResourceObservation, RootState, RuntimeSessionJournalV1, StagingBinding,
        },
        prepare::{
            build_immutable_group_plan, BindingAttemptId, CompleteGroupBinding,
            CompleteGroupBindingReceiptV1, PersistError, PreparePlanDraft, PrepareRootDraft,
            ReconcileRefSink, ValidatedActivationContext, VerifiedGroupBinding,
        },
        GroupRootPlanInput, OwnedRuntimeSession, SidecarLaunchSpec,
    };

    #[cfg(windows)]
    use sha2::{Digest, Sha256};

    #[cfg(windows)]
    struct BudgetSink {
        binding: Mutex<Option<CompleteGroupBinding>>,
    }

    #[cfg(windows)]
    impl BudgetSink {
        fn new() -> Self {
            Self {
                binding: Mutex::new(None),
            }
        }
    }

    #[cfg(windows)]
    impl ReconcileRefSink for BudgetSink {
        fn persist(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            binding: &CompleteGroupBinding,
        ) -> Result<(), PersistError> {
            *self.binding.lock().unwrap() = Some(binding.clone());
            Ok(())
        }

        fn read_back(
            &self,
            _binding_attempt_id: &BindingAttemptId,
        ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
            CompleteGroupBindingReceiptV1::from_binding(
                self.binding
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or(PersistError::Storage)?,
            )
        }

        fn verify(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            _expected: &CompleteGroupBinding,
            read_back: &CompleteGroupBindingReceiptV1,
        ) -> Result<VerifiedGroupBinding, PersistError> {
            VerifiedGroupBinding::from_receipt(read_back.clone())
        }
    }

    #[cfg(windows)]
    struct BudgetActivationFixture {
        _directory: tempfile::TempDir,
        activation: ValidatedActivationContext,
    }

    #[cfg(windows)]
    impl BudgetActivationFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("budget fixture directory");
            let producer_root = directory.path().join("producer-root");
            fs::create_dir(&producer_root).expect("producer root");

            let executable_path = producer_root.join("capture-runtime.exe");
            fs::copy(
                std::env::current_exe().expect("test executable"),
                &executable_path,
            )
            .expect("executable fixture");
            let executable_bytes = fs::read(&executable_path).expect("executable bytes");

            let schema_bytes = include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json"
            ));
            fs::write(
                producer_root.join(crate::health::R3_SCHEMA_FILE_NAME),
                schema_bytes,
            )
            .expect("canonical schema fixture");

            let manifest = crate::SidecarManifest {
                manifest_version: "1".into(),
                runtime_version: "0.4.2".into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
                platform: "windows".into(),
                arch: "x86_64".into(),
                file_name: "capture-runtime.exe".into(),
                bytes: executable_bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&executable_bytes)),
                schema_file_name: crate::health::R3_SCHEMA_FILE_NAME.into(),
                schema_sha256: crate::health::CANONICAL_CAPTURE_DOCUMENT_V2_SHA256.into(),
            };
            let manifest_path = producer_root.join("capture-runtime-manifest.json");
            fs::write(
                &manifest_path,
                serde_json::to_vec(&manifest).expect("manifest JSON"),
            )
            .expect("manifest fixture");

            let plan = crate::build_immutable_group_plan(
                producer_root.clone(),
                1,
                vec![GroupRootPlanInput::new(
                    "capture".into(),
                    1,
                    SidecarLaunchSpec::new(
                        executable_path,
                        42127,
                        "budget-test-token".into(),
                        vec![("CAPTURE_API_TOKEN".into(), "budget-test-token".into())],
                        Vec::new(),
                    ),
                    manifest_path,
                )],
            )
            .expect("immutable activation plan");
            let sink = BudgetSink::new();
            let prepared = OwnedRuntimeSession::prepare_group(&plan, &sink)
                .expect("prepared activation group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            Self {
                _directory: directory,
                activation,
            }
        }

        fn group_path(&self) -> PathBuf {
            self.activation.descriptor.planned_group_staging_path()
        }
    }

    #[cfg(windows)]
    fn suspended_observation(owner: &RunStagingOwner) -> ResourceObservation {
        ResourceObservation {
            job_binding: JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: "job-budget".into(),
            },
            staging_binding: Some(
                owner
                    .staging_binding_for_ready()
                    .expect("complete staging binding"),
            ),
            roots: owner
                .activation
                .journal_plan
                .roots
                .iter()
                .map(|root| JournalRoot {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    root_nonce: format!("root-budget-{}", root.ordinal),
                    pid: std::process::id(),
                    creation_identity: CreationIdentity {
                        kind: "windows-process-creation".into(),
                        value: format!("creation-budget-{}", root.ordinal),
                    },
                    state: RootState::Suspended,
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                    loopback_port: owner
                        .activation
                        .descriptor
                        .planned_root_port(root.ordinal as usize)
                        .expect("planned root port"),
                    live_listener_readiness: None,
                    started_at: "2026-09-12T00:00:00Z".into(),
                })
                .collect(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn budget_expiry_before_ownership_has_zero_private_group_effect() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() - Duration::from_millis(1),
            Arc::new(AtomicBool::new(false)),
        );

        assert!(matches!(
            result,
            Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::Deadline
            ))
        ));
        assert!(!group.exists(), "expired admission created a private group");
    }

    #[cfg(windows)]
    #[test]
    fn budget_cancellation_before_ownership_has_zero_private_group_effect() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(true)),
        );

        assert!(matches!(
            result,
            Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::Cancelled
            ))
        ));
        assert!(
            !group.exists(),
            "cancelled admission created a private group"
        );
    }

    #[cfg(windows)]
    #[test]
    fn budget_cancellation_after_group_mkdir_returns_the_owned_owner() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        cancel_materialize_after_group_mkdir_for_test();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        );

        match result {
            Err(StagingFailure::Owned { owner, kind }) => {
                assert_eq!(kind, StagingFailureKind::Cancelled);
                assert_eq!(owner.group.path, group);
                assert!(owner.group.path.is_dir());
                assert!(owner.marker.is_none());
                assert!(owner.roots.is_empty());
            }
            Err(StagingFailure::BeforeOwnership(kind)) => {
                panic!("cancellation happened before ownership: {kind:?}")
            }
            Ok(_) => panic!("cancellation was reported as success"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn budget_cancellation_after_marker_readback_returns_marker_owner() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        cancel_materialize_after_marker_for_test();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        );

        match result {
            Err(StagingFailure::Owned { owner, kind }) => {
                assert_eq!(kind, StagingFailureKind::Cancelled);
                let marker = owner.marker.as_ref().expect("retained marker owner");
                assert_eq!(owner.group.path, group);
                assert!(marker.path.is_file());
                assert!(owner.roots.is_empty());
            }
            Err(StagingFailure::BeforeOwnership(kind)) => {
                panic!("marker cancellation happened before ownership: {kind:?}")
            }
            Ok(_) => panic!("marker cancellation was reported as success"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn budgeted_materialization_reports_journal_lock_deadline_before_group_creation() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        let holder = fixture
            .activation
            .context
            .store
            .lock_for_test()
            .expect("journal lock holder");
        let started = Instant::now();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_millis(100),
            Arc::new(AtomicBool::new(false)),
        );
        let elapsed = started.elapsed();
        drop(holder);

        assert!(matches!(
            result,
            Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::Deadline
            ))
        ));
        assert!(!group.exists(), "lock timeout created a private group");
        assert!(
            elapsed < Duration::from_secs(1),
            "budgeted lock read exceeded its bounded wait: {elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn budgeted_ready_cas_reports_late_cancellation_with_ready_disk_state() {
        let fixture = BudgetActivationFixture::new();
        let owner = materialize(fixture.activation).expect("materialized owner");
        let observation = suspended_observation(&owner);
        let timestamp = owner.next_timestamp().expect("Ready timestamp");
        let cancellation = Arc::new(AtomicBool::new(false));
        cancel_after_ready_cas_for_test();
        let result = owner.persist_ready_with_budget(
            observation,
            timestamp,
            Instant::now() + Duration::from_secs(5),
            Arc::clone(&cancellation),
        );

        assert!(
            result
                .as_ref()
                .err()
                .is_some_and(|error| error.detail.contains("cancelled")),
            "late Ready cancellation was reported as success: {result:?}"
        );
        let journal = owner
            .activation
            .context
            .store
            .read(&owner.activation.journal_plan)
            .expect("Ready disk state");
        assert_eq!(journal.state, JournalState::Ready);
        assert!(cancellation.load(std::sync::atomic::Ordering::Acquire));
    }

    #[cfg(windows)]
    #[test]
    fn budgeted_launching_cas_reports_late_cancellation_with_launching_disk_state() {
        let fixture = BudgetActivationFixture::new();
        let owner = materialize(fixture.activation).expect("materialized owner");
        let observation = suspended_observation(&owner);
        let ready_timestamp = owner.next_timestamp().expect("Ready timestamp");
        let ready = owner
            .persist_ready(observation.clone(), ready_timestamp)
            .expect("Ready transition");
        let launching_timestamp = owner.next_timestamp().expect("Launching timestamp");
        let cancellation = Arc::new(AtomicBool::new(false));
        cancel_after_launching_cas_for_test();
        let result = owner.persist_launching_with_budget(
            &ready,
            observation,
            launching_timestamp,
            Instant::now() + Duration::from_secs(5),
            Arc::clone(&cancellation),
        );

        assert!(
            result
                .as_ref()
                .err()
                .is_some_and(|error| error.detail.contains("cancelled")),
            "late Launching cancellation was reported as success: {result:?}"
        );
        let journal = owner
            .activation
            .context
            .store
            .read(&owner.activation.journal_plan)
            .expect("Launching disk state");
        assert_eq!(journal.state, JournalState::Launching);
        assert!(cancellation.load(std::sync::atomic::Ordering::Acquire));
    }

    #[cfg(windows)]
    fn real_scope_digest_fixture(
        producer_root: &Path,
        shared_parent: &Path,
        group: &Path,
        marker: &Path,
        roots: &[PathBuf],
    ) -> String {
        let root_identities = roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("real root identity"))
            .collect::<Vec<_>>();
        run_staging_scope_digest(
            capture_directory_identity(producer_root).expect("real producer root identity"),
            capture_directory_identity(shared_parent).expect("real shared parent identity"),
            capture_directory_identity(group).expect("real group identity"),
            capture_file_identity(marker).expect("real marker identity"),
            "group-staging-identity",
            &fs::read(marker).expect("real marker bytes"),
            &root_identities,
        )
    }

    #[cfg(windows)]
    fn legacy_v1_scope_digest_fixture(
        group_staging_identity: &str,
        marker_bytes: &[u8],
        root_identities: &[FileIdentity],
    ) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"capture-runtime/run-staging-scope/v1\0");
        put_string(&mut hasher, group_staging_identity);
        hasher.update((marker_bytes.len() as u64).to_be_bytes());
        hasher.update(marker_bytes);
        for (ordinal, identity) in root_identities.iter().copied().enumerate() {
            hasher.update((ordinal as u64).to_be_bytes());
            hasher.update(identity.first.to_be_bytes());
            hasher.update(identity.second.to_be_bytes());
        }
        hex_lower(&hasher.finalize())
    }

    struct PartialWriter {
        written: Vec<u8>,
        first_chunk: usize,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.first_chunk != 0 {
                let count = self.first_chunk.min(bytes.len());
                self.written.extend_from_slice(&bytes[..count]);
                self.first_chunk = 0;
                return Ok(count);
            }
            self.written.extend_from_slice(b"foreign-suffix");
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected partial write failure",
            ))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_marker_write_retains_only_our_confirmed_prefix() {
        let mut writer = PartialWriter {
            written: Vec::new(),
            first_chunk: 2,
        };

        let (confirmed, complete) = write_confirmed_prefix(&mut writer, b"abcdef");

        assert_eq!(confirmed, b"ab");
        assert!(!complete);
        assert_eq!(writer.written, b"abforeign-suffix");
        assert_ne!(confirmed, writer.written);
    }

    fn scope_digest_fixture(
        producer_root: FileIdentity,
        shared_parent: FileIdentity,
        group: FileIdentity,
        marker: FileIdentity,
        roots: &[FileIdentity],
    ) -> String {
        run_staging_scope_digest(
            producer_root,
            shared_parent,
            group,
            marker,
            "group-staging-identity",
            br#"{"schemaVersion":"RunStagingMarkerV1"}"#,
            roots,
        )
    }

    #[test]
    fn v2_scope_digest_commits_each_owned_identity_and_root_order() {
        let producer_root = FileIdentity {
            first: 1,
            second: 2,
        };
        let shared_parent = FileIdentity {
            first: 3,
            second: 4,
        };
        let group = FileIdentity {
            first: 5,
            second: 6,
        };
        let marker = FileIdentity {
            first: 7,
            second: 8,
        };
        let roots = [
            FileIdentity {
                first: 9,
                second: 10,
            },
            FileIdentity {
                first: 11,
                second: 12,
            },
        ];
        let original = scope_digest_fixture(producer_root, shared_parent, group, marker, &roots);

        let mutations = [
            scope_digest_fixture(
                FileIdentity {
                    first: 101,
                    second: 2,
                },
                shared_parent,
                group,
                marker,
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                FileIdentity {
                    first: 103,
                    second: 4,
                },
                group,
                marker,
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                shared_parent,
                FileIdentity {
                    first: 105,
                    second: 6,
                },
                marker,
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                shared_parent,
                group,
                FileIdentity {
                    first: 107,
                    second: 8,
                },
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                shared_parent,
                group,
                marker,
                &[roots[1], roots[0]],
            ),
        ];

        for mutated in mutations {
            assert_ne!(mutated, original);
        }
        assert_eq!(
            original,
            scope_digest_fixture(producer_root, shared_parent, group, marker, &roots)
        );
    }

    #[test]
    fn v2_scope_digest_distinguishes_a_byte_identical_marker_copy() {
        let original = scope_digest_fixture(
            FileIdentity {
                first: 1,
                second: 2,
            },
            FileIdentity {
                first: 3,
                second: 4,
            },
            FileIdentity {
                first: 5,
                second: 6,
            },
            FileIdentity {
                first: 7,
                second: 8,
            },
            &[FileIdentity {
                first: 9,
                second: 10,
            }],
        );
        let copied_marker = scope_digest_fixture(
            FileIdentity {
                first: 1,
                second: 2,
            },
            FileIdentity {
                first: 3,
                second: 4,
            },
            FileIdentity {
                first: 5,
                second: 6,
            },
            FileIdentity {
                first: 107,
                second: 108,
            },
            &[FileIdentity {
                first: 9,
                second: 10,
            }],
        );

        assert_ne!(copied_marker, original);
    }

    #[test]
    fn v2_scope_digest_is_not_a_legacy_v1_commitment() {
        let producer_root = FileIdentity {
            first: 1,
            second: 2,
        };
        let shared_parent = FileIdentity {
            first: 3,
            second: 4,
        };
        let group = FileIdentity {
            first: 5,
            second: 6,
        };
        let marker = FileIdentity {
            first: 7,
            second: 8,
        };
        let roots = [FileIdentity {
            first: 9,
            second: 10,
        }];
        let marker_bytes = br#"{"schemaVersion":"RunStagingMarkerV1"}"#;
        let current = scope_digest_fixture(producer_root, shared_parent, group, marker, &roots);

        let mut legacy = Sha256::new();
        legacy.update(b"capture-runtime/run-staging-scope/v1\0");
        put_string(&mut legacy, "group-staging-identity");
        legacy.update((marker_bytes.len() as u64).to_be_bytes());
        legacy.update(marker_bytes);
        for (ordinal, identity) in roots.iter().copied().enumerate() {
            legacy.update((ordinal as u64).to_be_bytes());
            legacy.update(identity.first.to_be_bytes());
            legacy.update(identity.second.to_be_bytes());
        }

        assert_ne!(current, hex_lower(&legacy.finalize()));
    }

    #[cfg(windows)]
    #[test]
    fn v2_scope_digest_rejects_real_same_path_group_replacement_with_moved_scope() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let producer_root = directory.path().join("producer-root");
        let shared_parent = producer_root.join("private-run-staging");
        let group = shared_parent.join("group-staging-identity");
        let marker = group.join(MARKER_FILE_NAME);
        let roots = [group.join("root-00000000"), group.join("root-00000001")];
        fs::create_dir_all(&roots[0]).expect("root zero");
        fs::create_dir(&roots[1]).expect("root one");
        fs::write(&marker, br#"{"schemaVersion":"RunStagingMarkerV1"}"#).expect("marker");
        let original_group_identity =
            capture_directory_identity(&group).expect("original group identity");
        let original_marker_identity = capture_file_identity(&marker).expect("marker identity");
        let original_root_identities = roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("root identity"))
            .collect::<Vec<_>>();
        let original =
            real_scope_digest_fixture(&producer_root, &shared_parent, &group, &marker, &roots);

        let moved = shared_parent.join("moved-group");
        fs::rename(&group, &moved).expect("move original group");
        fs::create_dir(&group).expect("same path replacement group");
        fs::rename(moved.join(MARKER_FILE_NAME), group.join(MARKER_FILE_NAME))
            .expect("move original marker into replacement");
        for ordinal in 0..roots.len() {
            fs::rename(
                moved.join(format!("root-{ordinal:08}")),
                group.join(format!("root-{ordinal:08}")),
            )
            .expect("move original root into replacement");
        }
        let replaced =
            real_scope_digest_fixture(&producer_root, &shared_parent, &group, &marker, &roots);

        assert!(!same_identity(&group, Some(original_group_identity)));
        assert_eq!(
            capture_file_identity(&marker).expect("moved marker identity"),
            original_marker_identity
        );
        let replacement_root_identities = roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("moved root identity"))
            .collect::<Vec<_>>();
        assert_eq!(replacement_root_identities, original_root_identities);
        assert_ne!(replaced, original);
        assert_eq!(
            fs::read(&marker).expect("replacement marker bytes"),
            br#"{"schemaVersion":"RunStagingMarkerV1"}"#
        );
    }

    #[cfg(windows)]
    #[test]
    fn v2_scope_digest_rejects_real_byte_identical_marker_replacement() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let producer_root = directory.path().join("producer-root");
        let shared_parent = producer_root.join("private-run-staging");
        let group = shared_parent.join("group-staging-identity");
        let marker = group.join(MARKER_FILE_NAME);
        let root = group.join("root-00000000");
        fs::create_dir_all(&root).expect("root");
        let marker_bytes = br#"{"schemaVersion":"RunStagingMarkerV1"}"#;
        fs::write(&marker, marker_bytes).expect("marker");
        let original_marker_identity = capture_file_identity(&marker).expect("marker identity");
        let original = real_scope_digest_fixture(
            &producer_root,
            &shared_parent,
            &group,
            &marker,
            std::slice::from_ref(&root),
        );

        let copy = group.join("marker-copy");
        fs::copy(&marker, &copy).expect("copy marker");
        fs::remove_file(&marker).expect("remove original marker");
        fs::rename(&copy, &marker).expect("install byte-identical marker copy");
        let replacement_marker_identity =
            capture_file_identity(&marker).expect("replacement marker identity");
        let replaced = real_scope_digest_fixture(
            &producer_root,
            &shared_parent,
            &group,
            &marker,
            std::slice::from_ref(&root),
        );

        assert!(!same_identity(&marker, Some(original_marker_identity)));
        assert_ne!(replacement_marker_identity, original_marker_identity);
        assert_eq!(fs::read(&marker).expect("marker bytes"), marker_bytes);
        assert_ne!(replaced, original);
    }

    #[test]
    fn scope_digest_rejects_missing_filesystem_identity() {
        for name in [
            "producer root",
            "staging parent",
            "staging group",
            "staging marker",
            "staging root 0",
        ] {
            assert!(required_file_identity(None, name).is_err());
        }
        assert!(required_file_identity(
            Some(FileIdentity {
                first: 1,
                second: 2
            }),
            "root"
        )
        .is_ok());
    }

    #[cfg(windows)]
    struct RestartStagingFixture {
        directory: tempfile::TempDir,
        producer_root: PathBuf,
        plan: JournalPlanValue,
        journal: RuntimeSessionJournalV1,
        group: PathBuf,
        marker: PathBuf,
        roots: Vec<PathBuf>,
    }

    #[cfg(windows)]
    impl RestartStagingFixture {
        fn new(root_count: usize) -> Self {
            let directory = tempfile::tempdir().expect("restart staging fixture directory");
            let producer_root = directory.path().join("producer-root");
            fs::create_dir(&producer_root).expect("producer root");
            let plan = build_immutable_group_plan(
                PreparePlanDraft {
                    group_generation: 1,
                    roots: (0..root_count)
                        .map(|ordinal| PrepareRootDraft {
                            ordinal: ordinal as u32,
                            role: format!("root-{ordinal}"),
                            root_generation: ordinal as u64 + 1,
                            spec_digest: format!("{:064x}", ordinal + 1),
                            reserved_listener_identity: format!("listener-{ordinal}"),
                        })
                        .collect(),
                },
                producer_root.clone(),
                "session-1".into(),
            )
            .expect("restart staging plan")
            .value;
            let group_staging_identity = "0123456789abcdef0123456789abcdef";
            let shared_parent = producer_root.join(PRIVATE_RUN_STAGING_DIRECTORY);
            let group = shared_parent.join(group_staging_identity);
            fs::create_dir_all(&group).expect("staging group");
            let roots = (0..root_count)
                .map(|ordinal| group.join(format!("root-{ordinal:08}")))
                .collect::<Vec<_>>();
            for root in &roots {
                fs::create_dir(root).expect("staging root");
            }
            let marker = group.join(MARKER_FILE_NAME);
            let marker_record = RunStagingMarkerV1 {
                schema_version: MARKER_SCHEMA_VERSION.into(),
                producer: MARKER_PRODUCER.into(),
                session_nonce: "session-1".into(),
                plan_digest: plan.plan_digest.clone(),
                group_staging_identity: group_staging_identity.into(),
                roots: plan
                    .roots
                    .iter()
                    .map(|root| RunStagingMarkerRoot {
                        ordinal: root.ordinal,
                        root_identity_digest: root_identity_digest(
                            group_staging_identity,
                            root.ordinal,
                            root,
                        ),
                    })
                    .collect(),
            };
            let marker_bytes = serde_json::to_vec(&marker_record).expect("marker encoding");
            fs::write(&marker, &marker_bytes).expect("marker");

            let binding = JournalBinding::Bound {
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
                activation_receipt_digest:
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            };
            let root_identities = roots
                .iter()
                .map(|root| capture_directory_identity(root).expect("root identity"))
                .collect::<Vec<_>>();
            let staging_binding = StagingBinding {
                run_nonce: "session-1".into(),
                root_digest: run_staging_scope_digest(
                    capture_directory_identity(&producer_root).expect("producer identity"),
                    capture_directory_identity(&shared_parent).expect("parent identity"),
                    capture_directory_identity(&group).expect("group identity"),
                    capture_file_identity(&marker).expect("marker identity"),
                    group_staging_identity,
                    &marker_bytes,
                    &root_identities,
                ),
                scope: "run".into(),
            };
            let mut journal = RuntimeSessionJournalV1::planned(
                &plan,
                "session-1".into(),
                "2026-01-01T00:00:00Z".into(),
            )
            .expect("planned journal");
            journal.state = JournalState::Ready;
            journal.journal_revision = 1;
            journal.updated_at = "2026-01-01T00:00:01Z".into();
            journal.binding = binding;
            journal.job_binding = Some(JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: "job-1".into(),
            });
            journal.staging_binding = Some(staging_binding);
            journal.roots = plan
                .roots
                .iter()
                .map(|root| JournalRoot {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    root_nonce: format!("root-nonce-{}", root.ordinal),
                    pid: std::process::id(),
                    creation_identity: CreationIdentity {
                        kind: "windows-process-creation".into(),
                        value: "1".into(),
                    },
                    state: RootState::Suspended,
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                    loopback_port: 40000 + root.ordinal as u16,
                    live_listener_readiness: None,
                    started_at: "2026-01-01T00:00:00Z".into(),
                })
                .collect();
            journal
                .validate_against_plan(&plan)
                .expect("valid restart staging journal");

            Self {
                directory,
                producer_root,
                plan,
                journal,
                group,
                marker,
                roots,
            }
        }

        fn observe(&self) -> Result<RestartStagingObservation, RestartStagingObservationReason> {
            observe_restart_staging(
                &self.producer_root,
                &self.plan,
                &self.journal,
                Instant::now() + Duration::from_secs(10),
                &AtomicBool::new(false),
            )
        }
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_accepts_real_one_and_n_root_scopes() {
        for root_count in [1, 2] {
            let fixture = RestartStagingFixture::new(root_count);
            let observation = fixture.observe().expect("complete staging observation");
            assert_eq!(
                observation.binding(),
                fixture.journal.staging_binding.as_ref().expect("binding")
            );
            assert_eq!(observation.group_path(), fixture.group.as_path());
            assert!(fixture.marker.is_file());
            assert_eq!(fixture.roots.len(), root_count);
            assert!(fixture.directory.path().exists());
        }

        for attempt in [1, 2] {
            let mut retry = RestartStagingFixture::new(1);
            retry.journal.state = JournalState::ReconcileRequired;
            retry.journal.attempt = attempt;
            assert!(retry.observe().is_ok(), "complete retry attempt {attempt}");
        }
        let mut missing_resources = RestartStagingFixture::new(1);
        missing_resources.journal.state = JournalState::ReconcileRequired;
        missing_resources.journal.attempt = 1;
        missing_resources.journal.roots.clear();
        assert!(matches!(
            missing_resources.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_rejects_replaced_group_and_byte_identical_marker() {
        let group_fixture = RestartStagingFixture::new(1);
        let moved_group = group_fixture
            .group
            .parent()
            .expect("shared parent")
            .join("moved-group");
        fs::rename(&group_fixture.group, &moved_group).expect("move original group");
        fs::create_dir(&group_fixture.group).expect("replacement group");
        fs::rename(
            moved_group.join(MARKER_FILE_NAME),
            group_fixture.marker.clone(),
        )
        .expect("move original marker");
        for (ordinal, root) in group_fixture.roots.iter().enumerate() {
            fs::rename(moved_group.join(format!("root-{ordinal:08}")), root)
                .expect("move original root");
        }
        fs::remove_dir(&moved_group).expect("remove empty moved group");
        assert!(matches!(
            group_fixture.observe(),
            Err(RestartStagingObservationReason::IdentityChanged)
        ));

        let marker_fixture = RestartStagingFixture::new(1);
        let marker_copy = marker_fixture.group.join("marker-copy");
        fs::copy(&marker_fixture.marker, &marker_copy).expect("copy marker");
        fs::remove_file(&marker_fixture.marker).expect("remove marker");
        fs::rename(&marker_copy, &marker_fixture.marker).expect("replace marker");
        assert!(matches!(
            marker_fixture.observe(),
            Err(RestartStagingObservationReason::IdentityChanged)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_rejects_missing_foreign_and_hardlinked_stage_without_mutation() {
        let missing_marker = RestartStagingFixture::new(1);
        let before = fs::read(&missing_marker.marker).expect("marker bytes");
        fs::remove_file(&missing_marker.marker).expect("remove marker");
        assert!(matches!(
            missing_marker.observe(),
            Err(RestartStagingObservationReason::MissingStaging)
        ));
        assert!(!missing_marker.marker.exists());
        assert!(!before.is_empty());

        let foreign_entry = RestartStagingFixture::new(1);
        fs::write(foreign_entry.group.join("foreign"), b"foreign").expect("foreign entry");
        assert!(matches!(
            foreign_entry.observe(),
            Err(RestartStagingObservationReason::ForeignEntry)
        ));
        assert!(foreign_entry.group.join("foreign").is_file());

        let hardlinked = RestartStagingFixture::new(1);
        let payload = hardlinked.roots[0].join("payload");
        let hardlink = hardlinked.roots[0].join("hardlink");
        fs::write(&payload, b"payload").expect("payload");
        fs::hard_link(&payload, &hardlink).expect("hardlink");
        assert!(matches!(
            hardlinked.observe(),
            Err(RestartStagingObservationReason::HardLink)
        ));
        assert!(payload.is_file() && hardlink.is_file());

        let missing_root = RestartStagingFixture::new(2);
        fs::remove_dir(&missing_root.roots[1]).expect("remove second root");
        assert!(matches!(
            missing_root.observe(),
            Err(RestartStagingObservationReason::MissingStaging)
        ));

        let reparse = RestartStagingFixture::new(1);
        let target = reparse.directory.path().join("foreign-target");
        fs::create_dir(&target).expect("reparse target");
        fs::remove_dir(&reparse.roots[0]).expect("remove root for junction");
        let junction = Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                reparse.roots[0].to_str().expect("junction path"),
                target.to_str().expect("junction target"),
            ])
            .status()
            .expect("mklink junction");
        assert!(junction.success(), "junction fixture could not be created");
        assert!(matches!(
            reparse.observe(),
            Err(RestartStagingObservationReason::Reparse)
        ));
        assert!(target.exists());
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_requires_canonical_closed_marker_and_full_budget() {
        let fixture = RestartStagingFixture::new(1);
        let valid = fs::read(&fixture.marker).expect("valid marker");
        let mut noncanonical = b" ".to_vec();
        noncanonical.extend_from_slice(&valid);
        fs::write(&fixture.marker, &noncanonical).expect("noncanonical marker");
        assert!(matches!(
            fixture.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let duplicate = RestartStagingFixture::new(1);
        let duplicate_bytes = String::from_utf8(fs::read(&duplicate.marker).expect("marker"))
            .expect("marker utf8")
            .replacen(
                "\"producer\":",
                "\"schemaVersion\":\"RunStagingMarkerV1\",\"producer\":",
                1,
            );
        fs::write(&duplicate.marker, duplicate_bytes.as_bytes()).expect("duplicate marker");
        assert!(matches!(
            duplicate.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let unknown = RestartStagingFixture::new(1);
        let mut unknown_value: serde_json::Value =
            serde_json::from_slice(&valid).expect("marker json");
        unknown_value
            .as_object_mut()
            .expect("marker object")
            .insert("unknown".into(), true.into());
        fs::write(
            &unknown.marker,
            serde_json::to_vec(&unknown_value).expect("unknown marker"),
        )
        .expect("unknown marker write");
        assert!(matches!(
            unknown.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let wrong_type = RestartStagingFixture::new(1);
        let mut wrong_type_value: serde_json::Value =
            serde_json::from_slice(&valid).expect("marker json");
        wrong_type_value
            .as_object_mut()
            .expect("marker object")
            .insert("roots".into(), "wrong-type".into());
        fs::write(
            &wrong_type.marker,
            serde_json::to_vec(&wrong_type_value).expect("wrong type marker"),
        )
        .expect("wrong type marker write");
        assert!(matches!(
            wrong_type.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let mut legacy_binding = RestartStagingFixture::new(1);
        let marker_bytes = fs::read(&legacy_binding.marker).expect("legacy marker bytes");
        let root_identities = legacy_binding
            .roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("legacy root identity"))
            .collect::<Vec<_>>();
        let legacy_digest = legacy_v1_scope_digest_fixture(
            "0123456789abcdef0123456789abcdef",
            &marker_bytes,
            &root_identities,
        );
        legacy_binding
            .journal
            .staging_binding
            .as_mut()
            .expect("legacy staging binding")
            .root_digest = legacy_digest;
        assert!(matches!(
            legacy_binding.observe(),
            Err(RestartStagingObservationReason::IdentityChanged)
        ));

        let cancelled = RestartStagingFixture::new(1);
        assert!(matches!(
            observe_restart_staging(
                &cancelled.producer_root,
                &cancelled.plan,
                &cancelled.journal,
                Instant::now() + Duration::from_secs(10),
                &AtomicBool::new(true),
            ),
            Err(RestartStagingObservationReason::Cancelled)
        ));

        let cancelled_after_work = RestartStagingFixture::new(1);
        let marker_before_cancel = fs::read(&cancelled_after_work.marker).expect("marker");
        cancel_restart_after_marker_for_test();
        assert!(matches!(
            cancelled_after_work.observe(),
            Err(RestartStagingObservationReason::Cancelled)
        ));
        assert_eq!(
            fs::read(&cancelled_after_work.marker).expect("marker"),
            marker_before_cancel
        );

        let expired = RestartStagingFixture::new(1);
        assert!(matches!(
            observe_restart_staging(
                &expired.producer_root,
                &expired.plan,
                &expired.journal,
                Instant::now() - Duration::from_millis(1),
                &AtomicBool::new(false),
            ),
            Err(RestartStagingObservationReason::Deadline)
        ));

        let oversized = RestartStagingFixture::new(1);
        let oversized_bytes = vec![b'x'; MAX_MARKER_BYTES + 1];
        fs::write(&oversized.marker, &oversized_bytes).expect("oversized marker");
        assert!(matches!(
            oversized.observe(),
            Err(RestartStagingObservationReason::TraversalBound)
        ));
        assert_eq!(
            fs::read(&oversized.marker).expect("oversized marker"),
            oversized_bytes
        );

        let candidate_bound = RestartStagingFixture::new(1);
        let candidate_marker_before =
            fs::read(&candidate_bound.marker).expect("candidate bound marker");
        let candidate_parent = candidate_bound
            .producer_root
            .join(PRIVATE_RUN_STAGING_DIRECTORY);
        for index in 1..=MAX_RESTART_STAGING_CANDIDATES {
            let group_name = format!("{index:032x}");
            let group = candidate_parent.join(&group_name);
            fs::create_dir(&group).expect("candidate group");
            let marker = RunStagingMarkerV1 {
                schema_version: MARKER_SCHEMA_VERSION.into(),
                producer: MARKER_PRODUCER.into(),
                session_nonce: format!("foreign-{index}"),
                plan_digest: candidate_bound.plan.plan_digest.clone(),
                group_staging_identity: group_name,
                roots: Vec::new(),
            };
            fs::write(
                group.join(MARKER_FILE_NAME),
                serde_json::to_vec(&marker).expect("candidate marker"),
            )
            .expect("candidate marker");
        }
        assert!(matches!(
            candidate_bound.observe(),
            Err(RestartStagingObservationReason::TraversalBound)
        ));
        assert_eq!(
            fs::read(&candidate_bound.marker).expect("candidate bound marker"),
            candidate_marker_before
        );
        assert!(candidate_parent
            .join(format!("{:032x}", MAX_RESTART_STAGING_CANDIDATES))
            .join(MARKER_FILE_NAME)
            .is_file());

        let deep = RestartStagingFixture::new(1);
        let mut deepest = deep.roots[0].clone();
        for depth in 0..=MAX_RELEASE_TREE_DEPTH {
            deepest.push(format!("d{depth:02}"));
            fs::create_dir(&deepest).expect("nested staging directory");
        }
        let deep_result = deep.observe();
        let deep_reason = deep_result.as_ref().err().copied();
        assert_eq!(
            deep_reason,
            Some(RestartStagingObservationReason::TraversalBound),
            "unexpected deep observation reason: {deep_reason:?}"
        );
        assert!(deep.roots[0].is_dir() && deepest.is_dir());
    }
}
