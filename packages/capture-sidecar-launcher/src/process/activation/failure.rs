use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use crate::{
    journal::{JournalPlanValue, JournalState, RuntimeSessionJournalV1},
    journal_store::{
        ActivationBudget, CasDisposition, ClosingCasError, JournalStore, JournalStoreError,
        OwnedCasResult, RunningCasError,
    },
    staging::{StagingCleanupError, StagingFailureKind},
};

#[cfg(windows)]
use super::cancellation_requested;
use super::closing::ClosingActivationOwner;
#[cfg(windows)]
use super::group::{
    native_nonce_text, NativeCleanupProof, NativeListenerReleaseProof, SuspendedGroup,
};
#[cfg(windows)]
use super::launching::LaunchingActivationOwner;
#[cfg(windows)]
use super::reconcile::{pending_successor, record_owned_cas_context, ReconciledActivationOwner};
#[cfg(windows)]
use super::running::RunningActivationOwner;
#[cfg(windows)]
use super::suspended::{ActivationLaunchOwner, SuspendedActivationOwner};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupNativeFailureKind {
    Setup,
    Spawn,
    Identity,
    Assignment,
    Membership,
    Resume,
}

/// Read-only restart observations.  These values deliberately contain no
/// native handles or identifiers; the producer-owned journal remains the
/// authority for the identities being checked.
#[cfg(windows)]
#[cfg(windows)]
pub(crate) struct GroupNativeFailure {
    pub(crate) kind: GroupNativeFailureKind,
    pub(crate) detail: String,
    pub(crate) owner: Option<SuspendedGroup>,
}

/// The immutable journal context retained alongside a native owner.  Staging
/// owns the activation context itself; keeping the exact predecessor and
/// attempted candidate here lets a private failure path perform a full
/// candidate reconcile decision without reopening a later record or
/// reconstructing a permit.
#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct ActivationFailureJournalContext {
    pub(crate) store: Arc<JournalStore>,
    pub(crate) plan: JournalPlanValue,
    pub(crate) predecessor: RuntimeSessionJournalV1,
    pub(crate) candidate: RuntimeSessionJournalV1,
    pub(crate) disposition: CasDisposition,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivationReconcileFailureKind {
    Cleanup,
    Deadline,
    Conflict,
    Storage,
    Validation,
}

#[cfg(windows)]
pub(crate) struct ActivationReconcileFailure {
    pub(crate) kind: ActivationReconcileFailureKind,
    #[cfg(test)]
    pub(crate) detail: String,
    pub(crate) owner: SuspendedActivationOwner,
    pub(crate) committed_candidate: Option<RuntimeSessionJournalV1>,
    #[cfg(test)]
    pub(crate) candidate_disposition: Option<CasDisposition>,
}

#[cfg(windows)]
impl ActivationReconcileFailure {}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SuspendedActivationFailureKind {
    Staging,
    Native(GroupNativeFailureKind),
    Journal,
    Cancellation,
    Deadline,
}

#[cfg(windows)]
pub(crate) struct SuspendedActivationFailure {
    pub(crate) kind: SuspendedActivationFailureKind,
    pub(crate) detail: String,
    pub(crate) owner: Option<SuspendedActivationOwner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingCleanupFailureKind {
    Cancelled,
    Deadline,
    Native,
    Listener,
    Validation,
}

#[cfg(windows)]
pub(crate) struct ClosingCleanupFailure {
    pub(crate) kind: ClosingCleanupFailureKind,
    #[cfg(test)]
    pub(crate) detail: String,
    pub(crate) owner: ClosingActivationOwner,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingStagingReleaseFailureKind {
    Cancelled,
    Deadline,
    Listener,
    Validation,
    Storage,
}

#[cfg(windows)]
pub(crate) struct ClosingStagingReleaseFailure {
    pub(crate) kind: ClosingStagingReleaseFailureKind,
    #[cfg(test)]
    pub(crate) detail: String,
    pub(crate) owner: ClosingActivationOwner,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalJoinFailureKind {
    Cancelled,
    Deadline,
    Listener,
    Conflict,
    Storage,
    Validation,
    CommittedAfterBudget,
}

#[cfg(windows)]
pub(crate) struct TerminalJoinFailure {
    pub(crate) kind: TerminalJoinFailureKind,
    pub(crate) detail: String,
    pub(crate) owner: ClosingActivationOwner,
    /// The exact Terminal value when the final CAS committed after the
    /// authority budget. Retry validates this value by full read-back and
    /// never issues another Terminal CAS.
    pub(crate) committed_candidate: Option<RuntimeSessionJournalV1>,
    pub(crate) candidate_disposition: Option<CasDisposition>,
}

#[cfg(windows)]
impl TerminalJoinFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> ClosingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> TerminalJoinFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }
}

#[cfg(windows)]
impl ClosingStagingReleaseFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> ClosingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> ClosingStagingReleaseFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }
}

