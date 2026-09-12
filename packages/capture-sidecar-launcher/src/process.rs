use std::{
    fmt, io,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
};

use crate::prepare::{ImmutableGroupPlan, PrepareError, PreparedGroup, ReconcileRefSink};

#[cfg(windows)]
use std::collections::HashMap;

#[cfg(windows)]
use std::{
    ffi::{c_void, OsString},
    mem::size_of,
    os::windows::{ffi::OsStringExt, io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    ptr,
};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER,
        ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, INVALID_HANDLE_VALUE, WAIT_FAILED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::SystemInformation::GetSystemDirectoryW,
    System::Threading::{
        GetExitCodeProcess, GetProcessIdOfThread, GetProcessTimes, OpenProcess, OpenThread,
        ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    },
};

#[cfg(all(test, windows))]
use windows_sys::Win32::{
    System::JobObjects::{JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK},
    System::Threading::{
        CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, PROCESS_INFORMATION, STARTUPINFOW,
    },
};

#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct OwnedProcessIdentity {
    pid: u32,
    creation_time: u64,
}

#[cfg(any(windows, test))]
fn same_process_identity(expected: OwnedProcessIdentity, observed: OwnedProcessIdentity) -> bool {
    expected.pid == observed.pid && expected.creation_time == observed.creation_time
}

/// A sidecar root process plus its Windows job-object ownership boundary.
pub struct OwnedSidecarProcess {
    child: Child,
    #[cfg(windows)]
    job: WindowsJob,
    #[cfg(all(test, windows))]
    assignment_verified_before_resume: bool,
}

impl OwnedSidecarProcess {
    /// Spawns a command suspended, assigns it to a kill-on-close job, then resumes it.
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

    /// Checks whether the root process has exited without blocking.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Terminates the exact process tree owned by this launch attempt.
    pub fn terminate(&mut self) -> Result<(), RuntimeCleanupError> {
        ensure_termination_proof(self.terminate_and_prove()).map(|_| ())
    }

