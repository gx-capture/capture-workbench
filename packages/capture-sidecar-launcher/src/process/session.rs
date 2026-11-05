#[cfg(all(test, windows))]
use super::native::{process_identity_from_handle, same_process_identity};
use std::io;
#[cfg(all(test, windows))]
use std::os::windows::io::AsRawHandle;
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::prepare::{ImmutableGroupPlan, PrepareError, PreparedGroup, ReconcileRefSink};

#[cfg(windows)]
use super::activation::{activate_prepared_group, close_running_owner, RunningActivationOwner};

#[cfg(windows)]
use super::error::{launch_error_from_private_failure, lifecycle_error};
use super::error::{
    CleanupError, CleanupErrorKind, CleanupPhase, CloseReason, GroupObservation, GroupProof,
    LaunchError, LifecycleError, LifecycleErrorKind, LifecyclePhase, RuntimeCleanupError,
    RuntimeCleanupErrorKind,
};
#[cfg(not(windows))]
use super::error::{LaunchErrorKind, LaunchPhase};
use super::sidecar_process::OwnedSidecarProcess;

/// A move-only, one-use live group lease.  Its token is invalidated before
/// close or drop starts, and the private native owner is then dropped through
/// the existing bounded Job/child fallback only.
pub struct GroupLease {
    token: std::sync::atomic::AtomicBool,
    #[cfg(windows)]
    pub(crate) owner: Mutex<Option<RunningActivationOwner>>,
}

impl GroupLease {
    #[cfg(windows)]
    pub(crate) fn new(owner: RunningActivationOwner) -> Self {
        Self {
            token: std::sync::atomic::AtomicBool::new(true),
            owner: Mutex::new(Some(owner)),
        }
    }

    fn invalidate(&self) {
        self.token
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

impl Drop for GroupLease {
    fn drop(&mut self) {
        // This is intentionally the first operation. Dropping the owner below
        // may invoke the native bounded fallback, but can never leave a valid
        // in-memory lease token during that work.
        self.invalidate();
    }
}

/// A public whole-group lifecycle owner. Legacy one-process methods remain
/// available on this type for migration; the R3 methods below are a separate
/// opaque group seam.

impl OwnedRuntimeSession {
    pub fn activate_group(prepared: PreparedGroup) -> Result<GroupLease, LaunchError> {
        #[cfg(not(windows))]
        {
            let _ = prepared;
            return Err(LaunchError {
                kind: LaunchErrorKind::Unsupported,
                phase: LaunchPhase::Preparation,
                no_resources: false,
            });
        }
        #[cfg(windows)]
        {
            match activate_prepared_group(prepared) {
                Ok(owner) => Ok(GroupLease::new(owner)),
                Err(failure) => Err(launch_error_from_private_failure(failure)),
            }
        }
    }

    pub fn observe(lease: &GroupLease) -> Result<GroupObservation, LifecycleError> {
        #[cfg(not(windows))]
        {
            let _ = lease;
            return Err(LifecycleError {
                kind: LifecycleErrorKind::Unsupported,
                phase: LifecyclePhase::Observe,
            });
        }
        #[cfg(windows)]
        {
            let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            observe_group_with_budget(lease, deadline, cancellation)
        }
    }

    pub fn close(lease: GroupLease, reason: CloseReason) -> Result<GroupProof, CleanupError> {
        #[cfg(not(windows))]
        {
            let _ = (lease, reason);
            return Err(CleanupError {
                kind: CleanupErrorKind::Unsupported,
                phase: CleanupPhase::Running,
            });
        }
        #[cfg(windows)]
        {
            let mut lease = lease;
            // Invalidate before extracting the owner so a concurrent observer
            // cannot begin after close has acquired its one-use authority.
            lease.invalidate();
            let owner = match lease.owner.get_mut() {
                Ok(slot) => slot.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            let Some(owner) = owner else {
                return Err(CleanupError {
                    kind: CleanupErrorKind::InvalidState,
                    phase: CleanupPhase::Running,
                    owner: None,
                });
            };
            let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            let _ = reason;
            close_running_owner(owner, deadline, cancellation)
        }
    }
}

#[cfg(windows)]
/// Observe through one caller-owned absolute budget.  Keeping the budget
/// outside the mutex acquisition makes contention itself bounded and ensures
/// a lock released before the deadline does not grant a fresh timeout after
/// admission.

pub(crate) fn observe_group_with_budget(
    lease: &GroupLease,
    deadline: std::time::Instant,
    cancellation: Arc<AtomicBool>,
) -> Result<GroupObservation, LifecycleError> {
    if std::time::Instant::now() >= deadline {
        return Err(lifecycle_error(LifecycleErrorKind::Deadline));
    }
    if !lease.token.load(std::sync::atomic::Ordering::Acquire) {
        return Err(LifecycleError {
            kind: LifecycleErrorKind::InvalidState,
            phase: LifecyclePhase::Observe,
        });
    }
    let mut owner = loop {
        match lease.owner.try_lock() {
            Ok(owner) => break owner,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                // Poisoned admission retains the owner in the lease; fail
                // closed without taking or dropping that owner.
                return Err(lifecycle_error(LifecycleErrorKind::InvalidState));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    return Err(lifecycle_error(LifecycleErrorKind::Busy));
                }
                std::thread::sleep(std::time::Duration::from_millis(10).min(remaining));
            }
        }
    };
    let owner = owner.as_mut().ok_or(LifecycleError {
        kind: LifecycleErrorKind::InvalidState,
        phase: LifecyclePhase::Observe,
    })?;
    // Recheck after admission: another observer may have invalidated authority.
    if !lease.token.load(Ordering::Acquire) {
        return Err(lifecycle_error(LifecycleErrorKind::InvalidState));
    }
    let result = owner.observe_public(deadline, cancellation);
    if let Err(error) = &result {
        // A failed readiness/listener check revokes observation authority.
        // Budget, cancellation, lock, journal and staging observation errors
        // alone do not establish failed readiness; they withhold this result
        // but preserve retry and the exact close owner.
        if error.kind == LifecycleErrorKind::Listener {
            lease.invalidate();
        }
    }
    result
}

// Fail-closed evidence returned after one legacy launch attempt has been stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeTerminationProof {
    pub root_pid: u32,
    pub root_reaped: bool,
    pub descendants_terminated: bool,
}

