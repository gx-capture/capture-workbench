#[cfg(windows)]
use std::collections::HashSet;
use std::os::windows::io::AsRawHandle;
use std::{collections::HashMap, ffi::c_void, io, mem::size_of, process::Child, ptr};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::Threading::TerminateProcess,
};

#[cfg(all(test, windows))]
use windows_sys::Win32::System::JobObjects::{
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};

#[cfg(windows)]
use super::handle::{
    classify_terminated_process_with_timeout, next_process_list_capacity,
    open_process_for_termination, process_identity_from_handle,
    prove_process_terminated_with_timeout, read_process_identity_for_job_member,
    ScopedWindowsHandle, PROCESS_WAIT_TIMEOUT_MS,
};

#[cfg(windows)]
use super::tree::remaining_timeout_ms;

#[cfg(windows)]
use super::{same_process_identity, OwnedProcessIdentity};

#[cfg(windows)]
pub(crate) struct WindowsJob {
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
    #[cfg(test)]
    pub(crate) assignment_failure_at: Option<usize>,
    #[cfg(test)]
    assignment_attempts: usize,
    #[cfg(test)]
    pub(crate) membership_failure_at: Option<usize>,
    #[cfg(test)]
    pub(crate) membership_attempts: usize,
    #[cfg(test)]
    pub(crate) resume_failure_at: Option<usize>,
    #[cfg(test)]
    pub(crate) identity_failure_at: Option<usize>,
}

#[cfg(all(test, windows))]
#[derive(Default)]
pub(crate) struct GroupTestFaults {
    pub(crate) assignment_failure_at: Option<usize>,
    pub(crate) membership_failure_at: Option<usize>,
    pub(crate) resume_failure_at: Option<usize>,
    pub(crate) identity_failure_at: Option<usize>,
    pub(crate) nonce_generation_failure: bool,
}

#[cfg(windows)]
impl WindowsJob {
    pub(crate) fn new() -> Result<Self, String> {
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
            #[cfg(test)]
            assignment_failure_at: None,
            #[cfg(test)]
            assignment_attempts: 0,
            #[cfg(test)]
            membership_failure_at: None,
            #[cfg(test)]
            membership_attempts: 0,
            #[cfg(test)]
            resume_failure_at: None,
            #[cfg(test)]
            identity_failure_at: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_with_faults(faults: GroupTestFaults) -> Result<Self, String> {
        let mut job = Self::new()?;
        job.assignment_failure_at = faults.assignment_failure_at;
        job.membership_failure_at = faults.membership_failure_at;
        job.resume_failure_at = faults.resume_failure_at;
        job.identity_failure_at = faults.identity_failure_at;
        Ok(job)
    }

    pub(crate) fn assign(&mut self, child: &Child) -> Result<(), String> {
        #[cfg(test)]
        {
            let attempt = self.assignment_attempts;
            self.assignment_attempts += 1;
            if self.assignment_failure_at == Some(attempt) {
                self.assignment_failure_at = None;
                return Err("Injected Job assignment failure.".into());
            }
        }
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

    pub(crate) fn verify_assignment(&mut self, child: &Child) -> Result<(), String> {
        #[cfg(test)]
        {
            let attempt = self.membership_attempts;
            self.membership_attempts += 1;
            if self.membership_failure_at == Some(attempt) {
                self.membership_failure_at = None;
                return Err("Injected Job membership verification failure.".into());
            }
        }
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

    pub(crate) fn verify_membership_set(
        &mut self,
        expected: &[OwnedProcessIdentity],
    ) -> Result<(), String> {
        let observed = self.owned_processes(None)?;
        let expected_set: HashSet<_> = expected.iter().copied().collect();
        let observed_set: HashSet<_> = observed.iter().copied().collect();
        if expected.len() != expected_set.len()
            || observed.len() != observed_set.len()
            || expected_set != observed_set
        {
            return Err("The owned runtime Job membership did not match every group root.".into());
        }
        Ok(())
    }

    pub(crate) fn terminate(&mut self) -> Result<(), String> {
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

    pub(crate) fn active_processes(&self) -> Result<u32, String> {
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

    pub(crate) fn owned_processes(
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
            if let Some(next_capacity) =
                next_process_list_capacity(capacity, listed, assigned, MAX_CAPACITY)?
            {
                capacity = next_capacity;
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

    pub(crate) fn terminate_owned_processes(
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
                self.terminate_owned_process_with_timeout(
                    process,
                    exited_root,
                    PROCESS_WAIT_TIMEOUT_MS,
                )?;
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

    pub(crate) fn terminate_remaining_owned_processes(
        &mut self,
        deadline: std::time::Instant,
    ) -> Result<(), String> {
        const MAX_PASSES: usize = 20;
        for _ in 0..MAX_PASSES {
            if remaining_timeout_ms(deadline) == 0 {
                return Err("The owned runtime Job cleanup budget expired.".into());
            }
            let processes = self.owned_processes(None)?;
            if processes.is_empty() {
                return Ok(());
            }
            for process in processes {
                self.terminate_owned_process_with_timeout(
                    process,
                    None,
                    remaining_timeout_ms(deadline),
                )?;
            }
            if self.owned_processes(None)?.is_empty() {
                return Ok(());
            }
            let sleep_ms = remaining_timeout_ms(deadline).min(10);
            if sleep_ms == 0 {
                return Err("The owned runtime Job cleanup budget expired.".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(u64::from(sleep_ms)));
        }
        Err("The owned runtime Job still reports active processes after group cleanup.".into())
    }

    pub(crate) fn terminate_owned_process_with_timeout(
        &mut self,
        expected: OwnedProcessIdentity,
        exited_root: Option<OwnedProcessIdentity>,
        wait_timeout_ms: u32,
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
            let result = self.prove_missing_process_terminated(expected, wait_timeout_ms);
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
                return classify_terminated_process_with_timeout(
                    handle.raw(),
                    expected,
                    observed,
                    wait_timeout_ms,
                );
            }
            return Err(format!(
                "The owned runtime process {} could not be terminated: Windows error {error}.",
                expected.pid,
            ));
        }
        classify_terminated_process_with_timeout(handle.raw(), expected, observed, wait_timeout_ms)
    }

    pub(crate) fn prove_missing_process_terminated(
        &self,
        expected: OwnedProcessIdentity,
        wait_timeout_ms: u32,
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
        prove_process_terminated_with_timeout(handle.raw(), expected, wait_timeout_ms)
    }

    #[cfg(test)]
    pub(crate) fn inject_termination_failure(&mut self) {
        self.termination_failures += 1;
    }

    #[cfg(test)]
    pub(crate) fn inject_process_query_failure(&mut self) {
        self.process_query_failures += 1;
    }

    #[cfg(test)]
    pub(crate) fn inject_process_termination_failure_after_first(&mut self) {
        self.process_termination_failure_at = Some(1);
    }

    #[cfg(test)]
    pub(crate) fn inject_stale_process_snapshot(&mut self, snapshot: Vec<OwnedProcessIdentity>) {
        self.stale_process_snapshot = Some(snapshot);
    }

    #[cfg(test)]
    pub(crate) fn take_resume_failure(&mut self, ordinal: usize) -> bool {
        if self.resume_failure_at == Some(ordinal) {
            self.resume_failure_at = None;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn take_identity_failure(&mut self, ordinal: usize) -> bool {
        if self.identity_failure_at == Some(ordinal) {
            self.identity_failure_at = None;
            true
        } else {
            false
        }
    }

    #[cfg(all(test, windows))]
    pub(crate) fn breakaway_allowed(&self) -> Result<bool, String> {
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
