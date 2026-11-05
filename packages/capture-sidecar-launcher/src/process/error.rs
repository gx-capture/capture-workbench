use std::fmt;
use std::sync::Arc;

#[cfg(windows)]
use crate::journal::RuntimeSessionJournalV1;

#[cfg(windows)]
use crate::journal_store::{ActivationBudget, CasDisposition, JournalStoreError};

#[cfg(windows)]
use super::activation::{
    read_back_reconciled_activation, retry_cleanup_error, ActivationReconcileFailureKind,
    ClosingActivationOwner, ClosingCleanupFailure, ClosingCleanupFailureKind,
    ClosingStagingReleaseFailure, ClosingStagingReleaseFailureKind, ClosingTransitionFailure,
    ClosingTransitionFailureKind, PrivateActivationFailure, PrivateActivationFailureKind,
    PrivateActivationFailureOwner, ReconciledActivationOwner, RunningActivationOwner,
    SuspendedActivationOwner, TerminalJoinFailure, TerminalJoinFailureKind,
};

/// The typed reason an owned runtime cleanup attempt could not be proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCleanupErrorKind {
    Termination,
    Liveness,
    Reap,
    Descendants,
    Ownership,
    #[cfg(test)]
    Injected,
}

/// Cleanup failure returned while retaining the process/job ownership handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCleanupError {
    root_pid: u32,
    kind: RuntimeCleanupErrorKind,
    detail: String,
}

impl RuntimeCleanupError {
    pub(crate) fn new(
        root_pid: u32,
        kind: RuntimeCleanupErrorKind,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            root_pid,
            kind,
            detail: detail.into(),
        }
    }

    pub fn root_pid(&self) -> u32 {
        self.root_pid
    }

    pub fn kind(&self) -> RuntimeCleanupErrorKind {
        self.kind
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for RuntimeCleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Owned runtime cleanup failed for root PID {} ({:?}): {}",
            self.root_pid, self.kind, self.detail
        )
    }
}

impl std::error::Error for RuntimeCleanupError {}

/// Semantic lifecycle state exposed by the public group lease.
///
/// The native process, listener, journal, and staging identities remain
/// producer-private.  This state is deliberately small so a host can decide
/// whether to continue a normal lifecycle operation without acquiring any
/// cleanup authority of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupLifecycleState {
    Running,
    Closing,
    Terminal,
}

/// Read-only semantic observation of a live group.  It contains no native
/// identifiers, paths, tokens, journal values, or proof objects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupObservation {
    pub(crate) state: GroupLifecycleState,
    pub(crate) root_count: usize,
    pub(crate) roots_ready: bool,
    pub(crate) listeners_bound: bool,
}

impl GroupObservation {
    pub fn state(&self) -> GroupLifecycleState {
        self.state
    }

    pub fn root_count(&self) -> usize {
        self.root_count
    }

    pub fn roots_ready(&self) -> bool {
        self.roots_ready
    }

    pub fn all_roots_ready(&self) -> bool {
        self.roots_ready
    }

    pub fn listeners_bound(&self) -> bool {
        self.listeners_bound
    }

    pub fn all_listeners_bound(&self) -> bool {
        self.listeners_bound
    }
}

/// Semantic terminal proof projected from the canonical producer journal.
/// All four booleans are meaningful only when `state()` is `Terminal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupProof {
    pub(crate) state: GroupLifecycleState,
    pub(crate) root_count: usize,
    pub(crate) root_reaped: bool,
    pub(crate) descendants_terminated: bool,
    pub(crate) listeners_released: bool,
    pub(crate) staging_released: bool,
}

impl GroupProof {
    pub fn state(&self) -> GroupLifecycleState {
        self.state
    }

    pub fn root_count(&self) -> usize {
        self.root_count
    }

    pub fn root_reaped(&self) -> bool {
        self.root_reaped
    }

    pub fn descendants_terminated(&self) -> bool {
        self.descendants_terminated
    }

    pub fn listeners_released(&self) -> bool {
        self.listeners_released
    }

    pub fn staging_released(&self) -> bool {
        self.staging_released
    }

    pub fn is_terminal(&self) -> bool {
        self.state == GroupLifecycleState::Terminal
    }
}

/// The semantic reason supplied when a live group is closed.  The producer
/// owns the durable lifecycle transition; this value never crosses into the
/// journal or native process APIs as an unconstrained string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Shutdown,
    Cancelled,
}