#[cfg(windows)]
impl ClosingCleanupFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> ClosingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> ClosingCleanupFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingTransitionFailureKind {
    Cancelled,
    Deadline,
    Conflict,
    Storage,
    Validation,
}

#[cfg(windows)]
pub(crate) struct ClosingTransitionFailure {
    pub(crate) kind: ClosingTransitionFailureKind,
    #[cfg(test)]
    pub(crate) detail: String,
    pub(crate) owner: RunningActivationOwner,
    /// The exact Closing value when the CAS committed before authority was
    /// withheld. Retry adopts it only after full read-back, without a second
    /// CAS.
    pub(crate) committed_candidate: Option<RuntimeSessionJournalV1>,
    #[cfg(test)]
    pub(crate) candidate_disposition: Option<CasDisposition>,
}

#[cfg(windows)]
impl ClosingTransitionFailure {
    #[cfg(test)]
    pub(crate) fn candidate_disposition_for_test(&self) -> Option<CasDisposition> {
        self.candidate_disposition
    }

    #[cfg(test)]
    pub(crate) fn into_owner(self) -> RunningActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> ClosingTransitionFailureKind {
        self.kind
    }
}

/// Every promotion failure retains the Launching owner.  In particular, a
/// store error after an atomic replacement is never inferred to have produced
/// a valid Running authority from a later read.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunningPromotionFailureKind {
    Cancelled,
    Deadline,
    NotReady,
    Storage,
    Validation,
}

#[cfg(windows)]
pub(crate) struct RunningPromotionFailure {
    pub(crate) kind: RunningPromotionFailureKind,
    pub(crate) detail: String,
    pub(crate) owner: LaunchingActivationOwner,
    /// The exact Running record returned by a durable CAS whose final budget
    /// check failed.  This is retained privately so reconciliation can use the
    /// known candidate without reopening arbitrary disk state.
    pub(crate) committed_candidate: Option<RuntimeSessionJournalV1>,
    pub(crate) candidate_disposition: Option<CasDisposition>,
}

#[cfg(windows)]

impl RunningPromotionFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> LaunchingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> RunningPromotionFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn committed_candidate_for_test(&self) -> Option<&RuntimeSessionJournalV1> {
        self.committed_candidate.as_ref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivationLaunchFailureKind {
    Cancellation,
    Deadline,
    Staging,
    Journal,
    Native(GroupNativeFailureKind),
}

#[cfg(windows)]
pub(crate) struct ActivationLaunchFailure {
    pub(crate) kind: ActivationLaunchFailureKind,
    pub(crate) detail: String,
    pub(crate) owner: Option<ActivationLaunchOwner>,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrivateActivationFailureKind {
    Preparation,
    Staging,
    Native,
    Journal,
    Cancellation,
    Deadline,
    Reconcile,
}

#[cfg(windows)]
pub(crate) enum PrivateActivationFailureOwner {
    Suspended(SuspendedActivationOwner),
    Reconciled(ReconciledActivationOwner),
}

#[cfg(windows)]
pub(crate) struct PrivateActivationFailure {
    pub(crate) kind: PrivateActivationFailureKind,
    #[cfg(test)]
    pub(crate) detail: String,
    pub(crate) owner: Option<PrivateActivationFailureOwner>,
    pub(crate) committed_candidate: Option<RuntimeSessionJournalV1>,
}

#[cfg(windows)]
impl PrivateActivationFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> Option<PrivateActivationFailureOwner> {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> PrivateActivationFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }

