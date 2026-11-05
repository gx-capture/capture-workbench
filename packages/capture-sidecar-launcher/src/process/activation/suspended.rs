use std::sync::atomic::AtomicBool;
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::Arc;

#[cfg(windows)]
use crate::{
    journal::{
        CreationIdentity, JobBinding, JobSetupState, JournalRoot, JournalState,
        ResourceObservation, RootState, RuntimeSessionJournalV1,
    },
    journal_store::{
        install_running_read_budget, ActivationBudget, CasDisposition, JournalStoreError,
    },
    staging::RunStagingOwner,
};

#[cfg(windows)]
use super::failure::{
    activation_budget_error_detail, activation_failure_kind_for_budget,
    activation_failure_kind_for_staging_kind, activation_launch_failure_kind_for_staging_kind,
    activation_reconcile_failure_kind, check_activation_phase_budget,
    ActivationFailureJournalContext, ActivationLaunchFailure, ActivationLaunchFailureKind,
    ActivationReconcileFailure, ActivationReconcileFailureKind, GroupNativeFailureKind,
    SuspendedActivationFailure, SuspendedActivationFailureKind,
};

#[cfg(windows)]
use super::group::{native_nonce_text, NativeCleanupProof, SuspendedGroup};

#[cfg(windows)]
use super::cancellation_requested;
#[cfg(windows)]
use super::launching::LaunchingActivationOwner;
#[cfg(windows)]
use super::reconcile::{
    confirm_retained_candidate, record_owned_cas_context, ReconciledActivationOwner,
};

#[cfg(all(test, windows))]
use crate::process::fixture::{
    HttpFixturePermit, CANCEL_AFTER_READY_HELPER, CANCEL_AFTER_RESUME_ALL,
};

#[cfg(windows)]
pub(crate) struct SuspendedActivationOwner {
    pub(crate) staging: RunStagingOwner,
    pub(crate) native: Option<SuspendedGroup>,
    pub(crate) native_cleanup_proven: bool,
    pub(crate) failure_context: Option<ActivationFailureJournalContext>,
    #[cfg(all(test, windows))]
    pub(crate) _http_fixture_permit: Option<HttpFixturePermit>,
}

#[cfg(windows)]
#[cfg(windows)]
pub(crate) struct ReadySuspendedActivationOwner {
    pub(crate) owner: SuspendedActivationOwner,
    pub(crate) ready_journal: RuntimeSessionJournalV1,
}

/// The private owner after the durable Launching CAS and native resume loop.
/// The journal is intentionally still Launching: the live listener/readiness
/// observation and Running transition belong to the next lifecycle slice.

#[cfg(windows)]
pub(crate) enum ActivationLaunchOwner {
    Ready(ReadySuspendedActivationOwner),
    Launching(LaunchingActivationOwner),
}