/// Stable phase names for sanitized public activation errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchPhase {
    Preparation,
    NativeAcquisition,
    Readiness,
    Reconcile,
}

/// Stable public activation failure categories.  Details remain private to
/// the producer so formatting this value cannot disclose paths, PIDs, tokens,
/// or native diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchErrorKind {
    Unsupported,
    Preparation,
    Staging,
    Native,
    Storage,
    Conflict,
    Cancellation,
    Deadline,
    Reconcile,
    Validation,
}

#[cfg(windows)]
pub(crate) enum LaunchFailureOwner {
    Suspended(SuspendedActivationOwner),
    Reconciled(ReconciledActivationOwner),
}

/// Sanitized activation failure retaining the producer's exact cleanup owner.
pub struct LaunchError {
    pub(crate) kind: LaunchErrorKind,
    pub(crate) phase: LaunchPhase,
    pub(crate) no_resources: bool,
    #[cfg(windows)]
    pub(crate) owner: Option<LaunchFailureOwner>,
    #[cfg(windows)]
    pub(crate) committed_candidate: Option<RuntimeSessionJournalV1>,
}

impl LaunchError {
    pub fn kind(&self) -> LaunchErrorKind {
        self.kind
    }

    pub fn phase(&self) -> LaunchPhase {
        self.phase
    }

    /// Retry only the exact retained activation cleanup/reconciliation owner.
    /// This starts a fresh bounded cleanup attempt and never reruns group
    /// activation or resets the journal's recovery counters.
    pub fn retry_cleanup(self) -> Result<ActivationCleanupObservation, Self> {
        #[cfg(not(windows))]
        {
            Err(self)
        }
        #[cfg(windows)]
        {
            let LaunchError {
                kind,
                phase,
                no_resources,
                owner,
                committed_candidate,
            } = self;
            if no_resources {
                return Ok(ActivationCleanupObservation {
                    state: SemanticActivationCleanupState::NoResourcesAcquired,
                    native_closed: true,
                    staging_retained: false,
                });
            }
            let Some(owner) = owner else {
                return Err(Self {
                    kind,
                    phase,
                    no_resources: false,
                    owner: None,
                    committed_candidate,
                });
            };
            let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let budget = ActivationBudget::new(
                std::time::Instant::now() + std::time::Duration::from_secs(60),
                Arc::clone(&cancellation),
            );
            match owner {
                LaunchFailureOwner::Reconciled(owner) => {
                    match read_back_reconciled_activation(owner, &budget) {
                        Ok(()) => Ok(ActivationCleanupObservation {
                            state: SemanticActivationCleanupState::ReconcileRequired,
                            native_closed: true,
                            staging_retained: true,
                        }),
                        Err(owner) => Err(Self {
                            kind: LaunchErrorKind::Reconcile,
                            phase: LaunchPhase::Reconcile,
                            no_resources: false,
                            owner: Some(LaunchFailureOwner::Reconciled(owner)),
                            committed_candidate: None,
                        }),
                    }
                }
                LaunchFailureOwner::Suspended(owner) => {
                    match owner.cleanup_and_reconcile(&budget) {
                        Ok(reconciled) => {
                            match read_back_reconciled_activation(reconciled, &budget) {
                                Ok(()) => Ok(ActivationCleanupObservation {
                                    state: SemanticActivationCleanupState::ReconcileRequired,
                                    native_closed: true,
                                    staging_retained: true,
                                }),
                                Err(owner) => Err(Self {
                                    kind: LaunchErrorKind::Reconcile,
                                    phase: LaunchPhase::Reconcile,
                                    no_resources: false,
                                    owner: Some(LaunchFailureOwner::Reconciled(owner)),
                                    committed_candidate: None,
                                }),
                            }
                        }
                        Err(failure) => {
                            let kind = map_activation_reconcile_error_kind(failure.kind);
                            let owner = failure.owner;
                            let committed_candidate = failure.committed_candidate;
                            Err(Self {
                                kind,
                                phase: LaunchPhase::Reconcile,
                                no_resources: false,
                                owner: Some(LaunchFailureOwner::Suspended(owner)),
                                committed_candidate,
                            })
                        }
                    }
                }
            }
        }
    }
}

impl fmt::Debug for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LaunchError")
            .field("kind", &self.kind)
            .field("phase", &self.phase)
            .finish()
    }
}

