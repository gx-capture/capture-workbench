//! Private value and compare-and-swap foundation for `RuntimeSessionJournalV1`.
//!
//! This module deliberately does not persist a journal, inspect native
//! resources, launch a root, or construct an activation permit.  It validates
//! the producer-owned value and its legal state transitions so the later
//! durable writer can use one fail-closed CAS rule.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const JOURNAL_SCHEMA_VERSION: &str = "RuntimeSessionJournalV1";
const PRODUCER: &str = "capture-runtime";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JournalError {
    InvalidField(&'static str),
    InvalidBinding(&'static str),
    InvalidTransition,
    StaleCas,
    UnauthorizedRecovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JournalState {
    PlannedUnbound,
    PreparedBound,
    Ready,
    Launching,
    Running,
    Closing,
    Terminal,
    #[serde(rename = "reconcile-required")]
    ReconcileRequired,
    #[serde(rename = "manual-review")]
    ManualReview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlannedRoot {
    pub(crate) ordinal: u32,
    pub(crate) role: String,
    pub(crate) root_ref_digest: String,
    pub(crate) root_generation: u64,
    pub(crate) spec_digest: String,
    pub(crate) reserved_listener_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JournalPlanValue {
    pub(crate) plan_digest: String,
    pub(crate) group_ref_digest: String,
    pub(crate) group_generation: u64,
    pub(crate) roots: Vec<PlannedRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BoundRoot {
    pub(crate) ordinal: u32,
    pub(crate) role: String,
    pub(crate) root_ref_digest: String,
    pub(crate) root_generation: u64,
    pub(crate) spec_digest: String,
    pub(crate) reserved_listener_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum JournalBinding {
    Unbound {},
    Bound {
        #[serde(rename = "bindingAttemptId")]
        binding_attempt_id: String,
        #[serde(rename = "groupRefDigest")]
        group_ref_digest: String,
        #[serde(rename = "groupGeneration")]
        group_generation: u64,
        #[serde(rename = "rootBindings")]
        root_bindings: Vec<BoundRoot>,
        #[serde(rename = "activationReceiptDigest")]
        activation_receipt_digest: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobSetupState {
    Pending,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobBinding {
    pub(crate) setup_state: JobSetupState,
    pub(crate) job_nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StagingBinding {
    pub(crate) run_nonce: String,
    pub(crate) root_digest: String,
    pub(crate) scope: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RootState {
    Suspended,
    Running,
    Closing,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JournalRoot {
    pub(crate) ordinal: u32,
    pub(crate) role: String,
    pub(crate) root_ref_digest: String,
    pub(crate) root_generation: u64,
    pub(crate) root_nonce: String,
    pub(crate) pid: u32,
    pub(crate) creation_identity: CreationIdentity,
    pub(crate) state: RootState,
    pub(crate) reserved_listener_identity: String,
    pub(crate) loopback_port: u16,
    pub(crate) live_listener_readiness: Option<String>,
    pub(crate) started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreationIdentity {
    pub(crate) kind: String,
    pub(crate) value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalProof {
    pub(crate) root_reaped: bool,
    pub(crate) descendants_terminated: bool,
    pub(crate) listeners_released: bool,
    pub(crate) staging_released: bool,
    pub(crate) proof_generation: u64,
    pub(crate) unacquired_root_bindings: Vec<BoundRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeSessionJournalV1 {
    pub(crate) schema_version: String,
    pub(crate) producer: String,
    pub(crate) session_nonce: String,
    pub(crate) journal_revision: u64,
    pub(crate) plan_digest: String,
    pub(crate) state: JournalState,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) job_binding: Option<JobBinding>,
    pub(crate) binding: JournalBinding,
    pub(crate) staging_binding: Option<StagingBinding>,
    pub(crate) roots: Vec<JournalRoot>,
    pub(crate) proof: Option<TerminalProof>,
    pub(crate) recovery_epoch: u64,
    pub(crate) attempt: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CasSnapshot {
    pub(crate) session_nonce: String,
    pub(crate) plan_digest: String,
    pub(crate) state: JournalState,
    pub(crate) journal_revision: u64,
    pub(crate) attempt: u8,
    pub(crate) recovery_epoch: u64,
    pub(crate) binding: JournalBinding,
}

/// A producer-observed resource value. It contains no handles and performs no
/// acquisition; the durable lifecycle owner supplies only observations that it
/// has already verified against the private group binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResourceObservation {
    pub(crate) job_binding: JobBinding,
    pub(crate) staging_binding: Option<StagingBinding>,
    pub(crate) roots: Vec<JournalRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalObservation {
    proof: TerminalProof,
    binding: JournalBinding,
    resources: Option<ResourceObservation>,
    expected_revision: u64,
    expected_attempt: u8,
    expected_recovery_epoch: u64,
    expected_session_nonce: String,
    expected_plan_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryAuthorization {
    recovery_nonce: String,
    authorization_digest: String,
    expected_revision: u64,
    expected_attempt: u8,
    expected_recovery_epoch: u64,
    expected_binding: JournalBinding,
    expected_session_nonce: String,
    expected_plan_digest: String,
    consumed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReconcileAttempt {
    Complete,
    Failed,
}

impl ResourceObservation {
    fn validate_for_state(
        &self,
        binding: &JournalBinding,
        state: JournalState,
    ) -> Result<(), JournalError> {
        require_bound(binding)?;
        if self.job_binding.setup_state != JobSetupState::Committed {
            return Err(JournalError::InvalidBinding("jobBinding"));
        }
        validate_job_binding(Some(&self.job_binding))?;
        validate_staging_binding(self.staging_binding.as_ref())?;
        validate_journal_roots(&self.roots)?;
        require_bound_roots(binding, &self.roots)?;
        for root in &self.roots {
            let readiness = root.live_listener_readiness.is_some();
            let valid = match state {
                JournalState::Ready | JournalState::Launching => {
                    root.state == RootState::Suspended && !readiness
                }
                JournalState::Running => root.state == RootState::Running && readiness,
                JournalState::Closing => root.state == RootState::Closing && readiness,
                JournalState::Terminal => root.state == RootState::Terminal && !readiness,
                _ => false,
            };
            if !valid {
                return Err(JournalError::InvalidBinding("rootObservation"));
            }
        }
        Ok(())
    }

    fn validate_partial_for(&self, binding: &JournalBinding) -> Result<(), JournalError> {
        require_bound(binding)?;
        validate_job_binding(Some(&self.job_binding))?;
        validate_staging_binding(self.staging_binding.as_ref())?;
        validate_partial_journal_roots(&self.roots)?;
        let JournalBinding::Bound { root_bindings, .. } = binding else {
            return Err(JournalError::InvalidBinding("bound"));
        };
        if self.roots.len() > root_bindings.len()
            || self.roots.iter().any(|actual| {
                root_bindings
                    .iter()
                    .find(|expected| expected.ordinal == actual.ordinal)
                    .map_or(true, |expected| {
                        !bound_root_matches_actual(expected, actual)
                    })
            })
        {
            return Err(JournalError::InvalidBinding("partialRoots"));
        }
        Ok(())
    }
}

impl TerminalObservation {
    fn from_resources(
        journal: &RuntimeSessionJournalV1,
        resources: ResourceObservation,
        proof: TerminalProof,
    ) -> Result<Self, JournalError> {
        journal.validate()?;
        if !proof.unacquired_root_bindings.is_empty() {
            return Err(JournalError::InvalidBinding("terminalRoots"));
        }
        resources.validate_for_state(&journal.binding, JournalState::Terminal)?;
        validate_terminal_proof_generation(journal, &proof)?;
        Ok(Self {
            proof,
            binding: journal.binding.clone(),
            resources: Some(resources),
            expected_revision: journal.journal_revision,
            expected_attempt: journal.attempt,
            expected_recovery_epoch: journal.recovery_epoch,
            expected_session_nonce: journal.session_nonce.clone(),
            expected_plan_digest: journal.plan_digest.clone(),
        })
    }

    fn from_partial_resources(
        journal: &RuntimeSessionJournalV1,
        resources: ResourceObservation,
        proof: TerminalProof,
    ) -> Result<Self, JournalError> {
        journal.validate()?;
        resources.validate_partial_for(&journal.binding)?;
        validate_partial_terminal_observation(&journal.binding, &resources.roots, &proof)?;
        validate_terminal_proof_generation(journal, &proof)?;
        Ok(Self {
            proof,
            binding: journal.binding.clone(),
            resources: Some(resources),
            expected_revision: journal.journal_revision,
            expected_attempt: journal.attempt,
            expected_recovery_epoch: journal.recovery_epoch,
            expected_session_nonce: journal.session_nonce.clone(),
            expected_plan_digest: journal.plan_digest.clone(),
        })
    }

    fn no_resources(
        journal: &RuntimeSessionJournalV1,
        mut proof: TerminalProof,
    ) -> Result<Self, JournalError> {
        journal.validate()?;
        if journal.job_binding.is_some()
            || journal.staging_binding.is_some()
            || !journal.roots.is_empty()
        {
            return Err(JournalError::InvalidBinding("resourceObservation"));
        }
        match &journal.binding {
            JournalBinding::Unbound {} => {
                if !proof.unacquired_root_bindings.is_empty() {
                    return Err(JournalError::InvalidBinding("terminalRoots"));
                }
            }
            JournalBinding::Bound { root_bindings, .. } => {
                if proof.unacquired_root_bindings.is_empty() {
                    proof.unacquired_root_bindings = root_bindings.clone();
                }
                validate_partial_terminal_observation(&journal.binding, &[], &proof)?;
            }
        }
        validate_terminal_proof_generation(journal, &proof)?;
        Ok(Self {
            proof,
            binding: journal.binding.clone(),
            resources: None,
            expected_revision: journal.journal_revision,
            expected_attempt: journal.attempt,
            expected_recovery_epoch: journal.recovery_epoch,
            expected_session_nonce: journal.session_nonce.clone(),
            expected_plan_digest: journal.plan_digest.clone(),
        })
    }

    fn validate_for(
        &self,
        journal: &RuntimeSessionJournalV1,
        expected: &CasSnapshot,
    ) -> Result<(), JournalError> {
        journal.expect_snapshot(expected)?;
        if self.expected_revision != journal.journal_revision
            || self.expected_attempt != journal.attempt
            || self.expected_recovery_epoch != journal.recovery_epoch
            || self.binding != journal.binding
            || self.expected_session_nonce != journal.session_nonce
            || self.expected_plan_digest != journal.plan_digest
        {
            return Err(JournalError::StaleCas);
        }
        validate_terminal_proof_generation(journal, &self.proof)?;
        if let Some(resources) = &self.resources {
            assert_resource_identity_unchanged(journal, resources)?;
            if self.proof.unacquired_root_bindings.is_empty() {
                resources.validate_for_state(&self.binding, JournalState::Terminal)?;
            } else {
                resources.validate_partial_for(&self.binding)?;
                validate_partial_terminal_observation(
                    &self.binding,
                    &resources.roots,
                    &self.proof,
                )?;
            }
        } else if journal.job_binding.is_some()
            || journal.staging_binding.is_some()
            || !journal.roots.is_empty()
        {
            return Err(JournalError::InvalidBinding("resourceObservation"));
        } else {
            validate_no_resource_terminal_observation(&self.binding, &self.proof)?;
        }
        Ok(())
    }
}

impl RecoveryAuthorization {
    // The foundation has no durable operator-authority source. This constructor
    // is test-bound so production recovery cannot be claimed before that source
    // and its replay receipt are supplied by the later journal backend.
    #[cfg(test)]
    fn for_journal(
        journal: &RuntimeSessionJournalV1,
        recovery_nonce: String,
    ) -> Result<Self, JournalError> {
        journal.validate()?;
        opaque(&recovery_nonce, "recoveryNonce")?;
        Ok(Self {
            authorization_digest: recovery_authorization_digest(journal, &recovery_nonce)?,
            recovery_nonce,
            expected_revision: journal.journal_revision,
            expected_attempt: journal.attempt,
            expected_recovery_epoch: journal.recovery_epoch,
            expected_binding: journal.binding.clone(),
            expected_session_nonce: journal.session_nonce.clone(),
            expected_plan_digest: journal.plan_digest.clone(),
            consumed: false,
        })
    }

    fn validate_for(
        &self,
        journal: &RuntimeSessionJournalV1,
        expected: &CasSnapshot,
    ) -> Result<(), JournalError> {
        journal.expect_snapshot(expected)?;
        if self.consumed
            || !matches!(journal.state, JournalState::ManualReview)
            || journal.attempt != 3
            || self.expected_revision != journal.journal_revision
            || self.expected_attempt != journal.attempt
            || self.expected_recovery_epoch != journal.recovery_epoch
            || self.expected_binding != journal.binding
            || self.expected_session_nonce != journal.session_nonce
            || self.expected_plan_digest != journal.plan_digest
            || self.authorization_digest
                != recovery_authorization_digest(journal, &self.recovery_nonce)?
        {
            return Err(JournalError::UnauthorizedRecovery);
        }
        Ok(())
    }
}

impl JournalPlanValue {
    pub(crate) fn validate(&self) -> Result<(), JournalError> {
        digest(&self.plan_digest, "planDigest")?;
        digest(&self.group_ref_digest, "groupRefDigest")?;
        if self.group_generation == 0 {
            return Err(JournalError::InvalidField("groupGeneration"));
        }
        validate_complete_roots(&self.roots, "plan.roots")
    }
}

impl RuntimeSessionJournalV1 {
    pub(crate) fn planned(
        plan: &JournalPlanValue,
        session_nonce: String,
        timestamp: String,
    ) -> Result<Self, JournalError> {
        plan.validate()?;
        opaque(&session_nonce, "sessionNonce")?;
        timestamp_value(&timestamp, "timestamp")?;
        Ok(Self {
            schema_version: JOURNAL_SCHEMA_VERSION.to_owned(),
            producer: PRODUCER.to_owned(),
            session_nonce,
            journal_revision: 0,
            plan_digest: plan.plan_digest.clone(),
            state: JournalState::PlannedUnbound,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            job_binding: None,
            binding: JournalBinding::Unbound {},
            staging_binding: None,
            roots: Vec::new(),
            proof: None,
            recovery_epoch: 0,
            attempt: 0,
        })
    }

    pub(crate) fn validate_against_plan(
        &self,
        plan: &JournalPlanValue,
    ) -> Result<(), JournalError> {
        self.validate()?;
        plan.validate()?;
        if self.plan_digest != plan.plan_digest {
            return Err(JournalError::InvalidBinding("planDigest"));
        }
        if let JournalBinding::Bound { .. } = &self.binding {
            validate_binding_against_plan(&self.binding, plan)?;
        }
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), JournalError> {
        if self.schema_version != JOURNAL_SCHEMA_VERSION {
            return Err(JournalError::InvalidField("schemaVersion"));
        }
        if self.producer != PRODUCER {
            return Err(JournalError::InvalidField("producer"));
        }
        opaque(&self.session_nonce, "sessionNonce")?;
        digest(&self.plan_digest, "planDigest")?;
        timestamp_value(&self.created_at, "createdAt")?;
        timestamp_value(&self.updated_at, "updatedAt")?;
        if self.updated_at < self.created_at {
            return Err(JournalError::InvalidField("updatedAt"));
        }
        if self.attempt > 3 {
            return Err(JournalError::InvalidField("attempt"));
        }
        validate_binding(&self.binding)?;
        validate_job_binding(self.job_binding.as_ref())?;
        validate_staging_binding(self.staging_binding.as_ref())?;
        validate_partial_journal_roots(&self.roots)?;
        if let Some(proof) = &self.proof {
            validate_proof(proof)?;
        }
        match self.state {
            JournalState::PlannedUnbound => {
                if !matches!(self.binding, JournalBinding::Unbound {})
                    || self.job_binding.is_some()
                    || self.staging_binding.is_some()
                    || !self.roots.is_empty()
                    || self.proof.is_some()
                {
                    return Err(JournalError::InvalidBinding("plannedUnbound"));
                }
            }
            JournalState::PreparedBound => {
                require_bound(&self.binding)?;
                if self.job_binding.is_some()
                    || self.staging_binding.is_some()
                    || !self.roots.is_empty()
                    || self.proof.is_some()
                {
                    return Err(JournalError::InvalidBinding("preparedBound"));
                }
            }
            JournalState::Ready => {
                validate_journal_resources(self, JournalState::Ready)?;
                if self.proof.is_some() {
                    return Err(JournalError::InvalidBinding("ready"));
                }
            }
            JournalState::Launching | JournalState::Running | JournalState::Closing => {
                validate_journal_resources(self, self.state)?;
                if self.proof.is_some() {
                    return Err(JournalError::InvalidBinding("liveState"));
                }
            }
            JournalState::Terminal => {
                let proof = self
                    .proof
                    .as_ref()
                    .ok_or(JournalError::InvalidBinding("terminalProof"))?;
                if !proof.root_reaped
                    || !proof.descendants_terminated
                    || !proof.listeners_released
                    || !proof.staging_released
                {
                    return Err(JournalError::InvalidBinding("terminalProof"));
                }
                if proof.proof_generation != self.journal_revision {
                    return Err(JournalError::InvalidBinding("proofGeneration"));
                }
                match &self.binding {
                    JournalBinding::Unbound {} => {
                        if self.job_binding.is_some()
                            || self.staging_binding.is_some()
                            || !self.roots.is_empty()
                        {
                            return Err(JournalError::InvalidBinding("terminalUnbound"));
                        }
                    }
                    JournalBinding::Bound { .. } => {
                        if let Some(job_binding) = self.job_binding.clone() {
                            let resources = ResourceObservation {
                                job_binding,
                                staging_binding: self.staging_binding.clone(),
                                roots: self.roots.clone(),
                            };
                            if proof.unacquired_root_bindings.is_empty()
                                && self.roots.len()
                                    == bound_root_count(&self.binding).unwrap_or_default()
                            {
                                resources
                                    .validate_for_state(&self.binding, JournalState::Terminal)?;
                            } else {
                                resources.validate_partial_for(&self.binding)?;
                                validate_partial_terminal_observation(
                                    &self.binding,
                                    &self.roots,
                                    proof,
                                )?;
                            }
                        } else {
                            if self.staging_binding.is_some() || !self.roots.is_empty() {
                                return Err(JournalError::InvalidBinding("terminalResources"));
                            }
                            validate_no_resource_terminal_observation(&self.binding, proof)?;
                        }
                    }
                }
            }
            JournalState::ReconcileRequired | JournalState::ManualReview => {
                match &self.binding {
                    JournalBinding::Unbound {} => {
                        if self.job_binding.is_some()
                            || self.staging_binding.is_some()
                            || !self.roots.is_empty()
                        {
                            return Err(JournalError::InvalidBinding("unboundResources"));
                        }
                    }
                    JournalBinding::Bound { .. } => {
                        if self.job_binding.is_some()
                            || self.staging_binding.is_some()
                            || !self.roots.is_empty()
                        {
                            let job_binding = self
                                .job_binding
                                .clone()
                                .ok_or(JournalError::InvalidBinding("partialJobBinding"))?;
                            ResourceObservation {
                                job_binding,
                                staging_binding: self.staging_binding.clone(),
                                roots: self.roots.clone(),
                            }
                            .validate_partial_for(&self.binding)?;
                        }
                    }
                }
                if self.proof.is_some() {
                    return Err(JournalError::InvalidBinding("reconcileProof"));
                }
                if matches!(self.state, JournalState::ReconcileRequired) && self.attempt == 3 {
                    return Err(JournalError::InvalidField("attempt"));
                }
                if matches!(self.state, JournalState::ManualReview) && self.attempt != 3 {
                    return Err(JournalError::InvalidField("attempt"));
                }
            }
        }
        Ok(())
    }

    pub(crate) fn cas_snapshot(&self) -> CasSnapshot {
        CasSnapshot {
            session_nonce: self.session_nonce.clone(),
            plan_digest: self.plan_digest.clone(),
            state: self.state,
            journal_revision: self.journal_revision,
            attempt: self.attempt,
            recovery_epoch: self.recovery_epoch,
            binding: self.binding.clone(),
        }
    }

    pub(crate) fn cas_transition(
        &mut self,
        expected: &CasSnapshot,
        next_state: JournalState,
        replacement_binding: Option<JournalBinding>,
        timestamp: String,
    ) -> Result<(), JournalError> {
        if matches!(next_state, JournalState::PreparedBound) {
            return Err(JournalError::InvalidBinding("prepareBinding"));
        }
        self.cas_transition_internal(expected, next_state, replacement_binding, None, timestamp)
    }

    pub(crate) fn cas_transition_with_observation(
        &mut self,
        expected: &CasSnapshot,
        next_state: JournalState,
        replacement_binding: Option<JournalBinding>,
        observation: ResourceObservation,
        timestamp: String,
    ) -> Result<(), JournalError> {
        if matches!(next_state, JournalState::PreparedBound) {
            return Err(JournalError::InvalidBinding("prepareBinding"));
        }
        self.cas_transition_internal(
            expected,
            next_state,
            replacement_binding,
            Some(observation),
            timestamp,
        )
    }

    fn cas_transition_internal(
        &mut self,
        expected: &CasSnapshot,
        next_state: JournalState,
        replacement_binding: Option<JournalBinding>,
        observation: Option<ResourceObservation>,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        self.expect_snapshot(expected)?;
        timestamp_after(self, &timestamp)?;
        if !legal_transition(self.state, next_state)
            || matches!(
                next_state,
                JournalState::Terminal | JournalState::ManualReview
            )
        {
            return Err(JournalError::InvalidTransition);
        }
        if matches!(self.binding, JournalBinding::Unbound {})
            && matches!(replacement_binding, Some(JournalBinding::Bound { .. }))
            && !matches!(next_state, JournalState::PreparedBound)
        {
            return Err(JournalError::InvalidBinding("immutableBinding"));
        }
        let mut candidate = self.clone();
        candidate.state = next_state;
        if let Some(binding) = replacement_binding {
            candidate.binding = binding;
        }
        if let Some(observation) = observation {
            assert_resource_identity_unchanged(self, &observation)?;
            candidate.job_binding = Some(observation.job_binding);
            candidate.staging_binding = observation.staging_binding;
            candidate.roots = observation.roots;
        } else if matches!(
            next_state,
            JournalState::Ready
                | JournalState::Launching
                | JournalState::Running
                | JournalState::Closing
        ) {
            return Err(JournalError::InvalidBinding("resourceObservation"));
        }
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        self.assert_immutable_binding_after_transition(&candidate)?;
        candidate.validate()?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn cas_prepare_bound(
        &mut self,
        plan: &JournalPlanValue,
        expected: &CasSnapshot,
        binding: JournalBinding,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        self.expect_snapshot(expected)?;
        timestamp_after(self, &timestamp)?;
        if !matches!(self.state, JournalState::PlannedUnbound)
            || !matches!(self.binding, JournalBinding::Unbound {})
        {
            return Err(JournalError::InvalidTransition);
        }
        plan.validate()?;
        if self.plan_digest != plan.plan_digest {
            return Err(JournalError::InvalidBinding("planDigest"));
        }
        validate_binding_against_plan(&binding, plan)?;
        let mut candidate = self.clone();
        candidate.state = JournalState::PreparedBound;
        candidate.binding = binding;
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        candidate.validate()?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn cas_terminalize_with_observation(
        &mut self,
        expected: &CasSnapshot,
        observation: TerminalObservation,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        observation.validate_for(self, expected)?;
        timestamp_after(self, &timestamp)?;
        if !matches!(self.state, JournalState::Closing) {
            return Err(JournalError::InvalidTransition);
        }
        let mut candidate = self.clone();
        candidate.state = JournalState::Terminal;
        candidate.proof = Some(observation.proof.clone());
        if let Some(resources) = observation.resources {
            candidate.job_binding = Some(resources.job_binding);
            candidate.staging_binding = resources.staging_binding;
            candidate.roots = resources.roots;
        }
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        candidate.validate()?;
        self.assert_immutable_binding_after_transition(&candidate)?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn cas_terminalize_no_resource(
        &mut self,
        expected: &CasSnapshot,
        observation: TerminalObservation,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        observation.validate_for(self, expected)?;
        timestamp_after(self, &timestamp)?;
        if !matches!(self.state, JournalState::PlannedUnbound)
            || !matches!(self.binding, JournalBinding::Unbound {})
            || observation.resources.is_some()
        {
            return Err(JournalError::InvalidTransition);
        }
        let mut candidate = self.clone();
        candidate.state = JournalState::Terminal;
        candidate.proof = Some(observation.proof.clone());
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        candidate.validate()?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn cas_reconcile_attempt(
        &mut self,
        expected: &CasSnapshot,
        attempt: ReconcileAttempt,
        proof: Option<TerminalProof>,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        self.expect_snapshot(expected)?;
        timestamp_after(self, &timestamp)?;
        if !matches!(self.state, JournalState::ReconcileRequired) || self.attempt >= 3 {
            return Err(JournalError::InvalidTransition);
        }
        let next_attempt = self.attempt + 1;
        let mut candidate = self.clone();
        candidate.attempt = next_attempt;
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        match attempt {
            ReconcileAttempt::Complete => {
                let _ = proof;
                return Err(JournalError::InvalidBinding("terminalObservation"));
            }
            ReconcileAttempt::Failed => {
                if proof.is_some() {
                    return Err(JournalError::InvalidBinding("reconcileProof"));
                }
                candidate.state = if next_attempt == 3 {
                    JournalState::ManualReview
                } else {
                    JournalState::ReconcileRequired
                };
            }
        }
        candidate.validate()?;
        self.assert_immutable_binding_after_transition(&candidate)?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn cas_reconcile_complete(
        &mut self,
        expected: &CasSnapshot,
        observation: TerminalObservation,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        observation.validate_for(self, expected)?;
        timestamp_after(self, &timestamp)?;
        if !matches!(self.state, JournalState::ReconcileRequired) || self.attempt >= 3 {
            return Err(JournalError::InvalidTransition);
        }
        let mut candidate = self.clone();
        candidate.state = JournalState::Terminal;
        candidate.attempt = candidate.attempt + 1;
        candidate.proof = Some(observation.proof.clone());
        if let Some(resources) = observation.resources {
            candidate.job_binding = Some(resources.job_binding);
            candidate.staging_binding = resources.staging_binding;
            candidate.roots = resources.roots;
        }
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        candidate.validate()?;
        self.assert_immutable_binding_after_transition(&candidate)?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn cas_recover_manual_review(
        &mut self,
        expected: &CasSnapshot,
        authorization: &mut RecoveryAuthorization,
        timestamp: String,
    ) -> Result<(), JournalError> {
        self.validate()?;
        authorization.validate_for(self, expected)?;
        timestamp_after(self, &timestamp)?;
        let mut candidate = self.clone();
        candidate.state = JournalState::ReconcileRequired;
        candidate.attempt = 0;
        candidate.recovery_epoch = candidate
            .recovery_epoch
            .checked_add(1)
            .ok_or(JournalError::InvalidField("recoveryEpoch"))?;
        candidate.journal_revision = candidate
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?;
        candidate.updated_at = timestamp;
        candidate.validate()?;
        self.assert_immutable_binding_after_transition(&candidate)?;
        *self = candidate;
        authorization.consumed = true;
        Ok(())
    }

    pub(crate) fn encode_private(&self) -> Result<Vec<u8>, JournalError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| JournalError::InvalidField("journal"))
    }

    pub(crate) fn decode_private(bytes: &[u8]) -> Result<Self, JournalError> {
        let journal: Self =
            serde_json::from_slice(bytes).map_err(|_| JournalError::InvalidField("journal"))?;
        journal.validate()?;
        Ok(journal)
    }

    fn expect_snapshot(&self, expected: &CasSnapshot) -> Result<(), JournalError> {
        if self.cas_snapshot() == *expected {
            Ok(())
        } else {
            Err(JournalError::StaleCas)
        }
    }

    fn assert_immutable_binding_after_transition(
        &self,
        candidate: &Self,
    ) -> Result<(), JournalError> {
        if matches!(self.binding, JournalBinding::Bound { .. })
            && !matches!(candidate.binding, JournalBinding::Bound { .. })
        {
            return Err(JournalError::InvalidBinding("immutableBinding"));
        }
        if matches!(self.binding, JournalBinding::Bound { .. })
            && matches!(candidate.binding, JournalBinding::Bound { .. })
            && self.binding != candidate.binding
        {
            return Err(JournalError::InvalidBinding("immutableBinding"));
        }
        Ok(())
    }
}

fn legal_transition(from: JournalState, to: JournalState) -> bool {
    matches!(
        (from, to),
        (JournalState::PlannedUnbound, JournalState::PreparedBound)
            | (
                JournalState::PlannedUnbound,
                JournalState::ReconcileRequired
            )
            | (JournalState::PreparedBound, JournalState::Ready)
            | (JournalState::PreparedBound, JournalState::ReconcileRequired)
            | (JournalState::Ready, JournalState::Launching)
            | (JournalState::Ready, JournalState::ReconcileRequired)
            | (JournalState::Launching, JournalState::Running)
            | (JournalState::Launching, JournalState::ReconcileRequired)
            | (JournalState::Running, JournalState::Closing)
            | (JournalState::Running, JournalState::ReconcileRequired)
            | (JournalState::Closing, JournalState::ReconcileRequired)
    )
}

fn validate_binding(binding: &JournalBinding) -> Result<(), JournalError> {
    match binding {
        JournalBinding::Unbound {} => Ok(()),
        JournalBinding::Bound {
            binding_attempt_id,
            group_ref_digest,
            group_generation,
            root_bindings,
            activation_receipt_digest,
        } => {
            opaque(binding_attempt_id, "bindingAttemptId")?;
            digest(group_ref_digest, "groupRefDigest")?;
            if *group_generation == 0 {
                return Err(JournalError::InvalidField("groupGeneration"));
            }
            digest(activation_receipt_digest, "activationReceiptDigest")?;
            validate_complete_roots(root_bindings, "rootBindings")
        }
    }
}

fn validate_binding_against_plan(
    binding: &JournalBinding,
    plan: &JournalPlanValue,
) -> Result<(), JournalError> {
    let JournalBinding::Bound {
        group_ref_digest,
        group_generation,
        root_bindings,
        ..
    } = binding
    else {
        return Err(JournalError::InvalidBinding("completeBinding"));
    };
    if group_ref_digest != &plan.group_ref_digest
        || *group_generation != plan.group_generation
        || root_bindings.len() != plan.roots.len()
        || root_bindings
            .iter()
            .zip(&plan.roots)
            .any(|(actual, expected)| {
                actual.ordinal != expected.ordinal
                    || actual.role != expected.role
                    || actual.root_ref_digest != expected.root_ref_digest
                    || actual.root_generation != expected.root_generation
                    || actual.spec_digest != expected.spec_digest
                    || actual.reserved_listener_identity != expected.reserved_listener_identity
            })
    {
        return Err(JournalError::InvalidBinding("completeBinding"));
    }
    Ok(())
}

fn validate_complete_roots<T>(roots: &[T], context: &'static str) -> Result<(), JournalError>
where
    T: RootIdentity,
{
    if roots.is_empty() {
        return Err(JournalError::InvalidBinding(context));
    }
    for (index, root) in roots.iter().enumerate() {
        if root.ordinal() != index as u32
            || root.root_generation() == 0
            || root.role().is_empty()
            || root.reserved_listener_identity().is_empty()
        {
            return Err(JournalError::InvalidBinding(context));
        }
        digest(root.root_ref_digest(), "rootRefDigest")?;
        digest(root.spec_digest(), "specDigest")?;
    }
    Ok(())
}

trait RootIdentity {
    fn ordinal(&self) -> u32;
    fn role(&self) -> &str;
    fn root_ref_digest(&self) -> &str;
    fn root_generation(&self) -> u64;
    fn spec_digest(&self) -> &str;
    fn reserved_listener_identity(&self) -> &str;
}

impl RootIdentity for PlannedRoot {
    fn ordinal(&self) -> u32 {
        self.ordinal
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn root_ref_digest(&self) -> &str {
        &self.root_ref_digest
    }
    fn root_generation(&self) -> u64 {
        self.root_generation
    }
    fn spec_digest(&self) -> &str {
        &self.spec_digest
    }
    fn reserved_listener_identity(&self) -> &str {
        &self.reserved_listener_identity
    }
}

impl RootIdentity for BoundRoot {
    fn ordinal(&self) -> u32 {
        self.ordinal
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn root_ref_digest(&self) -> &str {
        &self.root_ref_digest
    }
    fn root_generation(&self) -> u64 {
        self.root_generation
    }
    fn spec_digest(&self) -> &str {
        &self.spec_digest
    }
    fn reserved_listener_identity(&self) -> &str {
        &self.reserved_listener_identity
    }
}

fn require_bound(binding: &JournalBinding) -> Result<(), JournalError> {
    if matches!(binding, JournalBinding::Bound { .. }) {
        Ok(())
    } else {
        Err(JournalError::InvalidBinding("bound"))
    }
}

fn require_bound_roots(
    binding: &JournalBinding,
    roots: &[JournalRoot],
) -> Result<(), JournalError> {
    let JournalBinding::Bound { root_bindings, .. } = binding else {
        return Err(JournalError::InvalidBinding("bound"));
    };
    if roots.len() != root_bindings.len()
        || roots.iter().zip(root_bindings).any(|(actual, expected)| {
            actual.ordinal != expected.ordinal
                || actual.role != expected.role
                || actual.root_ref_digest != expected.root_ref_digest
                || actual.root_generation != expected.root_generation
                || actual.reserved_listener_identity != expected.reserved_listener_identity
        })
    {
        return Err(JournalError::InvalidBinding("roots"));
    }
    Ok(())
}

fn validate_job_binding(binding: Option<&JobBinding>) -> Result<(), JournalError> {
    if let Some(binding) = binding {
        opaque(&binding.job_nonce, "jobNonce")?;
    }
    Ok(())
}

fn require_committed_job(binding: Option<&JobBinding>) -> Result<(), JournalError> {
    if matches!(
        binding,
        Some(JobBinding {
            setup_state: JobSetupState::Committed,
            ..
        })
    ) {
        Ok(())
    } else {
        Err(JournalError::InvalidBinding("jobBinding"))
    }
}

fn validate_staging_binding(binding: Option<&StagingBinding>) -> Result<(), JournalError> {
    if let Some(binding) = binding {
        opaque(&binding.run_nonce, "runNonce")?;
        digest(&binding.root_digest, "rootDigest")?;
        if binding.scope != "run" {
            return Err(JournalError::InvalidField("scope"));
        }
    }
    Ok(())
}

fn validate_journal_roots(roots: &[JournalRoot]) -> Result<(), JournalError> {
    for (index, root) in roots.iter().enumerate() {
        if root.ordinal != index as u32 {
            return Err(JournalError::InvalidBinding("roots"));
        }
        validate_journal_root_shape(root)?;
    }
    Ok(())
}

fn validate_partial_journal_roots(roots: &[JournalRoot]) -> Result<(), JournalError> {
    for (previous, root) in roots.iter().zip(roots.iter().skip(1)) {
        if previous.ordinal >= root.ordinal {
            return Err(JournalError::InvalidBinding("roots"));
        }
    }
    for root in roots {
        validate_journal_root_shape(root)?;
    }
    Ok(())
}

fn validate_journal_root_shape(root: &JournalRoot) -> Result<(), JournalError> {
    if root.role.is_empty()
        || root.pid == 0
        || root.loopback_port == 0
        || root.root_generation == 0
        || root.reserved_listener_identity.is_empty()
    {
        return Err(JournalError::InvalidBinding("roots"));
    }
    digest(&root.root_ref_digest, "rootRefDigest")?;
    opaque(&root.root_nonce, "rootNonce")?;
    opaque(&root.creation_identity.kind, "creationIdentity.kind")?;
    opaque(&root.creation_identity.value, "creationIdentity.value")?;
    opaque(&root.reserved_listener_identity, "reservedListenerIdentity")?;
    if let Some(readiness) = &root.live_listener_readiness {
        opaque(readiness, "liveListenerReadiness")?;
    }
    timestamp_value(&root.started_at, "startedAt")?;
    Ok(())
}

fn validate_journal_resources(
    journal: &RuntimeSessionJournalV1,
    state: JournalState,
) -> Result<(), JournalError> {
    let job_binding = journal
        .job_binding
        .clone()
        .ok_or(JournalError::InvalidBinding("jobBinding"))?;
    ResourceObservation {
        job_binding,
        staging_binding: journal.staging_binding.clone(),
        roots: journal.roots.clone(),
    }
    .validate_for_state(&journal.binding, state)
}

fn assert_resource_identity_unchanged(
    journal: &RuntimeSessionJournalV1,
    observation: &ResourceObservation,
) -> Result<(), JournalError> {
    if let Some(previous) = &journal.job_binding {
        if previous.job_nonce != observation.job_binding.job_nonce {
            return Err(JournalError::InvalidBinding("jobIdentity"));
        }
    }
    if let Some(previous) = &journal.staging_binding {
        if observation.staging_binding.as_ref() != Some(previous) {
            return Err(JournalError::InvalidBinding("stagingIdentity"));
        }
    }
    if journal.roots.len() != 0 {
        if journal.roots.len() != observation.roots.len()
            || journal
                .roots
                .iter()
                .zip(&observation.roots)
                .any(|(previous, next)| !same_root_identity(previous, next))
        {
            return Err(JournalError::InvalidBinding("rootIdentity"));
        }
    }
    Ok(())
}

fn same_root_identity(previous: &JournalRoot, next: &JournalRoot) -> bool {
    previous.ordinal == next.ordinal
        && previous.role == next.role
        && previous.root_ref_digest == next.root_ref_digest
        && previous.root_generation == next.root_generation
        && previous.root_nonce == next.root_nonce
        && previous.pid == next.pid
        && previous.creation_identity == next.creation_identity
        && previous.reserved_listener_identity == next.reserved_listener_identity
        && previous.loopback_port == next.loopback_port
        && previous.started_at == next.started_at
}

fn bound_root_matches_actual(expected: &BoundRoot, actual: &JournalRoot) -> bool {
    expected.ordinal == actual.ordinal
        && expected.role == actual.role
        && expected.root_ref_digest == actual.root_ref_digest
        && expected.root_generation == actual.root_generation
        && expected.reserved_listener_identity == actual.reserved_listener_identity
}

fn validate_proof(proof: &TerminalProof) -> Result<(), JournalError> {
    if proof.proof_generation == 0 {
        return Err(JournalError::InvalidField("proofGeneration"));
    }
    for root in &proof.unacquired_root_bindings {
        validate_bound_root(root, "unacquiredRootBindings")?;
    }
    Ok(())
}

fn validate_partial_terminal_observation(
    binding: &JournalBinding,
    roots: &[JournalRoot],
    proof: &TerminalProof,
) -> Result<(), JournalError> {
    let JournalBinding::Bound { root_bindings, .. } = binding else {
        return if roots.is_empty() && proof.unacquired_root_bindings.is_empty() {
            Ok(())
        } else {
            Err(JournalError::InvalidBinding("terminalRoots"))
        };
    };
    validate_partial_journal_roots(roots)?;
    for root in roots {
        if root.state != RootState::Terminal || root.live_listener_readiness.is_some() {
            return Err(JournalError::InvalidBinding("terminalRoots"));
        }
        let expected = root_bindings
            .iter()
            .find(|expected| expected.ordinal == root.ordinal)
            .ok_or(JournalError::InvalidBinding("terminalRoots"))?;
        if !bound_root_matches_actual(expected, root) {
            return Err(JournalError::InvalidBinding("terminalRoots"));
        }
    }
    if proof
        .unacquired_root_bindings
        .windows(2)
        .any(|pair| pair[0].ordinal >= pair[1].ordinal)
        || proof
            .unacquired_root_bindings
            .iter()
            .any(|absent| roots.iter().any(|root| root.ordinal == absent.ordinal))
    {
        return Err(JournalError::InvalidBinding("unacquiredRootBindings"));
    }
    for absent in &proof.unacquired_root_bindings {
        if root_bindings
            .iter()
            .find(|expected| expected.ordinal == absent.ordinal)
            != Some(absent)
        {
            return Err(JournalError::InvalidBinding("unacquiredRootBindings"));
        }
    }
    let mut ordinals = Vec::with_capacity(roots.len() + proof.unacquired_root_bindings.len());
    ordinals.extend(roots.iter().map(|root| root.ordinal));
    ordinals.extend(
        proof
            .unacquired_root_bindings
            .iter()
            .map(|root| root.ordinal),
    );
    ordinals.sort_unstable();
    if ordinals.len() != root_bindings.len()
        || ordinals.windows(2).any(|pair| pair[0] >= pair[1])
        || ordinals
            .iter()
            .enumerate()
            .any(|(index, ordinal)| *ordinal != index as u32)
    {
        return Err(JournalError::InvalidBinding("terminalRoots"));
    }
    Ok(())
}

fn validate_no_resource_terminal_observation(
    binding: &JournalBinding,
    proof: &TerminalProof,
) -> Result<(), JournalError> {
    validate_partial_terminal_observation(binding, &[], proof)
}

fn bound_root_count(binding: &JournalBinding) -> Option<usize> {
    match binding {
        JournalBinding::Unbound {} => None,
        JournalBinding::Bound { root_bindings, .. } => Some(root_bindings.len()),
    }
}

fn validate_bound_root(root: &BoundRoot, context: &'static str) -> Result<(), JournalError> {
    if root.role.is_empty()
        || root.root_generation == 0
        || root.reserved_listener_identity.is_empty()
    {
        return Err(JournalError::InvalidBinding(context));
    }
    digest(&root.root_ref_digest, "rootRefDigest")?;
    digest(&root.spec_digest, "specDigest")?;
    Ok(())
}

fn validate_terminal_proof_generation(
    journal: &RuntimeSessionJournalV1,
    proof: &TerminalProof,
) -> Result<(), JournalError> {
    validate_proof(proof)?;
    if proof.proof_generation
        != journal
            .journal_revision
            .checked_add(1)
            .ok_or(JournalError::InvalidField("journalRevision"))?
    {
        return Err(JournalError::InvalidBinding("proofGeneration"));
    }
    Ok(())
}

fn recovery_authorization_digest(
    journal: &RuntimeSessionJournalV1,
    recovery_nonce: &str,
) -> Result<String, JournalError> {
    let binding = serde_json::to_vec(&journal.binding)
        .map_err(|_| JournalError::InvalidField("recoveryAuthorizationDigest"))?;
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/recovery/v1\0");
    hasher.update(journal.session_nonce.as_bytes());
    hasher.update([0]);
    hasher.update(journal.plan_digest.as_bytes());
    hasher.update([0]);
    hasher.update(journal.journal_revision.to_le_bytes());
    hasher.update(journal.attempt.to_le_bytes());
    hasher.update(journal.recovery_epoch.to_le_bytes());
    hasher.update(binding);
    hasher.update([0]);
    hasher.update(recovery_nonce.as_bytes());
    Ok(hex_lower(&hasher.finalize()))
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

fn digest(value: &str, field: &'static str) -> Result<(), JournalError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(JournalError::InvalidField(field))
    }
}

fn opaque(value: &str, field: &'static str) -> Result<(), JournalError> {
    if !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        Ok(())
    } else {
        Err(JournalError::InvalidField(field))
    }
}

fn timestamp_value(value: &str, field: &'static str) -> Result<(), JournalError> {
    let bytes = value.as_bytes();
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if bytes.len() < 20
        || separators
            .iter()
            .any(|(index, separator)| bytes.get(*index) != Some(separator))
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
    {
        return Err(JournalError::InvalidField(field));
    }
    let month = u8::from_str_radix(&value[5..7], 10).unwrap_or_default();
    let day = u8::from_str_radix(&value[8..10], 10).unwrap_or_default();
    let hour = u8::from_str_radix(&value[11..13], 10).unwrap_or_default();
    let minute = u8::from_str_radix(&value[14..16], 10).unwrap_or_default();
    let second = u8::from_str_radix(&value[17..19], 10).unwrap_or_default();
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 29,
        _ => 0,
    };
    if (1..=12).contains(&month)
        && (1..=max_day).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60
        && bytes.len() == 20
        && bytes[19] == b'Z'
    {
        Ok(())
    } else {
        Err(JournalError::InvalidField(field))
    }
}

fn timestamp_after(journal: &RuntimeSessionJournalV1, timestamp: &str) -> Result<(), JournalError> {
    timestamp_value(timestamp, "updatedAt")?;
    if timestamp < journal.updated_at.as_str() || timestamp < journal.created_at.as_str() {
        return Err(JournalError::InvalidField("updatedAt"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn plan() -> JournalPlanValue {
        JournalPlanValue {
            plan_digest: DIGEST_A.into(),
            group_ref_digest: DIGEST_B.into(),
            group_generation: 4,
            roots: vec![PlannedRoot {
                ordinal: 0,
                role: "capture".into(),
                root_ref_digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .into(),
                root_generation: 1,
                spec_digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                    .into(),
                reserved_listener_identity: "listener-0".into(),
            }],
        }
    }

    fn two_root_plan() -> JournalPlanValue {
        let mut plan = plan();
        plan.roots.push(PlannedRoot {
            ordinal: 1,
            role: "worker".into(),
            root_ref_digest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                .into(),
            root_generation: 1,
            spec_digest: "9999999999999999999999999999999999999999999999999999999999999999".into(),
            reserved_listener_identity: "listener-1".into(),
        });
        plan
    }

    fn bound() -> JournalBinding {
        bound_for(&plan())
    }

    fn bound_for(plan: &JournalPlanValue) -> JournalBinding {
        JournalBinding::Bound {
            binding_attempt_id: "binding-attempt-1".into(),
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
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
        }
    }

    fn proof(proof_generation: u64) -> TerminalProof {
        TerminalProof {
            root_reaped: true,
            descendants_terminated: true,
            listeners_released: true,
            staging_released: true,
            proof_generation,
            unacquired_root_bindings: Vec::new(),
        }
    }

    fn prepared_journal() -> RuntimeSessionJournalV1 {
        let plan = plan();
        let mut journal = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = journal.cas_snapshot();
        journal
            .cas_prepare_bound(
                &plan,
                &expected,
                bound_for(&plan),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("prepared transition");
        journal
    }

    fn resource_observation(state: RootState, readiness: Option<&str>) -> ResourceObservation {
        ResourceObservation {
            job_binding: JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: "job-1".into(),
            },
            staging_binding: None,
            roots: vec![JournalRoot {
                ordinal: 0,
                role: "capture".into(),
                root_ref_digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .into(),
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

    fn ready_journal() -> RuntimeSessionJournalV1 {
        let mut journal = prepared_journal();
        let expected = journal.cas_snapshot();
        journal
            .cas_transition_with_observation(
                &expected,
                JournalState::Ready,
                None,
                resource_observation(RootState::Suspended, None),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("ready transition");
        journal
    }

    fn manual_review_journal() -> RuntimeSessionJournalV1 {
        let mut journal = ready_journal();
        let expected = journal.cas_snapshot();
        journal
            .cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:03Z".into(),
            )
            .expect("reconcile required");
        for attempt in 1..=3 {
            let expected = journal.cas_snapshot();
            journal
                .cas_reconcile_attempt(
                    &expected,
                    ReconcileAttempt::Failed,
                    None,
                    format!("2026-09-11T00:00:0{}Z", attempt + 3),
                )
                .expect("failed reconcile attempt");
        }
        journal
    }

    fn terminal_observation(
        journal: &RuntimeSessionJournalV1,
    ) -> Result<TerminalObservation, JournalError> {
        TerminalObservation::from_resources(
            journal,
            resource_observation(RootState::Terminal, None),
            proof(journal.journal_revision + 1),
        )
    }

    #[test]
    fn planned_value_is_unbound_and_has_no_resource_identity() {
        let journal = RuntimeSessionJournalV1::planned(
            &plan(),
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        journal.validate_against_plan(&plan()).expect("valid plan");
        let json = String::from_utf8(journal.encode_private().expect("encode")).expect("utf8");
        assert!(json.contains("\"kind\":\"unbound\""));
        assert!(!json.contains("bindingAttemptId"));
        assert!(!json.contains("rootBindings"));
        assert!(!json.contains("token"));
        assert!(!json.contains("path"));
    }

    #[test]
    fn serde_rejects_unknown_fields_at_every_closed_boundary() {
        let journal = RuntimeSessionJournalV1::planned(
            &plan(),
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let mut value: serde_json::Value =
            serde_json::from_slice(&journal.encode_private().expect("encode")).expect("json");
        value
            .as_object_mut()
            .expect("object")
            .insert("unexpected".into(), true.into());
        assert!(RuntimeSessionJournalV1::decode_private(
            &serde_json::to_vec(&value).expect("json")
        )
        .is_err());

        let journal = ready_journal();
        let mut value: serde_json::Value =
            serde_json::from_slice(&journal.encode_private().expect("encode")).expect("json");
        value
            .get_mut("binding")
            .and_then(serde_json::Value::as_object_mut)
            .expect("bound object")
            .insert("unexpected".into(), true.into());
        assert!(RuntimeSessionJournalV1::decode_private(
            &serde_json::to_vec(&value).expect("json")
        )
        .is_err());
    }

    #[test]
    fn bound_binding_requires_complete_ordered_roots() {
        let mut journal = prepared_journal();
        if let JournalBinding::Bound { root_bindings, .. } = &mut journal.binding {
            root_bindings[0].ordinal = 1;
        }
        assert_eq!(
            journal.validate(),
            Err(JournalError::InvalidBinding("rootBindings"))
        );
        let mut journal = prepared_journal();
        if let JournalBinding::Bound { root_bindings, .. } = &mut journal.binding {
            root_bindings[0].root_generation = 2;
        }
        assert_eq!(
            journal.validate_against_plan(&plan()),
            Err(JournalError::InvalidBinding("completeBinding"))
        );
    }

    #[test]
    fn planned_to_prepared_requires_complete_bound_plan_identity() {
        let plan = plan();
        let mut journal = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = journal.cas_snapshot();
        journal
            .cas_prepare_bound(
                &plan,
                &expected,
                bound_for(&plan),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("prepared transition");
        journal
            .validate_against_plan(&plan)
            .expect("complete binding");
        assert!(matches!(journal.binding, JournalBinding::Bound { .. }));
        assert_eq!(journal.journal_revision, 1);
    }

    #[test]
    fn preparation_binds_the_supplied_complete_plan_and_cannot_use_generic_cas() {
        let original_plan = plan();
        let mut journal = RuntimeSessionJournalV1::planned(
            &original_plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = journal.cas_snapshot();
        let mut wrong_group_plan = original_plan.clone();
        wrong_group_plan.group_ref_digest = DIGEST_A.into();
        let before = journal.clone();
        assert_eq!(
            journal.cas_prepare_bound(
                &original_plan,
                &expected,
                bound_for(&wrong_group_plan),
                "2026-09-11T00:00:01Z".into(),
            ),
            Err(JournalError::InvalidBinding("completeBinding"))
        );
        assert_eq!(journal, before);

        let mut wrong_root_plan_binding = bound_for(&original_plan);
        if let JournalBinding::Bound { root_bindings, .. } = &mut wrong_root_plan_binding {
            root_bindings[0].root_generation = 2;
        }
        assert_eq!(
            journal.cas_prepare_bound(
                &original_plan,
                &expected,
                wrong_root_plan_binding,
                "2026-09-11T00:00:01Z".into(),
            ),
            Err(JournalError::InvalidBinding("completeBinding"))
        );
        assert_eq!(journal, before);

        let mut wrong_digest_plan = original_plan.clone();
        wrong_digest_plan.plan_digest = DIGEST_B.into();
        assert_eq!(
            journal.cas_prepare_bound(
                &wrong_digest_plan,
                &expected,
                bound_for(&wrong_digest_plan),
                "2026-09-11T00:00:01Z".into(),
            ),
            Err(JournalError::InvalidBinding("planDigest"))
        );
        assert_eq!(journal, before);

        assert_eq!(
            journal.cas_transition(
                &expected,
                JournalState::PreparedBound,
                Some(bound()),
                "2026-09-11T00:00:01Z".into(),
            ),
            Err(JournalError::InvalidBinding("prepareBinding"))
        );
        assert_eq!(journal, before);
    }

    #[test]
    fn journal_states_use_the_canonical_hyphenated_recovery_names() {
        let mut journal = ready_journal();
        let expected = journal.cas_snapshot();
        journal
            .cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:03Z".into(),
            )
            .expect("reconcile required");
        let json = String::from_utf8(journal.encode_private().expect("encode")).expect("utf8");
        assert!(json.contains("\"state\":\"reconcile-required\""));
        journal = manual_review_journal();
        let json = String::from_utf8(journal.encode_private().expect("encode")).expect("utf8");
        assert!(json.contains("\"state\":\"manual-review\""));
    }

    #[test]
    fn legal_transition_graph_is_exhaustive_and_has_no_terminal_shortcuts() {
        let states = [
            JournalState::PlannedUnbound,
            JournalState::PreparedBound,
            JournalState::Ready,
            JournalState::Launching,
            JournalState::Running,
            JournalState::Closing,
            JournalState::Terminal,
            JournalState::ReconcileRequired,
            JournalState::ManualReview,
        ];
        let legal = [
            (JournalState::PlannedUnbound, JournalState::PreparedBound),
            (
                JournalState::PlannedUnbound,
                JournalState::ReconcileRequired,
            ),
            (JournalState::PreparedBound, JournalState::Ready),
            (JournalState::PreparedBound, JournalState::ReconcileRequired),
            (JournalState::Ready, JournalState::Launching),
            (JournalState::Ready, JournalState::ReconcileRequired),
            (JournalState::Launching, JournalState::Running),
            (JournalState::Launching, JournalState::ReconcileRequired),
            (JournalState::Running, JournalState::Closing),
            (JournalState::Running, JournalState::ReconcileRequired),
            (JournalState::Closing, JournalState::ReconcileRequired),
        ];
        for from in states {
            for to in states {
                assert_eq!(
                    legal.contains(&(from, to)),
                    legal_transition(from, to),
                    "unexpected transition {from:?} -> {to:?}"
                );
            }
        }
        assert!(!legal_transition(
            JournalState::ReconcileRequired,
            JournalState::Terminal
        ));
        assert!(!legal_transition(
            JournalState::ManualReview,
            JournalState::Terminal
        ));
    }

    #[test]
    fn cas_rejects_stale_snapshot_without_mutation() {
        let mut journal = ready_journal();
        let stale = journal.cas_snapshot();
        journal
            .cas_transition_with_observation(
                &stale,
                JournalState::Launching,
                None,
                resource_observation(RootState::Suspended, None),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("launching transition");
        let before = journal.clone();
        assert_eq!(
            journal.cas_transition(
                &stale,
                JournalState::Running,
                None,
                "2026-09-11T00:00:04Z".into()
            ),
            Err(JournalError::StaleCas)
        );
        assert_eq!(journal, before);
        let mut wrong_session = journal.cas_snapshot();
        wrong_session.session_nonce = "other-session".into();
        assert_eq!(
            journal.cas_transition(
                &wrong_session,
                JournalState::Running,
                None,
                "2026-09-11T00:00:04Z".into(),
            ),
            Err(JournalError::StaleCas)
        );
        let mut wrong_plan = journal.cas_snapshot();
        wrong_plan.plan_digest = DIGEST_B.into();
        assert_eq!(
            journal.cas_transition(
                &wrong_plan,
                JournalState::Running,
                None,
                "2026-09-11T00:00:04Z".into(),
            ),
            Err(JournalError::StaleCas)
        );
        assert_eq!(journal, before);
    }

    #[test]
    fn legal_graph_preserves_immutable_binding_identity() {
        let plan = plan();
        let mut journal = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = journal.cas_snapshot();
        journal
            .cas_prepare_bound(
                &plan,
                &expected,
                bound_for(&plan),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("prepared transition");
        let expected = journal.cas_snapshot();
        journal
            .cas_transition_with_observation(
                &expected,
                JournalState::Ready,
                None,
                resource_observation(RootState::Suspended, None),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("ready transition");
        let expected = journal.cas_snapshot();
        journal
            .cas_transition_with_observation(
                &expected,
                JournalState::Launching,
                None,
                resource_observation(RootState::Suspended, None),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("launching transition");
        let expected = journal.cas_snapshot();
        journal
            .cas_transition_with_observation(
                &expected,
                JournalState::Running,
                None,
                resource_observation(RootState::Running, Some("ready-1")),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("running transition");
        let expected = journal.cas_snapshot();
        journal
            .cas_transition_with_observation(
                &expected,
                JournalState::Closing,
                None,
                resource_observation(RootState::Closing, Some("ready-1")),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("closing transition");
        let expected = journal.cas_snapshot();
        journal
            .cas_terminalize_with_observation(
                &expected,
                terminal_observation(&journal).expect("terminal observation"),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("terminal");
        assert_eq!(journal.state, JournalState::Terminal);
        assert_eq!(journal.journal_revision, 6);
        assert_eq!(journal.attempt, 0);
        assert_eq!(journal.recovery_epoch, 0);
    }

    #[test]
    fn resource_observation_must_match_each_lifecycle_state() {
        let mut journal = ready_journal();
        let expected = journal.cas_snapshot();
        let before = journal.clone();
        assert_eq!(
            journal.cas_transition_with_observation(
                &expected,
                JournalState::Launching,
                None,
                resource_observation(RootState::Running, Some("ready-1")),
                "2026-09-11T00:00:03Z".into(),
            ),
            Err(JournalError::InvalidBinding("rootObservation"))
        );
        assert_eq!(journal, before);

        let expected = journal.cas_snapshot();
        let before = journal.clone();
        let mut changed_pid = resource_observation(RootState::Suspended, None);
        changed_pid.roots[0].pid = 4321;
        assert_eq!(
            journal.cas_transition_with_observation(
                &expected,
                JournalState::Launching,
                None,
                changed_pid,
                "2026-09-11T00:00:03Z".into(),
            ),
            Err(JournalError::InvalidBinding("rootIdentity"))
        );
        assert_eq!(journal, before);
    }

    #[test]
    fn prepared_failure_can_reconcile_without_claiming_native_resources() {
        let mut journal = prepared_journal();
        let expected = journal.cas_snapshot();
        journal
            .cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:02Z".into(),
            )
            .expect("prepared failure reconciliation");
        let expected = journal.cas_snapshot();
        journal
            .cas_reconcile_complete(
                &expected,
                TerminalObservation::no_resources(&journal, proof(3))
                    .expect("no-resource observation"),
                "2026-09-11T00:00:03Z".into(),
            )
            .expect("terminal no-resource reconciliation");
        assert_eq!(journal.state, JournalState::Terminal);
        assert!(journal.job_binding.is_none());
        assert!(journal.roots.is_empty());
        assert_eq!(journal.journal_revision, 3);
    }

    #[test]
    fn partial_assignment_reconcile_retains_identity_without_terminal_claim() {
        let mut journal = prepared_journal();
        let expected = journal.cas_snapshot();
        let mut partial = resource_observation(RootState::Suspended, None);
        partial.roots.clear();
        journal
            .cas_transition_with_observation(
                &expected,
                JournalState::ReconcileRequired,
                None,
                partial,
                "2026-09-11T00:00:02Z".into(),
            )
            .expect("partial reconciliation");
        assert!(matches!(journal.binding, JournalBinding::Bound { .. }));
        assert!(journal.roots.is_empty());
        let expected = journal.cas_snapshot();
        let mut partial_terminal = resource_observation(RootState::Terminal, None);
        partial_terminal.roots.clear();
        journal
            .cas_reconcile_complete(
                &expected,
                TerminalObservation::from_partial_resources(&journal, partial_terminal, {
                    let mut proof = proof(3);
                    proof.unacquired_root_bindings = match &journal.binding {
                        JournalBinding::Bound { root_bindings, .. } => root_bindings.clone(),
                        JournalBinding::Unbound {} => Vec::new(),
                    };
                    proof
                })
                .expect("partial terminal observation"),
                "2026-09-11T00:00:03Z".into(),
            )
            .expect("partial terminal reconciliation");
        assert_eq!(journal.state, JournalState::Terminal);
        assert!(journal.roots.is_empty());
    }

    #[test]
    fn unbound_reconcile_rejects_any_resource_observation() {
        let plan = plan();
        let mut journal = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = journal.cas_snapshot();
        let before = journal.clone();
        assert_eq!(
            journal.cas_transition_with_observation(
                &expected,
                JournalState::ReconcileRequired,
                None,
                resource_observation(RootState::Suspended, None),
                "2026-09-11T00:00:01Z".into(),
            ),
            Err(JournalError::InvalidBinding("unboundResources"))
        );
        assert_eq!(journal, before);
    }

    #[test]
    fn terminal_observation_binds_proof_generation_and_identity() {
        let journal = ready_journal();
        assert_eq!(
            TerminalObservation::from_resources(
                &journal,
                resource_observation(RootState::Terminal, None),
                proof(99),
            ),
            Err(JournalError::InvalidBinding("proofGeneration"))
        );
        let mut roots = resource_observation(RootState::Terminal, None);
        roots.roots[0].root_generation = 2;
        assert_eq!(
            TerminalObservation::from_resources(
                &journal,
                roots,
                proof(journal.journal_revision + 1)
            ),
            Err(JournalError::InvalidBinding("roots"))
        );

        for identity_case in ["pid", "creation", "loopback-port", "job"] {
            let mut target = ready_journal();
            let expected = target.cas_snapshot();
            let mut resources = resource_observation(RootState::Terminal, None);
            match identity_case {
                "pid" => resources.roots[0].pid = 4321,
                "creation" => resources.roots[0].creation_identity.value = "other".into(),
                "loopback-port" => resources.roots[0].loopback_port = 43124,
                "job" => resources.job_binding.job_nonce = "other-job".into(),
                _ => unreachable!(),
            }
            let observation = TerminalObservation::from_resources(
                &target,
                resources,
                proof(target.journal_revision + 1),
            )
            .expect("terminal observation shape");
            let before = target.clone();
            assert_eq!(
                target.cas_terminalize_with_observation(
                    &expected,
                    observation,
                    "2026-09-11T00:00:03Z".into(),
                ),
                Err(if identity_case == "job" {
                    JournalError::InvalidBinding("jobIdentity")
                } else {
                    JournalError::InvalidBinding("rootIdentity")
                })
            );
            assert_eq!(target, before);
        }

        let source = ready_journal();
        let observation = terminal_observation(&source).expect("source observation");
        let mut wrong_session = ready_journal();
        wrong_session.session_nonce = "other-session".into();
        let expected = wrong_session.cas_snapshot();
        let before = wrong_session.clone();
        assert_eq!(
            wrong_session.cas_terminalize_with_observation(
                &expected,
                observation.clone(),
                "2026-09-11T00:00:03Z".into(),
            ),
            Err(JournalError::StaleCas)
        );
        assert_eq!(wrong_session, before);

        let mut wrong_plan = ready_journal();
        wrong_plan.plan_digest = DIGEST_B.into();
        let expected = wrong_plan.cas_snapshot();
        let before = wrong_plan.clone();
        assert_eq!(
            wrong_plan.cas_terminalize_with_observation(
                &expected,
                observation,
                "2026-09-11T00:00:03Z".into(),
            ),
            Err(JournalError::StaleCas)
        );
        assert_eq!(wrong_plan, before);

        let mut malformed = ready_journal();
        malformed.roots[0].loopback_port = 0;
        assert_eq!(
            malformed.validate(),
            Err(JournalError::InvalidBinding("roots"))
        );
    }

    #[test]
    fn partial_terminal_proof_is_an_ordered_disjoint_complete_partition() {
        let binding = bound_for(&two_root_plan());
        let root_bindings = match &binding {
            JournalBinding::Bound { root_bindings, .. } => root_bindings.clone(),
            JournalBinding::Unbound {} => unreachable!(),
        };
        let actual = resource_observation(RootState::Terminal, None).roots;

        let mut valid = proof(1);
        valid.unacquired_root_bindings = vec![root_bindings[1].clone()];
        assert!(validate_partial_terminal_observation(&binding, &actual, &valid).is_ok());

        let mut overlap = proof(1);
        overlap.unacquired_root_bindings = root_bindings.clone();
        assert_eq!(
            validate_partial_terminal_observation(&binding, &actual, &overlap),
            Err(JournalError::InvalidBinding("unacquiredRootBindings"))
        );

        let mut duplicate = proof(1);
        duplicate.unacquired_root_bindings =
            vec![root_bindings[1].clone(), root_bindings[1].clone()];
        assert_eq!(
            validate_partial_terminal_observation(&binding, &[], &duplicate),
            Err(JournalError::InvalidBinding("unacquiredRootBindings"))
        );

        let mut reordered = proof(1);
        reordered.unacquired_root_bindings =
            vec![root_bindings[1].clone(), root_bindings[0].clone()];
        assert_eq!(
            validate_partial_terminal_observation(&binding, &[], &reordered),
            Err(JournalError::InvalidBinding("unacquiredRootBindings"))
        );

        let encoded = serde_json::to_string(&proof(1)).expect("proof encoding");
        assert!(encoded.contains("\"unacquiredRootBindings\":[]"));
        let mut missing_field: serde_json::Value =
            serde_json::from_str(&encoded).expect("proof value");
        missing_field
            .as_object_mut()
            .expect("proof object")
            .remove("unacquiredRootBindings");
        assert!(serde_json::from_value::<TerminalProof>(missing_field).is_err());
    }

    #[test]
    fn planned_no_resource_path_is_the_only_direct_terminal_path() {
        let plan = plan();
        let mut journal = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = journal.cas_snapshot();
        journal
            .cas_terminalize_no_resource(
                &expected,
                TerminalObservation::no_resources(&journal, proof(1))
                    .expect("no-resource observation"),
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("terminal no-resource path");
        assert_eq!(journal.state, JournalState::Terminal);
    }

    #[test]
    fn invalid_transition_and_direct_terminal_leave_value_unchanged() {
        let mut journal = prepared_journal();
        let expected = journal.cas_snapshot();
        let before = journal.clone();
        assert_eq!(
            journal.cas_transition(
                &expected,
                JournalState::Running,
                None,
                "2026-09-11T00:00:02Z".into()
            ),
            Err(JournalError::InvalidTransition)
        );
        assert_eq!(journal, before);
        assert_eq!(
            journal.cas_transition(
                &expected,
                JournalState::Terminal,
                None,
                "2026-09-11T00:00:02Z".into()
            ),
            Err(JournalError::InvalidTransition)
        );
        assert_eq!(journal, before);
    }

    #[test]
    fn cas_cannot_erase_or_introduce_binding_outside_prepared_state() {
        let mut bound_journal = ready_journal();
        let expected = bound_journal.cas_snapshot();
        let before = bound_journal.clone();
        assert_eq!(
            bound_journal.cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                Some(JournalBinding::Unbound {}),
                "2026-09-11T00:00:03Z".into(),
            ),
            Err(JournalError::InvalidBinding("immutableBinding"))
        );
        assert_eq!(bound_journal, before);

        let plan = plan();
        let mut unbound_journal = RuntimeSessionJournalV1::planned(
            &plan,
            "session-1".into(),
            "2026-09-11T00:00:00Z".into(),
        )
        .expect("planned journal");
        let expected = unbound_journal.cas_snapshot();
        let before = unbound_journal.clone();
        assert_eq!(
            unbound_journal.cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                Some(bound()),
                "2026-09-11T00:00:01Z".into(),
            ),
            Err(JournalError::InvalidBinding("immutableBinding"))
        );
        assert_eq!(unbound_journal, before);
    }

    #[test]
    fn timestamps_are_strict_utc_values() {
        assert!(timestamp_value("2026-09-11T00:00:00Z", "timestamp").is_ok());
        assert!(timestamp_value("2026-09-11T00:00:00.123Z", "timestamp").is_err());
        assert!(timestamp_value("2026-99-11T00:00:00Z", "timestamp").is_err());
        assert!(timestamp_value("2026-09-11T24:00:00Z", "timestamp").is_err());
        assert!(timestamp_value("2026-09-11T00:00:00+00:00", "timestamp").is_err());

        let mut journal = prepared_journal();
        let expected = journal.cas_snapshot();
        let before = journal.clone();
        assert_eq!(
            journal.cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:00Z".into(),
            ),
            Err(JournalError::InvalidField("updatedAt"))
        );
        assert_eq!(journal, before);

        journal
            .cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:01Z".into(),
            )
            .expect("same-second transition uses revision ordering");
        assert_eq!(journal.journal_revision, 2);
    }

    #[test]
    fn reconcile_attempts_increment_revision_and_enter_manual_review_on_three_failures() {
        let mut journal = ready_journal();
        let expected = journal.cas_snapshot();
        journal
            .cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:03Z".into(),
            )
            .expect("reconcile required");
        for attempt in 1..=3 {
            let expected = journal.cas_snapshot();
            journal
                .cas_reconcile_attempt(
                    &expected,
                    ReconcileAttempt::Failed,
                    None,
                    format!("2026-09-11T00:00:0{}Z", attempt + 3),
                )
                .expect("failed reconcile attempt");
            assert_eq!(journal.attempt, attempt);
        }
        assert_eq!(journal.state, JournalState::ManualReview);
        assert_eq!(journal.journal_revision, 6);
    }

    #[test]
    fn manual_review_requires_recovery_nonce_and_authorization() {
        let mut journal = manual_review_journal();
        let expected = journal.cas_snapshot();
        let before = journal.clone();
        let mut invalid_authorization =
            RecoveryAuthorization::for_journal(&journal, "recovery-1".into())
                .expect("authorization context");
        invalid_authorization.authorization_digest = DIGEST_A.into();
        assert_eq!(
            journal.cas_recover_manual_review(
                &expected,
                &mut invalid_authorization,
                "2026-09-11T00:00:07Z".into(),
            ),
            Err(JournalError::UnauthorizedRecovery)
        );
        assert_eq!(journal, before);
        let mut authorization = RecoveryAuthorization::for_journal(&journal, "recovery-1".into())
            .expect("authorization context");
        journal
            .cas_recover_manual_review(&expected, &mut authorization, "2026-09-11T00:00:07Z".into())
            .expect("authorized recovery");
        assert_eq!(journal.state, JournalState::ReconcileRequired);
        assert_eq!(journal.attempt, 0);
        assert_eq!(journal.recovery_epoch, 1);
        assert!(authorization.consumed);
        assert_eq!(
            journal.cas_recover_manual_review(
                &expected,
                &mut authorization,
                "2026-09-11T00:00:08Z".into(),
            ),
            Err(JournalError::StaleCas)
        );
    }

    #[test]
    fn complete_reconcile_requires_terminal_proof() {
        let mut journal = ready_journal();
        let expected = journal.cas_snapshot();
        journal
            .cas_transition(
                &expected,
                JournalState::ReconcileRequired,
                None,
                "2026-09-11T00:00:03Z".into(),
            )
            .expect("reconcile required");
        let expected = journal.cas_snapshot();
        assert_eq!(
            journal.cas_reconcile_attempt(
                &expected,
                ReconcileAttempt::Complete,
                None,
                "2026-09-11T00:00:04Z".into()
            ),
            Err(JournalError::InvalidBinding("terminalObservation"))
        );
        assert_eq!(journal.state, JournalState::ReconcileRequired);
    }
}
