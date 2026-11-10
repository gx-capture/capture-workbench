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

/// Why one owned-process cleanup could not be proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCleanupErrorKind {
    /// The root process could not be killed from its launch handle.
    Termination,
    /// The root's exit could not be proven, or its liveness could not be read.
    Liveness,
    /// Waiting for the root to exit failed after termination was requested.
    Reap,
    /// A descendant in the ownership boundary was still present, or could not be queried.
    Descendants,
    /// The launch identity or the ownership lock could not be used.
    Ownership,
    /// Test-only failure injected before a real cleanup proof is attempted.
    #[cfg(test)]
    Injected,
}

/// Cleanup failure that keeps the process and job handle for another attempt.
///
/// The detail string describes the operating-system or ownership failure. It
/// does not include the bearer token.
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

    /// Returns the root process id captured for this cleanup attempt.
    ///
    /// Zero means the ownership lock failed before a root id was available.
    pub fn root_pid(&self) -> u32 {
        self.root_pid
    }

    /// Returns the cleanup failure category.
    pub fn kind(&self) -> RuntimeCleanupErrorKind {
        self.kind
    }

    /// Returns the cleanup diagnostic.
    ///
    /// The text can include an operating-system error. It does not include
    /// the bearer token.
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
    /// The group journal is running and the lease can still be observed.
    Running,
    /// Close has started and the terminal journal record is not proven.
    Closing,
    /// The producer journal has a terminal record.
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
    /// Returns the lifecycle state observed for this group.
    pub fn state(&self) -> GroupLifecycleState {
        self.state
    }

    /// Returns the number of roots in the running journal.
    pub fn root_count(&self) -> usize {
        self.root_count
    }

    /// Reports whether every root was ready at this observation.
    pub fn roots_ready(&self) -> bool {
        self.roots_ready
    }

    /// Reports whether every root was ready at this observation.
    pub fn all_roots_ready(&self) -> bool {
        self.roots_ready
    }

    /// Reports whether every root listener was bound at this observation.
    pub fn listeners_bound(&self) -> bool {
        self.listeners_bound
    }

    /// Reports whether every root listener was bound at this observation.
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
    /// Returns the lifecycle state projected from the journal.
    pub fn state(&self) -> GroupLifecycleState {
        self.state
    }

    /// Returns the number of roots recorded for the group.
    pub fn root_count(&self) -> usize {
        self.root_count
    }

    /// Reports whether the journal says every root process was reaped.
    ///
    /// Meaningful when [`Self::is_terminal`] is true.
    pub fn root_reaped(&self) -> bool {
        self.root_reaped
    }

    /// Reports whether the journal says every descendant was stopped.
    ///
    /// Meaningful when [`Self::is_terminal`] is true.
    pub fn descendants_terminated(&self) -> bool {
        self.descendants_terminated
    }

    /// Reports whether the journal says every listener was released.
    ///
    /// Meaningful when [`Self::is_terminal`] is true.
    pub fn listeners_released(&self) -> bool {
        self.listeners_released
    }

    /// Reports whether the journal says the staging scope was released.
    ///
    /// Meaningful when [`Self::is_terminal`] is true.
    pub fn staging_released(&self) -> bool {
        self.staging_released
    }

    /// Reports whether [`Self::state`] is [`GroupLifecycleState::Terminal`].
    pub fn is_terminal(&self) -> bool {
        self.state == GroupLifecycleState::Terminal
    }
}

/// Caller label for [`crate::OwnedRuntimeSession::close`].
///
/// Neither variant is written to the journal or passed to the process
/// termination call. Close uses the same producer transition for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The host is stopping the group.
    Shutdown,
    /// The host is abandoning the group.
    Cancelled,
}

/// Phase named by a [`LaunchError`].
///
/// The phase says where activation stopped. It does not include a path,
/// process id, or token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchPhase {
    /// The prepared plan or permit was rejected before native acquisition.
    Preparation,
    /// Staging or process acquisition failed.
    NativeAcquisition,
    /// Journal or readiness work failed after acquisition started.
    Readiness,
    /// Cleanup or reconciliation after a failed activation did not finish.
    Reconcile,
}

