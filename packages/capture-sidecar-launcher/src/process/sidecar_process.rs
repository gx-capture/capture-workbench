use std::{
    io,
    process::{Child, Command, ExitStatus},
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

use super::error::{RuntimeCleanupError, RuntimeCleanupErrorKind};
#[cfg(windows)]
use super::native::{
    process_identity_from_handle, prove_process_terminated, resume_suspended_process,
    terminate_assigned_suspended_child, terminate_process_with_proof, terminate_unassigned_child,
    WindowsJob,
};
use super::session::{ensure_termination_proof, RuntimeTerminationProof};

/// One sidecar root process and, on Windows, its job-object boundary.
///
/// Prefer [`crate::OwnedRuntimeSession`] for a launch that must be cloned
/// before readiness. This value is the single-owner handle underneath that
/// token. On Windows the job is kill-on-close, so dropping this value closes
/// the job handle and the system kills processes still in the job. That drop
/// does not wait or return a proof. Call [`Self::terminate`] or
/// [`Self::terminate_and_prove`] to collect one.
pub struct OwnedSidecarProcess {
    pub(crate) child: Child,
    #[cfg(windows)]
    pub(crate) job: WindowsJob,
    #[cfg(all(test, windows))]
    pub(crate) assignment_verified_before_resume: bool,
}

impl OwnedSidecarProcess {
    /// Spawns `command` and, on Windows, places it in a kill-on-close job.
    ///
    /// On Windows the child is created suspended and without a window. It is
    /// resumed only after the job assignment has been checked. If assignment
    /// or resume fails, this stops that child before returning. Nothing is
    /// written to disk and readiness is not probed.
    ///
    /// # Errors
    ///
    /// Returns `Err(String)` when the process cannot be started, the job
    /// cannot be created or assigned, or cleanup of that rejected child also
    /// fails. A cleanup failure is appended to the assignment error.
    pub fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(windows)]
        let mut job = WindowsJob::new()?;
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);

        let mut child = command
            .spawn()
            .map_err(|error| format!("Capture runtime could not be started: {error}"))?;
        #[cfg(windows)]
        if let Err(error) = job.assign(&child) {
            return match terminate_unassigned_child(&mut child) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error} The unassigned runtime root also failed cleanup: {cleanup_error}"
                )),
            };
        }
        #[cfg(windows)]
        if let Err(error) = job.verify_assignment(&child) {
            return match terminate_assigned_suspended_child(&mut job, &mut child) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error} The assigned suspended runtime root also failed cleanup: {cleanup_error}"
                )),
            };
        }
        #[cfg(all(test, windows))]
        let assignment_verified_before_resume = true;
        #[cfg(windows)]
        if let Err(error) = resume_suspended_process(&child) {
            return match terminate_assigned_suspended_child(&mut job, &mut child) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error} The assigned suspended runtime root also failed cleanup: {cleanup_error}"
                )),
            };
        }
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
            #[cfg(all(test, windows))]
            assignment_verified_before_resume,
        })
    }

    /// Polls the root without stopping it.
    ///
    /// `Ok(None)` means the root is still running.
    ///
    /// # Errors
    ///
    /// Returns [`std::io::Error`] when the operating system cannot query the child.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Stops the owned process tree and requires a complete proof.
    ///
    /// Success requires the root to be reaped and descendants to be gone. On
    /// targets other than Windows the descendant flag stays false, so this
    /// fails after the root has been reaped.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeCleanupError`]. The kind can be
    /// [`RuntimeCleanupErrorKind::Ownership`],
    /// [`RuntimeCleanupErrorKind::Liveness`],
    /// [`RuntimeCleanupErrorKind::Termination`],
    /// [`RuntimeCleanupErrorKind::Reap`], or
    /// [`RuntimeCleanupErrorKind::Descendants`].
    pub fn terminate(&mut self) -> Result<(), RuntimeCleanupError> {
        ensure_termination_proof(self.terminate_and_prove()).map(|_| ())
    }

    /// Stops the owned job and returns the proof, including a failed descendant check.
    ///
    /// On Windows this terminates the job, proves the root from its launch
    /// handle, waits for that root, and queries remaining job processes. If
    /// job termination fails, it kills the root from its launch handle and
    /// then the owned descendants. The returned proof can have
    /// [`crate::RuntimeTerminationProof::descendants_terminated`] set to
    /// false. [`Self::terminate`] turns that into an error. On any other
    /// target the root is killed and waited on, and the descendant flag is
    /// false.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeCleanupError`] with
    /// [`RuntimeCleanupErrorKind::Ownership`],
    /// [`RuntimeCleanupErrorKind::Liveness`],
    /// [`RuntimeCleanupErrorKind::Termination`],
    /// [`RuntimeCleanupErrorKind::Reap`], or
    /// [`RuntimeCleanupErrorKind::Descendants`] when the proof cannot be
    /// collected. A collected proof whose descendant flag is false is `Ok`.
    pub fn terminate_and_prove(&mut self) -> Result<RuntimeTerminationProof, RuntimeCleanupError> {
        let root_pid = self.id();
        #[cfg(windows)]
        {
            let root_handle = self.child.as_raw_handle();
            let root_identity = process_identity_from_handle(root_handle, root_pid).map_err(|error| {
                RuntimeCleanupError::new(
                    root_pid,
                    RuntimeCleanupErrorKind::Ownership,
                    format!(
                        "Owned runtime root creation identity could not be captured before cleanup: {error}"
                    ),
                )
            })?;
            if self.job.terminate().is_ok() {
                prove_process_terminated(root_handle, root_identity).map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Liveness,
                        format!(
                            "Owned runtime root termination could not be proven from its launch handle: {error}"
                        ),
                    )
                })?;
                self.child.wait().map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Reap,
                        format!("Owned runtime root process could not be reaped: {error}"),
                    )
                })?;
                let descendants_terminated = self.job.active_processes().map_err(|error| {
                    RuntimeCleanupError::new(root_pid, RuntimeCleanupErrorKind::Descendants, error)
                })? == 0;
                return Ok(RuntimeTerminationProof {
                    root_pid,
                    root_reaped: true,
                    descendants_terminated,
                });
            }
            let root_exited = self.child.try_wait().map_err(|error| {
                RuntimeCleanupError::new(
                    root_pid,
                    RuntimeCleanupErrorKind::Liveness,
                    format!(
                        "Owned runtime root liveness could not be proven before Job fallback: {error}"
                    ),
                )
            })?.is_some();
            if root_exited {
                prove_process_terminated(root_handle, root_identity).map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Liveness,
                        format!(
                            "Owned runtime root exit could not be proven from its launch handle: {error}"
                        ),
                    )
                })?;
            } else {
                terminate_process_with_proof(root_handle, root_identity).map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Termination,
                        format!(
                            "Owned runtime root could not be terminated from its launch handle: {error}"
                        ),
                    )
                })?;
            }
            self.child.wait().map_err(|error| {
                RuntimeCleanupError::new(
                    root_pid,
                    RuntimeCleanupErrorKind::Reap,
                    format!("Owned runtime root process could not be reaped: {error}"),
                )
            })?;
            self.job
                .terminate_owned_processes(root_identity)
                .map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Descendants,
                        format!(
                            "Owned runtime Job termination failed; descendant ownership could not be proven: {error}"
                        ),
                    )
                })?;
            let descendants_terminated = self.job.active_processes().map_err(|error| {
                RuntimeCleanupError::new(root_pid, RuntimeCleanupErrorKind::Descendants, error)
            })? == 0;
            Ok(RuntimeTerminationProof {
                root_pid,
                root_reaped: true,
                descendants_terminated,
            })
        }
        #[cfg(not(windows))]
        {
            if self
                .child
                .try_wait()
                .map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Liveness,
                        format!("Owned runtime root liveness could not be read: {error}"),
                    )
                })?
                .is_none()
            {
                self.child.kill().map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Termination,
                        format!("Owned runtime root process could not be stopped: {error}"),
                    )
                })?;
            }
            self.child
                .wait()
                .map(|_| ())
                .map(|_| RuntimeTerminationProof {
                    root_pid,
                    root_reaped: true,
                    descendants_terminated: false,
                })
                .map_err(|error| {
                    RuntimeCleanupError::new(
                        root_pid,
                        RuntimeCleanupErrorKind::Reap,
                        format!("Owned runtime root process could not be reaped: {error}"),
                    )
                })
        }
    }

    /// Returns the root process id held by this ownership boundary.
    ///
    /// The id is not a connection credential and it does not reveal the
    /// bearer token.
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    #[cfg(all(test, windows))]
    pub(crate) fn active_processes(&self) -> Result<u32, String> {
        self.job.active_processes()
    }

    #[cfg(all(test, windows))]
    pub(crate) fn breakaway_allowed(&self) -> Result<bool, String> {
        self.job.breakaway_allowed()
    }
}
