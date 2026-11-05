#[cfg(windows)]
pub(crate) mod activation;
pub(crate) mod error;
#[cfg(windows)]
pub(crate) mod listener;
pub(crate) mod native;
pub(crate) mod session;
pub(crate) mod sidecar_process;

#[cfg(all(test, windows))]
pub(crate) mod fixture;

#[cfg(test)]
mod tests;

pub use error::{
    ActivationCleanupObservation, CleanupError, CleanupErrorKind, CleanupPhase, CloseReason,
    GroupLifecycleState, GroupObservation, GroupProof, LaunchError, LaunchErrorKind, LaunchPhase,
    LifecycleError, LifecycleErrorKind, LifecyclePhase, RuntimeCleanupError,
    RuntimeCleanupErrorKind, SemanticActivationCleanupState,
};
pub use session::{GroupLease, OwnedRuntimeSession, RuntimeTerminationProof};
pub use sidecar_process::OwnedSidecarProcess;

#[cfg(all(test, windows))]
pub(crate) use activation::{
    acquire_suspended_for_activation_with_budget, activate_prepared_group_with_budget,
    ActivationLaunchOwner, ClosingActivationOwner, ClosingCleanupFailureKind,
    ClosingStagingReleaseFailureKind, ClosingTransitionFailureKind, LaunchingActivationOwner,
    PrivateActivationFailureKind, RunningActivationOwner, RunningPromotionFailureKind,
    TerminalJoinFailureKind,
};

#[cfg(all(test, windows))]
pub(crate) use activation::cleanup_activation_for_test;

#[cfg(windows)]
pub(crate) use listener::{observe_restart_native, RestartNativeObservationError};

#[cfg(all(test, windows))]
pub(crate) use fixture::inject_cancellation_before_resume_root_for_test;