impl fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime activation failed during {:?} ({:?})",
            self.phase, self.kind
        )
    }
}

impl std::error::Error for LaunchError {}

/// Whether a failed activation acquired no resource in this invocation or
/// retained a durable record for producer reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticActivationCleanupState {
    NoResourcesAcquired,
    ReconcileRequired,
}

/// Semantic result of explicit activation cleanup retry.  `staging_retained`
/// intentionally means this invocation left the producer staging scope for
/// later reconciliation; it does not claim that staging was globally absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivationCleanupObservation {
    pub(crate) state: SemanticActivationCleanupState,
    pub(crate) native_closed: bool,
    pub(crate) staging_retained: bool,
}

impl ActivationCleanupObservation {
    pub fn state(&self) -> SemanticActivationCleanupState {
        self.state
    }

    pub fn native_closed(&self) -> bool {
        self.native_closed
    }

    pub fn staging_retained(&self) -> bool {
        self.staging_retained
    }
}

/// Stable phase names for public cleanup errors.  The phase represents the
/// exact producer owner retained for retry, including late CAS candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPhase {
    Running,
    Closing,
    NativeCleaned,
    StagingReleased,
    TerminalCommittedAfterBudget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupErrorKind {
    Unsupported,
    Cancelled,
    Deadline,
    Conflict,
    Storage,
    Native,
    Listener,
    Staging,
    Validation,
    InvalidState,
    TerminalCommittedAfterBudget,
}

#[cfg(windows)]
pub(crate) enum CleanupFailureOwner {
    Running {
        owner: RunningActivationOwner,
        committed_candidate: Option<RuntimeSessionJournalV1>,
    },
    Closing {
        owner: ClosingActivationOwner,
        phase: CleanupPhase,
        committed_candidate: Option<RuntimeSessionJournalV1>,
    },
}

/// Sanitized public cleanup failure.  The exact private owner is retained so
/// `retry` can resume at the first unproven phase without reconstructing or
/// reacquiring native state.
pub struct CleanupError {
    pub(crate) kind: CleanupErrorKind,
    pub(crate) phase: CleanupPhase,
    #[cfg(windows)]
    pub(crate) owner: Option<CleanupFailureOwner>,
}

impl CleanupError {
    pub fn kind(&self) -> CleanupErrorKind {
        self.kind
    }

    pub fn phase(&self) -> CleanupPhase {
        self.phase
    }

    /// Retry the exact retained cleanup owner with one fresh 60 second
    /// absolute budget. No journal attempt counter is reset and no phase CAS
    /// is repeated after an exact committed candidate is known.
    pub fn retry(self) -> Result<GroupProof, Self> {
        #[cfg(not(windows))]
        {
            Err(self)
        }
        #[cfg(windows)]
        {
            retry_cleanup_error(self)
        }
    }
}

impl fmt::Debug for CleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CleanupError")
            .field("kind", &self.kind)
            .field("phase", &self.phase)
            .finish()
    }
}

impl fmt::Display for CleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime cleanup failed during {:?} ({:?})",
            self.phase, self.kind
        )
    }
}

impl std::error::Error for CleanupError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Observe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleErrorKind {
    Unsupported,
    Busy,
    Cancellation,
    Deadline,
    Conflict,
    Storage,
    Native,
    Listener,
    Validation,
    InvalidState,
}

/// Sanitized read-only observation failure.  A failed observation never
/// consumes or closes its lease, so the caller retains close authority.
pub struct LifecycleError {
    pub(crate) kind: LifecycleErrorKind,
    pub(crate) phase: LifecyclePhase,
}

impl LifecycleError {
    pub fn kind(&self) -> LifecycleErrorKind {
        self.kind
    }

    pub fn phase(&self) -> LifecyclePhase {
        self.phase
    }
}

impl fmt::Debug for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LifecycleError")
            .field("kind", &self.kind)
            .field("phase", &self.phase)
            .finish()
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "runtime lifecycle observation failed during {:?} ({:?})",
            self.phase, self.kind
        )
    }
}

impl std::error::Error for LifecycleError {}

