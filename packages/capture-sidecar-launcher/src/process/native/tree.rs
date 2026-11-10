#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
#[cfg(any(windows, test))]
use std::process::{Child, Command, Stdio};

#[cfg(windows)]
use std::path::PathBuf;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    },
    System::SystemInformation::GetSystemDirectoryW,
    System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
        THREAD_SUSPEND_RESUME,
    },
};

#[cfg(windows)]
use super::handle::ScopedWindowsHandle;
#[cfg(windows)]
use super::job::WindowsJob;

#[cfg(windows)]
pub(crate) fn terminate_unassigned_child(child: &mut Child) -> Result<(), String> {
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
pub(crate) fn terminate_assigned_suspended_child(
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
pub(crate) fn open_suspended_primary_thread(child: &Child) -> Result<ScopedWindowsHandle, String> {
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
    Ok(thread)
}

#[cfg(windows)]
pub(crate) fn resume_suspended_process(child: &Child) -> Result<(), String> {
    let thread = open_suspended_primary_thread(child)?;
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
pub(crate) fn terminate_windows_tree(pid: u32) -> Result<(), String> {
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
pub(crate) fn taskkill_command(pid: u32) -> Result<Command, String> {
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
pub(crate) fn taskkill_command(pid: u32) -> Result<Command, String> {
    let mut command = Command::new("taskkill");
    command
        .args(taskkill_args(pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(any(windows, test))]
pub(crate) fn taskkill_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}