    /// Terminates the owned job and returns fail-closed cleanup evidence.
    pub fn terminate_and_prove(&mut self) -> Result<RuntimeTerminationProof, RuntimeCleanupError> {
        let root_pid = self.id();
        #[cfg(windows)]
        {
            let root_handle = self.child.as_raw_handle() as *mut c_void;
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
            return Ok(RuntimeTerminationProof {
                root_pid,
                root_reaped: true,
                descendants_terminated,
            });
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

    /// Returns the exact root PID held by this ownership boundary.
    ///
    /// Hosts use this only for bounded process-lifecycle verification; it does
    /// not expose any connection credentials or runtime payload.
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    #[cfg(all(test, windows))]
    fn active_processes(&self) -> Result<u32, String> {
        self.job.active_processes()
    }

    #[cfg(all(test, windows))]
    fn breakaway_allowed(&self) -> Result<bool, String> {
        self.job.breakaway_allowed()
    }
}

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
    fn new(root_pid: u32, kind: RuntimeCleanupErrorKind, detail: impl Into<String>) -> Self {
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

/// Fail-closed evidence returned after one launch attempt has been stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeTerminationProof {
    pub root_pid: u32,
    pub root_reaped: bool,
    pub descendants_terminated: bool,
}

fn ensure_termination_proof(
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
struct OwnedRuntimeSessionState {
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
    fn inject_cleanup_failure_for_test(&self) {
        self.inner
            .lock()
            .expect("owned runtime session lock is poisoned")
            .cleanup_failures += 1;
    }

    #[cfg(all(test, windows))]
    fn active_processes_for_test(&self) -> Result<u32, String> {
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
    fn inject_job_termination_failure_for_test(&self) {
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
    fn inject_job_process_query_failure_for_test(&self) {
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
    fn inject_process_termination_failure_after_first_for_test(&self) {
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
    fn inject_stale_descendant_snapshot_for_test(&self) {
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

#[cfg(windows)]
fn read_process_identity_for_job_member(
    pid: u32,
    exited_root: Option<OwnedProcessIdentity>,
) -> Result<Option<(OwnedProcessIdentity, Option<ScopedWindowsHandle>)>, String> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        if error == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        // A root that has already exited may remain in the Job process list
        // while its Child handle is still retained.  The exact creation
        // identity came from that handle before fallback, so an access-denied
        // reopen for that same identity is safe to ignore.  Descendant and
        // unknown access-denied errors remain fail-closed below.
        if error == ERROR_ACCESS_DENIED {
            if let Some(root) = exited_root {
                if root.pid == pid {
                    return Ok(Some((root, None)));
                }
            }
        }
        return Err(format!(
            "The owned runtime process could not be opened for identity capture: {}",
            io::Error::last_os_error()
        ));
    }
    let handle = ScopedWindowsHandle(handle as usize);
    let identity = process_identity_from_handle(handle.raw(), pid)?;
    Ok(Some((identity, Some(handle))))
}

#[cfg(windows)]
fn open_process_for_termination(pid: u32) -> Result<ScopedWindowsHandle, String> {
    let desired_access =
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
    let handle = unsafe { OpenProcess(desired_access, 0, pid) };
    if handle.is_null() {
        return Err(format!(
            "The owned runtime process could not be opened for termination: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(ScopedWindowsHandle(handle as usize))
}

#[cfg(windows)]
fn process_identity_from_handle(
    handle: *mut c_void,
    pid: u32,
) -> Result<OwnedProcessIdentity, String> {
    let mut creation_time = FILETIME::default();
    let mut exit_time = FILETIME::default();
    let mut kernel_time = FILETIME::default();
    let mut user_time = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            handle,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    } == 0
    {
        return Err(format!(
            "The owned runtime process creation identity could not be read: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(OwnedProcessIdentity {
        pid,
        creation_time: (u64::from(creation_time.dwHighDateTime) << 32)
            | u64::from(creation_time.dwLowDateTime),
    })
}

#[cfg(windows)]
fn prove_process_terminated(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
) -> Result<(), String> {
    let observed = process_identity_from_handle(handle, expected.pid)?;
    classify_terminated_process(handle, expected, observed)
}

#[cfg(windows)]
fn terminate_process_with_proof(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
) -> Result<(), String> {
    if unsafe { TerminateProcess(handle, 1) } == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_ACCESS_DENIED {
            return Err(format!(
                "The owned runtime process {} could not be terminated: Windows error {error}.",
                expected.pid,
            ));
        }
    }
    prove_process_terminated(handle, expected)
}

/// Proves that a process handle is already terminated after a termination
/// attempt reported `ERROR_ACCESS_DENIED` (or after a successful termination).
///
/// Windows can report `ERROR_ACCESS_DENIED` when `TerminateProcess` races with
/// a short-lived process exiting.  The error is recoverable only when the
/// handle still belongs to the exact process we opened, is signaled, and has a
/// terminal exit code.  Every other observation remains fail-closed.
#[cfg(windows)]
fn classify_terminated_process(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
) -> Result<(), String> {
    let wait_state = unsafe { WaitForSingleObject(handle, 5_000) };
    let exit_code = if wait_state == WAIT_OBJECT_0 {
        let mut exit_code = 0_u32;
        if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
            return Err(format!(
                "The owned runtime process exit code could not be queried: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(exit_code)
    } else {
        Err(match wait_state {
            WAIT_TIMEOUT => "The owned runtime process did not exit after termination.",
            WAIT_FAILED => "The owned runtime process wait failed.",
            _ => "The owned runtime process returned an unknown wait state.",
        }
        .to_string())
    }?;

    classify_terminated_observation(expected, observed, wait_state, Ok(exit_code))
}

#[cfg(any(windows, test))]
fn classify_terminated_observation(
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
    wait_state: u32,
    exit_code: Result<u32, String>,
) -> Result<(), String> {
    if !same_process_identity(expected, observed) {
        return Err(format!(
            "The owned runtime process {} creation identity changed before termination.",
            expected.pid
        ));
    }
    if wait_state != 0 {
        return Err(match wait_state {
            0x0000_0102 => "The owned runtime process did not exit after termination.",
            0xffff_ffff => "The owned runtime process wait failed.",
            _ => "The owned runtime process returned an unknown wait state.",
        }
        .into());
    }
    let exit_code = exit_code?;
    if exit_code == 259 {
        return Err("The owned runtime process exit code is still active.".into());
    }
    Ok(())
}

#[cfg(windows)]
struct WindowsJob {
    handle: usize,
    // Retain the exact process objects captured from each Job snapshot so a
    // member that disappears before the next snapshot can still be proven
    // terminal without trusting a PID reopen alone.
    captured_process_handles: HashMap<OwnedProcessIdentity, ScopedWindowsHandle>,
    #[cfg(test)]
    termination_failures: usize,
    #[cfg(test)]
    process_query_failures: usize,
    #[cfg(test)]
    process_termination_failure_at: Option<usize>,
    #[cfg(test)]
    process_termination_attempts: usize,
    #[cfg(test)]
    stale_process_snapshot: Option<Vec<OwnedProcessIdentity>>,
}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "An owned runtime process job could not be created: {}",
                io::Error::last_os_error()
            ));
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!(
                "The owned runtime process job could not be configured: {error}"
            ));
        }
        Ok(Self {
            handle: handle as usize,
            captured_process_handles: HashMap::new(),
            #[cfg(test)]
            termination_failures: 0,
            #[cfg(test)]
            process_query_failures: 0,
            #[cfg(test)]
            process_termination_failure_at: None,
            #[cfg(test)]
            process_termination_attempts: 0,
            #[cfg(test)]
            stale_process_snapshot: None,
        })
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        let assigned = unsafe {
            AssignProcessToJobObject(
                self.handle as *mut c_void,
                child.as_raw_handle() as *mut c_void,
            )
        };
        if assigned == 0 {
            Err(format!(
                "Capture runtime could not be attached to its owned process job: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    fn verify_assignment(&self, child: &Child) -> Result<(), String> {
        let mut in_job = 0_i32;
        let verified = unsafe {
            IsProcessInJob(
                child.as_raw_handle() as *mut c_void,
                self.handle as *mut c_void,
                &mut in_job,
            )
        };
        if verified == 0 {
            return Err(format!(
                "Capture runtime process-job assignment could not be verified: {}",
                io::Error::last_os_error()
            ));
        }
        if in_job == 0 {
            return Err("Capture runtime root process was not assigned to its owned Job.".into());
        }
        Ok(())
    }

    fn terminate(&mut self) -> Result<(), String> {
        #[cfg(test)]
        if self.termination_failures > 0 {
            self.termination_failures -= 1;
            return Err("Injected Job termination failure.".into());
        }
        let terminated = unsafe { TerminateJobObject(self.handle as *mut c_void, 1) };
        if terminated == 0 {
            Err(format!(
                "Owned runtime process job did not stop cleanly: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    fn active_processes(&self) -> Result<u32, String> {
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle as *mut c_void,
                JobObjectBasicAccountingInformation,
                (&mut information as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        };
        if queried == 0 {
            Err(format!(
                "The owned runtime process job could not be queried: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(information.ActiveProcesses)
        }
    }

    fn owned_processes(
        &mut self,
        exited_root: Option<OwnedProcessIdentity>,
    ) -> Result<Vec<OwnedProcessIdentity>, String> {
        #[cfg(test)]
        if let Some(snapshot) = self.stale_process_snapshot.take() {
            return Ok(snapshot);
        }
        #[cfg(test)]
        if self.process_query_failures > 0 {
            self.process_query_failures -= 1;
            return Err("Injected Job process query failure.".into());
        }
        const INITIAL_CAPACITY: usize = 16;
        const MAX_CAPACITY: usize = 16_384;
        let mut capacity = INITIAL_CAPACITY;
        loop {
            let bytes = size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
                .checked_add((capacity - 1).saturating_mul(size_of::<usize>()))
                .ok_or_else(|| "Owned runtime Job process list size overflowed.".to_string())?;
            let words = (bytes + size_of::<usize>() - 1) / size_of::<usize>();
            let mut buffer = vec![0usize; words];
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle as *mut c_void,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast::<c_void>(),
                    (buffer.len() * size_of::<usize>()) as u32,
                    ptr::null_mut(),
                )
            };
            if queried == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_INSUFFICIENT_BUFFER && capacity < MAX_CAPACITY {
                    capacity = (capacity * 2).min(MAX_CAPACITY);
                    continue;
                }
                return Err(format!(
                    "The owned runtime Job process list could not be queried: Windows error {error}."
                ));
            }
            let information =
                unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let assigned = information.NumberOfAssignedProcesses as usize;
            let listed = information.NumberOfProcessIdsInList as usize;
            if listed > capacity || assigned > listed {
                if assigned > MAX_CAPACITY {
                    return Err(
                        "The owned runtime Job process list exceeded the safe enumeration limit."
                            .into(),
                    );
                }
                capacity = assigned.max(capacity.saturating_mul(2)).min(MAX_CAPACITY);
                continue;
            }
            let process_ids =
                unsafe { std::slice::from_raw_parts(information.ProcessIdList.as_ptr(), listed) };
            return process_ids
                .iter()
                .filter_map(|raw_pid| {
                    let pid = u32::try_from(*raw_pid)
                        .map_err(|_| "The owned runtime Job returned an invalid process ID.");
                    let pid = match pid {
                        Ok(pid) => pid,
                        Err(error) => return Some(Err(error.to_string())),
                    };
                    match read_process_identity_for_job_member(pid, exited_root) {
                        Ok(Some((identity, handle))) => {
                            if let Some(handle) = handle {
                                self.captured_process_handles
                                    .entry(identity)
                                    .or_insert(handle);
                            }
                            Some(Ok(identity))
                        }
                        Ok(None) => None,
                        Err(error) => Some(Err(error)),
                    }
                })
                .collect();
        }
    }

    fn terminate_owned_processes(
        &mut self,
        root_identity: OwnedProcessIdentity,
    ) -> Result<(), String> {
        const MAX_PASSES: usize = 20;
        let exited_root = Some(root_identity);
        for _ in 0..MAX_PASSES {
            let mut processes = self.owned_processes(exited_root)?;
            processes.retain(|process| !same_process_identity(*process, root_identity));
            if processes.is_empty() {
                return Ok(());
            }
            for process in processes {
                self.terminate_owned_process(process, exited_root)?;
            }
            let mut remaining = self.owned_processes(exited_root)?;
            remaining.retain(|process| !same_process_identity(*process, root_identity));
            if remaining.is_empty() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Err(
            "The owned runtime Job still reports active processes after termination attempts."
                .into(),
        )
    }

    fn terminate_owned_process(
        &mut self,
        expected: OwnedProcessIdentity,
        exited_root: Option<OwnedProcessIdentity>,
    ) -> Result<(), String> {
        #[cfg(test)]
        {
            let attempt = self.process_termination_attempts;
            self.process_termination_attempts += 1;
            if self.process_termination_failure_at == Some(attempt) {
                self.process_termination_failure_at = None;
                return Err("Injected owned process termination failure.".into());
            }
        }
        let current = self.owned_processes(exited_root)?;
        if !current
            .iter()
            .copied()
            .any(|observed| same_process_identity(expected, observed))
        {
            if current.iter().any(|observed| observed.pid == expected.pid) {
                // The PID is now occupied by a different process in this Job;
                // the next pass will handle its newly captured identity.
                return Ok(());
            }
            let result = self.prove_missing_process_terminated(expected);
            return match result {
                Ok(()) => Ok(()),
                Err(error) => Err(format!(
                    "The owned runtime process remained alive outside its Job; cleanup is retained: {error}"
                )),
            };
        }
        let handle = open_process_for_termination(expected.pid)?;
        let observed = process_identity_from_handle(handle.raw(), expected.pid)?;
        if !same_process_identity(expected, observed) {
            return Err(format!(
                "The owned runtime process {} creation identity changed before termination.",
                expected.pid
            ));
        }
        if unsafe { TerminateProcess(handle.raw(), 1) } == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_ACCESS_DENIED {
                return classify_terminated_process(handle.raw(), expected, observed);
            }
            return Err(format!(
                "The owned runtime process {} could not be terminated: Windows error {error}.",
                expected.pid,
            ));
        }
        classify_terminated_process(handle.raw(), expected, observed)
    }

    fn prove_missing_process_terminated(
        &self,
        expected: OwnedProcessIdentity,
    ) -> Result<(), String> {
        let handle = self
            .captured_process_handles
            .get(&expected)
            .ok_or_else(|| {
                format!(
                    "The owned runtime process {} has no captured handle for terminal proof.",
                    expected.pid
                )
            })?;
        prove_process_terminated(handle.raw(), expected)
    }

    #[cfg(test)]
    fn inject_termination_failure(&mut self) {
        self.termination_failures += 1;
    }

    #[cfg(test)]
    fn inject_process_query_failure(&mut self) {
        self.process_query_failures += 1;
    }

    #[cfg(test)]
    fn inject_process_termination_failure_after_first(&mut self) {
        self.process_termination_failure_at = Some(1);
    }

    #[cfg(test)]
    fn inject_stale_process_snapshot(&mut self, snapshot: Vec<OwnedProcessIdentity>) {
        self.stale_process_snapshot = Some(snapshot);
    }

    #[cfg(all(test, windows))]
    #[allow(dead_code)]
    fn breakaway_allowed(&self) -> Result<bool, String> {
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle as *mut c_void,
                JobObjectExtendedLimitInformation,
                (&mut information as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        };
        if queried == 0 {
            Err(format!(
                "The owned runtime process job limits could not be queried: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(information.BasicLimitInformation.LimitFlags
                & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
                != 0)
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle as *mut c_void);
        }
    }
}

#[cfg(windows)]
fn terminate_unassigned_child(child: &mut Child) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {
            if terminate_windows_tree(child.id()).is_err() {
                child.kill().map_err(|error| {
                    format!("Unassigned runtime root process could not be stopped: {error}")
                })?;
            }
        }
        Err(error) => {
            child.kill().map_err(|kill_error| format!("Unassigned runtime root liveness could not be proven ({error}) and its process handle could not be terminated: {kill_error}"))?;
        }
    }
    child
        .wait()
        .map(|_| ())
        .map_err(|error| format!("Unassigned runtime root process could not be reaped: {error}"))
}

#[cfg(windows)]
fn terminate_assigned_suspended_child(
    job: &mut WindowsJob,
    child: &mut Child,
) -> Result<(), String> {
    if job.terminate().is_err() && child.try_wait().ok().flatten().is_none() {
        child.kill().map_err(|error| {
            format!("Assigned suspended runtime root could not be stopped: {error}")
        })?;
    }
    child
        .wait()
        .map(|_| ())
        .map_err(|error| format!("Assigned suspended runtime root could not be reaped: {error}"))
}

#[cfg(windows)]
fn resume_suspended_process(child: &Child) -> Result<(), String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "The suspended runtime thread snapshot could not be created: {}",
            io::Error::last_os_error()
        ));
    }
    let snapshot = ScopedWindowsHandle(snapshot as usize);
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    if unsafe { Thread32First(snapshot.raw(), &mut entry) } == 0 {
        return Err(format!(
            "The suspended runtime primary thread could not be enumerated: {}",
            io::Error::last_os_error()
        ));
    }
    let mut owned_thread_ids = Vec::new();
    loop {
        if entry.th32OwnerProcessID == child.id() {
            owned_thread_ids.push(entry.th32ThreadID);
        }
        if unsafe { Thread32Next(snapshot.raw(), &mut entry) } == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_NO_MORE_FILES {
                return Err(format!(
                    "The suspended runtime thread enumeration failed with Windows error {error}."
                ));
            }
            break;
        }
    }
    if owned_thread_ids.len() != 1 {
        return Err(format!(
            "Expected exactly one suspended runtime primary thread, found {}.",
            owned_thread_ids.len()
        ));
    }
    let thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            owned_thread_ids[0],
        )
    };
    if thread.is_null() {
        return Err(format!(
            "The suspended runtime primary thread could not be opened: {}",
            io::Error::last_os_error()
        ));
    }
    let thread = ScopedWindowsHandle(thread as usize);
    let thread_owner_pid = unsafe { GetProcessIdOfThread(thread.raw()) };
    if thread_owner_pid == 0 {
        return Err(format!(
            "The suspended runtime primary thread owner could not be verified: {}",
            io::Error::last_os_error()
        ));
    }
    if thread_owner_pid != child.id() {
        return Err(
            "The suspended runtime thread ID was reused by an unrelated process before resume."
                .into(),
        );
    }
    let previous_suspend_count = unsafe { ResumeThread(thread.raw()) };
    if previous_suspend_count == u32::MAX {
        return Err(format!(
            "The owned runtime primary thread could not be resumed: {}",
            io::Error::last_os_error()
        ));
    }
    if previous_suspend_count != 1 {
        return Err(format!("The owned runtime primary thread had an unexpected suspend count of {previous_suspend_count}."));
    }
    Ok(())
}

#[cfg(windows)]
struct ScopedWindowsHandle(usize);

#[cfg(windows)]
impl ScopedWindowsHandle {
    fn raw(&self) -> *mut c_void {
        self.0 as *mut c_void
    }
}

#[cfg(windows)]
impl Drop for ScopedWindowsHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.raw());
        }
    }
}

