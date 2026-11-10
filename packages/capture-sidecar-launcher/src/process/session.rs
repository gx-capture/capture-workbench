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

/// Move-only lease for one live runtime group.
///
/// [`crate::OwnedRuntimeSession::observe`] borrows it.
/// [`crate::OwnedRuntimeSession::close`] consumes it. Drop invalidates the
/// lease token and then drops the private owner, which can stop the owned
/// job. Drop does not return a [`GroupProof`].
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
    /// Starts the roots in `prepared` and returns a live lease.
    ///
    /// On Windows this consumes the prepared group, creates its staging
    /// scope, starts each root, and returns only after the running journal
    /// record is written. The call uses one 60 second budget and the cancel
    /// flag from [`PreparedGroup::cancel_handle`]. The bearer token is not
    /// logged or written to the journal. On failure the returned
    /// [`LaunchError`] keeps the cleanup owner; call
    /// [`LaunchError::retry_cleanup`] instead of dropping it unnoticed.
    ///
    /// # Errors
    ///
    /// On Windows the error kind can be [`crate::LaunchErrorKind::Preparation`],
    /// [`crate::LaunchErrorKind::Staging`], [`crate::LaunchErrorKind::Native`],
    /// [`crate::LaunchErrorKind::Storage`], [`crate::LaunchErrorKind::Cancellation`],
    /// [`crate::LaunchErrorKind::Deadline`], or [`crate::LaunchErrorKind::Reconcile`].
    /// On any other target the kind is [`crate::LaunchErrorKind::Unsupported`] and
    /// the phase is [`crate::LaunchPhase::Preparation`].
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

    /// Reads one running group's readiness without taking its close owner.
    ///
    /// On Windows this uses a 60 second budget, rechecks the journal, schema
    /// digest, listeners, and strict readiness probe, and returns an
    /// observation whose state is [`crate::GroupLifecycleState::Running`]. It does
    /// not consult [`PreparedGroup::cancel_handle`]. A
    /// [`LifecycleErrorKind::Listener`] result invalidates the lease token so
    /// a later observe fails, and it still leaves close authority with the
    /// caller. Other failures leave the token valid.
    ///
    /// # Errors
    ///
    /// Returns [`LifecycleError`]. On Windows the kind can be
    /// [`LifecycleErrorKind::Busy`], [`LifecycleErrorKind::Cancellation`],
    /// [`LifecycleErrorKind::Deadline`], [`LifecycleErrorKind::Conflict`],
    /// [`LifecycleErrorKind::Storage`], [`LifecycleErrorKind::Native`],
    /// [`LifecycleErrorKind::Listener`], [`LifecycleErrorKind::Validation`],
    /// or [`LifecycleErrorKind::InvalidState`]. On any other target the kind
    /// is [`LifecycleErrorKind::Unsupported`]. The phase is
    /// [`LifecyclePhase::Observe`].
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

    /// Stops a live group and returns its terminal proof.
    ///
    /// Consumes `lease` and invalidates its token before taking the owner, so
    /// a new observation cannot start. On Windows this uses a 60 second
    /// budget, stops the owned processes, releases listeners and staging, and
    /// writes the terminal journal record. `reason` selects neither a
    /// different transition nor a journal field; both
    /// [`CloseReason`] variants follow the same close path and neither is
    /// stored.
    ///
    /// # Errors
    ///
    /// Returns [`CleanupError`]. On Windows the kind can be any
    /// [`CleanupErrorKind`] other than [`CleanupErrorKind::Unsupported`].
    /// [`CleanupErrorKind::InvalidState`] means the lease no longer held an
    /// owner. On any other target the kind is
    /// [`CleanupErrorKind::Unsupported`] and the phase is
    /// [`CleanupPhase::Running`]. Call [`CleanupError::retry`] to resume a
    /// Windows failure that still holds an owner.
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

/// Evidence from one completed single-process stop.
///
/// [`OwnedRuntimeSession::terminate`] returns success only when both flags
/// are true. On targets other than Windows, `descendants_terminated` stays
/// false because there is no job object to query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeTerminationProof {
    /// Process id of the root that was stopped.
    pub root_pid: u32,
    /// The root was waited on after termination.
    pub root_reaped: bool,
    /// The job reported no remaining processes.
    ///
    /// This is false on targets other than Windows.
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

/// Cloneable ownership token for one runtime launch attempt.
///
/// [`crate::launch_sidecar_with_observer`] keeps one clone and passes another
/// to the host before readiness is probed. The process and its Windows job
/// are released only after the last clone proves cleanup. Dropping that last
/// clone stops the attempt and ignores a cleanup error. Group methods on
/// this type are a separate lifecycle from [`Self::spawn`].
#[derive(Clone)]
pub struct OwnedRuntimeSession {
    inner: Arc<Mutex<OwnedRuntimeSessionState>>,
}

