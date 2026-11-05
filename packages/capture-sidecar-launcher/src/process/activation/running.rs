use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use crate::{
    health::{probe_service_ready, StrictProbeResult},
    journal::{JournalState, ResourceObservation, RootState, RuntimeSessionJournalV1},
    journal_store::{ActivationBudget, CasDisposition},
};

#[cfg(windows)]
use super::failure::{
    closing_transition_failure, closing_transition_failure_for_bounded_error,
    closing_transition_failure_for_cas, closing_transition_failure_for_owned,
    ClosingTransitionFailure, ClosingTransitionFailureKind,
};

#[cfg(windows)]
use super::closing::ClosingActivationOwner;
#[cfg(windows)]
use super::launching::{check_running_promotion_budget, running_readiness_digest};
#[cfg(windows)]
use super::reconcile::record_owned_cas_context;
#[cfg(windows)]
use super::suspended::SuspendedActivationOwner;
#[cfg(windows)]
use crate::process::error::{
    lifecycle_error, lifecycle_error_for_native_detail, lifecycle_error_for_store,
    GroupLifecycleState, GroupObservation, LifecycleError, LifecycleErrorKind,
};

#[cfg(all(test, windows))]
use crate::process::fixture::ClosingAdmissionTestHook;
#[cfg(windows)]
#[cfg(all(test, windows))]
use std::sync::mpsc::{Receiver, SyncSender};

pub(crate) struct RunningActivationOwner {
    pub(crate) owner: SuspendedActivationOwner,
    pub(crate) running_journal: RuntimeSessionJournalV1,
    #[cfg(all(test, windows))]
    pub(crate) closing_admission_hook: Option<ClosingAdmissionTestHook>,
}

/// Private teardown-intent owner after the durable Running -> Closing CAS.
/// It retains the exact native and staging owners; cleanup proof and terminal
/// authority are deliberately later lifecycle steps.

impl RunningActivationOwner {
    #[cfg(test)]
    pub(crate) fn into_suspended_owner(self) -> SuspendedActivationOwner {
        self.owner
    }

