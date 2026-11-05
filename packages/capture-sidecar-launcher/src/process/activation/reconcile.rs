use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use crate::{
    journal::{JournalRoot, JournalState, RootState, RuntimeSessionJournalV1},
    journal_store::{
        install_running_read_budget, ActivationBudget, CasDisposition, JournalStoreError,
        OwnedCasResult,
    },
};

#[cfg(windows)]
use super::failure::ActivationFailureJournalContext;

#[cfg(windows)]
use super::closing::{ClosingActivationOwner, TerminalizedActivationOwner};
#[cfg(windows)]
use super::running::RunningActivationOwner;
#[cfg(windows)]
use super::suspended::SuspendedActivationOwner;
#[cfg(windows)]
use crate::process::error::{
    cleanup_error_from_native, cleanup_error_from_staging, cleanup_error_from_terminal,
    cleanup_error_from_transition, CleanupError, CleanupErrorKind, CleanupFailureOwner,
    CleanupPhase, GroupLifecycleState, GroupProof,
};

pub(crate) fn record_owned_cas_context(
    context: &mut ActivationFailureJournalContext,
    outcome: &OwnedCasResult,
) {
    if outcome.disposition() == CasDisposition::Prewrite {
        return;
    }
    context.predecessor = outcome.predecessor().clone();
    context.candidate = outcome
        .attempt()
        .cloned()
        .unwrap_or_else(|| outcome.predecessor().clone());
    context.disposition = outcome.disposition();
}

// Durable evidence survives later authority/admission failure. Only the exact
// retained attempt can retire ambiguity; a disk snapshot cannot invent one.
#[cfg(windows)]
pub(crate) fn confirm_retained_candidate(
    context: &mut Option<ActivationFailureJournalContext>,
    current: &RuntimeSessionJournalV1,
) {
    if let Some(context) = context.as_mut() {
        if context.candidate == *current && context.disposition == CasDisposition::AmbiguousWrite {
            context.disposition = CasDisposition::ConfirmedLate;
        }
    }
}

#[cfg(windows)]
pub(crate) fn pending_successor(
    context: &Option<ActivationFailureJournalContext>,
    baseline: &RuntimeSessionJournalV1,
    state: JournalState,
) -> (Option<RuntimeSessionJournalV1>, Option<CasDisposition>) {
    context
        .as_ref()
        .filter(|context| {
            context.predecessor == *baseline
                && context.candidate != *baseline
                && context.candidate.state == state
        })
        .map(|context| (Some(context.candidate.clone()), Some(context.disposition)))
        .unwrap_or((None, None))
}

#[cfg(windows)]
#[cfg(windows)]
pub(crate) struct ReconciledActivationOwner {
    pub(crate) journal: RuntimeSessionJournalV1,
    pub(crate) owner: SuspendedActivationOwner,
}

impl ReconciledActivationOwner {
    #[cfg(test)]
    pub(crate) fn journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.journal
    }

    #[cfg(test)]
    pub(crate) fn owner_for_test(&self) -> &SuspendedActivationOwner {
        &self.owner
    }
}

/// The private owner returned by the connected activation seam.  Native
/// acquisition and staging stay together so a partial group can never lose
/// either cleanup authority.  `native_cleanup_proven` means that no native
/// owner remains because its proof already succeeded; a later staging retry
/// must not reconstruct or re-run that proof.