#[cfg(windows)]
pub(crate) fn launch_error_from_private_failure(failure: PrivateActivationFailure) -> LaunchError {
    let PrivateActivationFailure {
        kind,
        owner,
        committed_candidate,
        ..
    } = failure;
    let (public_kind, phase) = match kind {
        PrivateActivationFailureKind::Preparation => {
            (LaunchErrorKind::Preparation, LaunchPhase::Preparation)
        }
        PrivateActivationFailureKind::Staging => {
            (LaunchErrorKind::Staging, LaunchPhase::NativeAcquisition)
        }
        PrivateActivationFailureKind::Native => {
            (LaunchErrorKind::Native, LaunchPhase::NativeAcquisition)
        }
        PrivateActivationFailureKind::Journal => (LaunchErrorKind::Storage, LaunchPhase::Readiness),
        PrivateActivationFailureKind::Cancellation => {
            (LaunchErrorKind::Cancellation, LaunchPhase::Readiness)
        }
        PrivateActivationFailureKind::Deadline => {
            (LaunchErrorKind::Deadline, LaunchPhase::Readiness)
        }
        PrivateActivationFailureKind::Reconcile => {
            (LaunchErrorKind::Reconcile, LaunchPhase::Reconcile)
        }
    };
    let owner = owner.map(|owner| match owner {
        PrivateActivationFailureOwner::Reconciled(owner) => LaunchFailureOwner::Reconciled(owner),
        PrivateActivationFailureOwner::Suspended(owner) => LaunchFailureOwner::Suspended(owner),
    });
    LaunchError {
        kind: public_kind,
        phase,
        no_resources: owner.is_none(),
        owner,
        committed_candidate,
    }
}

#[cfg(windows)]
pub(crate) fn map_activation_reconcile_error_kind(
    kind: ActivationReconcileFailureKind,
) -> LaunchErrorKind {
    match kind {
        ActivationReconcileFailureKind::Cleanup => LaunchErrorKind::Native,
        ActivationReconcileFailureKind::Deadline => LaunchErrorKind::Deadline,
        ActivationReconcileFailureKind::Conflict => LaunchErrorKind::Conflict,
        ActivationReconcileFailureKind::Storage => LaunchErrorKind::Storage,
        ActivationReconcileFailureKind::Validation => LaunchErrorKind::Validation,
    }
}

#[cfg(windows)]
pub(crate) fn lifecycle_error(kind: LifecycleErrorKind) -> LifecycleError {
    LifecycleError {
        kind,
        phase: LifecyclePhase::Observe,
    }
}

#[cfg(windows)]
pub(crate) fn lifecycle_error_for_store(error: JournalStoreError) -> LifecycleError {
    let kind = match error {
        JournalStoreError::AdmissionCancelled => LifecycleErrorKind::Cancellation,
        JournalStoreError::AdmissionDeadline => LifecycleErrorKind::Deadline,
        JournalStoreError::Conflict => LifecycleErrorKind::Conflict,
        JournalStoreError::UnsupportedPlatform => LifecycleErrorKind::Unsupported,
        JournalStoreError::Journal(_) | JournalStoreError::CorruptJournal => {
            LifecycleErrorKind::Validation
        }
        _ => LifecycleErrorKind::Storage,
    };
    lifecycle_error(kind)
}

#[cfg(windows)]
pub(crate) fn lifecycle_error_for_native_detail(detail: &str) -> LifecycleError {
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        LifecycleErrorKind::Cancellation
    } else if lower.contains("deadline") || lower.contains("expired") {
        LifecycleErrorKind::Deadline
    } else if lower.contains("listener") || lower.contains("readiness") {
        LifecycleErrorKind::Listener
    } else if lower.contains("identity") || lower.contains("binding") {
        LifecycleErrorKind::Validation
    } else {
        LifecycleErrorKind::Native
    };
    lifecycle_error(kind)
}

#[cfg(windows)]
pub(crate) fn map_cleanup_transition_kind(kind: ClosingTransitionFailureKind) -> CleanupErrorKind {
    match kind {
        ClosingTransitionFailureKind::Cancelled => CleanupErrorKind::Cancelled,
        ClosingTransitionFailureKind::Conflict => CleanupErrorKind::Conflict,
        ClosingTransitionFailureKind::Storage => CleanupErrorKind::Storage,
        ClosingTransitionFailureKind::Validation => CleanupErrorKind::Validation,
        ClosingTransitionFailureKind::Deadline => CleanupErrorKind::Deadline,
    }
}