    #[cfg(test)]
    pub(crate) fn committed_candidate_for_test(&self) -> Option<&RuntimeSessionJournalV1> {
        self.committed_candidate.as_ref()
    }
}

#[cfg(windows)]
/// Private producer activation coordinator.  Every failed owned phase closes
/// the whole native Job and attempts the exact ReconcileRequired CAS under

#[cfg(windows)]
pub(crate) fn private_failure_from_running_promotion_failure(
    failure: RunningPromotionFailure,
    budget: &ActivationBudget,
) -> PrivateActivationFailure {
    let RunningPromotionFailure {
        kind,
        detail,
        mut owner,
        committed_candidate,
        candidate_disposition,
    } = failure;
    // A late Running CAS can leave the durable state one phase ahead of the
    // retained Launching owner.  Install that exact candidate before forced
    // native cleanup and reconciliation; never reopen an arbitrary disk
    // record to infer authority.
    if let Some(candidate) = committed_candidate {
        if let Some(context) = owner.owner.failure_context.as_mut() {
            context.candidate = candidate;
            context.disposition = candidate_disposition.unwrap_or(CasDisposition::ConfirmedLate);
        }
    }
    let kind = match kind {
        RunningPromotionFailureKind::Cancelled => PrivateActivationFailureKind::Cancellation,
        RunningPromotionFailureKind::Deadline => PrivateActivationFailureKind::Deadline,
        RunningPromotionFailureKind::Storage => PrivateActivationFailureKind::Journal,
        RunningPromotionFailureKind::NotReady | RunningPromotionFailureKind::Validation => {
            PrivateActivationFailureKind::Native
        }
    };
    private_failure_after_cleanup(kind, detail, owner.owner, budget)
}

#[cfg(windows)]
pub(crate) fn private_failure_from_suspended_failure(
    failure: SuspendedActivationFailure,
    budget: &ActivationBudget,
) -> PrivateActivationFailure {
    let kind = match failure.kind {
        SuspendedActivationFailureKind::Staging => PrivateActivationFailureKind::Staging,
        SuspendedActivationFailureKind::Native(_) => PrivateActivationFailureKind::Native,
        SuspendedActivationFailureKind::Journal => PrivateActivationFailureKind::Journal,
        SuspendedActivationFailureKind::Cancellation => PrivateActivationFailureKind::Cancellation,
        SuspendedActivationFailureKind::Deadline => PrivateActivationFailureKind::Deadline,
    };
    let detail = failure.detail;
    let Some(owner) = failure.owner else {
        return PrivateActivationFailure {
            kind,
            #[cfg(test)]
            detail,
            owner: None,
            committed_candidate: None,
        };
    };
    private_failure_after_cleanup(kind, detail, owner, budget)
}

#[cfg(windows)]
pub(crate) fn private_failure_from_launch_failure(
    failure: ActivationLaunchFailure,
    budget: &ActivationBudget,
) -> PrivateActivationFailure {
    let kind = match failure.kind {
        ActivationLaunchFailureKind::Cancellation => PrivateActivationFailureKind::Cancellation,
        ActivationLaunchFailureKind::Deadline => PrivateActivationFailureKind::Deadline,
        ActivationLaunchFailureKind::Staging => PrivateActivationFailureKind::Staging,
        ActivationLaunchFailureKind::Native(_) => PrivateActivationFailureKind::Native,
        ActivationLaunchFailureKind::Journal => PrivateActivationFailureKind::Journal,
    };
    let detail = failure.detail;
    let Some(owner) = failure.owner else {
        return PrivateActivationFailure {
            kind,
            #[cfg(test)]
            detail,
            owner: None,
            committed_candidate: None,
        };
    };
    match owner {
        ActivationLaunchOwner::Ready(owner) => {
            private_failure_after_cleanup(kind, detail, owner.owner, budget)
        }
        ActivationLaunchOwner::Launching(owner) => {
            private_failure_after_cleanup(kind, detail, owner.owner, budget)
        }
    }
}

#[cfg(windows)]
pub(crate) fn private_failure_after_cleanup(
    original_kind: PrivateActivationFailureKind,
    #[cfg_attr(not(test), allow(unused_variables))] detail: String,
    owner: SuspendedActivationOwner,
    budget: &ActivationBudget,
) -> PrivateActivationFailure {
    match owner.cleanup_and_reconcile(budget) {
        Ok(reconciled) => PrivateActivationFailure {
            kind: original_kind,
            #[cfg(test)]
            detail,
            owner: Some(PrivateActivationFailureOwner::Reconciled(reconciled)),
            committed_candidate: None,
        },
        Err(failure) => PrivateActivationFailure {
            kind: PrivateActivationFailureKind::Reconcile,
            #[cfg(test)]
            detail: format!(
                "{detail} Activation cleanup/reconcile remained owned: {}.",
                failure.detail
            ),
            owner: Some(PrivateActivationFailureOwner::Suspended(failure.owner)),
            committed_candidate: failure.committed_candidate,
        },
    }
}

#[cfg(windows)]
impl ActivationLaunchFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> Option<ActivationLaunchOwner> {
        self.owner
    }
}

#[cfg(windows)]
impl SuspendedActivationFailure {
    #[cfg(test)]
    pub(crate) fn into_owner(self) -> Option<SuspendedActivationOwner> {
        self.owner
    }
}

