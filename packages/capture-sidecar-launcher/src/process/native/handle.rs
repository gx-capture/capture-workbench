#[cfg(windows)]
use std::io;
#[cfg(windows)]
pub(crate) const PROCESS_WAIT_TIMEOUT_MS: u32 = 5_000;

#[cfg(windows)]
use std::ffi::c_void;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME,
        WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    },
};

#[cfg(any(windows, test))]
use super::{same_process_identity, OwnedProcessIdentity};

#[cfg(windows)]
pub(crate) struct ScopedWindowsHandle(pub(crate) usize);

#[cfg(windows)]
impl ScopedWindowsHandle {
    pub(crate) fn raw(&self) -> *mut c_void {
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
pub(crate) fn read_process_identity_for_job_member(
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
pub(crate) fn open_process_for_termination(pid: u32) -> Result<ScopedWindowsHandle, String> {
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
pub(crate) fn process_identity_from_handle(
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
pub(crate) fn prove_process_terminated(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
) -> Result<(), String> {
    prove_process_terminated_with_timeout(handle, expected, PROCESS_WAIT_TIMEOUT_MS)
}

#[cfg(windows)]
pub(crate) fn prove_process_terminated_with_timeout(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    wait_timeout_ms: u32,
) -> Result<(), String> {
    let observed = process_identity_from_handle(handle, expected.pid)?;
    classify_terminated_process_with_timeout(handle, expected, observed, wait_timeout_ms)
}

#[cfg(windows)]
pub(crate) fn terminate_process_with_proof(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
) -> Result<(), String> {
    terminate_process_with_proof_with_timeout(handle, expected, PROCESS_WAIT_TIMEOUT_MS)
}

#[cfg(windows)]
pub(crate) fn terminate_process_with_proof_with_timeout(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    wait_timeout_ms: u32,
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
    prove_process_terminated_with_timeout(handle, expected, wait_timeout_ms)
}

/// Proves that a process handle is already terminated after a termination
/// attempt reported `ERROR_ACCESS_DENIED` (or after a successful termination).
///
/// Windows can report `ERROR_ACCESS_DENIED` when `TerminateProcess` races with
/// a short-lived process exiting.  The error is recoverable only when the
/// handle still belongs to the exact process we opened, is signaled, and has a
/// terminal exit code.  Every other observation remains fail-closed.
#[cfg(all(test, windows))]
pub(crate) fn classify_terminated_process(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
) -> Result<(), String> {
    classify_terminated_process_with_timeout(handle, expected, observed, PROCESS_WAIT_TIMEOUT_MS)
}

#[cfg(windows)]
pub(crate) fn classify_terminated_process_with_timeout(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
    wait_timeout_ms: u32,
) -> Result<(), String> {
    let wait_state = unsafe { WaitForSingleObject(handle, wait_timeout_ms) };
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
pub(crate) fn classify_terminated_observation(
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

#[cfg(any(windows, test))]
pub(crate) fn next_process_list_capacity(
    capacity: usize,
    listed: usize,
    assigned: usize,
    max_capacity: usize,
) -> Result<Option<usize>, String> {
    if listed <= capacity && assigned <= listed {
        return Ok(None);
    }
    if assigned > max_capacity || capacity >= max_capacity {
        return Err("The owned runtime Job process list counts exceeded the safe enumeration limit or remained inconsistent at that limit.".into());
    }
    let next_capacity = assigned.max(capacity.saturating_mul(2)).min(max_capacity);
    if next_capacity <= capacity {
        return Err("The owned runtime Job process list capacity could not make progress.".into());
    }
    Ok(Some(next_capacity))
}