#[cfg(windows)]
pub(crate) fn read_back_reconciled_activation(
    owner: ReconciledActivationOwner,
    budget: &ActivationBudget,
) -> Result<(), ReconciledActivationOwner> {
    if budget.check().is_err() {
        return Err(owner);
    }
    let Some(context) = owner.owner.failure_context.as_ref() else {
        return Err(owner);
    };
    if owner
        .owner
        .staging
        .validate_reconcile_retained_scope(budget.deadline(), budget.cancellation())
        .is_err()
    {
        return Err(owner);
    }
    let _read_budget = budget.install_read_scope();
    let current = match context
        .store
        .read_exact_durable(&context.plan, &owner.journal)
    {
        Ok(current) => current,
        Err(_) => return Err(owner),
    };
    if current != owner.journal
        || current.state != JournalState::ReconcileRequired
        || current.validate_against_plan(&context.plan).is_err()
        || budget.check().is_err()
    {
        return Err(owner);
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn close_running_owner(
    owner: RunningActivationOwner,
    deadline: std::time::Instant,
    cancellation: Arc<AtomicBool>,
) -> Result<GroupProof, CleanupError> {
    let closing =
        match owner.begin_closing_with_cancellation(deadline, Some(Arc::clone(&cancellation))) {
            Ok(owner) => owner,
            Err(failure) => return Err(cleanup_error_from_transition(failure)),
        };
    close_closing_owner(closing, CleanupPhase::Closing, None, deadline, cancellation)
}

#[cfg(windows)]
pub(crate) fn close_closing_owner(
    mut owner: ClosingActivationOwner,
    phase: CleanupPhase,
    committed_candidate: Option<RuntimeSessionJournalV1>,
    deadline: std::time::Instant,
    cancellation: Arc<AtomicBool>,
) -> Result<GroupProof, CleanupError> {
    if let Some(candidate) = committed_candidate {
        let retained_candidate = candidate.clone();
        return project_known_terminal_candidate(&mut owner, candidate, deadline, &cancellation)
            .map_err(|kind| CleanupError {
                kind,
                phase: CleanupPhase::TerminalCommittedAfterBudget,
                owner: Some(CleanupFailureOwner::Closing {
                    owner,
                    phase: CleanupPhase::TerminalCommittedAfterBudget,
                    committed_candidate: Some(retained_candidate),
                }),
            });
    }

    let owner = if phase == CleanupPhase::Closing {
        match owner
            .cleanup_native_and_observe_listener_release(deadline, Some(Arc::clone(&cancellation)))
        {
            Ok(owner) => owner,
            Err(failure) => return Err(cleanup_error_from_native(failure)),
        }
    } else {
        owner
    };
    let (owner, _) = if owner.staging_release_proof.is_none()
        && (phase == CleanupPhase::Closing || phase == CleanupPhase::NativeCleaned)
    {
        match owner.release_staging_after_native_cleanup(deadline, Some(Arc::clone(&cancellation)))
        {
            Ok(result) => result,
            Err(failure) => return Err(cleanup_error_from_staging(failure)),
        }
    } else {
        let proof = owner.staging_release_proof.clone().expect("staging proof");
        (owner, proof)
    };
    match owner.terminalize_after_release(deadline, Some(cancellation)) {
        Ok(terminal) => Ok(project_terminal_owner(terminal)),
        Err(failure) => Err(cleanup_error_from_terminal(failure)),
    }
}

#[cfg(windows)]
pub(crate) fn project_terminal_owner(owner: TerminalizedActivationOwner) -> GroupProof {
    let journal = owner.terminal_journal;
    let proof = journal.proof.expect("validated terminal proof");
    GroupProof {
        state: GroupLifecycleState::Terminal,
        root_count: journal.roots.len() + proof.unacquired_root_bindings.len(),
        root_reaped: proof.root_reaped,
        descendants_terminated: proof.descendants_terminated,
        listeners_released: proof.listeners_released,
        staging_released: proof.staging_released,
    }
}

#[cfg(windows)]
pub(crate) fn map_cleanup_store_kind(error: &JournalStoreError) -> CleanupErrorKind {
    match error {
        JournalStoreError::AdmissionCancelled => CleanupErrorKind::Cancelled,
        JournalStoreError::AdmissionDeadline => CleanupErrorKind::Deadline,
        JournalStoreError::Conflict => CleanupErrorKind::Conflict,
        JournalStoreError::Journal(_) | JournalStoreError::CorruptJournal => {
            CleanupErrorKind::Validation
        }
        JournalStoreError::UnsupportedPlatform => CleanupErrorKind::Unsupported,
        _ => CleanupErrorKind::Storage,
    }
}

#[cfg(windows)]
pub(crate) fn adopt_known_closing_candidate(
    mut owner: RunningActivationOwner,
    candidate: RuntimeSessionJournalV1,
    budget: &ActivationBudget,
) -> Result<ClosingActivationOwner, CleanupError> {
    if budget.check().is_err() {
        return Err(cleanup_error_for_known_closing_candidate(
            owner,
            candidate,
            CleanupErrorKind::Deadline,
        ));
    }
    let Some(context) = owner.owner.failure_context.as_ref() else {
        return Err(cleanup_error_for_known_closing_candidate(
            owner,
            candidate,
            CleanupErrorKind::InvalidState,
        ));
    };
    let expected = &owner.running_journal;
    let valid_shape = candidate.state == JournalState::Closing
        && candidate.schema_version == expected.schema_version
        && candidate.producer == expected.producer
        && candidate.session_nonce == expected.session_nonce
        && candidate.plan_digest == expected.plan_digest
        && candidate.created_at == expected.created_at
        && candidate.binding == expected.binding
        && candidate.job_binding == expected.job_binding
        && candidate.staging_binding == expected.staging_binding
        && candidate.recovery_epoch == expected.recovery_epoch
        && candidate.attempt == expected.attempt
        && expected
            .journal_revision
            .checked_add(1)
            .is_some_and(|revision| candidate.journal_revision == revision)
        && candidate.roots.len() == expected.roots.len()
        && candidate
            .roots
            .iter()
            .zip(&expected.roots)
            .all(|(root, prior)| {
                same_root_identity(root, prior)
                    && root.state == RootState::Closing
                    && root.live_listener_readiness == prior.live_listener_readiness
            })
        && candidate.proof.is_none()
        && candidate.validate_against_plan(&context.plan).is_ok();
    if !valid_shape {
        return Err(cleanup_error_for_known_closing_candidate(
            owner,
            candidate,
            CleanupErrorKind::Conflict,
        ));
    }
    let store = Arc::clone(&context.store);
    let plan = context.plan.clone();
    let _read_budget = budget.install_read_scope();
    let current = match store.read_durable(&plan) {
        Ok(current) => current,
        Err(error) => {
            return Err(cleanup_error_for_known_closing_candidate(
                owner,
                candidate,
                map_cleanup_store_kind(&error),
            ))
        }
    };
    if current == candidate {
        confirm_retained_candidate(&mut owner.owner.failure_context, &current);
        if budget.check().is_err() {
            return Err(cleanup_error_for_known_closing_candidate(
                owner,
                candidate,
                CleanupErrorKind::Deadline,
            ));
        }
        if let Some(context) = owner.owner.failure_context.as_mut() {
            context.candidate = candidate.clone();
        }
        return Ok(ClosingActivationOwner {
            owner: owner.owner,
            closing_journal: candidate,
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
        });
    }
    if context.disposition != CasDisposition::AmbiguousWrite
        || context.candidate != candidate
        || current != *expected
        || current.validate_against_plan(&plan).is_err()
    {
        return Err(cleanup_error_for_known_closing_candidate(
            owner,
            candidate,
            CleanupErrorKind::Conflict,
        ));
    }
    drop(_read_budget);

    // The durable record is still the exact predecessor. Permit one fresh
    // Running -> Closing CAS using the same absolute retry budget. A CAS that
    // reports an ambiguous replacement contributes its newer exact candidate
    // through the normal transition failure path.
    let cancellation = budget.cancellation_arc();
    match owner.begin_closing_with_cancellation(budget.deadline(), Some(cancellation)) {
        Ok(closing) => Ok(closing),
        Err(failure) => Err(cleanup_error_from_transition(failure)),
    }
}

#[cfg(windows)]
pub(crate) fn cleanup_error_for_known_closing_candidate(
    owner: RunningActivationOwner,
    candidate: RuntimeSessionJournalV1,
    kind: CleanupErrorKind,
) -> CleanupError {
    CleanupError {
        kind,
        phase: CleanupPhase::Running,
        owner: Some(CleanupFailureOwner::Running {
            owner,
            committed_candidate: Some(candidate),
        }),
    }
}

#[cfg(windows)]
pub(crate) fn project_known_terminal_candidate(
    owner: &mut ClosingActivationOwner,
    candidate: RuntimeSessionJournalV1,
    deadline: std::time::Instant,
    cancellation: &Arc<AtomicBool>,
) -> Result<GroupProof, CleanupErrorKind> {
    if cancellation.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
        return Err(CleanupErrorKind::Deadline);
    }
    let Some(context) = owner.owner.failure_context.as_ref() else {
        return Err(CleanupErrorKind::InvalidState);
    };
    if !terminal_candidate_shape_is_valid(owner, &candidate) {
        return Err(CleanupErrorKind::Conflict);
    }
    let _read_budget = install_running_read_budget(deadline, Arc::clone(cancellation));
    let current = context
        .store
        .read_exact_durable(&context.plan, &candidate)
        .map_err(|error| map_cleanup_store_kind(&error))?;
    // read_exact_durable already validated the complete record under the lock.
    confirm_retained_candidate(&mut owner.owner.failure_context, &current);
    // Reading and validating the complete candidate can consume the remaining
    // authority budget. Recheck immediately before projecting GroupProof so a
    // late readback never grants terminal authority; the caller retains this
    // exact candidate for a fresh retry and issues no second Terminal CAS.
    if cancellation.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
        return Err(CleanupErrorKind::Deadline);
    }
    let proof = candidate.proof.as_ref().expect("validated proof");
    Ok(GroupProof {
        state: GroupLifecycleState::Terminal,
        root_count: candidate.roots.len() + proof.unacquired_root_bindings.len(),
        root_reaped: proof.root_reaped,
        descendants_terminated: proof.descendants_terminated,
        listeners_released: proof.listeners_released,
        staging_released: proof.staging_released,
    })
}

