use std::{
    io,
    process::{Child, Command, ExitStatus, Stdio},
};

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
    Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::SystemInformation::GetSystemDirectoryW,
    System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    },
};

#[cfg(all(windows, test))]
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicAccountingInformation, QueryInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};

/// A sidecar root process plus its Windows job-object ownership boundary.
pub struct OwnedSidecarProcess {
    child: Child,
    #[cfg(windows)]
    job: WindowsJob,
}

impl OwnedSidecarProcess {
    /// Spawns a command suspended, assigns it to a kill-on-close job, then resumes it.
    pub fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(windows)]
        let job = WindowsJob::new()?;
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
        if let Err(error) = resume_suspended_process(&child) {
            return match terminate_assigned_suspended_child(&job, &mut child) {
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
        })
    }

    /// Checks whether the root process has exited without blocking.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Terminates the exact process tree owned by this launch attempt.
    pub fn terminate(mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if self.job.terminate().is_ok() {
                self.child.wait().map_err(|error| {
                    format!("Owned runtime root process could not be reaped: {error}")
                })?;
                return Ok(());
            }
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {
                    if terminate_windows_tree(self.child.id()).is_ok() {
                        self.child.wait().map_err(|error| {
                            format!("Owned runtime root process could not be reaped: {error}")
                        })?;
                        return Ok(());
                    }
                }
                Err(error) => {
                    return Err(format!(
                        "Owned runtime root liveness could not be proven before PID cleanup: {error}"
                    ));
                }
            }
        }
        if self.child.try_wait().ok().flatten().is_none() {
            self.child.kill().map_err(|error| {
                format!("Owned runtime root process could not be stopped: {error}")
            })?;
        }
        self.child
            .wait()
            .map(|_| ())
            .map_err(|error| format!("Owned runtime root process could not be reaped: {error}"))
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
}

#[cfg(windows)]
struct WindowsJob {
    handle: usize,
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

    fn terminate(&self) -> Result<(), String> {
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

    #[cfg(test)]
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
fn terminate_assigned_suspended_child(job: &WindowsJob, child: &mut Child) -> Result<(), String> {
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
        process.terminate().expect("terminate owned process");
    }
}
