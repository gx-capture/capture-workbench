use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use sha2::{Digest, Sha256};

#[cfg(windows)]
use crate::{
    health::{probe_service_ready, StrictProbeResult},
    journal::{JournalRoot, ResourceObservation, RootState, RuntimeSessionJournalV1},
    journal_store::CasDisposition,
};

#[cfg(windows)]
use super::failure::{
    running_promotion_failure, running_promotion_failure_for_bounded_error,
    running_promotion_failure_for_cas, running_promotion_failure_for_owned,
    running_promotion_failure_with_candidate, RunningPromotionFailure,
};

#[cfg(windows)]
use super::group::native_nonce_text;
#[cfg(windows)]
use super::reconcile::record_owned_cas_context;
#[cfg(windows)]
use super::running::RunningActivationOwner;
#[cfg(windows)]
use super::suspended::SuspendedActivationOwner;
#[cfg(windows)]
use crate::process::listener::{check_listener_budget, NativeListenerRootObservation};
#[cfg(windows)]
use crate::process::native::OwnedProcessIdentity;

#[cfg(all(test, windows))]
use crate::prepare::ActivationCancelHandle;
#[cfg(all(test, windows))]
use crate::process::fixture::{
    ReadinessProbeTestHook, RunningAdmissionTestHook, RunningCommitTestHook,
};
#[cfg(all(test, windows))]
use std::sync::mpsc::{Receiver, SyncSender};

#[cfg(windows)]
pub(crate) struct LaunchingActivationOwner {
    pub(crate) owner: SuspendedActivationOwner,
    pub(crate) launching_journal: RuntimeSessionJournalV1,
    #[cfg(all(test, windows))]
    pub(crate) running_admission_hook: Option<RunningAdmissionTestHook>,
    #[cfg(all(test, windows))]
    pub(crate) readiness_probe_hook: Option<ReadinessProbeTestHook>,
    #[cfg(all(test, windows))]
    pub(crate) running_commit_hook: Option<RunningCommitTestHook>,
}

#[cfg(windows)]
impl LaunchingActivationOwner {
    #[cfg(test)]
    pub(crate) fn into_suspended_owner(self) -> SuspendedActivationOwner {
        self.owner
    }

