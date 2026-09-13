//! Private pre-native run-staging owner.
//!
//! This module materializes only the producer-planned directory scope after
//! durable preparation.  It does not acquire a listener, process, model, or
//! other runtime resource.  The owner is deliberately move-only and is kept
//! in every error after the group directory is created so a later lifecycle
//! owner can retry cleanup without rediscovering paths.
//!
//! The filesystem checks and directory creation are deliberately sequential;
//! this foundation does not claim hostile concurrent path confinement or
//! restartable ownership.  File contents are flushed and read back, but this
//! slice does not establish a crash-durable directory-entry or restart
//! ownership proof.  It also does not claim native cleanup or terminal proof.
//! A later activation owner must consume this value and perform the native
//! cleanup proof before final journal terminalization.

#![allow(dead_code)]

use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

#[cfg(test)]
use std::cell::Cell;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    journal::{JournalState, ResourceObservation, RuntimeSessionJournalV1, StagingBinding},
    journal_store::JournalStoreCommand,
    prepare::ValidatedActivationContext,
};

#[cfg(windows)]
use crate::journal_store::{
    install_running_read_budget, ClosingCasAdmission, ClosingCasError, ClosingCasResult,
    ClosingCleanupAdmission, RunningCasAdmission, RunningCasError, RunningCasResult,
};

#[cfg(windows)]
use std::{sync::atomic::AtomicBool, time::Instant};

const MARKER_FILE_NAME: &str = ".capture-run-staging-v1";
const MARKER_SCHEMA_VERSION: &str = "RunStagingMarkerV1";
const MARKER_PRODUCER: &str = "capture-runtime";
// Keep marker reads bounded by the journal record ceiling used by the store.
const MAX_MARKER_BYTES: usize = 1024 * 1024;
const MAX_RELEASE_TREE_ENTRIES: usize = 8 * 1024;
const MAX_RELEASE_TREE_DEPTH: usize = 32;

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_MARKER_FLUSH: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_PARTIAL_WRITE: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_READBACK: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_ROOT_MKDIR: Cell<u32> = const { Cell::new(u32::MAX) };
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