#[cfg(windows)]
pub(crate) fn closing_cleanup_failure(
    owner: ClosingActivationOwner,
    detail: impl Into<String>,
) -> ClosingCleanupFailure {
    let detail = detail.into();
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        ClosingCleanupFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        ClosingCleanupFailureKind::Deadline
    } else if lower.contains("listener") {
        ClosingCleanupFailureKind::Listener
    } else if lower.contains("native")
        || lower.contains("job")
        || lower.contains("process")
        || lower.contains("cleanup")
    {
        ClosingCleanupFailureKind::Native
    } else {
        ClosingCleanupFailureKind::Validation
    };
    ClosingCleanupFailure {
        kind,
        #[cfg(test)]
        detail,
        owner,
    }
}

#[cfg(windows)]
pub(crate) fn closing_cleanup_failure_for_admission(
    owner: ClosingActivationOwner,
    cause: ClosingCasError,
) -> ClosingCleanupFailure {
    let kind = match cause {
        ClosingCasError::Cancelled => ClosingCleanupFailureKind::Cancelled,
        ClosingCasError::Deadline => ClosingCleanupFailureKind::Deadline,
        // A conflict means the exact Closing tuple was stale before any
        // native operation.  Keep this distinct from native cleanup/storage
        // failures so callers can reconcile the foreign journal safely.
        ClosingCasError::Conflict => ClosingCleanupFailureKind::Validation,
        ClosingCasError::Storage => ClosingCleanupFailureKind::Native,
    };
    #[cfg_attr(not(test), allow(unused_variables))]
    let detail = match cause {
        ClosingCasError::Cancelled => {
            "Capture runtime Closing cleanup admission was cancelled before native cleanup."
        }
        ClosingCasError::Deadline => {
            "Capture runtime Closing cleanup admission expired before native cleanup."
        }
        ClosingCasError::Conflict => {
            "Capture runtime Closing cleanup admission found a stale journal snapshot."
        }
        ClosingCasError::Storage => {
            "Capture runtime Closing cleanup admission could not read its exact snapshot."
        }
    };
    ClosingCleanupFailure {
        kind,
        #[cfg(test)]
        detail: detail.into(),
        owner,
    }
}

#[cfg(windows)]
pub(crate) fn closing_staging_release_failure(
    owner: ClosingActivationOwner,
    kind: ClosingStagingReleaseFailureKind,
    #[cfg_attr(not(test), allow(unused_variables))] detail: impl Into<String>,
) -> ClosingStagingReleaseFailure {
    ClosingStagingReleaseFailure {
        kind,
        #[cfg(test)]
        detail: detail.into(),
        owner,
    }
}

#[cfg(windows)]
pub(crate) fn closing_staging_release_failure_for_staging(
    owner: ClosingActivationOwner,
    error: StagingCleanupError,
) -> ClosingStagingReleaseFailure {
    let kind = match error {
        StagingCleanupError::Cancelled => ClosingStagingReleaseFailureKind::Cancelled,
        StagingCleanupError::Deadline => ClosingStagingReleaseFailureKind::Deadline,
        StagingCleanupError::DeleteFailed => ClosingStagingReleaseFailureKind::Storage,
        StagingCleanupError::JournalChanged
        | StagingCleanupError::TraversalBound
        | StagingCleanupError::OwnershipUnknown
        | StagingCleanupError::Reparse
        | StagingCleanupError::IdentityChanged
        | StagingCleanupError::ForeignEntry
        | StagingCleanupError::HardLink
        | StagingCleanupError::NonEmpty => ClosingStagingReleaseFailureKind::Validation,
    };
    closing_staging_release_failure(
        owner,
        kind,
        format!("Capture runtime staging release stopped: {error:?}."),
    )
}

#[cfg(windows)]
pub(crate) fn closing_staging_release_failure_for_store_error(
    owner: ClosingActivationOwner,
    error: crate::journal_store::JournalStoreError,
) -> ClosingStagingReleaseFailure {
    let kind = match error {
        crate::journal_store::JournalStoreError::AdmissionCancelled => {
            ClosingStagingReleaseFailureKind::Cancelled
        }
        crate::journal_store::JournalStoreError::AdmissionDeadline => {
            ClosingStagingReleaseFailureKind::Deadline
        }
        crate::journal_store::JournalStoreError::Conflict
        | crate::journal_store::JournalStoreError::Journal(_) => {
            ClosingStagingReleaseFailureKind::Validation
        }
        _ => ClosingStagingReleaseFailureKind::Storage,
    };
    closing_staging_release_failure(
        owner,
        kind,
        format!("Capture runtime Closing staging-release admission stopped: {error:?}."),
    )
}