    /// Consume the Running owner and persist only teardown intent.  This
    /// boundary deliberately does not require a live root, listener, HTTP
    /// readiness, or unchanged executable/schema bytes: those observations
    /// belong to cleanup proof.  The retained Running journal and immutable
    /// address index still have to match before the typed CAS.
    #[allow(unused_mut)]
    pub(crate) fn begin_closing_with_cancellation(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<ClosingActivationOwner, ClosingTransitionFailure> {
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(closing_transition_failure(self, detail));
        }

        if let Err(detail) = self.owner.staging.revalidate_running_snapshot_for_closing(
            &self.running_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(closing_transition_failure_for_bounded_error(
                self,
                detail,
                deadline,
                cancellation.as_ref(),
            ));
        }

        #[cfg(all(test, windows))]
        if let Some(hook) = self.closing_admission_hook.take() {
            if hook.reached.send(()).is_err() {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Closing admission test rendezvous closed.",
                ));
            }
            if hook
                .acquired
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Closing admission test rendezvous timed out.",
                ));
            }
        }
        let admission = match self.owner.staging.begin_closing_admission(
            &self.running_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(closing_transition_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Closing admission failed before CAS.",
                ));
            }
        };
        if admission.current() != &self.running_journal {
            return Err(closing_transition_failure(
                self,
                "Capture runtime Running journal changed before Closing CAS.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(closing_transition_failure(self, detail));
        }

        let mut roots = self.running_journal.roots.clone();
        for root in &mut roots {
            if root.state != RootState::Running || root.live_listener_readiness.is_none() {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Running journal did not contain complete live observations before Closing CAS.",
                ));
            }
            root.state = RootState::Closing;
        }
        let job_binding = match self.running_journal.job_binding.clone() {
            Some(binding) => binding,
            None => {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Running Job binding was missing before Closing CAS.",
                ));
            }
        };
        let staging_binding = match self.running_journal.staging_binding.clone() {
            Some(binding) => Some(binding),
            None => {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Running staging binding was missing before Closing CAS.",
                ));
            }
        };
        let observation = ResourceObservation {
            job_binding,
            staging_binding,
            roots,
        };
        let timestamp = match self.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => return Err(closing_transition_failure(self, detail)),
        };
        if timestamp < self.running_journal.updated_at {
            return Err(closing_transition_failure(
                self,
                "Capture runtime producer clock moved backwards before Closing CAS.",
            ));
        }

        let result = self.owner.staging.persist_closing_admission_owned(
            admission,
            &self.running_journal,
            observation,
            timestamp,
        );
        if let Some(context) = self.owner.failure_context.as_mut() {
            record_owned_cas_context(context, &result);
        }
        let closing_journal = match result.disposition() {
            CasDisposition::Committed => result.attempt().cloned().expect("closing candidate"),
            CasDisposition::ConfirmedLate => {
                #[cfg_attr(not(test), allow(unused_variables))]
                let detail = if cancellation.load(Ordering::Acquire) {
                    "Capture runtime Closing CAS completed after cancellation; the durable Closing record remains for reconciliation."
                } else {
                    "Capture runtime Closing CAS completed after its deadline; the durable Closing record remains for reconciliation."
                };
                return Err(ClosingTransitionFailure {
                    kind: if cancellation.load(Ordering::Acquire) {
                        ClosingTransitionFailureKind::Cancelled
                    } else {
                        ClosingTransitionFailureKind::Deadline
                    },
                    #[cfg(test)]
                    detail: detail.into(),
                    owner: self,
                    committed_candidate: result.attempt().cloned(),
                    #[cfg(test)]
                    candidate_disposition: Some(CasDisposition::ConfirmedLate),
                });
            }
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => {
                return Err(closing_transition_failure_for_owned(
                    self,
                    result,
                    "Capture runtime Closing journal CAS was ambiguous; no Closing authority was issued and the disk state (possibly Closing) requires reconciliation.",
                ));
            }
        };
        #[cfg_attr(not(test), allow(unused_variables))]
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            // The complete Closing candidate is already durable, but the
            // owner boundary has not been issued.  Keep the original Running
            // owner so reconciliation can account for the disk Closing
            // intent without fabricating a typed Closing authority.
            return Err(ClosingTransitionFailure {
                kind: if cancellation.load(Ordering::Acquire) {
                    ClosingTransitionFailureKind::Cancelled
                } else {
                    ClosingTransitionFailureKind::Deadline
                },
                #[cfg(test)]
                detail,
                owner: self,
                committed_candidate: Some(closing_journal),
                #[cfg(test)]
                candidate_disposition: Some(CasDisposition::ConfirmedLate),
            });
        }

        Ok(ClosingActivationOwner {
            owner: self.owner,
            closing_journal,
            native_cleanup_proof: None,
            listener_release_proof: None,
            staging_release_proof: None,
            #[cfg(all(test, windows))]
            listener_query_failure_after_staging: false,
            #[cfg(all(test, windows))]
            staging_release_cancel_before_authority: false,
            #[cfg(all(test, windows))]
            terminal_listener_rebind_after_clock_port: None,
            #[cfg(all(test, windows))]
            terminal_foreign_listener: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn running_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.running_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_query_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn terminate_root_for_test(&mut self, ordinal: usize) -> Result<(), String> {
        self.owner.terminate_root_for_test(ordinal)
    }

    #[cfg(test)]
    pub(crate) fn coordinate_closing_admission_for_test(
        &mut self,
        reached: SyncSender<()>,
        acquired: Receiver<()>,
    ) {
        self.closing_admission_hook = Some(ClosingAdmissionTestHook { reached, acquired });
    }
}

#[cfg(windows)]
impl RunningActivationOwner {
    pub(crate) fn observe_public(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<GroupObservation, LifecycleError> {
        let budget = ActivationBudget::new(deadline, Arc::clone(&cancellation));
        if let Err(error) = budget.check() {
            return Err(lifecycle_error_for_store(error));
        }

        let expected = self.running_journal.clone();
        let Some(context) = self.owner.failure_context.as_ref() else {
            return Err(lifecycle_error(LifecycleErrorKind::InvalidState));
        };
        let store = Arc::clone(&context.store);
        let plan = context.plan.clone();
        {
            let _read_budget = budget.install_read_scope();
            let current = store.read(&plan).map_err(lifecycle_error_for_store)?;
            if current != expected
                || current.state != JournalState::Running
                || current.validate_against_plan(&plan).is_err()
            {
                return Err(lifecycle_error(LifecycleErrorKind::Conflict));
            }
        }

        self.owner
            .staging
            .revalidate_address_index_for_running(deadline, Arc::clone(&cancellation))
            .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
        self.owner
            .staging
            .checked_commands_for_running()
            .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
        let descriptor = self.owner.staging.activation_descriptor();
        let expected_staging = self
            .owner
            .staging
            .staging_binding_for_running()
            .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
        if expected.staging_binding.as_ref() != Some(&expected_staging) {
            return Err(lifecycle_error(LifecycleErrorKind::Conflict));
        }

        let mut readiness_facts = Vec::with_capacity(expected.roots.len());
        for ordinal in 0..expected.roots.len() {
            let (_, manifest, schema_context, _) = descriptor
                .strict_readiness_inputs(ordinal)
                .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
            schema_context
                .revalidate(manifest)
                .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
        }

        let ports = expected
            .roots
            .iter()
            .map(|root| root.loopback_port)
            .collect::<Vec<_>>();
        let first_listener_observation = {
            let native = self
                .owner
                .native
                .as_mut()
                .ok_or(lifecycle_error(LifecycleErrorKind::Native))?;
            native
                .observe_root_listeners(&ports, deadline, Some(cancellation.as_ref()))
                .map_err(|detail| lifecycle_error_for_native_detail(&detail))?
        };

        for ordinal in 0..expected.roots.len() {
            if let Err(error) = budget.check() {
                return Err(lifecycle_error_for_store(error));
            }
            let (token, manifest, schema_context, port) = descriptor
                .strict_readiness_inputs(ordinal)
                .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
            schema_context
                .revalidate(manifest)
                .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
            match probe_service_ready(
                port,
                token,
                manifest,
                schema_context.schema(),
                deadline,
                cancellation.as_ref(),
            ) {
                Ok(StrictProbeResult::Ready(facts)) => readiness_facts.push(facts),
                Ok(StrictProbeResult::NotReady) => {
                    return Err(lifecycle_error(LifecycleErrorKind::Listener))
                }
                Ok(StrictProbeResult::Cancelled) => {
                    return Err(lifecycle_error(LifecycleErrorKind::Cancellation))
                }
                Err(detail) => {
                    let error = lifecycle_error_for_native_detail(&detail);
                    return Err(
                        if matches!(
                            error.kind,
                            LifecycleErrorKind::Cancellation | LifecycleErrorKind::Deadline
                        ) {
                            error
                        } else {
                            lifecycle_error(LifecycleErrorKind::Listener)
                        },
                    );
                }
            }
        }

        let final_listener_observation = {
            let native = self
                .owner
                .native
                .as_mut()
                .ok_or(lifecycle_error(LifecycleErrorKind::Native))?;
            native
                .observe_root_listeners(&ports, deadline, Some(cancellation.as_ref()))
                .map_err(|detail| lifecycle_error_for_native_detail(&detail))?
        };
        if first_listener_observation != final_listener_observation {
            return Err(lifecycle_error(LifecycleErrorKind::Listener));
        }
        if readiness_facts.len() != expected.roots.len()
            || final_listener_observation.roots.len() != expected.roots.len()
        {
            return Err(lifecycle_error(LifecycleErrorKind::Validation));
        }
        for ((root, facts), listener) in expected
            .roots
            .iter()
            .zip(&readiness_facts)
            .zip(&final_listener_observation.roots)
        {
            if listener.ordinal != root.ordinal
                || root.live_listener_readiness.as_deref()
                    != Some(running_readiness_digest(&expected, root, listener, facts).as_str())
            {
                return Err(lifecycle_error(LifecycleErrorKind::Conflict));
            }
        }
        self.owner
            .staging
            .checked_commands_for_running()
            .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
        let final_staging = self
            .owner
            .staging
            .staging_binding_for_running()
            .map_err(|_| lifecycle_error(LifecycleErrorKind::Validation))?;
        if expected.staging_binding.as_ref() != Some(&final_staging) {
            return Err(lifecycle_error(LifecycleErrorKind::Conflict));
        }
        {
            let _read_budget = budget.install_read_scope();
            let current = store.read(&plan).map_err(lifecycle_error_for_store)?;
            if current != expected {
                return Err(lifecycle_error(LifecycleErrorKind::Conflict));
            }
        }
        if let Err(error) = budget.check() {
            return Err(lifecycle_error_for_store(error));
        }
        Ok(GroupObservation {
            state: GroupLifecycleState::Running,
            root_count: expected.roots.len(),
            roots_ready: true,
            listeners_bound: true,
        })
    }
}
