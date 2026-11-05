use std::collections::HashSet;
use std::sync::atomic::Ordering;

#[cfg(windows)]
use crate::journal::{
    JobSetupState, JournalPlanValue, JournalRoot, JournalState, RuntimeSessionJournalV1,
};

#[cfg(windows)]
use super::activation::NativeNonce;

#[cfg(windows)]
use super::activation::launching::parse_creation_identity;

#[cfg(windows)]
use std::{mem::size_of, ptr, sync::atomic::AtomicBool};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER,
        WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    },
    System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    },
};

#[cfg(windows)]
use super::activation::SuspendedGroup;

#[cfg(windows)]
use super::native::{
    process_identity_from_handle, same_process_identity, OwnedProcessIdentity, ScopedWindowsHandle,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartNativeObservationError {
    MissingNativeIdentity,
    InvalidState,
    InvalidRecord,
    RootPresent,
    RootReused,
    RootAccessDenied,
    RootUnqueryable,
    ListenerPresent,
    ListenerAmbiguous,
    ListenerQuery,
    Cancelled,
    Deadline,
}

#[cfg(windows)]
#[cfg(windows)]
pub(crate) struct NativeRootObservation {
    pub(crate) ordinal: u32,
    pub(crate) root_nonce: NativeNonce,
    pub(crate) identity: OwnedProcessIdentity,
}

/// A private observation of the exact loopback listener owned by each root.
/// The process identity is captured from the retained root handle and the
/// table contributes only the listener port; neither a PID supplied by a
/// caller nor Job membership alone can create this value.
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeListenerObservation {
    pub(crate) roots: Vec<NativeListenerRootObservation>,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeListenerRootObservation {
    pub(crate) ordinal: u32,
    pub(crate) identity: OwnedProcessIdentity,
    pub(crate) port: u16,
}

#[cfg(windows)]
impl NativeListenerObservation {
    #[cfg(test)]
    pub(crate) fn root_count(&self) -> usize {
        self.roots.len()
    }

    #[cfg(test)]
    pub(crate) fn root(&self, ordinal: usize) -> Option<&NativeListenerRootObservation> {
        self.roots.get(ordinal)
    }
}

#[cfg(windows)]
pub(crate) const TCP_TABLE_QUERY_ATTEMPTS: usize = 5;

#[cfg(windows)]
pub(crate) const MAX_TCP_TABLE_BYTES: usize = 4 * 1024 * 1024;

#[cfg(windows)]
pub(crate) const AF_INET: u32 = 2;

#[cfg(windows)]
pub(crate) fn check_listener_budget(
    deadline: std::time::Instant,
    cancellation: Option<&AtomicBool>,
) -> Result<(), String> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Runtime listener observation was cancelled.".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("Runtime listener observation exceeded its group deadline.".into());
    }
    Ok(())
}

#[cfg(windows)]
#[cfg(windows)]
pub(crate) fn validate_listener_process_identity(
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
) -> Result<(), String> {
    if same_process_identity(expected, observed) {
        Ok(())
    } else {
        Err("The listener owner did not retain the expected process creation identity.".into())
    }
}