#[cfg(windows)]
pub(crate) fn map_cleanup_native_kind(kind: ClosingCleanupFailureKind) -> CleanupErrorKind {
    match kind {
        ClosingCleanupFailureKind::Cancelled => CleanupErrorKind::Cancelled,
        ClosingCleanupFailureKind::Deadline => CleanupErrorKind::Deadline,
        ClosingCleanupFailureKind::Native => CleanupErrorKind::Native,
        ClosingCleanupFailureKind::Listener => CleanupErrorKind::Listener,
        ClosingCleanupFailureKind::Validation => CleanupErrorKind::Validation,
    }
}

#[cfg(windows)]
pub(crate) fn map_cleanup_staging_kind(kind: ClosingStagingReleaseFailureKind) -> CleanupErrorKind {
    match kind {
        ClosingStagingReleaseFailureKind::Cancelled => CleanupErrorKind::Cancelled,
        ClosingStagingReleaseFailureKind::Deadline => CleanupErrorKind::Deadline,
        ClosingStagingReleaseFailureKind::Listener => CleanupErrorKind::Listener,
        ClosingStagingReleaseFailureKind::Validation => CleanupErrorKind::Validation,
        ClosingStagingReleaseFailureKind::Storage => CleanupErrorKind::Staging,
    }
}

#[cfg(windows)]
pub(crate) fn map_cleanup_terminal_kind(kind: TerminalJoinFailureKind) -> CleanupErrorKind {
    match kind {
        TerminalJoinFailureKind::Cancelled => CleanupErrorKind::Cancelled,
        TerminalJoinFailureKind::Deadline => CleanupErrorKind::Deadline,
        TerminalJoinFailureKind::Listener => CleanupErrorKind::Listener,
        TerminalJoinFailureKind::Conflict => CleanupErrorKind::Conflict,
        TerminalJoinFailureKind::Storage => CleanupErrorKind::Storage,
        TerminalJoinFailureKind::Validation => CleanupErrorKind::Validation,
        TerminalJoinFailureKind::CommittedAfterBudget => {
            CleanupErrorKind::TerminalCommittedAfterBudget
        }
    }
}

#[cfg(windows)]
pub(crate) fn cleanup_error_from_transition(failure: ClosingTransitionFailure) -> CleanupError {
    let kind = map_cleanup_transition_kind(failure.kind);
    CleanupError {
        kind,
        phase: CleanupPhase::Running,
        owner: Some(CleanupFailureOwner::Running {
            owner: failure.owner,
            committed_candidate: failure.committed_candidate,
        }),
    }
}

#[cfg(windows)]
pub(crate) fn cleanup_error_from_native(failure: ClosingCleanupFailure) -> CleanupError {
    let phase = if failure.owner.native_cleanup_proof.is_some() {
        CleanupPhase::NativeCleaned
    } else {
        CleanupPhase::Closing
    };
    CleanupError {
        kind: map_cleanup_native_kind(failure.kind),
        phase,
        owner: Some(CleanupFailureOwner::Closing {
            owner: failure.owner,
            phase,
            committed_candidate: None,
        }),
    }
}

#[cfg(windows)]
pub(crate) fn cleanup_error_from_staging(failure: ClosingStagingReleaseFailure) -> CleanupError {
    let phase = if failure.owner.staging_release_proof.is_some() {
        CleanupPhase::StagingReleased
    } else {
        CleanupPhase::NativeCleaned
    };
    CleanupError {
        kind: map_cleanup_staging_kind(failure.kind),
        phase,
        owner: Some(CleanupFailureOwner::Closing {
            owner: failure.owner,
            phase,
            committed_candidate: None,
        }),
    }
}

#[cfg(windows)]
pub(crate) fn cleanup_error_from_terminal(failure: TerminalJoinFailure) -> CleanupError {
    let phase = match failure.candidate_disposition {
        Some(CasDisposition::ConfirmedLate) => CleanupPhase::TerminalCommittedAfterBudget,
        Some(CasDisposition::AmbiguousWrite) | Some(CasDisposition::Prewrite) | None => {
            CleanupPhase::StagingReleased
        }
        Some(CasDisposition::Committed) => CleanupPhase::StagingReleased,
    };
    let kind = map_cleanup_terminal_kind(failure.kind);
    CleanupError {
        kind,
        phase,
        owner: Some(CleanupFailureOwner::Closing {
            owner: failure.owner,
            phase,
            committed_candidate: failure.committed_candidate,
        }),
    }
}