    /// Promote an already-resumed Launching owner after strict service and
    /// native listener observations for every root.  The caller supplies one
    /// absolute deadline for the whole operation; no root receives a fresh
    /// timeout.  Running authority is returned only after the exact CAS value
    /// has been durably written and read back by the staging/store owner.
    pub(crate) fn promote_running_with_cancellation(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<RunningActivationOwner, RunningPromotionFailure> {
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        if cancellation.load(Ordering::Acquire) {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Running promotion was cancelled before validation.",
            ));
        }
        if std::time::Instant::now() >= deadline {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Running promotion expired before validation.",
            ));
        }

        if let Err(detail) = self
            .owner
            .staging
            .validate_launching_journal(&self.launching_journal)
        {
            return Err(running_promotion_failure(
                self,
                format!("Capture runtime Launching journal validation failed: {detail}"),
            ));
        }
        if let Err(detail) = self
            .owner
            .staging
            .revalidate_address_index_for_running(deadline, Arc::clone(&cancellation))
        {
            return Err(running_promotion_failure_for_bounded_error(
                self,
                detail,
                deadline,
                cancellation.as_ref(),
            ));
        }
        let descriptor = self.owner.staging.activation_descriptor();
        if let Err(detail) = self.owner.staging.checked_commands_for_running() {
            return Err(running_promotion_failure(self, detail));
        }
        // Schema context is a required input for this service-only Running
        // promotion.  Validate all roots before touching the native listener
        // table so a value-only or partially described descriptor cannot be
        // mistaken for a live service proof.
        for ordinal in 0..self.launching_journal.roots.len() {
            let (_, manifest, schema_context, _) = match descriptor.strict_readiness_inputs(ordinal)
            {
                Ok(inputs) => inputs,
                Err(detail) => return Err(running_promotion_failure(self, detail)),
            };
            if let Err(detail) = schema_context.revalidate(manifest) {
                return Err(running_promotion_failure(
                    self,
                    format!("Capture runtime readiness schema revalidation failed: {detail}"),
                ));
            }
        }
        let expected_staging = match self.owner.staging.staging_binding_for_running() {
            Ok(binding) => binding,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if self.launching_journal.staging_binding.as_ref() != Some(&expected_staging) {
            return Err(running_promotion_failure(
                self,
                "Capture runtime staging identity changed before Running promotion.",
            ));
        }
        let launching_snapshot = self.launching_journal.clone();
        let first_listener_observation = match self
            .observe_native_listeners_for_running_until_ready(
                &launching_snapshot,
                deadline,
                Some(cancellation.as_ref()),
            ) {
            Ok(observation) => observation,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        let mut readiness = Vec::with_capacity(self.launching_journal.roots.len());
        for ordinal in 0..self.launching_journal.roots.len() {
            if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
                return Err(running_promotion_failure(self, detail));
            }
            // A fresh checked command revalidates the frozen executable and
            // its manifest/schema context at this root's probe boundary.  It
            // is deliberately discarded because the native child already
            // owns the command used for Launching.
            if let Err(detail) = descriptor.checked_command(ordinal) {
                return Err(running_promotion_failure(self, detail));
            }
            let (token, manifest, schema_context, port) =
                match descriptor.strict_readiness_inputs(ordinal) {
                    Ok(inputs) => inputs,
                    Err(detail) => return Err(running_promotion_failure(self, detail)),
                };
            if let Err(detail) = schema_context.revalidate(manifest) {
                return Err(running_promotion_failure(
                    self,
                    format!("Capture runtime readiness schema revalidation failed: {detail}"),
                ));
            }
            match probe_service_ready(
                port,
                token,
                manifest,
                schema_context.schema(),
                deadline,
                cancellation.as_ref(),
            ) {
                Ok(StrictProbeResult::Ready(facts)) => readiness.push(facts),
                Ok(StrictProbeResult::NotReady) => {
                    return Err(running_promotion_failure(
                        self,
                        format!(
                            "Capture runtime root {ordinal} did not report strict service readiness."
                        ),
                    ));
                }
                Ok(StrictProbeResult::Cancelled) => {
                    return Err(running_promotion_failure(
                        self,
                        "Capture runtime Running promotion was cancelled during readiness.",
                    ));
                }
                Err(detail) => return Err(running_promotion_failure(self, detail)),
            }
            #[cfg(all(test, windows))]
            if self
                .readiness_probe_hook
                .as_ref()
                .is_some_and(|hook| hook.after_ordinal == ordinal)
            {
                let hook = self
                    .readiness_probe_hook
                    .take()
                    .expect("readiness probe test hook");
                hook.reached.store(true, Ordering::Release);
                hook.cancel.cancel();
            }
        }
        if readiness.len() != self.launching_journal.roots.len() {
            return Err(running_promotion_failure(
                self,
                "Capture runtime readiness observations were incomplete.",
            ));
        }

        // Acquire the journal lock before the final validation pass.  The
        // guard remains held through the typed Running CAS; a cancellation or
        // deadline during contention therefore cannot promote an old snapshot.
        #[cfg(all(test, windows))]
        if let Some(hook) = self.running_admission_hook.take() {
            if hook.reached.send(()).is_err() {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running admission test rendezvous closed.",
                ));
            }
            if hook
                .acquired
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running admission test rendezvous timed out.",
                ));
            }
        }
        let admission = match self.owner.staging.begin_running_admission(
            &self.launching_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(running_promotion_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Running admission failed.",
                ));
            }
        };
        if admission.current() != &self.launching_journal {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Launching journal changed during Running admission.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }
        // Reopening the immutable address index also reopens the journal to
        // cross-check its plan, so it cannot run while this journal lock is
        // held.  Release only this read-only admission, revalidate the index,
        // and reacquire an exact snapshot before any native observation.
        drop(admission);
        if let Err(detail) = self
            .owner
            .staging
            .revalidate_address_index_for_running(deadline, Arc::clone(&cancellation))
        {
            return Err(running_promotion_failure_for_bounded_error(
                self,
                detail,
                deadline,
                cancellation.as_ref(),
            ));
        }
        let admission = match self.owner.staging.begin_running_admission(
            &self.launching_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(running_promotion_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Running admission failed.",
                ));
            }
        };
        if admission.current() != &self.launching_journal {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Launching journal changed during Running admission.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }
        let launching_snapshot = self.launching_journal.clone();
        let final_listener_observation = match self
            .observe_native_listeners_for_running_until_ready(
                &launching_snapshot,
                deadline,
                Some(cancellation.as_ref()),
            ) {
            Ok(observation) => observation,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if first_listener_observation != final_listener_observation {
            return Err(running_promotion_failure(
                self,
                "Capture runtime native listener identity changed during readiness.",
            ));
        }
        if let Err(detail) = self.owner.staging.checked_commands_for_running() {
            return Err(running_promotion_failure(self, detail));
        }
        // Revalidate the frozen schema bytes after the lock wait and before
        // the last native observation.  The readiness facts must still be
        // anchored to the same producer manifest at the commit boundary.
        for ordinal in 0..self.launching_journal.roots.len() {
            let (_, manifest, schema_context, _) = match descriptor.strict_readiness_inputs(ordinal)
            {
                Ok(inputs) => inputs,
                Err(detail) => return Err(running_promotion_failure(self, detail)),
            };
            if let Err(detail) = schema_context.revalidate(manifest) {
                return Err(running_promotion_failure(
                    self,
                    format!("Capture runtime readiness schema revalidation failed: {detail}"),
                ));
            }
        }
        let final_staging = match self.owner.staging.staging_binding_for_running() {
            Ok(binding) => binding,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if final_staging != expected_staging {
            return Err(running_promotion_failure(
                self,
                "Capture runtime staging identity changed before Running CAS.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }

        let mut roots = self.launching_journal.roots.clone();
        for (index, ((root, facts), listener)) in roots
            .iter_mut()
            .zip(&readiness)
            .zip(&final_listener_observation)
            .enumerate()
        {
            if root.ordinal != index as u32 || listener.ordinal != root.ordinal {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running root order changed before CAS.",
                ));
            }
            root.state = RootState::Running;
            root.live_listener_readiness = Some(running_readiness_digest(
                &self.launching_journal,
                root,
                listener,
                facts,
            ));
        }
        let job_binding = match self.launching_journal.job_binding.clone() {
            Some(binding) => binding,
            None => {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running Job binding was missing.",
                ));
            }
        };
        let timestamp = match self.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if timestamp < self.launching_journal.updated_at {
            return Err(running_promotion_failure(
                self,
                "Capture runtime producer clock moved backwards before Running CAS.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }
        // Recheck native root/liveness identity at the last possible point
        // before the typed CAS.  The lock is still held, so a root that dies
        // while earlier validation or lock contention is in progress cannot
        // produce Running authority from a stale observation.
        let precommit_listener_observation = match self
            .observe_native_listeners_for_running_until_ready(
                &self.launching_journal.clone(),
                deadline,
                Some(cancellation.as_ref()),
            ) {
            Ok(observation) => observation,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if precommit_listener_observation != final_listener_observation {
            return Err(running_promotion_failure(
                self,
                "Capture runtime native listener identity changed before Running CAS.",
            ));
        }
        let observation = ResourceObservation {
            job_binding,
            staging_binding: Some(final_staging),
            roots,
        };
        let result = self.owner.staging.persist_running_admission_owned(
            admission,
            &self.launching_journal,
            observation,
            timestamp,
        );
        if let Some(context) = self.owner.failure_context.as_mut() {
            record_owned_cas_context(context, &result);
        }
        let running_journal = match result.disposition() {
            CasDisposition::Committed => {
                #[cfg(all(test, windows))]
                if let Some(hook) = self.running_commit_hook.take() {
                    hook.reached.store(true, Ordering::Release);
                    hook.cancel.cancel();
                }
                result.attempt().cloned().expect("running candidate")
            }
            CasDisposition::ConfirmedLate => {
                // The exact Running record is durable, but cancellation or
                // deadline was observed before authority issuance.  Keep the
                // Launching owner and leave the disk record for reconciliation;
                // never fabricate a Running owner after the boundary.
                let detail = if cancellation.load(Ordering::Acquire) {
                    "Capture runtime Running CAS completed after cancellation."
                } else {
                    "Capture runtime Running CAS completed after its deadline."
                };
                return Err(running_promotion_failure_with_candidate(
                    self,
                    detail,
                    result.attempt().cloned(),
                ));
            }
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => {
                return Err(running_promotion_failure_for_owned(
                    self,
                    result,
                    "Capture runtime Running journal CAS failed.",
                ));
            }
        };
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            // The disk record remains the exact durable Running candidate;
            // cancellation observed before this owner is issued leaves it for
            // reconciliation rather than rolling it back or issuing authority.
            return Err(running_promotion_failure_with_candidate(
                self,
                detail,
                Some(running_journal),
            ));
        }
        Ok(RunningActivationOwner {
            owner: self.owner,
            running_journal,
            #[cfg(all(test, windows))]
            closing_admission_hook: None,
        })
    }

    pub(crate) fn observe_native_listeners_for_running(
        &mut self,
        expected: &RuntimeSessionJournalV1,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<Vec<NativeListenerRootObservation>, String> {
        let expected_job = expected
            .job_binding
            .as_ref()
            .ok_or_else(|| "Capture runtime Launching Job binding was missing.".to_string())?;
        let native = self
            .owner
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing.".to_string())?;
        if native_nonce_text(&native.job_nonce) != expected_job.job_nonce {
            return Err(
                "Capture runtime native Job nonce changed during Running promotion.".into(),
            );
        }
        let ports = expected
            .roots
            .iter()
            .map(|root| root.loopback_port)
            .collect::<Vec<_>>();
        let observation = native.observe_root_listeners(&ports, deadline, cancellation)?;
        if observation.roots.len() != expected.roots.len()
            || native.roots.len() != expected.roots.len()
            || !native.unacquired_root_nonces.is_empty()
        {
            return Err("Capture runtime native listener observation was incomplete.".into());
        }
        for (index, ((expected_root, observed), native_root)) in expected
            .roots
            .iter()
            .zip(&observation.roots)
            .zip(&native.roots)
            .enumerate()
        {
            if expected_root.ordinal != index as u32
                || observed.ordinal != expected_root.ordinal
                || observed.port != expected_root.loopback_port
                || native_root.ordinal != expected_root.ordinal
                || native_nonce_text(&native_root.root_nonce) != expected_root.root_nonce
            {
                return Err(
                    "Capture runtime native root binding changed during Running promotion.".into(),
                );
            }
            let creation_time = parse_creation_identity(expected_root)?;
            let expected_identity = OwnedProcessIdentity {
                pid: expected_root.pid,
                creation_time,
            };
            if observed.identity != expected_identity
                || native_root.identity != Some(expected_identity)
            {
                return Err(
                    "Capture runtime native process identity changed during Running promotion."
                        .into(),
                );
            }
        }
        Ok(observation.roots)
    }

    /// A resumed sidecar can take a short, bounded interval to bind its
    /// reserved loopback listener.  Retry only the missing-listener result;
    /// all identity, liveness, foreign-listener, and malformed-table errors
    /// remain fail-closed.  The caller's absolute deadline is never refreshed.
    pub(crate) fn observe_native_listeners_for_running_until_ready(
        &mut self,
        expected: &RuntimeSessionJournalV1,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<Vec<NativeListenerRootObservation>, String> {
        loop {
            match self.observe_native_listeners_for_running(expected, deadline, cancellation) {
                Ok(observation) => return Ok(observation),
                Err(detail) if detail.starts_with("No exact loopback listener was observed") => {
                    check_listener_budget(deadline, cancellation)?;
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    std::thread::sleep(std::time::Duration::from_millis(5).min(remaining));
                }
                Err(detail) => return Err(detail),
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn launching_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.launching_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }

    #[cfg(test)]
    pub(crate) fn observe_native_listeners_for_test(
        &mut self,
        ports: &[u16],
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<usize, String> {
        let native = self
            .owner
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing.".to_string())?;
        Ok(native
            .observe_root_listeners(ports, deadline, cancellation)?
            .root_count())
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_query_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_identity_mutation_after_first_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_identity_mutation_after_first_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_root_exit_after_first_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_root_exit_after_first_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_identity_mutation_at_last_observation_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_identity_mutation_at_last_observation_for_test();
    }

    #[cfg(test)]
    pub(crate) fn listener_observation_count_for_test(&self) -> usize {
        self.owner
            .native
            .as_ref()
            .map_or(0, |native| native.listener_observation_count)
    }

    #[cfg(test)]
    pub(crate) fn coordinate_running_admission_for_test(
        &mut self,
        reached: SyncSender<()>,
        acquired: Receiver<()>,
    ) {
        self.running_admission_hook = Some(RunningAdmissionTestHook { reached, acquired });
    }

    #[cfg(all(test, windows))]
    pub(crate) fn coordinate_readiness_probe_for_test(
        &mut self,
        after_ordinal: usize,
        reached: Arc<AtomicBool>,
        cancel: ActivationCancelHandle,
    ) {
        assert!(after_ordinal + 1 < self.launching_journal.roots.len());
        self.readiness_probe_hook = Some(ReadinessProbeTestHook {
            after_ordinal,
            reached,
            cancel,
        });
    }

    #[cfg(all(test, windows))]
    pub(crate) fn cancel_after_running_commit_for_test(
        &mut self,
        reached: Arc<AtomicBool>,
        cancel: ActivationCancelHandle,
    ) {
        self.running_commit_hook = Some(RunningCommitTestHook { reached, cancel });
    }

    #[cfg(test)]
    pub(crate) fn inject_native_cleanup_failure_for_test(&mut self) {
        self.owner.inject_native_cleanup_failure_for_test();
    }
}

#[cfg(windows)]
#[cfg(windows)]
pub(crate) fn check_running_promotion_budget(
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> Result<(), String> {
    if cancellation.load(Ordering::Acquire) {
        return Err("Capture runtime Running promotion was cancelled.".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("Capture runtime Running promotion exceeded its group deadline.".into());
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn parse_creation_identity(root: &JournalRoot) -> Result<u64, String> {
    if root.creation_identity.kind != "windows-process-creation" {
        return Err("Capture runtime root creation identity had an unsupported kind.".into());
    }
    if root.creation_identity.value.len() != 16
        || !root
            .creation_identity
            .value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Capture runtime root creation identity was malformed.".into());
    }
    u64::from_str_radix(&root.creation_identity.value, 16)
        .map_err(|_| "Capture runtime root creation identity was malformed.".into())
}

#[cfg(windows)]
pub(crate) fn running_readiness_digest(
    journal: &RuntimeSessionJournalV1,
    root: &JournalRoot,
    listener: &NativeListenerRootObservation,
    facts: &crate::health::ServiceReadinessFacts,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/running-readiness/v1\0");
    digest_field(&mut hasher, journal.session_nonce.as_bytes());
    digest_field(&mut hasher, journal.plan_digest.as_bytes());
    digest_field(&mut hasher, &root.ordinal.to_be_bytes());
    digest_field(&mut hasher, root.role.as_bytes());
    digest_field(&mut hasher, root.root_ref_digest.as_bytes());
    digest_field(&mut hasher, &root.root_generation.to_be_bytes());
    digest_field(&mut hasher, root.root_nonce.as_bytes());
    digest_field(&mut hasher, &root.pid.to_be_bytes());
    digest_field(&mut hasher, root.creation_identity.kind.as_bytes());
    digest_field(&mut hasher, root.creation_identity.value.as_bytes());
    digest_field(&mut hasher, root.reserved_listener_identity.as_bytes());
    digest_field(&mut hasher, &root.loopback_port.to_be_bytes());
    digest_field(&mut hasher, root.started_at.as_bytes());
    digest_field(&mut hasher, &listener.identity.pid.to_be_bytes());
    digest_field(&mut hasher, &listener.identity.creation_time.to_be_bytes());
    digest_field(&mut hasher, &listener.port.to_be_bytes());
    digest_field(&mut hasher, facts.facts_digest().as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(windows)]
pub(crate) fn digest_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}