#[cfg(windows)]
pub(crate) fn validate_listener_inputs(
    group: &SuspendedGroup,
    ports: &[u16],
) -> Result<(), String> {
    if ports.len() != group.roots.len()
        || group.roots.is_empty()
        || !group.unacquired_root_nonces.is_empty()
    {
        return Err("The runtime listener observation did not receive a complete root set.".into());
    }
    let mut seen_ports = HashSet::with_capacity(ports.len());
    let mut seen_pids = HashSet::with_capacity(ports.len());
    for (index, (&port, root)) in ports.iter().zip(&group.roots).enumerate() {
        let expected_ordinal = u32::try_from(index)
            .map_err(|_| "The runtime listener root ordinal exceeded its native range.")?;
        if root.ordinal != expected_ordinal {
            return Err(
                "The runtime listener root ordinals were not contiguous and ordered.".into(),
            );
        }
        if port == 0 || !seen_ports.insert(port) {
            return Err("Runtime listener ports must be distinct nonzero values.".into());
        }
        let identity = root.identity.ok_or_else(|| {
            format!("Runtime root {expected_ordinal} has no captured process identity.")
        })?;
        if !seen_pids.insert(identity.pid) {
            return Err("Runtime listener roots had ambiguous process ownership.".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn query_listener_table(
    deadline: std::time::Instant,
    cancellation: Option<&AtomicBool>,
) -> Result<Vec<u8>, String> {
    check_listener_budget(deadline, cancellation)?;
    let mut required_bytes = 0_u32;
    let first_status = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut required_bytes,
            1,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first_status != ERROR_INSUFFICIENT_BUFFER || required_bytes == 0 {
        return Err("The Windows listener table size query failed closed.".into());
    }
    let mut capacity = usize::try_from(required_bytes)
        .map_err(|_| "The Windows listener table size exceeded the platform range.")?;
    if capacity > MAX_TCP_TABLE_BYTES {
        return Err("The Windows listener table exceeded its bounded size.".into());
    }
    for attempt in 0..TCP_TABLE_QUERY_ATTEMPTS {
        check_listener_budget(deadline, cancellation)?;
        let mut table = vec![0_u8; capacity];
        let mut returned_bytes = u32::try_from(capacity)
            .map_err(|_| "The Windows listener table size exceeded the API range.")?;
        let status = unsafe {
            GetExtendedTcpTable(
                table.as_mut_ptr().cast(),
                &mut returned_bytes,
                1,
                AF_INET,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        check_listener_budget(deadline, cancellation)?;
        if status == 0 {
            let returned = usize::try_from(returned_bytes)
                .map_err(|_| "The Windows listener table result size was invalid.")?;
            if returned < size_of::<u32>() || returned > table.len() {
                return Err("The Windows listener table result was malformed.".into());
            }
            table.truncate(returned);
            return Ok(table);
        }
        if status != ERROR_INSUFFICIENT_BUFFER {
            return Err("The Windows listener table query failed closed.".into());
        }
        let next_capacity = usize::try_from(returned_bytes)
            .map_err(|_| "The Windows listener table retry size was invalid.")?;
        if next_capacity <= capacity
            || next_capacity > MAX_TCP_TABLE_BYTES
            || attempt + 1 == TCP_TABLE_QUERY_ATTEMPTS
        {
            return Err(
                "The Windows listener table retries exceeded their bounded size budget.".into(),
            );
        }
        capacity = next_capacity;
    }
    Err("The Windows listener table retries exceeded their bounded attempt budget.".into())
}

#[cfg(windows)]
pub(crate) fn parse_listener_table(
    table: &[u8],
    expected_identities: &[OwnedProcessIdentity],
    ports: &[u16],
) -> Result<NativeListenerObservation, String> {
    if expected_identities.len() != ports.len() {
        return Err("The Windows listener table result was too short or incomplete.".into());
    }
    let rows = listener_table_rows(table)?;

    let mut observed = (0..ports.len()).map(|_| None).collect::<Vec<_>>();
    for row in rows {
        let port = u16::from_be(row.dwLocalPort as u16);
        let target = ports.iter().position(|expected| *expected == port);
        let Some(target) = target else {
            continue;
        };
        // Row state is deliberately not checked. TCP_TABLE_OWNER_PID_LISTENER is
        // filtered by Windows to listening endpoints, and Windows 11 build 26300
        // reports undefined or non-listening dwState values (0, 6) for those rows,
        // which made every launch fail. Ownership is proven by the loopback
        // address, the port and the owning process identity below.
        if u32::from_be(row.dwLocalAddr) != 0x7f00_0001 {
            return Err("The target listener was wildcard or otherwise not loopback-only.".into());
        }
        let identity_matches = expected_identities
            .iter()
            .enumerate()
            .filter(|(_, identity)| identity.pid == row.dwOwningPid)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if identity_matches.len() != 1 || identity_matches[0] != target {
            return Err("The target listener belonged to a foreign or ambiguous process.".into());
        }
        if observed[target].is_some() {
            return Err("The target listener table contained duplicate rows.".into());
        }
        observed[target] = Some(NativeListenerRootObservation {
            ordinal: u32::try_from(target)
                .map_err(|_| "The listener root ordinal exceeded its native range.")?,
            identity: expected_identities[target],
            port,
        });
    }
    let roots = observed
        .into_iter()
        .enumerate()
        .map(|(index, root)| {
            root.ok_or_else(|| format!("No exact loopback listener was observed for root {index}."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(NativeListenerObservation { roots })
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartRootProcessState {
    Absent,
    Present,
}

/// Observe the exact recorded root processes and listener ports after a
/// producer restart.  This function is deliberately read-only: it never
/// opens a Job, adopts a handle for later action, terminates a process, or
/// mutates the journal.  A successful result means only that the point-in-time
/// absence observation completed and must still be revalidated before a later
/// journal transition.
#[cfg(windows)]
pub(crate) fn observe_restart_native(
    journal: &RuntimeSessionJournalV1,
    plan: &JournalPlanValue,
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> Result<(), RestartNativeObservationError> {
    journal
        .validate_against_plan(plan)
        .map_err(|_| RestartNativeObservationError::InvalidRecord)?;
    match journal.state {
        JournalState::PlannedUnbound | JournalState::PreparedBound => {
            // These records have no durable, complete native identity.  Do
            // not turn their missing fields into a PID query or an absence
            // claim.
            return Err(RestartNativeObservationError::MissingNativeIdentity);
        }
        JournalState::Ready
        | JournalState::Launching
        | JournalState::Running
        | JournalState::Closing
        | JournalState::ReconcileRequired => {}
        JournalState::Terminal | JournalState::ManualReview => {
            return Err(RestartNativeObservationError::InvalidState);
        }
    }

    let job = journal
        .job_binding
        .as_ref()
        .ok_or(RestartNativeObservationError::MissingNativeIdentity)?;
    if job.setup_state != JobSetupState::Committed {
        return Err(RestartNativeObservationError::MissingNativeIdentity);
    }
    let crate::journal::JournalBinding::Bound { root_bindings, .. } = &journal.binding else {
        return Err(RestartNativeObservationError::MissingNativeIdentity);
    };
    if root_bindings.len() != plan.roots.len()
        || journal.roots.len() != plan.roots.len()
        || journal.roots.is_empty()
    {
        return Err(RestartNativeObservationError::MissingNativeIdentity);
    }

    let mut expected_pids = HashSet::with_capacity(journal.roots.len());
    let mut expected_ports = HashSet::with_capacity(journal.roots.len());
    for (index, root) in journal.roots.iter().enumerate() {
        let ordinal =
            u32::try_from(index).map_err(|_| RestartNativeObservationError::InvalidRecord)?;
        if root.ordinal != ordinal
            || root.pid == 0
            || root.root_nonce.is_empty()
            || root.reserved_listener_identity.is_empty()
            || root.loopback_port == 0
            || !expected_pids.insert(root.pid)
            || !expected_ports.insert(root.loopback_port)
        {
            return Err(RestartNativeObservationError::MissingNativeIdentity);
        }
        let creation_time = parse_creation_identity(root)
            .map_err(|_| RestartNativeObservationError::InvalidRecord)?;
        if creation_time == 0 {
            return Err(RestartNativeObservationError::InvalidRecord);
        }
    }

    for root in &journal.roots {
        match observe_restart_root_process(root, deadline, cancellation)? {
            RestartRootProcessState::Absent => {}
            RestartRootProcessState::Present => {
                return Err(RestartNativeObservationError::RootPresent);
            }
        }
    }

    check_restart_observation_budget(deadline, cancellation)?;
    let table = query_listener_table(deadline, Some(cancellation))
        .map_err(|_| RestartNativeObservationError::ListenerQuery)?;
    check_restart_observation_budget(deadline, cancellation)?;
    parse_restart_listener_absence(&table, &journal.roots)
}

#[cfg(windows)]
pub(crate) fn observe_restart_root_process(
    root: &JournalRoot,
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> Result<RestartRootProcessState, RestartNativeObservationError> {
    check_restart_observation_budget(deadline, cancellation)?;
    let expected_creation =
        parse_creation_identity(root).map_err(|_| RestartNativeObservationError::InvalidRecord)?;
    if expected_creation == 0 {
        return Err(RestartNativeObservationError::InvalidRecord);
    }
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            root.pid,
        )
    };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        return if error == ERROR_INVALID_PARAMETER {
            Ok(RestartRootProcessState::Absent)
        } else if error == ERROR_ACCESS_DENIED {
            Err(RestartNativeObservationError::RootAccessDenied)
        } else {
            Err(RestartNativeObservationError::RootUnqueryable)
        };
    }
    let handle = ScopedWindowsHandle(handle as usize);
    let observed = process_identity_from_handle(handle.raw(), root.pid)
        .map_err(|_| restart_native_query_error())?;
    if observed.creation_time != expected_creation {
        return Err(RestartNativeObservationError::RootReused);
    }
    check_restart_observation_budget(deadline, cancellation)?;
    let wait_state = unsafe { WaitForSingleObject(handle.raw(), 0) };
    match wait_state {
        WAIT_OBJECT_0 => {
            let mut _exit_code = 0_u32;
            if unsafe { GetExitCodeProcess(handle.raw(), &mut _exit_code) } == 0 {
                return Err(restart_native_query_error());
            }
            // A signaled process handle is authoritative.  259 is the
            // conventional STILL_ACTIVE value, but it is also a legal
            // application exit code after the wait has reported termination.
            Ok(RestartRootProcessState::Absent)
        }
        WAIT_TIMEOUT => Ok(RestartRootProcessState::Present),
        WAIT_FAILED => Err(restart_native_query_error()),
        _ => Err(RestartNativeObservationError::RootUnqueryable),
    }
}

#[cfg(windows)]
pub(crate) fn restart_native_query_error() -> RestartNativeObservationError {
    restart_native_query_error_for_code(unsafe { GetLastError() })
}

#[cfg(windows)]
pub(crate) fn restart_native_query_error_for_code(error: u32) -> RestartNativeObservationError {
    if error == ERROR_ACCESS_DENIED {
        RestartNativeObservationError::RootAccessDenied
    } else {
        RestartNativeObservationError::RootUnqueryable
    }
}

#[cfg(windows)]
pub(crate) fn parse_restart_listener_absence(
    table: &[u8],
    roots: &[JournalRoot],
) -> Result<(), RestartNativeObservationError> {
    let rows =
        listener_table_rows(table).map_err(|_| RestartNativeObservationError::ListenerQuery)?;
    let mut seen_ports = HashSet::with_capacity(roots.len());
    for row in rows {
        let port = u16::from_be(row.dwLocalPort as u16);
        let Some(root) = roots.iter().find(|root| root.loopback_port == port) else {
            continue;
        };
        if !seen_ports.insert(port) {
            return Err(RestartNativeObservationError::ListenerAmbiguous);
        }
        // Row state is not checked here either; see parse_listener_table.
        if u32::from_be(row.dwLocalAddr) != 0x7f00_0001 {
            return Err(RestartNativeObservationError::ListenerAmbiguous);
        }
        if row.dwOwningPid == root.pid {
            return Err(RestartNativeObservationError::ListenerPresent);
        }
        return Err(RestartNativeObservationError::ListenerAmbiguous);
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn check_restart_observation_budget(
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> Result<(), RestartNativeObservationError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(RestartNativeObservationError::Cancelled);
    }
    if std::time::Instant::now() >= deadline {
        return Err(RestartNativeObservationError::Deadline);
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn listener_table_rows(table: &[u8]) -> Result<Vec<MIB_TCPROW_OWNER_PID>, String> {
    if table.len() < size_of::<u32>() || table.len() > MAX_TCP_TABLE_BYTES {
        return Err("The Windows listener table result was too short or too large.".into());
    }
    let count = u32::from_ne_bytes(
        table[..size_of::<u32>()]
            .try_into()
            .map_err(|_| "The Windows listener table row count was malformed.")?,
    );
    let count = usize::try_from(count)
        .map_err(|_| "The Windows listener table row count exceeded the platform range.")?;
    let row_size = size_of::<MIB_TCPROW_OWNER_PID>();
    let rows_bytes = count
        .checked_mul(row_size)
        .ok_or_else(|| "The Windows listener table row count overflowed.".to_string())?;
    let required = size_of::<u32>()
        .checked_add(rows_bytes)
        .ok_or_else(|| "The Windows listener table size overflowed.".to_string())?;
    if required > table.len() || required > MAX_TCP_TABLE_BYTES {
        return Err("The Windows listener table row count exceeded its buffer.".into());
    }
    (0..count)
        .map(|row_index| {
            let offset = size_of::<u32>() + row_index * row_size;
            Ok(unsafe {
                ptr::read_unaligned(table.as_ptr().add(offset).cast::<MIB_TCPROW_OWNER_PID>())
            })
        })
        .collect()
}
