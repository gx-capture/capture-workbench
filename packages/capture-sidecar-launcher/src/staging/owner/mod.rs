use std::{fs, path::PathBuf, sync::Arc};

#[cfg(test)]
use std::cell::Cell;

#[cfg(windows)]
use std::{sync::atomic::AtomicBool, time::Instant};

use crate::prepare::ValidatedActivationContext;

#[cfg(windows)]
use crate::journal_store::install_running_read_budget;

use super::{
    failure::StagingCleanupError,
    identity::{
        ensure_existing_directory, is_empty_directory, path_exists, path_is_reparse, read_bounded,
        same_identity, validate_safe_chain, FileIdentity,
    },
    marker::{OwnedMarker, MARKER_FILE_NAME},
};

mod journal;
mod materialize;
mod release;

pub(crate) use materialize::materialize;

#[cfg(windows)]
pub(crate) use materialize::materialize_with_budget;

#[cfg(test)]
pub(crate) use materialize::fail_next_root_mkdir_for_test;

struct OwnedDirectory {
    path: PathBuf,
    identity: Option<FileIdentity>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StagingScopeState {
    Partial,
    Complete,
    Released,
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
    fn matches_activation(&self, activation: &ValidatedActivationContext) -> bool {
        self.session_nonce == activation.descriptor.session_nonce()
            && self.plan_digest == activation.journal_plan.plan_digest
            && self.group_staging_identity == activation.descriptor.group_staging_identity()
    }
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

impl RunStagingOwner {
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
}

#[cfg(all(test, windows))]
use std::sync::Mutex;

#[cfg(all(test, windows))]
use sha2::{Digest, Sha256};

#[cfg(all(test, windows))]
use crate::journal_store::activation_budget_for_test;

#[cfg(all(test, windows))]
use crate::prepare::{
    BindingAttemptId, CompleteGroupBinding, CompleteGroupBindingReceiptV1, PersistError,
    ReconcileRefSink, VerifiedGroupBinding,
};

#[cfg(all(test, windows))]
use crate::{GroupRootPlanInput, OwnedRuntimeSession, SidecarLaunchSpec};

#[cfg(all(test, windows))]
struct BudgetSink {
    binding: Mutex<Option<CompleteGroupBinding>>,
}

#[cfg(all(test, windows))]
impl BudgetSink {
    fn new() -> Self {
        Self {
            binding: Mutex::new(None),
        }
    }
}

#[cfg(all(test, windows))]
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

#[cfg(all(test, windows))]
struct BudgetActivationFixture {
    _directory: tempfile::TempDir,
    activation: ValidatedActivationContext,
}

#[cfg(all(test, windows))]
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
            runtime_version: env!("CARGO_PKG_VERSION").into(),
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
        let prepared =
            OwnedRuntimeSession::prepare_group(&plan, &sink).expect("prepared activation group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
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