#[cfg(windows)]
pub(crate) fn terminal_candidate_shape_is_valid(
    owner: &ClosingActivationOwner,
    candidate: &RuntimeSessionJournalV1,
) -> bool {
    candidate.state == JournalState::Terminal
        && candidate.schema_version == owner.closing_journal.schema_version
        && candidate.producer == owner.closing_journal.producer
        && candidate.session_nonce == owner.closing_journal.session_nonce
        && candidate.plan_digest == owner.closing_journal.plan_digest
        && candidate.created_at == owner.closing_journal.created_at
        && candidate.binding == owner.closing_journal.binding
        && candidate.job_binding == owner.closing_journal.job_binding
        && candidate.staging_binding == owner.closing_journal.staging_binding
        && candidate.recovery_epoch == owner.closing_journal.recovery_epoch
        && candidate.attempt == owner.closing_journal.attempt
        && owner
            .closing_journal
            .journal_revision
            .checked_add(1)
            .is_some_and(|revision| candidate.journal_revision == revision)
        && candidate.roots.len() == owner.closing_journal.roots.len()
        && candidate
            .roots
            .iter()
            .zip(&owner.closing_journal.roots)
            .all(|(root, prior)| {
                same_root_identity(root, prior)
                    && root.state == RootState::Terminal
                    && root.live_listener_readiness.is_none()
            })
        && candidate.proof.as_ref().is_some_and(|proof| {
            proof.root_reaped
                && proof.descendants_terminated
                && proof.listeners_released
                && proof.staging_released
        })
}