#[cfg(windows)]
pub(crate) fn closing_staging_release_failure_for_admission(
    owner: ClosingActivationOwner,
    cause: ClosingCasError,
) -> ClosingStagingReleaseFailure {
    let kind = match cause {
        ClosingCasError::Cancelled => ClosingStagingReleaseFailureKind::Cancelled,
        ClosingCasError::Deadline => ClosingStagingReleaseFailureKind::Deadline,
        ClosingCasError::Conflict => ClosingStagingReleaseFailureKind::Validation,
        ClosingCasError::Storage => ClosingStagingReleaseFailureKind::Storage,
    };
    closing_staging_release_failure(
        owner,
        kind,
        format!("Capture runtime Closing staging-release admission stopped: {cause:?}."),
    )
}

#[cfg(windows)]
pub(crate) fn staging_release_kind_from_detail(
    detail: &str,
    fallback: ClosingStagingReleaseFailureKind,
) -> ClosingStagingReleaseFailureKind {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("cancel") {
        ClosingStagingReleaseFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        ClosingStagingReleaseFailureKind::Deadline
    } else {
        fallback
    }
}

#[cfg(windows)]
pub(crate) fn listener_release_proof_for_closing(
    closing: &RuntimeSessionJournalV1,
    native: NativeCleanupProof,
) -> Result<NativeListenerReleaseProof, String> {
    let roots = closing
        .roots
        .iter()
        .zip(&native.roots)
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
        .ok_or_else(|| {
            "Capture runtime listener release tuple was incomplete or reordered.".to_string()
        })?;
    if roots.len() != closing.roots.len() || roots.is_empty() {
        return Err("Capture runtime listener release tuple was incomplete or reordered.".into());
    }
    Ok(NativeListenerReleaseProof {})
}

#[cfg(windows)]
pub(crate) fn closing_transition_failure(
    owner: RunningActivationOwner,
    detail: impl Into<String>,
) -> ClosingTransitionFailure {
    let detail = detail.into();
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        ClosingTransitionFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        ClosingTransitionFailureKind::Deadline
    } else if lower.contains("conflict") || lower.contains("changed") {
        ClosingTransitionFailureKind::Conflict
    } else if lower.contains("cas") || lower.contains("storage") {
        ClosingTransitionFailureKind::Storage
    } else {
        ClosingTransitionFailureKind::Validation
    };
    #[cfg_attr(not(test), allow(unused_variables))]
    let (committed_candidate, candidate_disposition) = pending_successor(
        &owner.owner.failure_context,
        &owner.running_journal,
        JournalState::Closing,
    );
    ClosingTransitionFailure {
        kind,
        #[cfg(test)]
        detail,
        owner,
        committed_candidate,
        #[cfg(test)]
        candidate_disposition,
    }
}

#[cfg(windows)]
pub(crate) fn closing_transition_failure_for_cas(
    owner: RunningActivationOwner,
    cause: ClosingCasError,
    #[cfg_attr(not(test), allow(unused_variables))] detail: &str,
) -> ClosingTransitionFailure {
    let kind = match cause {
        ClosingCasError::Cancelled => ClosingTransitionFailureKind::Cancelled,
        ClosingCasError::Deadline => ClosingTransitionFailureKind::Deadline,
        ClosingCasError::Conflict => ClosingTransitionFailureKind::Conflict,
        ClosingCasError::Storage => ClosingTransitionFailureKind::Storage,
    };
    #[cfg_attr(not(test), allow(unused_variables))]
    let (committed_candidate, candidate_disposition) = pending_successor(
        &owner.owner.failure_context,
        &owner.running_journal,
        JournalState::Closing,
    );
    ClosingTransitionFailure {
        kind,
        #[cfg(test)]
        detail: detail.to_owned(),
        owner,
        committed_candidate,
        #[cfg(test)]
        candidate_disposition,
    }
}

#[cfg(windows)]
pub(crate) fn closing_transition_failure_for_owned(
    mut owner: RunningActivationOwner,
    outcome: OwnedCasResult,
    #[cfg_attr(not(test), allow(unused_variables))] detail: &str,
) -> ClosingTransitionFailure {
    if let Some(context) = owner.owner.failure_context.as_mut() {
        record_owned_cas_context(context, &outcome);
    }
    let kind = match outcome.error() {
        Some(JournalStoreError::AdmissionCancelled) => ClosingTransitionFailureKind::Cancelled,
        Some(JournalStoreError::AdmissionDeadline) => ClosingTransitionFailureKind::Deadline,
        Some(JournalStoreError::Conflict) => ClosingTransitionFailureKind::Conflict,
        _ => ClosingTransitionFailureKind::Storage,
    };
    #[cfg_attr(not(test), allow(unused_variables))]
    let (committed_candidate, candidate_disposition) = pending_successor(
        &owner.owner.failure_context,
        &owner.running_journal,
        JournalState::Closing,
    );
    ClosingTransitionFailure {
        kind,
        #[cfg(test)]
        detail: detail.to_owned(),
        owner,
        committed_candidate,
        #[cfg(test)]
        candidate_disposition,
    }
}