#[cfg(windows)]
#[cfg(windows)]
impl SuspendedActivationOwner {
    /// Budget-aware Ready handoff.  The store/index operations inside the
    /// staging owner inherit the same scoped lock budget; a cancellation or
    /// deadline observed after a durable Ready result is converted back to an
    /// owned failure so the caller must reconcile instead of issuing another
    /// phase authority.
    #[cfg(windows)]
    pub(crate) fn persist_ready_with_budget(
        mut self,
        budget: &ActivationBudget,
    ) -> Result<ReadySuspendedActivationOwner, SuspendedActivationFailure> {
        if let Err(error) = budget.check() {
            return Err(SuspendedActivationFailure {
                kind: activation_failure_kind_for_budget(&error),
                detail: activation_budget_error_detail(error),
                owner: Some(self),
            });
        }
        let _read_budget = budget.install_read_scope();
        let observation = match self.resource_observation() {
            Ok(observation) => observation,
            Err(detail) => {
                return Err(SuspendedActivationFailure {
                    kind: SuspendedActivationFailureKind::Native(
                        GroupNativeFailureKind::Membership,
                    ),
                    detail,
                    owner: Some(self),
                });
            }
        };
        let timestamp = match self.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => {
                return Err(SuspendedActivationFailure {
                    kind: SuspendedActivationFailureKind::Journal,
                    detail,
                    owner: Some(self),
                });
            }
        };
        if observation
            .roots
            .iter()
            .any(|root| timestamp < root.started_at)
        {
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Journal,
                detail: "Capture runtime producer clock moved backwards before Ready CAS.".into(),
                owner: Some(self),
            });
        }
        let ready_journal = match self.staging.persist_ready_with_budget(
            observation,
            timestamp,
            budget.deadline(),
            budget.cancellation_arc(),
        ) {
            Ok(ready) => ready,
            Err(error) => {
                let (staging_kind, detail, cas_outcome) = error.into_cas_parts();
                if let Some(outcome) = cas_outcome {
                    if let Some(context) = self.failure_context.as_mut() {
                        record_owned_cas_context(context, &outcome);
                    }
                }
                return Err(SuspendedActivationFailure {
                    kind: activation_failure_kind_for_staging_kind(staging_kind),
                    detail,
                    owner: Some(self),
                });
            }
        };
        // The staging helper has durably returned the exact Ready value. Keep
        // that candidate with the owner before any coordinator-level check can
        // fail, so reconciliation uses Ready rather than the stale Prepared
        // snapshot.
        if let Some(context) = self.failure_context.as_mut() {
            context.candidate = ready_journal.clone();
            context.disposition = CasDisposition::Committed;
        }
        #[cfg(all(test, windows))]
        if CANCEL_AFTER_READY_HELPER.with(|cancel| cancel.replace(false)) {
            budget.cancellation().store(true, Ordering::Release);
        }
        if let Err(error) = budget.check() {
            return Err(SuspendedActivationFailure {
                kind: activation_failure_kind_for_budget(&error),
                detail: activation_budget_error_detail(error),
                owner: Some(self),
            });
        }
        Ok(ReadySuspendedActivationOwner {
            owner: self,
            ready_journal,
        })
    }

    pub(crate) fn resource_observation(&mut self) -> Result<ResourceObservation, String> {
        if !self.staging.journal_is_still_prepared() {
            return Err(
                "Capture runtime prepared binding changed before Ready observation.".into(),
            );
        }
        self.resource_observation_with_started_at(None)
    }

    pub(crate) fn resource_observation_for_journal(
        &mut self,
        expected: &RuntimeSessionJournalV1,
    ) -> Result<ResourceObservation, String> {
        let observation = self.resource_observation_with_started_at(Some(&expected.roots))?;
        let expected_observation = ResourceObservation {
            job_binding: expected
                .job_binding
                .clone()
                .ok_or_else(|| "Capture runtime Ready Job binding was missing.".to_string())?,
            staging_binding: expected.staging_binding.clone(),
            roots: expected.roots.clone(),
        };
        if observation != expected_observation {
            return Err(
                "Capture runtime native or staging identity changed after durable Ready.".into(),
            );
        }
        Ok(observation)
    }

    pub(crate) fn resource_observation_with_started_at(
        &mut self,
        started_at_by_root: Option<&[JournalRoot]>,
    ) -> Result<ResourceObservation, String> {
        self.staging.revalidate_address_index()?;
        let _checked_commands = self.staging.checked_commands()?;
        let snapshot = self
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing before Ready.".to_string())?
            .binding_snapshot()?;
        let staging_binding = self.staging.staging_binding_for_ready()?;
        let planned_roots = self.staging.planned_roots();
        if planned_roots.len() != snapshot.roots.len() {
            return Err("Capture runtime native root observation was incomplete.".into());
        }
        if let Some(expected_roots) = started_at_by_root {
            if expected_roots.len() != planned_roots.len() {
                return Err("Capture runtime Ready root observation was incomplete.".into());
            }
        }
        let shared_started_at = match started_at_by_root {
            Some(_) => None,
            None => Some(self.staging.next_timestamp()?),
        };
        let mut roots = Vec::with_capacity(planned_roots.len());
        for (planned, actual) in planned_roots.iter().zip(snapshot.roots) {
            let ordinal = usize::try_from(planned.ordinal)
                .map_err(|_| "Capture runtime root ordinal was invalid.")?;
            if actual.ordinal != planned.ordinal {
                return Err("Capture runtime native root order changed before Ready.".into());
            }
            let started_at = match started_at_by_root {
                Some(expected_roots) => expected_roots
                    .get(ordinal)
                    .ok_or_else(|| "Capture runtime Ready root timestamp was missing.".to_string())?
                    .started_at
                    .clone(),
                None => shared_started_at
                    .as_ref()
                    .expect("shared Ready timestamp")
                    .clone(),
            };
            let loopback_port = self
                .staging
                .planned_root_port(ordinal)
                .ok_or_else(|| "Capture runtime frozen root port was missing.".to_string())?;
            roots.push(JournalRoot {
                ordinal: planned.ordinal,
                role: planned.role.clone(),
                root_ref_digest: planned.root_ref_digest.clone(),
                root_generation: planned.root_generation,
                root_nonce: native_nonce_text(&actual.root_nonce),
                pid: actual.identity.pid,
                creation_identity: CreationIdentity {
                    kind: "windows-process-creation".into(),
                    value: format!("{:016x}", actual.identity.creation_time),
                },
                state: RootState::Suspended,
                reserved_listener_identity: planned.reserved_listener_identity.clone(),
                loopback_port,
                live_listener_readiness: None,
                started_at,
            });
        }
        Ok(ResourceObservation {
            job_binding: JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: native_nonce_text(&snapshot.job_nonce),
            },
            staging_binding: Some(staging_binding),
            roots,
        })
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.native.as_ref().map(|native| native.roots.len())
    }

    #[cfg(test)]
    pub(crate) fn native_is_suspended_for_test(&mut self) -> bool {
        self.native
            .as_mut()
            .is_some_and(|native| native.binding_snapshot().is_ok())
    }

    #[cfg(test)]
    pub(crate) fn native_cleanup_proven_for_test(&self) -> bool {
        self.native_cleanup_proven
    }

    #[cfg(test)]
    pub(crate) fn inject_native_cleanup_failure_for_test(&mut self) {
        let native = self.native.as_mut().expect("native owner");
        native.inject_cleanup_failure_after_first_for_test();
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_job_termination_failure_for_test(&mut self) {
        self.native
            .as_mut()
            .expect("native owner")
            .inject_job_termination_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_resume_failure_at_for_test(&mut self, ordinal: usize) {
        let native = self.native.as_mut().expect("native owner");
        native.inject_resume_failure_at_for_test(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn inject_native_membership_failure_for_test(&mut self) {
        let native = self.native.as_mut().expect("native owner");
        native.inject_membership_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_journal_drift_before_ready_for_test(&self) {
        self.staging.inject_journal_drift_before_ready_for_test();
    }

    #[cfg(test)]
    pub(crate) fn terminate_root_for_test(&mut self, ordinal: usize) -> Result<(), String> {
        let native = self
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing.".to_string())?;
        native.terminate_root_for_test(ordinal)
    }
}

#[cfg(windows)]
impl ReadySuspendedActivationOwner {
    /// Budget-aware private Launching handoff.  It shares the caller's
    /// absolute budget with journal/index locks and the native resume loop.
    #[cfg(windows)]
    pub(crate) fn launch_with_budget(
        self,
        budget: &ActivationBudget,
    ) -> Result<LaunchingActivationOwner, ActivationLaunchFailure> {
        self.launch_inner(None, Some(budget))
    }

    pub(crate) fn launch_inner(
        self,
        cancellation: Option<&AtomicBool>,
        budget: Option<&ActivationBudget>,
    ) -> Result<LaunchingActivationOwner, ActivationLaunchFailure> {
        let mut ready = self;
        let _read_budget = budget.map(ActivationBudget::install_read_scope);
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }

        if ready.ready_journal.state != crate::journal::JournalState::Ready {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail: "Capture runtime retained journal was not Ready.".into(),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready
            .owner
            .staging
            .validate_ready_journal(&ready.ready_journal)
        {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail: format!("Capture runtime Ready journal validation failed: {detail:?}."),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready
            .owner
            .staging
            .revalidate_ready_snapshot(&ready.ready_journal)
        {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready.owner.staging.revalidate_address_index() {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready.owner.staging.checked_commands() {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Staging,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }

        let observation = match ready
            .owner
            .resource_observation_for_journal(&ready.ready_journal)
        {
            Ok(observation) => observation,
            Err(detail) => {
                return Err(ActivationLaunchFailure {
                    kind: ActivationLaunchFailureKind::Native(GroupNativeFailureKind::Membership),
                    detail,
                    owner: Some(ActivationLaunchOwner::Ready(ready)),
                });
            }
        };
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        let timestamp = match ready.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => {
                return Err(ActivationLaunchFailure {
                    kind: ActivationLaunchFailureKind::Journal,
                    detail,
                    owner: Some(ActivationLaunchOwner::Ready(ready)),
                });
            }
        };
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if timestamp < ready.ready_journal.updated_at {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail: "Capture runtime producer clock moved backwards before Launching CAS."
                    .into(),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        let launching_journal = if let Some(activation_budget) = budget {
            match ready.owner.staging.persist_launching_with_budget(
                &ready.ready_journal,
                observation,
                timestamp,
                activation_budget.deadline(),
                activation_budget.cancellation_arc(),
            ) {
                Ok(journal) => journal,
                Err(error) => {
                    let (staging_kind, detail, cas_outcome) = error.into_cas_parts();
                    if let Some(outcome) = cas_outcome {
                        if let Some(context) = ready.owner.failure_context.as_mut() {
                            record_owned_cas_context(context, &outcome);
                        }
                    }
                    return Err(ActivationLaunchFailure {
                        kind: activation_launch_failure_kind_for_staging_kind(staging_kind),
                        detail,
                        owner: Some(ActivationLaunchOwner::Ready(ready)),
                    });
                }
            }
        } else {
            match ready.owner.staging.persist_launching(
                &ready.ready_journal,
                observation,
                timestamp,
            ) {
                Ok(journal) => journal,
                Err(detail) => {
                    return Err(ActivationLaunchFailure {
                        kind: ActivationLaunchFailureKind::Journal,
                        detail,
                        owner: Some(ActivationLaunchOwner::Ready(ready)),
                    });
                }
            }
        };
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            let mut owner = ready.owner;
            if let Some(context) = owner.failure_context.as_mut() {
                context.candidate = launching_journal.clone();
                context.disposition = CasDisposition::Committed;
            }
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Launching(LaunchingActivationOwner {
                    owner,
                    launching_journal,
                    #[cfg(all(test, windows))]
                    running_admission_hook: None,
                    #[cfg(all(test, windows))]
                    readiness_probe_hook: None,
                    #[cfg(all(test, windows))]
                    running_commit_hook: None,
                })),
            });
        }
        if let Some(context) = ready.owner.failure_context.as_mut() {
            context.candidate = launching_journal.clone();
            context.disposition = CasDisposition::Committed;
        }

        let mut launching = LaunchingActivationOwner {
            owner: ready.owner,
            launching_journal,
            #[cfg(all(test, windows))]
            running_admission_hook: None,
            #[cfg(all(test, windows))]
            readiness_probe_hook: None,
            #[cfg(all(test, windows))]
            running_commit_hook: None,
        };
        if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
            return Err(ActivationLaunchFailure {
                kind,
                detail,
                owner: Some(ActivationLaunchOwner::Launching(launching)),
            });
        }
        let Some(native) = launching.owner.native.take() else {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Native(GroupNativeFailureKind::Membership),
                detail: "Capture runtime native owner was missing before resume.".into(),
                owner: Some(ActivationLaunchOwner::Launching(launching)),
            });
        };
        let resume_result = match budget {
            Some(budget) => native.resume_all_with_budget(budget),
            None => native.resume_all_with_cancellation(cancellation),
        };
        match resume_result {
            Ok(native) => {
                launching.owner.native = Some(native);
                #[cfg(all(test, windows))]
                if CANCEL_AFTER_RESUME_ALL.with(|cancel| cancel.replace(false)) {
                    if let Some(budget) = budget {
                        budget.cancellation().store(true, Ordering::Release);
                    }
                }
                // The complete native group is now resumed, but success is
                // linearized only by this final budget check. A late request
                // remains an owned Launching failure and is reconciled by the
                // private coordinator; no lease or public owner escapes.
                if let Err((kind, detail)) = check_activation_phase_budget(budget, cancellation) {
                    return Err(ActivationLaunchFailure {
                        kind,
                        detail,
                        owner: Some(ActivationLaunchOwner::Launching(launching)),
                    });
                }
                Ok(launching)
            }
            Err(failure) => {
                let native = failure.owner.expect(
                    "native resume failure after an owned group must retain the native owner",
                );
                launching.owner.native = Some(native);
                Err(ActivationLaunchFailure {
                    kind: if let Some(budget) = budget {
                        match budget.check() {
                            Err(JournalStoreError::AdmissionCancelled) => {
                                ActivationLaunchFailureKind::Cancellation
                            }
                            Err(JournalStoreError::AdmissionDeadline) => {
                                ActivationLaunchFailureKind::Deadline
                            }
                            _ => ActivationLaunchFailureKind::Native(failure.kind),
                        }
                    } else if failure.kind == GroupNativeFailureKind::Resume
                        && cancellation_requested(cancellation)
                    {
                        ActivationLaunchFailureKind::Cancellation
                    } else {
                        ActivationLaunchFailureKind::Native(failure.kind)
                    },
                    detail: failure.detail,
                    owner: Some(ActivationLaunchOwner::Launching(launching)),
                })
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn into_suspended_owner(self) -> SuspendedActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn ready_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.ready_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }

    #[cfg(test)]
    pub(crate) fn native_is_suspended_for_test(&mut self) -> bool {
        self.owner.native_is_suspended_for_test()
    }

    #[cfg(test)]
    pub(crate) fn inject_resume_failure_at_for_test(&mut self, ordinal: usize) {
        self.owner.inject_resume_failure_at_for_test(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn inject_native_membership_failure_for_test(&mut self) {
        self.owner.inject_native_membership_failure_for_test();
    }
}

#[cfg(windows)]
impl SuspendedActivationOwner {
    #[cfg(all(test, windows))]
    pub(crate) fn release_http_fixture_permit_after_native_cleanup(&mut self) {
        if self.native_cleanup_proven {
            self._http_fixture_permit.take();
        }
    }

    pub(crate) fn cleanup_native_for_closing(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<NativeCleanupProof, String> {
        if self.native_cleanup_proven {
            let proof = self
                .native
                .as_ref()
                .and_then(SuspendedGroup::retained_cleanup_proof)
                .ok_or_else(|| {
                    "Capture runtime native cleanup proof was incomplete.".to_string()
                })?;
            #[cfg(all(test, windows))]
            self.release_http_fixture_permit_after_native_cleanup();
            return Ok(proof);
        }
        let native = self.native.as_mut().ok_or_else(|| {
            "Capture runtime native owner was missing before Closing cleanup.".to_string()
        })?;
        let proof = native.cleanup_and_retain_proof(deadline, cancellation)?;
        self.native_cleanup_proven = true;
        #[cfg(all(test, windows))]
        self.release_http_fixture_permit_after_native_cleanup();
        Ok(proof)
    }

    /// Close the exact native owner after an activation failure and then
    /// record ReconcileRequired from the same full journal candidate.  The
    /// staging owner is returned even after a successful CAS because Ready /
    /// Launching failure cleanup deliberately leaves that scope for the later
    /// reconciliation owner; no terminal or lease authority is produced.
    pub(crate) fn cleanup_and_reconcile(
        mut self,
        budget: &ActivationBudget,
    ) -> Result<ReconciledActivationOwner, ActivationReconcileFailure> {
        if !self.native_cleanup_proven {
            if let Some(native) = self.native.as_mut() {
                #[cfg_attr(not(test), allow(unused_variables))]
                if let Err(detail) =
                    native.cleanup_and_retain_proof_after_activation_failure(budget.deadline())
                {
                    return Err(ActivationReconcileFailure {
                        kind: ActivationReconcileFailureKind::Cleanup,
                        #[cfg(test)]
                        detail,
                        committed_candidate: self
                            .failure_context
                            .as_ref()
                            .map(|c| c.candidate.clone()),
                        #[cfg(test)]
                        candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                        owner: self,
                    });
                }
                self.native_cleanup_proven = true;
            } else {
                // A staging-only owner has no Job to close.  Preserve its
                // scope for reconcile, but treat native cleanup as vacuous.
                self.native_cleanup_proven = true;
            }
        }
        #[cfg(all(test, windows))]
        self.release_http_fixture_permit_after_native_cleanup();

        let no_cancellation = AtomicBool::new(false);
        #[cfg_attr(not(test), allow(unused_variables))]
        if let Err(detail) = self
            .staging
            .validate_reconcile_retained_scope(budget.deadline(), &no_cancellation)
        {
            return Err(ActivationReconcileFailure {
                kind: ActivationReconcileFailureKind::Cleanup,
                #[cfg(test)]
                detail,
                committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                #[cfg(test)]
                candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                owner: self,
            });
        }

        #[cfg_attr(not(test), allow(unused_variables))]
        if let Err(error) = budget.check_deadline() {
            return Err(ActivationReconcileFailure {
                kind: ActivationReconcileFailureKind::Deadline,
                #[cfg(test)]
                detail: activation_budget_error_detail(error),
                committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                #[cfg(test)]
                candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                owner: self,
            });
        }
        let timestamp = match self.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            #[cfg_attr(not(test), allow(unused_variables))]
            Err(detail) => {
                return Err(ActivationReconcileFailure {
                    kind: ActivationReconcileFailureKind::Validation,
                    #[cfg(test)]
                    detail,
                    committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                    #[cfg(test)]
                    candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                    owner: self,
                });
            }
        };
        #[cfg_attr(not(test), allow(unused_variables))]
        if let Err(error) = budget.check_deadline() {
            return Err(ActivationReconcileFailure {
                kind: ActivationReconcileFailureKind::Deadline,
                #[cfg(test)]
                detail: activation_budget_error_detail(error),
                committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                #[cfg(test)]
                candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                owner: self,
            });
        }
        let Some(context) = self.failure_context.clone() else {
            return Err(ActivationReconcileFailure {
                kind: ActivationReconcileFailureKind::Validation,
                #[cfg(test)]
                detail: "Capture runtime activation reconcile context was unavailable.".into(),
                committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                #[cfg(test)]
                candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                owner: self,
            });
        };
        let reconcile_read_cancellation = Arc::new(AtomicBool::new(false));
        let _read_budget = install_running_read_budget(
            budget.deadline(),
            Arc::clone(&reconcile_read_cancellation),
        );
        let current = match context.store.read_durable(&context.plan) {
            Ok(current) => current,
            Err(error) => {
                return Err(ActivationReconcileFailure {
                    kind: activation_reconcile_failure_kind(&error),
                    #[cfg(test)]
                    detail: "Capture runtime activation reconcile could not validate its durable predecessor or candidate.".into(),
                    committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                    #[cfg(test)]
                    candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                    owner: self,
                });
            }
        };
        let expected = if current == context.candidate {
            confirm_retained_candidate(&mut self.failure_context, &current);
            context.candidate.clone()
        } else if current == context.predecessor
            && context.disposition == CasDisposition::AmbiguousWrite
        {
            context.predecessor.clone()
        } else {
            return Err(ActivationReconcileFailure {
                kind: ActivationReconcileFailureKind::Conflict,
                #[cfg(test)]
                detail: "Capture runtime activation reconcile found an unknown or conflicting durable journal state.".into(),
                committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                #[cfg(test)]
                candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                owner: self,
            });
        };
        // A durable ReconcileRequired candidate is already the requested
        // state. Native cleanup plus retained staging proves semantic
        // adoption; repeating Reconcile -> Reconcile CAS would create a
        // second authority edge.
        if expected.state == JournalState::ReconcileRequired {
            #[cfg_attr(not(test), allow(unused_variables))]
            if let Err(error) = budget.check_deadline() {
                return Err(ActivationReconcileFailure {
                    kind: ActivationReconcileFailureKind::Deadline,
                    #[cfg(test)]
                    detail: activation_budget_error_detail(error),
                    committed_candidate: Some(expected),
                    #[cfg(test)]
                    candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                    owner: self,
                });
            }
            drop(_read_budget);
            return Ok(ReconciledActivationOwner {
                journal: expected,
                owner: self,
            });
        }
        let admission = match context.store.begin_activation_reconcile(
            &context.plan,
            &expected,
            budget.deadline(),
        ) {
            Ok(admission) => admission,
            Err(error) => {
                return Err(ActivationReconcileFailure {
                    kind: activation_reconcile_failure_kind(&error),
                    #[cfg(test)]
                    detail: format!(
                        "Capture runtime activation reconcile admission failed: {error:?}."
                    ),
                    committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                    #[cfg(test)]
                    candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                    owner: self,
                });
            }
        };
        drop(_read_budget);
        let outcome = admission.commit_reconcile_required_owned(timestamp);
        if let Some(context) = self.failure_context.as_mut() {
            record_owned_cas_context(context, &outcome);
        }
        match outcome.disposition() {
            CasDisposition::Committed => Ok(ReconciledActivationOwner {
                journal: outcome.attempt().cloned().expect("reconcile candidate"),
                owner: self,
            }),
            CasDisposition::ConfirmedLate
            | CasDisposition::AmbiguousWrite
            | CasDisposition::Prewrite => {
                let kind = match outcome.error() {
                    Some(error) => activation_reconcile_failure_kind(error),
                    None => ActivationReconcileFailureKind::Deadline,
                };
                #[cfg_attr(not(test), allow(unused_variables))]
                let detail = match outcome.disposition() {
                    CasDisposition::ConfirmedLate => "Capture runtime activation reconcile committed after its absolute deadline; durable state is retained without reconcile authority.".into(),
                    CasDisposition::AmbiguousWrite => "Capture runtime activation reconcile write remained unconfirmed; durable state is retained without reconcile authority.".into(),
                    CasDisposition::Prewrite => format!("Capture runtime activation reconcile CAS failed: {:?}.", outcome.error()),
                    CasDisposition::Committed => unreachable!(),
                };
                Err(ActivationReconcileFailure {
                    kind,
                    #[cfg(test)]
                    detail,
                    committed_candidate: self.failure_context.as_ref().map(|c| c.candidate.clone()),
                    #[cfg(test)]
                    candidate_disposition: self.failure_context.as_ref().map(|c| c.disposition),
                    owner: self,
                })
            }
        }
    }
}