impl OwnedRuntimeSession {
    /// Writes the group journal and asks `sink` to store the binding.
    ///
    /// Takes the journal lock under `plan`'s producer root, creates the
    /// journal file when it is absent, writes the address index, and calls
    /// [`ReconcileRefSink::persist`], [`ReconcileRefSink::read_back`], and
    /// [`ReconcileRefSink::verify`]. It then compare-and-swaps the journal to
    /// the prepared-bound record. The bearer token is not written to the
    /// journal, the index, or the sink record. No listener or root process is
    /// started. A failure after the initial journal write leaves that file in
    /// place.
    ///
    /// # Errors
    ///
    /// Returns [`PrepareError::InvalidPlan`] when the plan or address index
    /// is incomplete, [`PrepareError::InvalidTimestamp`] when a journal
    /// timestamp is rejected, [`PrepareError::ReferenceGeneration`] when the
    /// attempt id cannot be generated, and [`PrepareError::InvalidBinding`]
    /// when the sink receipt does not match the binding.
    /// [`PrepareError::Binding`] carries the sink's [`crate::PersistError`].
    /// Journal failures are [`PrepareError::JournalAlreadyExists`],
    /// [`PrepareError::JournalConflict`], [`PrepareError::JournalCorrupt`],
    /// [`PrepareError::JournalTooLarge`], [`PrepareError::JournalAmbiguous`],
    /// or [`PrepareError::JournalUnavailable`].
    pub fn prepare_group(
        plan: &ImmutableGroupPlan,
        sink: &dyn ReconcileRefSink,
    ) -> Result<PreparedGroup, PrepareError> {
        crate::prepare::prepare_group(plan, sink)
    }

    /// Spawns `command` and wraps it in an ownership token.
    ///
    /// On Windows the child is created suspended and without a window,
    /// assigned to a new kill-on-close job, and resumed only after that
    /// assignment is checked. A failed assignment stops the child before this
    /// returns. This does not probe readiness and does not write a journal.
    ///
    /// # Errors
    ///
    /// Returns `Err(String)` when the process cannot be started, the job
    /// cannot be created or assigned, or cleanup of a rejected child fails.
    /// The cleanup failure is appended to the assignment error.
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

    /// Returns the root process id for this attempt.
    ///
    /// After a proven stop, this is the id stored on the termination proof.
    /// Panics if the ownership lock is poisoned or no process id was recorded.
    pub fn id(&self) -> u32 {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .id()
    }

    /// Polls the root without stopping it.
    ///
    /// `Ok(None)` means the root is still running. After a proven stop, this
    /// returns the stored exit status and does not touch a process handle.
    ///
    /// # Errors
    ///
    /// Returns [`std::io::Error`] when the ownership lock is poisoned or the
    /// operating system cannot query the child.
    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("owned runtime session lock is poisoned"))?;
        state.try_wait()
    }

    /// Returns a root exit only after descendant cleanup is proven.
    ///
    /// `Ok(None)` means the root is still running and nothing was killed. When
    /// the root has exited, this stops the owned job and proves that the root
    /// and its descendants are gone before returning the status. A previously
    /// seen exit is retried until that proof succeeds. The process handle
    /// stays available when the proof fails.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeCleanupError`] with
    /// [`RuntimeCleanupErrorKind::Ownership`],
    /// [`RuntimeCleanupErrorKind::Liveness`],
    /// [`RuntimeCleanupErrorKind::Termination`],
    /// [`RuntimeCleanupErrorKind::Reap`], or
    /// [`RuntimeCleanupErrorKind::Descendants`].
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

    /// Stops this attempt and returns the proof.
    ///
    /// The first successful call stops the job, waits for the root, and checks
    /// descendants. Later calls return that same proof and do not signal the
    /// process again. A failed call keeps the handle for a retry.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeCleanupError`] with
    /// [`RuntimeCleanupErrorKind::Ownership`],
    /// [`RuntimeCleanupErrorKind::Liveness`],
    /// [`RuntimeCleanupErrorKind::Termination`],
    /// [`RuntimeCleanupErrorKind::Reap`], or
    /// [`RuntimeCleanupErrorKind::Descendants`].
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

    /// Stops this attempt and discards the proof.
    ///
    /// Success requires both [`RuntimeTerminationProof::root_reaped`] and
    /// [`RuntimeTerminationProof::descendants_terminated`]. On targets other
    /// than Windows the descendant flag stays false, so this call fails after
    /// the root has been reaped.
    ///
    /// # Errors
    ///
    /// Returns the same [`RuntimeCleanupError`] kinds as
    /// [`Self::terminate_and_prove`]. A proof that does not cover both the
    /// root and its descendants is [`RuntimeCleanupErrorKind::Descendants`].
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
