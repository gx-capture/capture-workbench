#[cfg(all(test, windows))]
use super::native::{process_identity_from_handle, same_process_identity};
use std::io;
#[cfg(all(test, windows))]
use std::os::windows::io::AsRawHandle;
use std::process::{Command, ExitStatus};
use std::sync::{Arc, Mutex};

use super::error::{RuntimeCleanupError, RuntimeCleanupErrorKind};
use super::sidecar_process::OwnedSidecarProcess;

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
/// clone stops the attempt and ignores a cleanup error.
#[derive(Clone)]
pub struct OwnedRuntimeSession {
    inner: Arc<Mutex<OwnedRuntimeSessionState>>,
}

impl OwnedRuntimeSession {
    /// Spawns `command` and wraps it in an ownership token.
    ///
    /// On Windows the child is created suspended and without a window,
    /// assigned to a new kill-on-close job, and resumed only after that
    /// assignment is checked. A failed assignment stops the child before this
    /// returns. This does not probe readiness and writes nothing to disk.
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