#[cfg(windows)]
fn terminate_windows_tree(pid: u32) -> Result<(), String> {
    let output = taskkill_command(pid)?
        .output()
        .map_err(|error| format!("Failed to stop owned runtime process tree: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Owned runtime process tree did not stop cleanly.".into())
    }
}

#[cfg(windows)]
fn taskkill_command(pid: u32) -> Result<Command, String> {
    let mut buffer = [0_u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err("The Windows system directory could not be resolved safely.".into());
    }
    let directory = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
    let candidate = directory.join("taskkill.exe");
    if !candidate
        .metadata()
        .map_err(|error| format!("The Windows system taskkill executable is unavailable: {error}"))?
        .is_file()
    {
        return Err("The Windows system taskkill path is not a regular file.".into());
    }
    let mut command = Command::new(candidate);
    command
        .args(taskkill_args(pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(all(test, not(windows)))]
fn taskkill_command(pid: u32) -> Result<Command, String> {
    let mut command = Command::new("taskkill");
    command
        .args(taskkill_args(pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(any(windows, test))]
fn taskkill_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_targets_only_the_recorded_pid_tree() {
        let command = taskkill_command(4242).expect("taskkill command");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["/PID", "4242", "/T", "/F"]);
        assert!(!args.iter().any(|arg| arg == "/IM"));
    }

    #[cfg(windows)]
    #[test]
    fn runtime_process_is_assigned_to_an_owned_job() {
        let mut command = Command::new("cmd.exe");
        command
            .args([
                "/D",
                "/S",
                "/C",
                "start \"\" /B ping.exe -n 30 127.0.0.1 >nul & ping.exe -n 30 127.0.0.1 >nul",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = OwnedSidecarProcess::spawn(&mut command).expect("owned process");
        assert!(process.id() > 0);
        assert!(process.try_wait().expect("status").is_none());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while process.active_processes().expect("active processes") < 2
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(process.active_processes().expect("descendant process") >= 2);
        assert!(!process.breakaway_allowed().expect("job limits"));
        assert!(process.assignment_verified_before_resume);
        process.terminate().expect("terminate owned process");
    }

    #[cfg(windows)]
    #[test]
    fn a_child_attempting_breakaway_is_rejected_by_the_owned_job() {
        let test_exe = std::env::current_exe().expect("test executable");
        let mut command = Command::new(test_exe);
        command
            .args([
                "--exact",
                "process::tests::breakaway_probe_child_entry",
                "--nocapture",
            ])
            .env("CAPTURE_BREAKAWAY_PROBE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let process = OwnedRuntimeSession::spawn(&mut command).expect("owned probe");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while process.try_wait().expect("probe status").is_none()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let status = process
            .monitor_root_exit()
            .expect("probe cleanup")
            .expect("probe exit");
        assert_eq!(status.code(), Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn breakaway_probe_child_entry() {
        if std::env::var_os("CAPTURE_BREAKAWAY_PROBE").is_none() {
            return;
        }
        assert_eq!(attempt_breakaway_child(), Err(ERROR_ACCESS_DENIED));
    }

    #[cfg(windows)]
    fn attempt_breakaway_child() -> Result<(), u32> {
        use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr::null_mut};

        let executable = std::env::var_os("COMSPEC").ok_or(ERROR_ACCESS_DENIED)?;
        let executable: Vec<u16> = OsStr::new(&executable)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut command_line: Vec<u16> = OsStr::new("cmd.exe /D /S /C exit 0")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process_information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command_line.as_mut_ptr(),
                null_mut(),
                null_mut(),
                0,
                CREATE_BREAKAWAY_FROM_JOB,
                null_mut(),
                null_mut(),
                &mut startup,
                &mut process_information,
            )
        };
        if created == 0 {
            return Err(unsafe { GetLastError() });
        }
        unsafe {
            CloseHandle(process_information.hThread);
            CloseHandle(process_information.hProcess);
        }
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn runtime_session_termination_is_idempotent_and_proven() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        let first = session
            .terminate_and_prove()
            .expect("first termination proof");
        let second = session
            .terminate_and_prove()
            .expect("idempotent termination proof");
        assert_eq!(first, second);
        assert!(first.root_reaped);
        assert!(first.descendants_terminated);
    }

    #[cfg(windows)]
    #[test]
    fn host_ownership_clone_survives_launcher_scope_until_cleanup_proof() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let host_owned = {
            let launcher_owned = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
            let host_owned = launcher_owned.clone();
            drop(launcher_owned);
            host_owned
        };

        let proof = host_owned
            .terminate_and_prove()
            .expect("host cleanup proof");
        assert!(proof.root_reaped);
        assert!(proof.descendants_terminated);
    }

    #[cfg(windows)]
    #[test]
    fn launcher_scope_drop_does_not_fake_cleanup_proof_for_host_owner() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let launcher_owned = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        let host_owned = launcher_owned.clone();
        host_owned.inject_cleanup_failure_for_test();
        drop(launcher_owned);

        let failure = host_owned
            .terminate_and_prove()
            .expect_err("host must not observe a fabricated Drop proof");
        assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Injected);

        let proof = host_owned
            .terminate_and_prove()
            .expect("host retry cleanup proof");
        assert!(proof.root_reaped);
        assert!(proof.descendants_terminated);
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_proof_failure_retains_the_ownership_handle_for_retry() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        let root_pid = session.id();
        session.inject_cleanup_failure_for_test();

        let failure = session
            .terminate_and_prove()
            .expect_err("injected proof failure");
        assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Injected);
        assert_eq!(session.id(), root_pid);

        let proof = session.terminate_and_prove().expect("retry cleanup proof");
        assert_eq!(proof.root_pid, root_pid);
        assert!(proof.root_reaped);
        assert!(proof.descendants_terminated);
    }

    #[cfg(windows)]
    #[test]
    fn monitor_root_exit_retries_cleanup_after_a_proof_race() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "exit /B 17"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        let root_pid = session.id();
        while session.try_wait().expect("root status").is_none() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        session.inject_cleanup_failure_for_test();

        let failure = session
            .monitor_root_exit()
            .expect_err("injected monitor proof failure");
        assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Injected);
        assert_eq!(session.id(), root_pid);

        let observed = session
            .monitor_root_exit()
            .expect("monitor retry")
            .expect("root exit");
        assert_eq!(session.id(), root_pid);
        assert!(observed.code().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn root_exit_with_job_termination_failure_reaps_job_owned_descendant() {
        let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 17",
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        wait_for_root_exit(&session);
        session.inject_job_termination_failure_for_test();

        let observed = session
            .monitor_root_exit()
            .expect("fallback cleanup proof")
            .expect("root exit");

        assert_eq!(observed.code(), Some(17));
        assert_eq!(session.active_processes_for_test().expect("job query"), 0);
    }

    #[cfg(windows)]
    #[test]
    fn root_still_alive_with_job_termination_failure_reaps_root_and_descendant() {
        let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','192.0.2.1' -WindowStyle Hidden; Start-Sleep -Seconds 30",
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        wait_for_active_processes(&session, 2);
        session.inject_job_termination_failure_for_test();

        let proof = session
            .terminate_and_prove()
            .expect("fallback cleanup proof");

        assert!(proof.root_reaped);
        assert!(proof.descendants_terminated);
        assert_eq!(session.active_processes_for_test().expect("job query"), 0);
    }

    #[cfg(windows)]
    #[test]
    fn job_query_failure_retains_session_for_retry_after_root_exit() {
        let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 17",
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        let root_pid = session.id();
        wait_for_root_exit(&session);
        session.inject_job_termination_failure_for_test();
        session.inject_job_process_query_failure_for_test();

        let failure = session
            .monitor_root_exit()
            .expect_err("query failure must not claim cleanup");
        assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Descendants);
        assert_eq!(session.id(), root_pid);
        assert!(session
            .active_processes_for_test()
            .expect("job query")
            .ge(&1));

        let observed = session
            .monitor_root_exit()
            .expect("retry cleanup proof")
            .expect("root exit");
        assert_eq!(observed.code(), Some(17));
        assert_eq!(session.active_processes_for_test().expect("job query"), 0);
    }

    #[cfg(windows)]
    #[test]
    fn partial_descendant_termination_retains_session_and_retry_proves_cleanup() {
        let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; $p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 17",
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        wait_for_root_exit(&session);
        wait_for_active_processes(&session, 2);
        session.inject_job_termination_failure_for_test();
        session.inject_process_termination_failure_after_first_for_test();

        let failure = session
            .monitor_root_exit()
            .expect_err("partial kill must not claim cleanup");
        assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Descendants);
        assert!(session.active_processes_for_test().expect("job query") >= 1);

        let observed = session
            .monitor_root_exit()
            .expect("retry cleanup proof")
            .expect("root exit");
        assert_eq!(observed.code(), Some(17));
        assert_eq!(session.active_processes_for_test().expect("job query"), 0);
    }

    #[test]
    fn reused_pid_requires_the_same_creation_identity() {
        let original = OwnedProcessIdentity {
            pid: 4242,
            creation_time: 100,
        };
        let reused = OwnedProcessIdentity {
            pid: 4242,
            creation_time: 101,
        };
        assert!(!same_process_identity(original, reused));
        assert!(same_process_identity(original, original));
    }

    #[test]
    fn terminated_observation_requires_exact_identity_and_terminal_proof() {
        let expected = OwnedProcessIdentity {
            pid: 4242,
            creation_time: 100,
        };

        assert!(classify_terminated_observation(expected, expected, 0, Ok(17)).is_ok());
        assert!(
            classify_terminated_observation(expected, expected, 0, Err("query".into())).is_err()
        );
        assert!(classify_terminated_observation(expected, expected, 0x0000_0102, Ok(17)).is_err());
        assert!(classify_terminated_observation(expected, expected, 0xffff_ffff, Ok(17)).is_err());
        assert!(classify_terminated_observation(expected, expected, 0xdead_beef, Ok(17)).is_err());
        assert!(classify_terminated_observation(expected, expected, 0, Ok(259)).is_err());
        assert!(classify_terminated_observation(
            expected,
            OwnedProcessIdentity {
                pid: expected.pid,
                creation_time: expected.creation_time + 1,
            },
            0,
            Ok(17),
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn short_lived_child_access_denied_is_classified_from_its_signaled_handle() {
        let mut child = Command::new("cmd.exe");
        child
            .args(["/D", "/S", "/C", "exit /B 17"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = child.spawn().expect("short-lived child");
        let pid = child.id();
        while child.try_wait().expect("child status").is_none() {
            std::thread::yield_now();
        }

        let handle = open_process_for_termination(pid).expect("retained process handle");
        let expected = process_identity_from_handle(handle.raw(), pid).expect("child identity");
        let observed = process_identity_from_handle(handle.raw(), pid).expect("handle identity");
        assert_eq!(expected, observed);
        assert_eq!(unsafe { TerminateProcess(handle.raw(), 1) }, 0);
        assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
        classify_terminated_process(handle.raw(), expected, observed)
            .expect("already-exited process proof");
        child.wait().expect("reap child");
    }

    #[cfg(windows)]
    #[test]
    fn short_lived_root_exit_cleanup_stress_is_sequential() {
        for _ in 0..100 {
            let mut command = Command::new("cmd.exe");
            command
                .args(["/D", "/S", "/C", "exit /B 17"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
            wait_for_root_exit(&session);
            session.inject_job_termination_failure_for_test();

            let observed = session
                .monitor_root_exit()
                .expect("cleanup proof")
                .expect("root exit");
            assert_eq!(observed.code(), Some(17));
            assert_eq!(session.active_processes_for_test().expect("job query"), 0);
        }
    }

    #[cfg(windows)]
    #[test]
    fn missing_descendant_snapshot_requires_terminal_proof() {
        let mut command = powershell_command(
            "$p = Start-Process cmd.exe -ArgumentList '/D','/S','/C','ping.exe -n 3 127.0.0.1' -WindowStyle Hidden; Wait-Process -Id $p.Id; exit 17",
        );
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        wait_for_active_processes(&session, 2);
        session.inject_stale_descendant_snapshot_for_test();
        wait_for_root_exit(&session);
        session.inject_job_termination_failure_for_test();

        let observed = session
            .monitor_root_exit()
            .expect("cleanup proof")
            .expect("root exit");
        assert_eq!(observed.code(), Some(17));
        assert_eq!(session.active_processes_for_test().expect("job query"), 0);
    }

    #[cfg(windows)]
    fn wait_for_root_exit(session: &OwnedRuntimeSession) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while session.try_wait().expect("root status").is_none()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(session.try_wait().expect("root status").is_some());
    }

    #[cfg(windows)]
    fn powershell_command(script: &str) -> Command {
        let executable = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .expect("SystemRoot")
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let mut command = Command::new(executable);
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        command
    }

    #[cfg(windows)]
    fn wait_for_active_processes(session: &OwnedRuntimeSession, minimum: u32) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while session
            .active_processes_for_test()
            .expect("job process query")
            < minimum
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(
            session
                .active_processes_for_test()
                .expect("job process query")
                >= minimum
        );
    }
}