/// Consume the validated activation handoff and materialize its producer-
/// planned, empty directory scope.  The journal snapshot is read while the
/// tree is still untouched, immediately before the first mkdir.
pub(crate) fn materialize(
    activation: ValidatedActivationContext,
) -> Result<RunStagingOwner, StagingFailure> {
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
    if !journal_is_exactly_prepared(&activation) {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::JournalChanged,
        ));
    }
    // Verify every executable before creating even the shared staging
    // directory.  A later per-root check rechecks the artifact before each
    // spawn; this does not eliminate path/content TOCTOU.
    if activation.descriptor.checked_commands().is_err() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    if validate_safe_chain(&producer_root_path).is_err() {
        return Err(StagingFailure::BeforeOwnership(StagingFailureKind::Reparse));
    }

    let shared_parent = group_path.parent().ok_or(StagingFailure::BeforeOwnership(
        StagingFailureKind::InvalidActivation,
    ))?;
    if ensure_existing_directory(shared_parent).is_err() {
        if let Err(error) = fs::create_dir(shared_parent) {
            if error.kind() != std::io::ErrorKind::AlreadyExists
                || ensure_existing_directory(shared_parent).is_err()
            {
                return Err(StagingFailure::BeforeOwnership(
                    StagingFailureKind::SharedParent,
                ));
            }
        }
    }
    if path_is_reparse(shared_parent).unwrap_or(true) {
        return Err(StagingFailure::BeforeOwnership(StagingFailureKind::Reparse));
    }
    let producer_root_identity = capture_directory_identity(&producer_root_path).ok();
    let shared_parent_identity = capture_directory_identity(shared_parent).ok();
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
    if let Err(error) = fs::create_dir(&group_path) {
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

    let marker_path = group_path.join(MARKER_FILE_NAME);
    if ensure_path_absent_and_safe(&marker_path).is_err() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::MarkerCollision,
        });
    }
    let marker_bytes = match marker_bytes(&owner) {
        Ok(bytes) => bytes,
        Err(kind) => {
            return Err(StagingFailure::Owned { owner, kind });
        }
    };
    let marker = match create_marker(&marker_path, &marker_bytes) {
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

    for (_ordinal, root_path) in owner.expected_root_paths.clone().into_iter().enumerate() {
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
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::RootCollision,
            });
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
    }
    owner.scope_state = StagingScopeState::Complete;
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
        let mut hasher = Sha256::new();
        hasher.update(b"capture-runtime/run-staging-scope/v1\0");
        put_string(
            &mut hasher,
            self.activation.descriptor.group_staging_identity(),
        );
        hasher.update((marker.bytes.len() as u64).to_be_bytes());
        hasher.update(&marker.bytes);
        for (ordinal, root) in self.roots.iter().enumerate() {
            hasher.update((ordinal as u64).to_be_bytes());
            let identity = root
                .identity
                .ok_or_else(|| "Capture runtime staging root identity was missing.".to_string())?;
            hasher.update(identity.first.to_be_bytes());
            hasher.update(identity.second.to_be_bytes());
        }
        Ok(StagingBinding {
            run_nonce: self.activation.descriptor.session_nonce().to_owned(),
            root_digest: hex_lower(&hasher.finalize()),
            scope: "run".into(),
        })
    }

    pub(crate) fn persist_ready(
        &self,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<crate::journal::RuntimeSessionJournalV1, String> {
        if !journal_is_exactly_prepared(&self.activation) {
            return Err("Capture runtime prepared binding changed before Ready CAS.".into());
        }
        let expected_revision = self
            .activation
            .expected
            .journal_revision
            .checked_add(1)
            .ok_or_else(|| "Capture runtime journal revision overflowed.".to_string())?;
        #[cfg(test)]
        self.maybe_inject_journal_drift_before_ready();
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
            .map_err(|_| "Capture runtime Ready journal CAS failed.".to_string())?;
        if ready.state != JournalState::Ready
            || ready.journal_revision != expected_revision
            || ready.binding != self.activation.binding
            || ready.job_binding.as_ref() != Some(&observation.job_binding)
            || ready.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || ready.roots != observation.roots
        {
            return Err("Capture runtime Ready journal read-back was not exact.".into());
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
        expected_ready
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| "Capture runtime Ready journal was invalid.".to_string())?;
        if expected_ready.state != JournalState::Ready
            || expected_ready.session_nonce != self.activation.descriptor.session_nonce()
            || expected_ready.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(
                "Capture runtime Ready journal identity was invalid before Launching CAS.".into(),
            );
        }
        let current = self
            .activation
            .context
            .store
            .read(&self.activation.journal_plan)
            .map_err(|_| "Capture runtime Ready journal could not be revalidated.".to_string())?;
        if current != *expected_ready {
            return Err("Capture runtime Ready journal changed before Launching CAS.".into());
        }
        let expected_revision = expected_ready
            .journal_revision
            .checked_add(1)
            .ok_or_else(|| "Capture runtime journal revision overflowed.".to_string())?;
        let expected_updated_at = timestamp.clone();
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
            .map_err(|_| "Capture runtime Launching journal CAS failed.".to_string())?;
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
            return Err("Capture runtime Launching journal read-back was not exact.".into());
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

fn put_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn create_marker(
    path: &Path,
    bytes: &[u8],
) -> Result<OwnedMarker, (StagingFailureKind, Option<FileIdentity>, Vec<u8>)> {
    let mut file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(path)
    {
        Ok(file) => file,
        Err(_) => return Err((StagingFailureKind::MarkerCollision, None, Vec::new())),
    };
    let identity = capture_file_identity(path).ok();
    if identity.is_none() {
        return Err((StagingFailureKind::MarkerWrite, identity, Vec::new()));
    }
    #[cfg(test)]
    let write_result = if FAIL_NEXT_MARKER_PARTIAL_WRITE.with(|fault| fault.replace(0)) != 0 {
        let mut writer = PartialMarkerWriter {
            file: &mut file,
            remaining: 4,
        };
        write_confirmed_prefix(&mut writer, bytes)
    } else {
        write_confirmed_prefix(&mut file, bytes)
    };
    #[cfg(not(test))]
    let write_result = write_confirmed_prefix(&mut file, bytes);
    let (confirmed, write_complete) = write_result;
    if !write_complete {
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if file.flush().is_err() {
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    #[cfg(test)]
    if FAIL_NEXT_MARKER_FLUSH.with(|fault| fault.replace(0)) != 0 {
        return Err((StagingFailureKind::Durability, identity, confirmed.clone()));
    }
    if file.sync_all().is_err() {
        return Err((StagingFailureKind::Durability, identity, confirmed));
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
        return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
    }
    let read_back = match read_bounded(path) {
        Ok(read_back) => read_back,
        Err(()) => return Err((StagingFailureKind::MarkerReadBack, identity, confirmed)),
    };
    if read_back != bytes || serde_json::from_slice::<RunStagingMarkerV1>(&read_back).is_err() {
        return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
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
mod tests {
    use super::*;

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
}