pub(crate) fn ensure_termination_proof(
    result: Result<RuntimeTerminationProof, RuntimeCleanupError>,
) -> Result<RuntimeTerminationProof, RuntimeCleanupError> {
    let proof = result?;
    if !proof.root_reaped || !proof.descendants_terminated {
        return Err(RuntimeCleanupError::new(
            proof.root_pid,
            RuntimeCleanupErrorKind::Descendants,
            "Owned runtime cleanup could not prove that the root and all descendants were stopped.",
        ));
    }
    Ok(proof)
}

/// Deep lifecycle module for one runtime launch attempt.
///
/// The underlying process is created suspended, assigned to a fresh
/// kill-on-close Job before resume, and never exposes a host-specific process
/// tree.  `monitor_root_exit` is the host polling seam for unexpected root
/// exits; it closes the same Job and only returns the observation after the
/// terminal proof succeeds. Failed proofs retain the same process/job handle
/// so a later call can retry cleanup.
pub(crate) struct OwnedRuntimeSessionState {
    process: Option<OwnedSidecarProcess>,
    root_exit: Option<ExitStatus>,
    proof: Option<RuntimeTerminationProof>,
    #[cfg(test)]
    cleanup_failures: usize,
}

/// A cloneable ownership token for one runtime launch attempt.
///
/// The launcher may retain one token while the host registers another token in
/// its authoritative state before readiness.  The underlying process/job is
/// released only after the final token proves cleanup, so a readiness failure
/// cannot strand the native ownership boundary in a local launcher scope.
#[derive(Clone)]
pub struct OwnedRuntimeSession {
    inner: Arc<Mutex<OwnedRuntimeSessionState>>,
}

impl OwnedRuntimeSession {
    /// Persists and verifies a complete group binding before any native root
    /// acquisition. The returned value is consumed by the later activation
    /// seam; external plan construction is intentionally still producer-only.
    pub fn prepare_group(
        plan: &ImmutableGroupPlan,
        sink: &dyn ReconcileRefSink,
    ) -> Result<PreparedGroup, PrepareError> {
        crate::prepare::prepare_group(plan, sink)
    }

    pub fn spawn(command: &mut Command) -> Result<Self, String> {
        Ok(Self {
            inner: Arc::new(Mutex::new(OwnedRuntimeSessionState {
                process: Some(OwnedSidecarProcess::spawn(command)?),
                root_exit: None,
                proof: None,
                #[cfg(test)]
                cleanup_failures: 0,
            })),
        })
    }