#[cfg(windows)]
pub(crate) fn closing_transition_failure_for_bounded_error(
    owner: RunningActivationOwner,
    detail: String,
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> ClosingTransitionFailure {
    if cancellation.load(Ordering::Acquire) {
        return closing_transition_failure(
            owner,
            "Capture runtime Closing admission was cancelled during bounded revalidation.",
        );
    }
    if std::time::Instant::now() >= deadline {
        return closing_transition_failure(
            owner,
            "Capture runtime Closing admission expired during bounded revalidation.",
        );
    }
    closing_transition_failure(owner, detail)
}

#[cfg(windows)]
pub(crate) fn running_promotion_failure(
    owner: LaunchingActivationOwner,
    detail: impl Into<String>,
) -> RunningPromotionFailure {
    running_promotion_failure_with_candidate(owner, detail, None)
}

#[cfg(windows)]
pub(crate) fn running_promotion_failure_with_candidate(
    owner: LaunchingActivationOwner,
    detail: impl Into<String>,
    committed_candidate: Option<RuntimeSessionJournalV1>,
) -> RunningPromotionFailure {
    let detail = detail.into();
    let candidate_disposition = committed_candidate
        .as_ref()
        .map(|_| CasDisposition::ConfirmedLate);
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        RunningPromotionFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        RunningPromotionFailureKind::Deadline
    } else if lower.contains("did not report strict service readiness") {
        RunningPromotionFailureKind::NotReady
    } else if lower.contains("journal cas") || lower.contains("admission failed") {
        RunningPromotionFailureKind::Storage
    } else {
        RunningPromotionFailureKind::Validation
    };
    RunningPromotionFailure {
        kind,
        detail,
        owner,
        committed_candidate,
        candidate_disposition,
    }
}

#[cfg(windows)]
pub(crate) fn running_promotion_failure_for_owned(
    mut owner: LaunchingActivationOwner,
    outcome: OwnedCasResult,
    detail: &str,
) -> RunningPromotionFailure {
    if let Some(context) = owner.owner.failure_context.as_mut() {
        record_owned_cas_context(context, &outcome);
    }
    let kind = match outcome.error() {
        Some(JournalStoreError::AdmissionCancelled) => RunningPromotionFailureKind::Cancelled,
        Some(JournalStoreError::AdmissionDeadline) => RunningPromotionFailureKind::Deadline,
        Some(JournalStoreError::Conflict) => RunningPromotionFailureKind::Storage,
        _ => RunningPromotionFailureKind::Storage,
    };
    RunningPromotionFailure {
        kind,
        detail: detail.to_owned(),
        owner,
        committed_candidate: outcome.attempt().cloned(),
        candidate_disposition: Some(outcome.disposition()),
    }
}

#[cfg(windows)]
pub(crate) fn terminal_join_failure(
    owner: ClosingActivationOwner,
    kind: TerminalJoinFailureKind,
    detail: impl Into<String>,
) -> TerminalJoinFailure {
    let (committed_candidate, candidate_disposition) = pending_successor(
        &owner.owner.failure_context,
        &owner.closing_journal,
        JournalState::Terminal,
    );
    TerminalJoinFailure {
        kind,
        detail: detail.into(),
        owner,
        committed_candidate,
        candidate_disposition,
    }
}

#[cfg(windows)]
pub(crate) fn terminal_join_failure_with_candidate(
    mut owner: ClosingActivationOwner,
    kind: TerminalJoinFailureKind,
    detail: impl Into<String>,
    committed_candidate: RuntimeSessionJournalV1,
) -> TerminalJoinFailure {
    if let Some(context) = owner.owner.failure_context.as_mut() {
        context.predecessor = owner.closing_journal.clone();
        context.candidate = committed_candidate.clone();
        context.disposition = CasDisposition::ConfirmedLate;
    }
    TerminalJoinFailure {
        kind,
        detail: detail.into(),
        owner,
        committed_candidate: Some(committed_candidate),
        candidate_disposition: Some(CasDisposition::ConfirmedLate),
    }
}