#[cfg(windows)]
pub(crate) fn same_root_identity(left: &JournalRoot, right: &JournalRoot) -> bool {
    left.ordinal == right.ordinal
        && left.role == right.role
        && left.root_ref_digest == right.root_ref_digest
        && left.root_generation == right.root_generation
        && left.root_nonce == right.root_nonce
        && left.pid == right.pid
        && left.creation_identity == right.creation_identity
        && left.reserved_listener_identity == right.reserved_listener_identity
        && left.loopback_port == right.loopback_port
        && left.started_at == right.started_at
}

#[cfg(windows)]
pub(crate) fn retry_known_terminal_candidate(
    mut owner: ClosingActivationOwner,
    candidate: RuntimeSessionJournalV1,
    budget: &ActivationBudget,
) -> Result<GroupProof, CleanupError> {
    if budget.check().is_err() {
        return Err(cleanup_error_for_known_terminal_candidate(
            owner,
            candidate,
            CleanupErrorKind::Deadline,
        ));
    }
    if !terminal_candidate_shape_is_valid(&owner, &candidate) {
        return Err(cleanup_error_for_known_terminal_candidate(
            owner,
            candidate,
            CleanupErrorKind::Conflict,
        ));
    }
    let Some(context) = owner.owner.failure_context.as_ref() else {
        return Err(cleanup_error_for_known_terminal_candidate(
            owner,
            candidate,
            CleanupErrorKind::InvalidState,
        ));
    };
    let store = Arc::clone(&context.store);
    let plan = context.plan.clone();
    let _read_budget = budget.install_read_scope();
    let current = match store.read_durable(&plan) {
        Ok(current) => current,
        Err(error) => {
            return Err(cleanup_error_for_known_terminal_candidate(
                owner,
                candidate,
                map_cleanup_store_kind(&error),
            ))
        }
    };
    if current == candidate {
        confirm_retained_candidate(&mut owner.owner.failure_context, &current);
        drop(_read_budget);
        return project_known_terminal_candidate(
            &mut owner,
            candidate.clone(),
            budget.deadline(),
            &budget.cancellation_arc(),
        )
        .map_err(|kind| cleanup_error_for_known_terminal_candidate(owner, candidate, kind));
    }
    if context.disposition != CasDisposition::AmbiguousWrite
        || context.candidate != candidate
        || current != owner.closing_journal
        || current.validate_against_plan(&plan).is_err()
    {
        return Err(cleanup_error_for_known_terminal_candidate(
            owner,
            candidate,
            CleanupErrorKind::Conflict,
        ));
    }
    drop(_read_budget);

    // The predecessor is still exactly Closing. Permit one fresh Closing ->
    // Terminal CAS, which rechecks native/listener/staging proof through the
    // normal private seam. A Terminal record is never written from a
    // Terminal predecessor and a known Terminal candidate is only projected
    // after its complete read-back and final budget check above.
    let cancellation = budget.cancellation_arc();
    match owner.terminalize_after_release(budget.deadline(), Some(cancellation)) {
        Ok(terminal) => Ok(project_terminal_owner(terminal)),
        Err(failure) => Err(cleanup_error_from_terminal(failure)),
    }
}