    pub fn id(&self) -> u32 {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .id()
    }

    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("owned runtime session lock is poisoned"))?;
        state.try_wait()
    }

    /// Observe a root exit and reclaim its descendants before returning it.
    ///
    /// A previously observed root exit is retried until the same ownership
    /// boundary can prove descendant cleanup. Observation alone is never
    /// reported as cleanup success.
    pub fn monitor_root_exit(&self) -> Result<Option<ExitStatus>, RuntimeCleanupError> {
        self.inner
            .lock()
            .map_err(|_| {
                RuntimeCleanupError::new(
                    0,
                    RuntimeCleanupErrorKind::Ownership,
                    "Owned runtime session lock is poisoned.",
                )
            })?
            .monitor_root_exit()
    }

    /// Stop this attempt exactly once; repeated calls return the same proof.
    pub fn terminate_and_prove(&self) -> Result<RuntimeTerminationProof, RuntimeCleanupError> {
        self.inner
            .lock()
            .map_err(|_| {
                RuntimeCleanupError::new(
                    0,
                    RuntimeCleanupErrorKind::Ownership,
                    "Owned runtime session lock is poisoned.",
                )
            })?
            .terminate_and_prove()
    }

    pub fn terminate(&self) -> Result<(), RuntimeCleanupError> {
        self.terminate_and_prove().map(|_| ())
    }

    #[cfg(test)]
    pub(crate) fn inject_cleanup_failure_for_test(&self) {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .cleanup_failures += 1;
    }

    #[cfg(all(test, windows))]
    pub(crate) fn active_processes_for_test(&self) -> Result<u32, String> {
        let state = self
            .inner
            .lock()
            .expect("owned runtime session lock is poisoned");
        state
            .process
            .as_ref()
            .map_or(Ok(0), OwnedSidecarProcess::active_processes)
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_job_termination_failure_for_test(&self) {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .process
            .as_mut()
            .expect("owned runtime process")
            .job
            .inject_termination_failure();
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_job_process_query_failure_for_test(&self) {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .process
            .as_mut()
            .expect("owned runtime process")
            .job
            .inject_process_query_failure();
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_process_termination_failure_after_first_for_test(&self) {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .process
            .as_mut()
            .expect("owned runtime process")
            .job
            .inject_process_termination_failure_after_first();
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_stale_descendant_snapshot_for_test(&self) {
        let mut state = self
            .inner
            .lock()
            .expect("owned runtime session lock is poisoned");
        let process = state.process.as_mut().expect("owned runtime process");
        let root_identity =
            process_identity_from_handle(process.child.as_raw_handle(), process.id())
                .expect("owned runtime root identity");
        let snapshot = process
            .job
            .owned_processes(None)
            .expect("owned runtime process snapshot");
        let descendants: Vec<_> = snapshot
            .into_iter()
            .filter(|identity| !same_process_identity(*identity, root_identity))
            .collect();
        assert!(
            !descendants.is_empty(),
            "expected a captured Job descendant"
        );
        process.job.inject_stale_process_snapshot(descendants);
    }
}

impl Drop for OwnedRuntimeSession {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            if let Ok(mut state) = self.inner.lock() {
                let _ = state.terminate_and_prove();
            }
        }
    }
}

impl OwnedRuntimeSessionState {
    fn id(&self) -> u32 {
        self.process
            .as_ref()
            .map(OwnedSidecarProcess::id)
            .or_else(|| self.proof.map(|proof| proof.root_pid))
            .expect("owned runtime session has no process identity")
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self.process.as_mut() {
            Some(process) => process.try_wait(),
            None => Ok(self.root_exit),
        }
    }

    fn monitor_root_exit(&mut self) -> Result<Option<ExitStatus>, RuntimeCleanupError> {
        if let Some(status) = self.root_exit {
            self.terminate_and_prove()?;
            return Ok(Some(status));
        }
        let status = self
            .process
            .as_mut()
            .ok_or_else(|| {
                RuntimeCleanupError::new(
                    self.proof.map_or(0, |proof| proof.root_pid),
                    RuntimeCleanupErrorKind::Ownership,
                    "Owned runtime session has no live process handle.",
                )
            })?
            .try_wait()
            .map_err(|error| {
                RuntimeCleanupError::new(
                    self.id(),
                    RuntimeCleanupErrorKind::Liveness,
                    format!("Owned runtime root liveness could not be read: {error}"),
                )
            })?;
        if let Some(status) = status {
            self.root_exit = Some(status);
            self.terminate_and_prove()?;
        }
        Ok(status)
    }

    fn terminate_and_prove(&mut self) -> Result<RuntimeTerminationProof, RuntimeCleanupError> {
        if let Some(proof) = self.proof {
            return Ok(proof);
        }
        #[cfg(test)]
        if self.cleanup_failures > 0 {
            self.cleanup_failures -= 1;
            return Err(RuntimeCleanupError::new(
                self.id(),
                RuntimeCleanupErrorKind::Injected,
                "Injected cleanup proof failure.",
            ));
        }
        let proof = {
            let process = self.process.as_mut().ok_or_else(|| {
                RuntimeCleanupError::new(
                    self.proof.map_or(0, |proof| proof.root_pid),
                    RuntimeCleanupErrorKind::Ownership,
                    "Owned runtime session lost its process ownership handle.",
                )
            })?;
            ensure_termination_proof(process.terminate_and_prove())?
        };
        // Release the process and Job Object only after proof succeeds. Any
        // error above leaves the same handle in `self.process` for retry.
        self.process.take();
        self.proof = Some(proof);
        Ok(proof)
    }
}