#[cfg(windows)]
pub(crate) fn terminal_join_failure_for_owned(
    mut owner: ClosingActivationOwner,
    outcome: OwnedCasResult,
    detail: &str,
) -> TerminalJoinFailure {
    if let Some(context) = owner.owner.failure_context.as_mut() {
        record_owned_cas_context(context, &outcome);
    }
    let mut failure = match outcome.error().cloned() {
        Some(error) => terminal_join_failure_for_store(owner, error),
        None => terminal_join_failure(owner, TerminalJoinFailureKind::Storage, detail),
    };
    failure.detail = detail.to_owned();
    failure
}

#[cfg(windows)]
pub(crate) fn terminal_join_kind_from_detail(
    detail: &str,
    fallback: TerminalJoinFailureKind,
) -> TerminalJoinFailureKind {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("cancel") {
        TerminalJoinFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        TerminalJoinFailureKind::Deadline
    } else {
        fallback
    }
}

#[cfg(windows)]
pub(crate) fn terminal_join_failure_for_admission(
    owner: ClosingActivationOwner,
    cause: ClosingCasError,
) -> TerminalJoinFailure {
    let (kind, detail) = match cause {
        ClosingCasError::Cancelled => (
            TerminalJoinFailureKind::Cancelled,
            "Capture runtime terminal journal admission was cancelled.",
        ),
        ClosingCasError::Deadline => (
            TerminalJoinFailureKind::Deadline,
            "Capture runtime terminal journal admission exceeded its budget.",
        ),
        ClosingCasError::Conflict => (
            TerminalJoinFailureKind::Conflict,
            "Capture runtime terminal journal admission found a stale Closing snapshot.",
        ),
        ClosingCasError::Storage => (
            TerminalJoinFailureKind::Storage,
            "Capture runtime terminal journal admission could not read its exact snapshot.",
        ),
    };
    terminal_join_failure(owner, kind, detail)
}

#[cfg(windows)]
pub(crate) fn terminal_join_failure_for_store(
    owner: ClosingActivationOwner,
    error: crate::journal_store::JournalStoreError,
) -> TerminalJoinFailure {
    let (kind, detail): (TerminalJoinFailureKind, String) = match error {
        crate::journal_store::JournalStoreError::AdmissionCancelled => (
            TerminalJoinFailureKind::Cancelled,
            "Capture runtime terminal journal admission was cancelled.".into(),
        ),
        crate::journal_store::JournalStoreError::AdmissionDeadline => (
            TerminalJoinFailureKind::Deadline,
            "Capture runtime terminal journal admission exceeded its budget.".into(),
        ),
        crate::journal_store::JournalStoreError::Conflict => (
            TerminalJoinFailureKind::Conflict,
            "Capture runtime terminal journal admission found a stale Closing snapshot.".into(),
        ),
        crate::journal_store::JournalStoreError::Journal(_) => (
            TerminalJoinFailureKind::Validation,
            "Capture runtime terminal journal observation was rejected.".into(),
        ),
        error => (
            TerminalJoinFailureKind::Storage,
            format!("Capture runtime terminal journal write failed: {error:?}."),
        ),
    };
    terminal_join_failure(owner, kind, detail)
}

#[cfg(windows)]
pub(crate) fn running_promotion_failure_for_cas(
    owner: LaunchingActivationOwner,
    cause: RunningCasError,
    detail: &str,
) -> RunningPromotionFailure {
    let kind = match cause {
        RunningCasError::Cancelled => RunningPromotionFailureKind::Cancelled,
        RunningCasError::Deadline => RunningPromotionFailureKind::Deadline,
        RunningCasError::Conflict => RunningPromotionFailureKind::Storage,
        RunningCasError::Storage => RunningPromotionFailureKind::Storage,
    };
    let detail = match cause {
        RunningCasError::Cancelled => format!("{detail} AdmissionCancelled."),
        RunningCasError::Deadline => format!("{detail} AdmissionDeadline."),
        RunningCasError::Conflict => format!("{detail} Conflict."),
        RunningCasError::Storage => detail.to_owned(),
    };
    RunningPromotionFailure {
        kind,
        detail,
        owner,
        committed_candidate: None,
        candidate_disposition: None,
    }
}

#[cfg(windows)]
pub(crate) fn running_promotion_failure_for_bounded_error(
    owner: LaunchingActivationOwner,
    detail: String,
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> RunningPromotionFailure {
    if cancellation.load(Ordering::Acquire) {
        return running_promotion_failure_for_cas(owner, RunningCasError::Cancelled, &detail);
    }
    if std::time::Instant::now() >= deadline {
        return running_promotion_failure_for_cas(owner, RunningCasError::Deadline, &detail);
    }
    running_promotion_failure(owner, detail)
}

impl fmt::Debug for GroupNativeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GroupNativeFailure")
            .field("kind", &self.kind)
            .field("owner_present", &self.owner.is_some())
            .finish()
    }
}

