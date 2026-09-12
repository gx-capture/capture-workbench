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
};

#[cfg(test)]
use std::cell::Cell;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    journal::{JournalState, ResourceObservation, StagingBinding},
    journal_store::JournalStoreCommand,
    prepare::ValidatedActivationContext,
};

const MARKER_FILE_NAME: &str = ".capture-run-staging-v1";
const MARKER_SCHEMA_VERSION: &str = "RunStagingMarkerV1";
const MARKER_PRODUCER: &str = "capture-runtime";
// Keep marker reads bounded by the journal record ceiling used by the store.
const MAX_MARKER_BYTES: usize = 1024 * 1024;

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_MARKER_FLUSH: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_PARTIAL_WRITE: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_READBACK: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_ROOT_MKDIR: Cell<u32> = const { Cell::new(u32::MAX) };
}

/// The private result used by the later terminal CAS.  It does not claim
/// native cleanup; this slice only proves that this exact owned empty scope
/// was released.
pub(crate) struct StagingReleasedObservation {
    session_nonce: String,
    plan_digest: String,
    group_staging_identity: String,
}

impl StagingReleasedObservation {
    pub(crate) fn staging_released_matches(&self, activation: &ValidatedActivationContext) -> bool {
        self.session_nonce == activation.descriptor.session_nonce()
            && self.plan_digest == activation.journal_plan.plan_digest
            && self.group_staging_identity == activation.descriptor.group_staging_identity()
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
    JournalChanged,
    OwnershipUnknown,
    Reparse,
    IdentityChanged,
    ForeignEntry,
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
    #[cfg(test)]
    journal_drift_before_root: Cell<Option<usize>>,
    #[cfg(test)]
    journal_drift_before_ready: Cell<bool>,
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
        #[cfg(test)]
        journal_drift_before_root: Cell::new(None),
        #[cfg(test)]
        journal_drift_before_ready: Cell::new(false),
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

    pub(crate) fn staging_binding_for_ready(&self) -> Result<StagingBinding, String> {
        self.validate_complete_materialized_scope()
            .map_err(|error| format!("Capture runtime staging admission failed: {error:?}."))?;
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
