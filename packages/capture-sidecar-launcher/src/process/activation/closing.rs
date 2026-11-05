use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[cfg(windows)]
use crate::{
    journal::{
        ResourceObservation, RootState, RuntimeSessionJournalV1, TerminalObservation, TerminalProof,
    },
    journal_store::CasDisposition,
    staging::StagingReleasedObservation,
};

#[cfg(windows)]
use super::failure::{
    check_native_cleanup_budget, closing_cleanup_failure, closing_cleanup_failure_for_admission,
    closing_staging_release_failure, closing_staging_release_failure_for_admission,
    closing_staging_release_failure_for_staging, closing_staging_release_failure_for_store_error,
    listener_release_proof_for_closing, staging_release_kind_from_detail, terminal_join_failure,
    terminal_join_failure_for_admission, terminal_join_failure_for_owned,
    terminal_join_failure_for_store, terminal_join_failure_with_candidate,
    terminal_join_kind_from_detail, ClosingCleanupFailure, ClosingStagingReleaseFailure,
    ClosingStagingReleaseFailureKind, TerminalJoinFailure, TerminalJoinFailureKind,
};

#[cfg(windows)]
use super::group::{native_nonce_text, NativeCleanupProof, NativeListenerReleaseProof};

#[cfg(windows)]
use super::suspended::SuspendedActivationOwner;

pub(crate) struct ClosingActivationOwner {
    pub(crate) owner: SuspendedActivationOwner,
    pub(crate) closing_journal: RuntimeSessionJournalV1,
    pub(crate) native_cleanup_proof: Option<NativeCleanupProof>,
    pub(crate) listener_release_proof: Option<NativeListenerReleaseProof>,
    pub(crate) staging_release_proof: Option<StagingReleasedObservation>,
    #[cfg(all(test, windows))]
    pub(crate) listener_query_failure_after_staging: bool,
    #[cfg(all(test, windows))]
    pub(crate) staging_release_cancel_before_authority: bool,
    #[cfg(all(test, windows))]
    pub(crate) terminal_listener_rebind_after_clock_port: Option<u16>,
    #[cfg(all(test, windows))]
    pub(crate) terminal_foreign_listener: Option<std::net::TcpListener>,
}

/// Private proof retained after the exact Job and root handles have proved
/// termination.  It deliberately retains the native identities needed by a
/// later listener-release observation; it is not a TerminalProof.
#[cfg(windows)]
#[cfg(windows)]
pub(crate) struct TerminalizedActivationOwner {
    pub(crate) terminal_journal: RuntimeSessionJournalV1,
}

#[cfg(windows)]
impl TerminalizedActivationOwner {
    #[cfg(test)]
    pub(crate) fn journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.terminal_journal
    }
}