#[cfg(windows)]
impl GroupNativeFailure {
    pub(crate) fn with_owner(
        kind: GroupNativeFailureKind,
        detail: impl Into<String>,
        owner: SuspendedGroup,
    ) -> Self {
        Self {
            kind,
            detail: detail.into(),
            owner: Some(owner),
        }
    }

    pub(crate) fn without_owner(kind: GroupNativeFailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
            owner: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn kind(&self) -> GroupNativeFailureKind {
        self.kind
    }
}

pub(crate) fn activation_budget_error_detail(error: JournalStoreError) -> String {
    match error {
        JournalStoreError::AdmissionCancelled => {
            "Capture runtime activation was cancelled at its bounded phase boundary.".into()
        }
        JournalStoreError::AdmissionDeadline => {
            "Capture runtime activation exceeded its absolute deadline.".into()
        }
        _ => "Capture runtime activation budget validation failed.".into(),
    }
}

#[cfg(windows)]
pub(crate) fn activation_failure_kind_for_budget(
    error: &JournalStoreError,
) -> SuspendedActivationFailureKind {
    match error {
        JournalStoreError::AdmissionCancelled => SuspendedActivationFailureKind::Cancellation,
        JournalStoreError::AdmissionDeadline => SuspendedActivationFailureKind::Deadline,
        _ => SuspendedActivationFailureKind::Journal,
    }
}

#[cfg(windows)]
pub(crate) fn activation_failure_kind_for_staging_kind(
    kind: StagingFailureKind,
) -> SuspendedActivationFailureKind {
    match kind {
        StagingFailureKind::Cancelled => SuspendedActivationFailureKind::Cancellation,
        StagingFailureKind::Deadline => SuspendedActivationFailureKind::Deadline,
        _ => SuspendedActivationFailureKind::Journal,
    }
}

#[cfg(windows)]
pub(crate) fn activation_launch_failure_kind_for_staging_kind(
    kind: StagingFailureKind,
) -> ActivationLaunchFailureKind {
    match kind {
        StagingFailureKind::Cancelled => ActivationLaunchFailureKind::Cancellation,
        StagingFailureKind::Deadline => ActivationLaunchFailureKind::Deadline,
        _ => ActivationLaunchFailureKind::Journal,
    }
}

#[cfg(windows)]
pub(crate) fn check_activation_phase_budget(
    budget: Option<&ActivationBudget>,
    cancellation: Option<&AtomicBool>,
) -> Result<(), (ActivationLaunchFailureKind, String)> {
    if let Some(budget) = budget {
        return budget.check().map_err(|error| match error {
            JournalStoreError::AdmissionCancelled => (
                ActivationLaunchFailureKind::Cancellation,
                activation_budget_error_detail(error),
            ),
            JournalStoreError::AdmissionDeadline => (
                ActivationLaunchFailureKind::Deadline,
                activation_budget_error_detail(error),
            ),
            _ => (
                ActivationLaunchFailureKind::Journal,
                activation_budget_error_detail(error),
            ),
        });
    }
    if cancellation_requested(cancellation) {
        return Err((
            ActivationLaunchFailureKind::Cancellation,
            "Capture runtime Launching was cancelled before its next phase boundary.".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn activation_reconcile_failure_kind(
    error: &JournalStoreError,
) -> ActivationReconcileFailureKind {
    match error {
        JournalStoreError::AdmissionDeadline => ActivationReconcileFailureKind::Deadline,
        JournalStoreError::Conflict => ActivationReconcileFailureKind::Conflict,
        JournalStoreError::Journal(_) | JournalStoreError::CorruptJournal => {
            ActivationReconcileFailureKind::Validation
        }
        _ => ActivationReconcileFailureKind::Storage,
    }
}

#[cfg(windows)]
pub(crate) fn check_native_cleanup_budget(
    deadline: std::time::Instant,
    cancellation: Option<&AtomicBool>,
) -> Result<(), String> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Capture runtime native cleanup was cancelled.".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("Capture runtime native cleanup exceeded its group deadline.".into());
    }
    Ok(())
}

#[cfg(windows)]
impl fmt::Debug for SuspendedActivationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SuspendedActivationFailure")
            .field("kind", &self.kind)
            .field("owner_present", &self.owner.is_some())
            .finish()
    }
}