#[cfg(windows)]
pub(crate) fn cleanup_error_for_known_terminal_candidate(
    owner: ClosingActivationOwner,
    candidate: RuntimeSessionJournalV1,
    kind: CleanupErrorKind,
) -> CleanupError {
    let phase = owner
        .owner
        .failure_context
        .as_ref()
        .filter(|context| context.candidate == candidate)
        .map(|context| match context.disposition {
            CasDisposition::AmbiguousWrite => CleanupPhase::StagingReleased,
            CasDisposition::ConfirmedLate => CleanupPhase::TerminalCommittedAfterBudget,
            CasDisposition::Prewrite | CasDisposition::Committed => CleanupPhase::StagingReleased,
        })
        .unwrap_or(CleanupPhase::TerminalCommittedAfterBudget);
    CleanupError {
        kind,
        phase,
        owner: Some(CleanupFailureOwner::Closing {
            owner,
            phase,
            committed_candidate: Some(candidate),
        }),
    }
}

#[cfg(windows)]
pub(crate) fn retry_cleanup_error(error: CleanupError) -> Result<GroupProof, CleanupError> {
    let CleanupError { kind, phase, owner } = error;
    let Some(owner) = owner else {
        return Err(CleanupError {
            kind,
            phase,
            owner: None,
        });
    };
    let cancellation = Arc::new(AtomicBool::new(false));
    let budget = ActivationBudget::new(
        std::time::Instant::now() + std::time::Duration::from_secs(60),
        Arc::clone(&cancellation),
    );
    match owner {
        CleanupFailureOwner::Running {
            owner,
            committed_candidate,
        } => {
            if let Some(candidate) = committed_candidate {
                match adopt_known_closing_candidate(owner, candidate.clone(), &budget) {
                    Ok(closing) => close_closing_owner(
                        closing,
                        CleanupPhase::Closing,
                        None,
                        budget.deadline(),
                        cancellation,
                    ),
                    Err(error) => Err(error),
                }
            } else {
                close_running_owner(owner, budget.deadline(), cancellation)
            }
        }
        CleanupFailureOwner::Closing {
            owner,
            phase,
            committed_candidate,
        } => {
            if phase == CleanupPhase::TerminalCommittedAfterBudget
                || (phase == CleanupPhase::StagingReleased
                    && committed_candidate
                        .as_ref()
                        .is_some_and(|candidate| candidate.state == JournalState::Terminal))
            {
                let Some(candidate) = committed_candidate else {
                    return Err(CleanupError {
                        kind: CleanupErrorKind::InvalidState,
                        phase,
                        owner: Some(CleanupFailureOwner::Closing {
                            owner,
                            phase,
                            committed_candidate: None,
                        }),
                    });
                };
                return retry_known_terminal_candidate(owner, candidate, &budget);
            }
            close_closing_owner(owner, phase, None, budget.deadline(), cancellation)
        }
    }
}