#[cfg(windows)]
impl ClosingActivationOwner {
    /// Consume the Closing owner through the native teardown boundary.  The
    /// current Closing journal/index and every retained native identity are
    /// checked before the first destructive operation.  A successful native
    /// proof stays inside this same owner so a later listener-query failure
    /// can be retried without reacquiring or reconstructing native state.
    pub(crate) fn cleanup_native_and_observe_listener_release(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<Self, ClosingCleanupFailure> {
        // A release proof is valid only for the observation that produced it.
        // Clear it before every retry, including validation and cancellation
        // exits, so a rebound or failed listener query can never inherit an
        // earlier absence observation.
        self.listener_release_proof = None;
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(closing_cleanup_failure(self, detail));
        }
        if let Err(detail) = self.owner.staging.revalidate_closing_index_for_cleanup(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(closing_cleanup_failure(self, detail));
        }

        // Keep the exact Closing journal snapshot locked through native
        // termination and listener-release observation.  A reconciler may
        // still read the filesystem, but it cannot advance this journal and
        // leave an older owner acting on a stale teardown intent.
        let cleanup_admission = match self.owner.staging.begin_closing_cleanup_admission(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(closing_cleanup_failure_for_admission(self, cause));
            }
        };
        if cleanup_admission.current() != &self.closing_journal {
            return Err(closing_cleanup_failure(
                self,
                "Capture runtime Closing journal changed before native cleanup admission.",
            ));
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing cleanup admission budget ended: {cause:?}."),
            ));
        }

        if self.native_cleanup_proof.is_none() {
            let expected = match self
                .owner
                .native
                .as_mut()
                .ok_or_else(|| {
                    "Capture runtime native owner was missing before Closing cleanup.".to_string()
                })
                .and_then(|native| native.validate_closing_binding(&self.closing_journal))
            {
                Ok(expected) => expected,
                Err(detail) => return Err(closing_cleanup_failure(self, detail)),
            };
            let proof = match self
                .owner
                .cleanup_native_for_closing(deadline, Some(cancellation.as_ref()))
            {
                Ok(proof) => proof,
                Err(detail) => return Err(closing_cleanup_failure(self, detail)),
            };
            if proof != expected {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime native cleanup proof did not retain the Closing identity tuple.",
                ));
            }
            self.native_cleanup_proof = Some(proof);
        } else {
            // A retry after a failed listener observation must still bind the
            // retained native proof to this exact Closing tuple.  The journal
            // admission is unchanged, but the retained handles and all root
            // identities are rechecked before another table observation.
            let expected = match self
                .owner
                .native
                .as_mut()
                .ok_or_else(|| {
                    "Capture runtime native owner was missing before listener retry.".to_string()
                })
                .and_then(|native| native.validate_closing_binding(&self.closing_journal))
            {
                Ok(expected) => expected,
                Err(detail) => return Err(closing_cleanup_failure(self, detail)),
            };
            if self.native_cleanup_proof.as_ref() != Some(&expected) {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime retained native cleanup proof no longer matched Closing.",
                ));
            }
        }
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(closing_cleanup_failure(self, detail));
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing cleanup admission budget ended: {cause:?}."),
            ));
        }

        let native = match self.owner.native.as_mut() {
            Some(native) => native,
            None => {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime native owner was lost after cleanup proof.",
                ));
            }
        };
        let native_proof = self
            .native_cleanup_proof
            .as_ref()
            .expect("native cleanup proof after successful cleanup")
            .clone();
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing listener proof budget ended: {cause:?}."),
            ));
        }
        let _release_roots = match self
            .closing_journal
            .roots
            .iter()
            .zip(&native_proof.roots)
            .map(|(journal_root, native_root)| {
                if journal_root.ordinal != native_root.ordinal
                    || journal_root.root_nonce != native_nonce_text(&native_root.root_nonce)
                    || journal_root.loopback_port == 0
                    || journal_root.reserved_listener_identity.is_empty()
                    || journal_root.live_listener_readiness.is_none()
                {
                    return None;
                }
                Some(())
            })
            .collect::<Option<Vec<_>>>()
        {
            Some(roots) if roots.len() == self.closing_journal.roots.len() => roots,
            _ => {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime listener release tuple was incomplete or reordered.",
                ));
            }
        };
        let release = match native.observe_listener_release_for_closing(
            &self.closing_journal,
            &native_proof,
            deadline,
            Some(cancellation.as_ref()),
        ) {
            Ok(()) => NativeListenerReleaseProof {},
            Err(detail) => return Err(closing_cleanup_failure(self, detail)),
        };
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing listener proof budget ended: {cause:?}."),
            ));
        }
        self.listener_release_proof = Some(release);
        drop(cleanup_admission);
        Ok(self)
    }

    /// Consume the native/listener-proven Closing owner through the staging
    /// release boundary.  The journal admission remains held for the first
    /// listener absence observation, every staging mutation, and the final
    /// listener absence observation.  A failure retains this exact owner,
    /// including any native proof and partial staging-release progress.
    pub(crate) fn release_staging_after_native_cleanup(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<(Self, StagingReleasedObservation), ClosingStagingReleaseFailure> {
        self.listener_release_proof = None;
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        let native_proof = match self.native_cleanup_proof.clone() {
            Some(proof) => proof,
            None => {
                return Err(closing_staging_release_failure(
                    self,
                    ClosingStagingReleaseFailureKind::Validation,
                    "Capture runtime staging release lacked the exact native cleanup proof.",
                ));
            }
        };
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(closing_staging_release_failure(
                self,
                staging_release_kind_from_detail(
                    &detail,
                    ClosingStagingReleaseFailureKind::Validation,
                ),
                detail,
            ));
        }
        if let Err(detail) = self.owner.staging.revalidate_closing_index_for_cleanup(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(closing_staging_release_failure(
                self,
                ClosingStagingReleaseFailureKind::Validation,
                detail,
            ));
        }
        let cleanup_admission = match self.owner.staging.begin_closing_cleanup_admission(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(closing_staging_release_failure_for_admission(self, cause));
            }
        };
        if cleanup_admission.current() != &self.closing_journal {
            return Err(closing_staging_release_failure(
                self,
                ClosingStagingReleaseFailureKind::Validation,
                "Capture runtime Closing cleanup admission did not retain the exact journal.",
            ));
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }

        {
            let native = match self.owner.native.as_mut() {
                Some(native) => native,
                None => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        "Capture runtime native owner was missing before staging release.",
                    ));
                }
            };
            let retained = match native.validate_closing_binding(&self.closing_journal) {
                Ok(proof) => proof,
                Err(detail) => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        detail,
                    ));
                }
            };
            if retained != native_proof {
                return Err(closing_staging_release_failure(
                    self,
                    ClosingStagingReleaseFailureKind::Validation,
                    "Capture runtime retained native cleanup proof no longer matched Closing.",
                ));
            }
            if let Err(detail) = native.observe_listener_release_for_closing(
                &self.closing_journal,
                &native_proof,
                deadline,
                Some(cancellation.as_ref()),
            ) {
                return Err(closing_staging_release_failure(
                    self,
                    staging_release_kind_from_detail(
                        &detail,
                        ClosingStagingReleaseFailureKind::Listener,
                    ),
                    detail,
                ));
            }
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }

        let observation = match self.owner.staging.cleanup_after_closing(
            &self.closing_journal,
            deadline,
            cancellation.as_ref(),
        ) {
            Ok(observation) => observation,
            Err(error) => {
                return Err(closing_staging_release_failure_for_staging(self, error));
            }
        };
        self.staging_release_proof = Some(observation.clone());
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }

        {
            let native = match self.owner.native.as_mut() {
                Some(native) => native,
                None => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        "Capture runtime native owner was missing after staging release.",
                    ));
                }
            };
            #[cfg(all(test, windows))]
            if self.listener_query_failure_after_staging {
                self.listener_query_failure_after_staging = false;
                native.inject_listener_query_failure_for_test();
            }
            if let Err(detail) = native.observe_listener_release_for_closing(
                &self.closing_journal,
                &native_proof,
                deadline,
                Some(cancellation.as_ref()),
            ) {
                return Err(closing_staging_release_failure(
                    self,
                    staging_release_kind_from_detail(
                        &detail,
                        ClosingStagingReleaseFailureKind::Listener,
                    ),
                    detail,
                ));
            }
        }
        let listener_release_proof =
            match listener_release_proof_for_closing(&self.closing_journal, native_proof) {
                Ok(proof) => proof,
                Err(detail) => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        detail,
                    ));
                }
            };
        #[cfg(all(test, windows))]
        if self.staging_release_cancel_before_authority {
            self.staging_release_cancel_before_authority = false;
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        }
        // The proof builder walks the complete retained root tuple.  Check
        // the shared budget after that bounded observation and immediately
        // before issuing the returned proof.
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }
        self.listener_release_proof = Some(listener_release_proof);
        drop(cleanup_admission);
        Ok((self, observation))
    }

    /// Consume the fully cleaned Closing owner through the final typed
    /// Closing -> Terminal CAS.  Native cleanup and staging release have
    /// already happened; this seam only re-observes their exact identities,
    /// confirms absence, and persists the canonical terminal proof.
    pub(crate) fn terminalize_after_release(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<TerminalizedActivationOwner, TerminalJoinFailure> {
        self.listener_release_proof = None;
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        let native_proof = match self.native_cleanup_proof.clone() {
            Some(proof) => proof,
            None => {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    "Capture runtime terminalization lacked the exact native cleanup proof.",
                ));
            }
        };
        let staging_proof = match self.staging_release_proof.clone() {
            Some(proof) => proof,
            None => {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    "Capture runtime terminalization lacked the exact staging release proof.",
                ));
            }
        };
        if native_proof.activation_failure_only || native_proof.roots.is_empty() {
            return Err(terminal_join_failure(
                self,
                TerminalJoinFailureKind::Validation,
                "Capture runtime terminalization lacked complete native identity proof.",
            ));
        }
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(terminal_join_failure(
                self,
                terminal_join_kind_from_detail(&detail, TerminalJoinFailureKind::Validation),
                detail,
            ));
        }

        // The immutable address index is checked before locking.  The exact
        // full Closing value is then re-read under the same store lock used by
        // the typed terminal CAS; no nested journal read occurs under guard.
        if let Err(detail) = self.owner.staging.revalidate_closing_index_for_cleanup(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(terminal_join_failure(
                self,
                TerminalJoinFailureKind::Validation,
                detail,
            ));
        }
        let admission = match self.owner.staging.begin_closing_cleanup_admission(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(terminal_join_failure_for_admission(self, cause));
            }
        };
        if admission.current() != &self.closing_journal {
            return Err(terminal_join_failure(
                self,
                TerminalJoinFailureKind::Conflict,
                "Capture runtime Closing journal changed before terminal admission.",
            ));
        }
        if let Err(cause) = admission.check_budget() {
            return Err(terminal_join_failure_for_store(self, cause));
        }
        let current = admission.current().clone();

        // Revalidate the retained native identity without terminating again,
        // then take a fresh listener-absence observation for this exact
        // Closing revision.  A foreign rebound remains ambiguous and clears
        // the historical proof for this attempt.
        let fresh_listener_proof = {
            let native = match self.owner.native.as_mut() {
                Some(native) => native,
                None => {
                    return Err(terminal_join_failure(
                        self,
                        TerminalJoinFailureKind::Validation,
                        "Capture runtime native owner was missing during terminalization.",
                    ));
                }
            };
            let retained = match native.validate_closing_binding(&current) {
                Ok(proof) => proof,
                Err(detail) => {
                    return Err(terminal_join_failure(
                        self,
                        TerminalJoinFailureKind::Validation,
                        detail,
                    ));
                }
            };
            if retained != native_proof {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    "Capture runtime retained native cleanup proof changed before terminalization.",
                ));
            }
            if let Err(detail) = native.observe_listener_release_for_closing(
                &current,
                &native_proof,
                deadline,
                Some(cancellation.as_ref()),
            ) {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Listener,
                    detail,
                ));
            }
            listener_release_proof_for_closing(&current, native_proof.clone())
        };
        if let Err(detail) = fresh_listener_proof {
            return Err(terminal_join_failure(
                self,
                terminal_join_kind_from_detail(&detail, TerminalJoinFailureKind::Listener),
                detail,
            ));
        }
        if let Err(cause) = admission.check_budget() {
            return Err(terminal_join_failure_for_store(self, cause));
        }

        if let Err(detail) = self.owner.staging.revalidate_released_scope_for_terminal(
            &staging_proof,
            deadline,
            cancellation.as_ref(),
        ) {
            return Err(terminal_join_failure(
                self,
                TerminalJoinFailureKind::Validation,
                detail,
            ));
        }
        if let Err(cause) = admission.check_budget() {
            return Err(terminal_join_failure_for_store(self, cause));
        }

        let job_binding = match current.job_binding.clone() {
            Some(binding) => binding,
            None => {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    "Capture runtime Closing Job binding was missing during terminalization.",
                ));
            }
        };
        if current.staging_binding.is_none() {
            return Err(terminal_join_failure(
                self,
                TerminalJoinFailureKind::Validation,
                "Capture runtime Closing staging binding was missing during terminalization.",
            ));
        }
        let mut terminal_roots = current.roots.clone();
        for root in &mut terminal_roots {
            root.state = RootState::Terminal;
            root.live_listener_readiness = None;
        }
        let resources = ResourceObservation {
            job_binding,
            staging_binding: current.staging_binding.clone(),
            roots: terminal_roots,
        };
        let proof_generation = match current.journal_revision.checked_add(1) {
            Some(generation) => generation,
            None => {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    "Capture runtime terminal proof generation overflowed.",
                ));
            }
        };
        let proof = TerminalProof {
            root_reaped: true,
            descendants_terminated: true,
            listeners_released: true,
            staging_released: true,
            proof_generation,
            unacquired_root_bindings: Vec::new(),
        };
        let observation = match TerminalObservation::from_resources(&current, resources, proof) {
            Ok(observation) => observation,
            Err(error) => {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    format!("Capture runtime terminal observation was invalid: {error:?}."),
                ));
            }
        };
        let timestamp = match self.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    detail,
                ));
            }
        };
        #[cfg(all(test, windows))]
        if let Some(port) = self.terminal_listener_rebind_after_clock_port.take() {
            match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => self.terminal_foreign_listener = Some(listener),
                Err(error) => {
                    return Err(terminal_join_failure(
                        self,
                        TerminalJoinFailureKind::Listener,
                        format!(
                            "Capture runtime test foreign listener could not rebind port: {error}."
                        ),
                    ));
                }
            }
        }
        if let Err(cause) = admission.check_budget() {
            return Err(terminal_join_failure_for_store(self, cause));
        }

        // The first listener and released-scope observations protect the
        // expensive proof construction above.  Re-observe both after the
        // producer timestamp/candidate has been prepared and immediately
        // before the typed write, while the same journal lock remains held.
        // This closes the final cooperative observation window without
        // claiming an impossible atomic snapshot across Windows and FS I/O.
        let final_listener_proof = {
            let native = match self.owner.native.as_mut() {
                Some(native) => native,
                None => {
                    return Err(terminal_join_failure(
                        self,
                        TerminalJoinFailureKind::Validation,
                        "Capture runtime native owner was missing at the terminal write boundary.",
                    ));
                }
            };
            let retained = match native.validate_closing_binding(&current) {
                Ok(proof) => proof,
                Err(detail) => {
                    return Err(terminal_join_failure(
                        self,
                        TerminalJoinFailureKind::Validation,
                        detail,
                    ));
                }
            };
            if retained != native_proof {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Validation,
                    "Capture runtime retained native cleanup proof changed at the terminal write boundary.",
                ));
            }
            if let Err(detail) = native.observe_listener_release_for_closing(
                &current,
                &native_proof,
                deadline,
                Some(cancellation.as_ref()),
            ) {
                return Err(terminal_join_failure(
                    self,
                    TerminalJoinFailureKind::Listener,
                    detail,
                ));
            }
            listener_release_proof_for_closing(&current, native_proof)
        };
        if let Err(detail) = final_listener_proof {
            return Err(terminal_join_failure(
                self,
                terminal_join_kind_from_detail(&detail, TerminalJoinFailureKind::Listener),
                detail,
            ));
        }
        if let Err(detail) = self.owner.staging.revalidate_released_scope_for_terminal(
            &staging_proof,
            deadline,
            cancellation.as_ref(),
        ) {
            return Err(terminal_join_failure(
                self,
                TerminalJoinFailureKind::Validation,
                detail,
            ));
        }
        if let Err(cause) = admission.check_budget() {
            return Err(terminal_join_failure_for_store(self, cause));
        }
        let result = admission.commit_terminal_owned(observation, timestamp);
        match result.disposition() {
            CasDisposition::Committed => {
                let terminal_journal = result.attempt().cloned().expect("terminal candidate");
                if let Err(detail) = check_native_cleanup_budget(
                    deadline,
                    Some(cancellation.as_ref()),
                ) {
                    return Err(terminal_join_failure_with_candidate(
                        self,
                        TerminalJoinFailureKind::CommittedAfterBudget,
                        format!(
                            "Capture runtime terminal journal committed at revision {} after the authority budget ended ({detail}); terminal authority was withheld for reconciliation.",
                            terminal_journal.journal_revision
                        ),
                        terminal_journal,
                    ));
                }
                Ok(TerminalizedActivationOwner { terminal_journal })
            }
            CasDisposition::ConfirmedLate => {
                let terminal_journal = result.attempt().cloned().expect("late terminal candidate");
                Err(terminal_join_failure_with_candidate(
                    self,
                    TerminalJoinFailureKind::CommittedAfterBudget,
                    format!(
                        "Capture runtime terminal journal committed at revision {} after the authority budget ended; terminal authority was withheld for reconciliation.",
                        terminal_journal.journal_revision
                    ),
                    terminal_journal,
                ))
            }
            CasDisposition::Prewrite | CasDisposition::AmbiguousWrite => Err(
                terminal_join_failure_for_owned(
                    self,
                    result,
                    "Capture runtime terminal journal write remained unconfirmed; terminal authority was withheld for reconciliation.",
                ),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn native_cleanup_proven_for_test(&self) -> bool {
        self.native_cleanup_proof.is_some()
    }

    #[cfg(test)]
    pub(crate) fn listener_release_proven_for_test(&self) -> bool {
        self.listener_release_proof.is_some()
    }

    #[cfg(test)]
    pub(crate) fn native_cleanup_attempts_for_test(&self) -> usize {
        self.owner
            .native
            .as_ref()
            .map_or(0, |native| native.cleanup_attempts)
    }

    #[cfg(test)]
    pub(crate) fn staging_release_proven_for_test(&self) -> bool {
        self.staging_release_proof.is_some()
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_after_staging_for_test(&mut self) {
        self.listener_query_failure_after_staging = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_cancel_before_authority_for_test(&mut self) {
        self.staging_release_cancel_before_authority = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_terminal_listener_rebind_after_clock_for_test(&mut self, port: u16) {
        self.terminal_listener_rebind_after_clock_port = Some(port);
    }

    #[cfg(test)]
    pub(crate) fn release_terminal_foreign_listener_for_test(&mut self) {
        self.terminal_foreign_listener = None;
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_delete_failure_at_for_test(&self, mutation: usize) {
        self.owner
            .staging
            .inject_release_delete_failure_at_for_test(mutation);
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_cancel_after_delete_at_for_test(&self, mutation: usize) {
        self.owner
            .staging
            .inject_release_cancel_after_delete_at_for_test(mutation);
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_entry_limit_for_test(&self, limit: usize) {
        self.owner
            .staging
            .inject_release_entry_limit_for_test(limit);
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_depth_limit_for_test(&self, limit: usize) {
        self.owner
            .staging
            .inject_release_depth_limit_for_test(limit);
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_query_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_native_cleanup_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_cleanup_failure_after_first_for_test();
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_job_termination_failure_for_test(&mut self) {
        self.owner.inject_job_termination_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_cancellation_after_native_cleanup_root_for_test(
        &mut self,
        ordinal: usize,
    ) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_cancellation_after_cleanup_root_for_test(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn closing_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.closing_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }
}