/// Stable public activation failure categories.  Details remain private to
/// the producer so formatting this value cannot disclose paths, PIDs, tokens,
/// or native diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchErrorKind {
    /// The call is not implemented on this target.
    Unsupported,
    /// The prepared plan or permit was rejected.
    Preparation,
    /// The staging scope could not be materialized.
    Staging,
    /// A process or job operation failed.
    Native,
    /// The journal could not be read or replaced.
    Storage,
    /// The journal changed under the cleanup owner.
    Conflict,
    /// The activation cancel flag was set.
    Cancellation,
    /// The activation budget expired.
    Deadline,
    /// Reconciliation did not finish.
    Reconcile,
    /// A cleanup or journal record failed validation.
    Validation,
}

#[cfg(windows)]
pub(crate) enum LaunchFailureOwner {
    Suspended(SuspendedActivationOwner),
    Reconciled(ReconciledActivationOwner),
}

/// Activation failure that keeps the producer cleanup owner.
///
/// `Debug` prints `kind` and `phase` only. Paths, process ids, tokens, and
/// the private owner are omitted.
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
    /// Returns the failure category.
    pub fn kind(&self) -> LaunchErrorKind {
        self.kind
    }

    /// Returns the phase where activation stopped.
    pub fn phase(&self) -> LaunchPhase {
        self.phase
    }

    /// Runs one fresh cleanup against the owner retained in this error.
    ///
    /// Uses a new 60 second budget. Does not activate the group again and
    /// does not reset journal recovery counters. On Windows, an error that
    /// acquired nothing returns
    /// [`SemanticActivationCleanupState::NoResourcesAcquired`]. A finished
    /// read-back returns [`SemanticActivationCleanupState::ReconcileRequired`]
    /// with native resources closed and the producer staging scope retained.
    /// On any other target this returns the same error.
    ///
    /// # Errors
    ///
    /// Returns `Err(self)` when this value has no cleanup owner or the target
    /// is not Windows. A failed Windows cleanup returns [`LaunchErrorKind::Reconcile`],
    /// [`LaunchErrorKind::Native`], [`LaunchErrorKind::Deadline`],
    /// [`LaunchErrorKind::Conflict`], [`LaunchErrorKind::Storage`], or
    /// [`LaunchErrorKind::Validation`], with [`LaunchPhase::Reconcile`].
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
    /// This activation acquired no resource that needs reconciliation.
    NoResourcesAcquired,
    /// Native resources were closed and the staging scope remains for a later reconcile.
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
    /// Returns whether this attempt acquired nothing or left work to reconcile.
    pub fn state(&self) -> SemanticActivationCleanupState {
        self.state
    }

    /// Reports whether this attempt closed the native resources it owned.
    pub fn native_closed(&self) -> bool {
        self.native_closed
    }

    /// Reports whether the producer staging scope was left in place.
    ///
    /// True means this attempt did not release staging. It does not mean
    /// staging was absent on disk before the attempt.
    pub fn staging_retained(&self) -> bool {
        self.staging_retained
    }
}

/// Stable phase names for public cleanup errors.  The phase represents the
/// exact producer owner retained for retry, including late CAS candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPhase {
    /// Failure while leaving Running, before Closing was committed.
    Running,
    /// Native cleanup of a Closing owner is not proven yet.
    Closing,
    /// Native cleanup is proven and staging release is not.
    NativeCleaned,
    /// Staging release is proven and the terminal journal record is not.
    StagingReleased,
    /// A terminal candidate was committed but not proven inside the budget.
    TerminalCommittedAfterBudget,
}

