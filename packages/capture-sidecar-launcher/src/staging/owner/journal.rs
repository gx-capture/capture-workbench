use std::process::Command;

#[cfg(windows)]
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

use crate::{
    journal::{JournalState, ResourceObservation, RuntimeSessionJournalV1, StagingBinding},
    journal_store::{CasDisposition, JournalStoreCommand, OwnedCasResult},
    prepare::ValidatedActivationContext,
};

#[cfg(windows)]
use crate::journal_store::{
    install_running_read_budget, ClosingCasAdmission, ClosingCasError, ClosingCleanupAdmission,
    RunningCasAdmission, RunningCasError,
};

#[cfg(all(test, windows))]
use super::super::budget::{cancel_after_launching_cas_for_test, cancel_after_ready_cas_for_test};
#[cfg(all(test, windows))]
use super::{materialize::materialize, BudgetActivationFixture};

use super::super::{
    budget::StagingBudget,
    failure::{staging_budget_error, StagingBudgetFailure, StagingFailureKind},
    scope_digest::{required_file_identity, run_staging_scope_digest},
};
use super::RunStagingOwner;

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
        let cas_outcome = self.activation.context.store.compare_and_swap_owned(
            &self.activation.journal_plan,
            &self.activation.expected_journal,
            JournalStoreCommand::TransitionWithObservation {
                next_state: JournalState::Ready,
                observation: observation.clone(),
                timestamp,
            },
        );
        let ready = match cas_outcome.disposition() {
            CasDisposition::Committed | CasDisposition::ConfirmedLate => {
                cas_outcome.attempt().cloned().ok_or_else(|| {
                    StagingBudgetFailure::with_cas_outcome(
                        StagingFailureKind::Durability,
                        "Capture runtime Ready journal CAS returned no candidate.".into(),
                        cas_outcome.clone(),
                    )
                })?
            }
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => {
                let kind = cas_outcome
                    .error()
                    .map(map_journal_store_error_kind)
                    .unwrap_or(StagingFailureKind::Durability);
                return Err(StagingBudgetFailure::with_cas_outcome(
                    kind,
                    "Capture runtime Ready journal CAS failed.".into(),
                    cas_outcome,
                ));
            }
        };
        budget.cancel_after_ready_cas_if_requested();
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_cas_outcome(
                kind,
                staging_budget_error(kind),
                cas_outcome,
            ));
        }
        if ready.state != JournalState::Ready
            || ready.journal_revision != expected_revision
            || ready.binding != self.activation.binding
            || ready.job_binding.as_ref() != Some(&observation.job_binding)
            || ready.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || ready.roots != observation.roots
        {
            return Err(StagingBudgetFailure::with_cas_outcome(
                StagingFailureKind::JournalChanged,
                "Capture runtime Ready journal read-back was not exact.".into(),
                cas_outcome,
            ));
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_cas_outcome(
                kind,
                staging_budget_error(kind),
                cas_outcome,
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
        let cas_outcome = self.activation.context.store.compare_and_swap_owned(
            &self.activation.journal_plan,
            expected_ready,
            JournalStoreCommand::TransitionWithObservation {
                next_state: JournalState::Launching,
                observation: observation.clone(),
                timestamp,
            },
        );
        let launching = match cas_outcome.disposition() {
            CasDisposition::Committed | CasDisposition::ConfirmedLate => {
                cas_outcome.attempt().cloned().ok_or_else(|| {
                    StagingBudgetFailure::with_cas_outcome(
                        StagingFailureKind::Durability,
                        "Capture runtime Launching journal CAS returned no candidate.".into(),
                        cas_outcome.clone(),
                    )
                })?
            }
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => {
                let kind = cas_outcome
                    .error()
                    .map(map_journal_store_error_kind)
                    .unwrap_or(StagingFailureKind::Durability);
                return Err(StagingBudgetFailure::with_cas_outcome(
                    kind,
                    "Capture runtime Launching journal CAS failed.".into(),
                    cas_outcome,
                ));
            }
        };
        budget.cancel_after_launching_cas_if_requested();
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_cas_outcome(
                kind,
                staging_budget_error(kind),
                cas_outcome,
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
            return Err(StagingBudgetFailure::with_cas_outcome(
                StagingFailureKind::JournalChanged,
                "Capture runtime Launching journal read-back was not exact.".into(),
                cas_outcome,
            ));
        }
        if let Err(kind) = budget.check() {
            return Err(StagingBudgetFailure::with_cas_outcome(
                kind,
                staging_budget_error(kind),
                cas_outcome,
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
                expected_launching,
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
    pub(crate) fn persist_running_admission_owned(
        &self,
        admission: RunningCasAdmission,
        expected_launching: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
    ) -> OwnedCasResult {
        let mut result = admission.commit_running_owned(observation.clone(), timestamp.clone());
        let Some(running) = result.attempt().cloned() else {
            return result;
        };
        let expected_revision = match expected_launching.journal_revision.checked_add(1) {
            Some(revision) => revision,
            None => {
                return result
                    .mark_ambiguous(crate::journal_store::JournalStoreError::CorruptJournal)
            }
        };
        if running.state != JournalState::Running
            || running.journal_revision != expected_revision
            || running.schema_version != expected_launching.schema_version
            || running.producer != expected_launching.producer
            || running.session_nonce != expected_launching.session_nonce
            || running.plan_digest != expected_launching.plan_digest
            || running.created_at != expected_launching.created_at
            || running.updated_at != timestamp
            || running.attempt != expected_launching.attempt
            || running.recovery_epoch != expected_launching.recovery_epoch
            || running.binding != expected_launching.binding
            || running.job_binding.as_ref() != Some(&observation.job_binding)
            || running.staging_binding.as_ref() != observation.staging_binding.as_ref()
            || running.roots != observation.roots
            || running.proof.is_some()
        {
            result = result.mark_ambiguous(crate::journal_store::JournalStoreError::CorruptJournal);
        }
        result
    }

    #[cfg(windows)]
    pub(crate) fn persist_closing_admission_owned(
        &self,
        admission: ClosingCasAdmission,
        expected_running: &RuntimeSessionJournalV1,
        observation: ResourceObservation,
        timestamp: String,
    ) -> OwnedCasResult {
        let mut result = admission.commit_closing_owned(observation.clone(), timestamp.clone());
        let Some(closing) = result.attempt().cloned() else {
            return result;
        };
        let expected_revision = match expected_running.journal_revision.checked_add(1) {
            Some(revision) => revision,
            None => {
                return result
                    .mark_ambiguous(crate::journal_store::JournalStoreError::CorruptJournal)
            }
        };
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
            result = result.mark_ambiguous(crate::journal_store::JournalStoreError::CorruptJournal);
        }
        #[cfg(test)]
        if let Some(cancellation) = self
            .activation
            .context
            .store
            .take_cancel_after_closing_readback_for_test()
        {
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        }
        result
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
        let _ = self.activation.context.store.compare_and_swap_owned(
            &self.activation.journal_plan,
            &current,
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp: current.updated_at.clone(),
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
        let _ = self.activation.context.store.compare_and_swap_owned(
            &self.activation.journal_plan,
            &current,
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: JournalState::ReconcileRequired,
                timestamp: current.updated_at.clone(),
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

pub(super) fn journal_is_exactly_prepared_with_budget(
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

fn map_journal_store_error_kind(
    error: &crate::journal_store::JournalStoreError,
) -> StagingFailureKind {
    match error {
        crate::journal_store::JournalStoreError::AdmissionCancelled => {
            StagingFailureKind::Cancelled
        }
        crate::journal_store::JournalStoreError::AdmissionDeadline => StagingFailureKind::Deadline,
        crate::journal_store::JournalStoreError::Conflict => StagingFailureKind::JournalChanged,
        _ => StagingFailureKind::Durability,
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

#[cfg(all(test, windows))]
mod tests {
    use std::{
        sync::{atomic::AtomicBool, Arc},
        time::{Duration, Instant},
    };

    use super::*;

    #[cfg(windows)]
    use crate::journal::{CreationIdentity, JobBinding, JobSetupState, JournalRoot, RootState};

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
            .persist_ready_with_budget(
                observation.clone(),
                ready_timestamp,
                Instant::now() + Duration::from_secs(5),
                Arc::new(AtomicBool::new(false)),
            )
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
}