/// Category of a [`CleanupError`].
///
/// Formatting this value does not include a path, process id, or token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupErrorKind {
    /// The call is not implemented on this target.
    Unsupported,
    /// The cleanup budget's cancel flag was set.
    Cancelled,
    /// The cleanup budget expired.
    Deadline,
    /// The journal changed under the cleanup owner.
    Conflict,
    /// The journal could not be read or replaced.
    Storage,
    /// A process or job operation failed.
    Native,
    /// A listener was not released, or readiness during cleanup was not proven.
    Listener,
    /// Staging release failed.
    Staging,
    /// A journal or staging record failed validation.
    Validation,
    /// The lease no longer held a close owner.
    InvalidState,
    /// The terminal record was committed after the budget.
    ///
    /// [`CleanupError::retry`] must not repeat that compare-and-swap.
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

/// Cleanup failure that keeps the owner for [`Self::retry`].
///
/// `Debug` prints `kind` and `phase` only. The private owner stays inside
/// the value so retry can resume at the first unproven phase.
pub struct CleanupError {
    pub(crate) kind: CleanupErrorKind,
    pub(crate) phase: CleanupPhase,
    #[cfg(windows)]
    pub(crate) owner: Option<CleanupFailureOwner>,
}

impl CleanupError {
    /// Returns the cleanup failure category.
    pub fn kind(&self) -> CleanupErrorKind {
        self.kind
    }

    /// Returns the first unproven cleanup phase retained for retry.
    pub fn phase(&self) -> CleanupPhase {
        self.phase
    }

    /// Resumes the retained cleanup owner with one fresh 60 second budget.
    ///
    /// Does not reset a journal attempt counter. When a terminal candidate is
    /// already known to have been committed, that compare-and-swap is not
    /// repeated. On any target other than Windows this returns the same error.
    ///
    /// # Errors
    ///
    /// Returns a [`CleanupError`]. On any target other than Windows this is
    /// the same error. On Windows an error with no retained owner is returned
    /// unchanged. A failed resume reports the unproven [`CleanupPhase`] and
    /// one of [`CleanupErrorKind::Cancelled`], [`CleanupErrorKind::Deadline`],
    /// [`CleanupErrorKind::Conflict`], [`CleanupErrorKind::Storage`],
    /// [`CleanupErrorKind::Native`], [`CleanupErrorKind::Listener`],
    /// [`CleanupErrorKind::Staging`], [`CleanupErrorKind::Validation`],
    /// [`CleanupErrorKind::InvalidState`], or
    /// [`CleanupErrorKind::TerminalCommittedAfterBudget`].
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

/// Phase named by a [`LifecycleError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    /// The only phase. A failed observation does not close the lease.
    Observe,
}

/// Category of a failed [`crate::OwnedRuntimeSession::observe`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleErrorKind {
    /// The call is not implemented on this target.
    Unsupported,
    /// The lease lock stayed busy until the observation budget expired.
    Busy,
    /// The observation budget's cancel flag was set, or a probe reported cancellation.
    Cancellation,
    /// The 60 second observation budget expired.
    Deadline,
    /// The running journal or listener evidence changed during the read.
    Conflict,
    /// The journal could not be read.
    Storage,
    /// The native ownership record could not be queried.
    Native,
    /// A root was not ready, or its listener evidence disagreed.
    ///
    /// This category revokes further observation on the same lease. It does
    /// not close the group.
    Listener,
    /// The plan, schema, command, or staging binding failed revalidation.
    Validation,
    /// The lease token was already invalidated, or the owner was missing.
    InvalidState,
}

/// Read-only observation failure.
///
/// A failed observation does not take the lease's close owner, except that
/// [`LifecycleErrorKind::Listener`] invalidates the lease token so a later
/// observe fails with [`LifecycleErrorKind::InvalidState`]. `Debug` prints
/// `kind` and `phase` only.
pub struct LifecycleError {
    pub(crate) kind: LifecycleErrorKind,
    pub(crate) phase: LifecyclePhase,
}

impl LifecycleError {
    /// Returns the observation failure category.
    pub fn kind(&self) -> LifecycleErrorKind {
        self.kind
    }

    /// Returns the observation phase. This is always [`LifecyclePhase::Observe`].
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
