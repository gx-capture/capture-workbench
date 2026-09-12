use std::{
    fmt, io,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
};

use crate::prepare::{ImmutableGroupPlan, PrepareError, PreparedGroup, ReconcileRefSink};

#[cfg(windows)]
use crate::{
    journal::{
        CreationIdentity, JobBinding, JobSetupState, JournalRoot, ResourceObservation, RootState,
        RuntimeSessionJournalV1,
    },
    prepare::ValidatedActivationContext,
    staging::{RunStagingOwner, StagingFailure},
};

#[cfg(windows)]
use std::collections::{HashMap, HashSet, VecDeque};

#[cfg(windows)]
use rand::{rngs::OsRng, RngCore};

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
        ResumeThread, SuspendThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
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

#[cfg(windows)]
const PROCESS_WAIT_TIMEOUT_MS: u32 = 5_000;

#[cfg(windows)]
#[allow(dead_code)]
const GROUP_CLEANUP_BUDGET_MS: u32 = 5_000;

#[cfg(windows)]
#[allow(dead_code)]
const DROP_CLEANUP_WAIT_MS: u32 = 250;

#[cfg(windows)]
const NATIVE_NONCE_BYTES: usize = 16;

#[cfg(windows)]
type NativeNonce = [u8; NATIVE_NONCE_BYTES];

#[cfg(windows)]
const NATIVE_NONCE_ATTEMPTS: usize = 32;

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum GroupNativeFailureKind {
    Setup,
    Spawn,
    Identity,
    Assignment,
    Membership,
    Resume,
    Cleanup,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum SuspendedRootState {
    Unassigned,
    AssignedSuspended,
    Resumed,
}

/// Private ownership for a group before the journal/activation seam is wired.
/// The Job and every Child remain together so a partial native operation can
/// never return a cleanup-free error.
#[cfg(windows)]
#[allow(dead_code)]
struct SuspendedGroup {
    job: Option<WindowsJob>,
    job_nonce: NativeNonce,
    roots: Vec<SuspendedGroupRoot>,
    // Only planned roots that have not acquired a Child are retained here.
    // Once a root exists, its nonce moves into that root's owner record.
    unacquired_root_nonces: VecDeque<NativeNonce>,
    cleanup_complete: bool,
    #[cfg(test)]
    cleanup_failure_at: Option<usize>,
}

#[cfg(windows)]
#[allow(dead_code)]
struct SuspendedGroupRoot {
    child: Child,
    root_nonce: NativeNonce,
    identity: Option<OwnedProcessIdentity>,
    ordinal: u32,
    state: SuspendedRootState,
}

#[cfg(windows)]
#[allow(dead_code)]
struct PreallocatedNativeNonces {
    job_nonce: NativeNonce,
    root_nonces: Vec<NativeNonce>,
}

/// A private observation produced only after the existing native ownership
/// checks pass. It carries binding evidence for the future activation seam;
/// it is deliberately not a readiness or terminal proof and has no
/// serialization or Debug authority.
#[cfg(windows)]
#[allow(dead_code)]
struct NativeBindingSnapshot {
    job_nonce: NativeNonce,
    roots: Vec<NativeRootObservation>,
}

#[cfg(windows)]
#[allow(dead_code)]
struct NativeRootObservation {
    ordinal: u32,
    root_nonce: NativeNonce,
    identity: OwnedProcessIdentity,
}

#[cfg(windows)]
fn generate_group_nonces(root_count: usize) -> Result<PreallocatedNativeNonces, String> {
    generate_group_nonces_with_filler(root_count, |nonce| {
        OsRng.try_fill_bytes(nonce).map_err(|_| ())
    })
}

#[cfg(windows)]
fn generate_group_nonces_with_filler<F>(
    root_count: usize,
    mut fill: F,
) -> Result<PreallocatedNativeNonces, String>
where
    F: FnMut(&mut NativeNonce) -> Result<(), ()>,
{
    if root_count == 0 {
        return Err("A runtime group must contain at least one root.".into());
    }

    let mut used = HashSet::with_capacity(root_count.saturating_add(1));
    let job_nonce = generate_unique_nonce(&mut used, &mut fill, "Job")?;
    let mut root_nonces = Vec::with_capacity(root_count);
    while root_nonces.len() < root_count {
        root_nonces.push(generate_unique_nonce(&mut used, &mut fill, "root")?);
    }
    Ok(PreallocatedNativeNonces {
        job_nonce,
        root_nonces,
    })
}

#[cfg(windows)]
fn generate_unique_nonce<F>(
    used: &mut HashSet<NativeNonce>,
    fill: &mut F,
    subject: &str,
) -> Result<NativeNonce, String>
where
    F: FnMut(&mut NativeNonce) -> Result<(), ()>,
{
    for _ in 0..NATIVE_NONCE_ATTEMPTS {
        let mut nonce = [0_u8; NATIVE_NONCE_BYTES];
        fill(&mut nonce).map_err(|_| {
            format!("Runtime group {subject} nonce generation failed before native acquisition.")
        })?;
        if nonce != [0_u8; NATIVE_NONCE_BYTES] && used.insert(nonce) {
            return Ok(nonce);
        }
    }
    Err(format!(
        "Runtime group {subject} nonce generation exceeded its bounded retry budget before native acquisition."
    ))
}

#[cfg(windows)]
#[allow(dead_code)]
fn native_nonce_text(nonce: &NativeNonce) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(nonce.len() * 2);
    for byte in nonce {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0x0f) as usize] as char);
    }
    text
}

#[cfg(windows)]
#[allow(dead_code)]
struct GroupNativeFailure {
    kind: GroupNativeFailureKind,
    #[allow(dead_code)]
    detail: String,
    owner: Option<SuspendedGroup>,
}

#[cfg(windows)]
#[allow(dead_code)]
struct GroupCleanupFailure {
    kind: GroupNativeFailureKind,
    detail: String,
    #[allow(dead_code)]
    owner: SuspendedGroup,
}

/// The private owner returned by the connected activation seam.  Native
/// acquisition and staging stay together so a partial group can never lose
/// either cleanup authority.  `native_cleanup_proven` means that no native
/// owner remains because its proof already succeeded; a later staging retry
/// must not reconstruct or re-run that proof.
#[cfg(windows)]
pub(crate) struct SuspendedActivationOwner {
    staging: RunStagingOwner,
    native: Option<SuspendedGroup>,
    native_cleanup_proven: bool,
}

#[cfg(windows)]
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SuspendedActivationFailureKind {
    Staging,
    Native(GroupNativeFailureKind),
    Journal,
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) struct SuspendedActivationFailure {
    kind: SuspendedActivationFailureKind,
    detail: String,
    owner: Option<SuspendedActivationOwner>,
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) struct SuspendedActivationCleanupFailure {
    detail: String,
    owner: SuspendedActivationOwner,
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) struct ReadySuspendedActivationOwner {
    owner: SuspendedActivationOwner,
    ready_journal: RuntimeSessionJournalV1,
}

#[cfg(windows)]
impl SuspendedActivationFailure {
    #[allow(dead_code)]
    pub(crate) fn into_owner(self) -> Option<SuspendedActivationOwner> {
        self.owner
    }
}

#[cfg(windows)]
impl SuspendedActivationCleanupFailure {
    #[allow(dead_code)]
    pub(crate) fn into_owner(self) -> SuspendedActivationOwner {
        self.owner
    }
}

#[cfg(windows)]
impl SuspendedActivationOwner {
    #[allow(dead_code)]
    pub(crate) fn persist_ready(
        mut self,
    ) -> Result<ReadySuspendedActivationOwner, SuspendedActivationFailure> {
        let observation = match self.resource_observation() {
            Ok(observation) => observation,
            Err(detail) => {
                return Err(SuspendedActivationFailure {
                    kind: SuspendedActivationFailureKind::Native(
                        GroupNativeFailureKind::Membership,
                    ),
                    detail,
                    owner: Some(self),
                });
            }
        };
        let timestamp = match self.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => {
                return Err(SuspendedActivationFailure {
                    kind: SuspendedActivationFailureKind::Journal,
                    detail,
                    owner: Some(self),
                });
            }
        };
        // `started_at` records when the producer observed the native root
        // identity, while this separate timestamp records the Ready CAS.  A
        // producer clock may advance equally, but it must not move backwards
        // between those two observations.
        if observation
            .roots
            .iter()
            .any(|root| timestamp < root.started_at)
        {
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Journal,
                detail: "Capture runtime producer clock moved backwards before Ready CAS.".into(),
                owner: Some(self),
            });
        }
        let ready_journal = match self.staging.persist_ready(observation, timestamp) {
            Ok(ready_journal) => ready_journal,
            Err(detail) => {
                return Err(SuspendedActivationFailure {
                    kind: SuspendedActivationFailureKind::Journal,
                    detail,
                    owner: Some(self),
                });
            }
        };
        Ok(ReadySuspendedActivationOwner {
            owner: self,
            ready_journal,
        })
    }

    fn resource_observation(&mut self) -> Result<ResourceObservation, String> {
        if !self.staging.journal_is_still_prepared() {
            return Err(
                "Capture runtime prepared binding changed before Ready observation.".into(),
            );
        }
        self.staging.revalidate_address_index()?;
        let _checked_commands = self.staging.checked_commands()?;
        let snapshot = self
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing before Ready.".to_string())?
            .binding_snapshot()?;
        let staging_binding = self.staging.staging_binding_for_ready()?;
        let planned_roots = self.staging.planned_roots();
        if planned_roots.len() != snapshot.roots.len() {
            return Err("Capture runtime native root observation was incomplete.".into());
        }
        let started_at = self.staging.next_timestamp()?;
        let mut roots = Vec::with_capacity(planned_roots.len());
        for (planned, actual) in planned_roots.iter().zip(snapshot.roots) {
            let ordinal = usize::try_from(planned.ordinal)
                .map_err(|_| "Capture runtime root ordinal was invalid.")?;
            if actual.ordinal != planned.ordinal {
                return Err("Capture runtime native root order changed before Ready.".into());
            }
            let loopback_port = self
                .staging
                .planned_root_port(ordinal)
                .ok_or_else(|| "Capture runtime frozen root port was missing.".to_string())?;
            roots.push(JournalRoot {
                ordinal: planned.ordinal,
                role: planned.role.clone(),
                root_ref_digest: planned.root_ref_digest.clone(),
                root_generation: planned.root_generation,
                root_nonce: native_nonce_text(&actual.root_nonce),
                pid: actual.identity.pid,
                creation_identity: CreationIdentity {
                    kind: "windows-process-creation".into(),
                    value: format!("{:016x}", actual.identity.creation_time),
                },
                state: RootState::Suspended,
                reserved_listener_identity: planned.reserved_listener_identity.clone(),
                loopback_port,
                live_listener_readiness: None,
                started_at: started_at.clone(),
            });
        }
        Ok(ResourceObservation {
            job_binding: JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: native_nonce_text(&snapshot.job_nonce),
            },
            staging_binding: Some(staging_binding),
            roots,
        })
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.native.as_ref().map(|native| native.roots.len())
    }

    #[cfg(test)]
    pub(crate) fn native_is_suspended_for_test(&mut self) -> bool {
        self.native
            .as_mut()
            .is_some_and(|native| native.binding_snapshot().is_ok())
    }

    #[cfg(test)]
    pub(crate) fn native_cleanup_proven_for_test(&self) -> bool {
        self.native_cleanup_proven
    }

    #[cfg(test)]
    pub(crate) fn inject_native_cleanup_failure_for_test(&mut self) {
        let native = self.native.as_mut().expect("native owner");
        native.inject_cleanup_failure_after_first_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_journal_drift_before_ready_for_test(&self) {
        self.staging.inject_journal_drift_before_ready_for_test();
    }
}

#[cfg(windows)]
impl ReadySuspendedActivationOwner {
    /// Failure cleanup is native-first and never claims terminal proof. The
    /// Ready journal remains for the later reconciliation transition when the
    /// pre-native staging cleanup rejects its PreparedBound-only boundary.
    #[allow(dead_code)]
    pub(crate) fn cleanup_without_terminal_proof(
        self,
    ) -> Result<(), SuspendedActivationCleanupFailure> {
        self.owner.cleanup()
    }

    #[cfg(test)]
    pub(crate) fn ready_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.ready_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }

    #[cfg(test)]
    pub(crate) fn native_is_suspended_for_test(&mut self) -> bool {
        self.owner.native_is_suspended_for_test()
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
struct GroupCleanupProof {
    roots_reaped: bool,
    descendants_terminated: bool,
}

#[cfg(windows)]
impl fmt::Debug for SuspendedGroup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SuspendedGroup")
            .field("root_count", &self.roots.len())
            .field("cleanup_complete", &self.cleanup_complete)
            .finish()
    }
}

#[cfg(windows)]
impl fmt::Debug for GroupNativeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GroupNativeFailure")
            .field("kind", &self.kind)
            .field("owner_present", &self.owner.is_some())
            .finish()
    }
}

#[cfg(windows)]
impl fmt::Debug for GroupCleanupFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GroupCleanupFailure")
            .field("kind", &self.kind)
            .finish()
    }
}

#[cfg(windows)]
#[allow(dead_code)]
impl GroupNativeFailure {
    fn with_owner(
        kind: GroupNativeFailureKind,
        detail: impl Into<String>,
        owner: SuspendedGroup,
    ) -> Self {
        Self {
            kind,
            detail: detail.into(),
            owner: Some(owner),
        }
    }

    fn without_owner(kind: GroupNativeFailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
            owner: None,
        }
    }

    #[cfg(test)]
    fn kind(&self) -> GroupNativeFailureKind {
        self.kind
    }
}

#[cfg(windows)]
#[allow(dead_code)]
impl GroupCleanupFailure {
    #[cfg(test)]
    fn retry(self) -> Result<GroupCleanupProof, Self> {
        match self.owner.cleanup_and_prove() {
            Ok(proof) => Ok(proof),
            Err(next) => Err(next),
        }
    }
}

#[cfg(windows)]
#[allow(dead_code)]
impl SuspendedGroup {
    fn spawn(commands: &mut [Command]) -> Result<Self, GroupNativeFailure> {
        Self::spawn_with_prespawn_check(commands, |_, _| Ok(()))
    }

    /// Shared native acquisition loop with a private last-moment check.  The
    /// connected activation path uses this hook to replace each command from
    /// the frozen descriptor immediately before CreateProcess; legacy tests
    /// and callers use the no-op adapter above.
    fn spawn_with_prespawn_check<F>(
        commands: &mut [Command],
        before_spawn: F,
    ) -> Result<Self, GroupNativeFailure>
    where
        F: FnMut(usize, &mut Command) -> Result<(), String>,
    {
        if commands.is_empty() {
            return Err(GroupNativeFailure::without_owner(
                GroupNativeFailureKind::Setup,
                "A runtime group must contain at least one root.",
            ));
        }
        let nonces = generate_group_nonces(commands.len()).map_err(|error| {
            GroupNativeFailure::without_owner(GroupNativeFailureKind::Setup, error)
        })?;
        let job = WindowsJob::new().map_err(|error| {
            GroupNativeFailure::without_owner(GroupNativeFailureKind::Setup, error)
        })?;
        Self::spawn_with_job(commands, job, nonces, before_spawn)
    }

    #[cfg(test)]
    fn spawn_with_faults(
        commands: &mut [Command],
        faults: GroupTestFaults,
    ) -> Result<Self, GroupNativeFailure> {
        if commands.is_empty() {
            return Err(GroupNativeFailure::without_owner(
                GroupNativeFailureKind::Setup,
                "A runtime group must contain at least one root.",
            ));
        }
        #[cfg(test)]
        if faults.nonce_generation_failure {
            return Err(GroupNativeFailure::without_owner(
                GroupNativeFailureKind::Setup,
                "Runtime group nonce generation failed before native acquisition.",
            ));
        }
        let nonces = generate_group_nonces(commands.len()).map_err(|error| {
            GroupNativeFailure::without_owner(GroupNativeFailureKind::Setup, error)
        })?;
        let job = WindowsJob::new_with_faults(faults).map_err(|error| {
            GroupNativeFailure::without_owner(GroupNativeFailureKind::Setup, error)
        })?;
        Self::spawn_with_job(commands, job, nonces, |_, _| Ok(()))
    }

    fn spawn_with_job<F>(
        commands: &mut [Command],
        job: WindowsJob,
        nonces: PreallocatedNativeNonces,
        mut before_spawn: F,
    ) -> Result<Self, GroupNativeFailure>
    where
        F: FnMut(usize, &mut Command) -> Result<(), String>,
    {
        debug_assert_eq!(commands.len(), nonces.root_nonces.len());
        let mut group = Self {
            job: Some(job),
            job_nonce: nonces.job_nonce,
            roots: Vec::with_capacity(commands.len()),
            unacquired_root_nonces: VecDeque::from(nonces.root_nonces),
            cleanup_complete: false,
            #[cfg(test)]
            cleanup_failure_at: None,
        };
        for (ordinal, command) in commands.iter_mut().enumerate() {
            let root_nonce = *group
                .unacquired_root_nonces
                .front()
                .expect("pre-generated root nonce");
            if let Err(error) = before_spawn(ordinal, command) {
                return Err(group.failure(
                    GroupNativeFailureKind::Spawn,
                    format!("Capture runtime root failed its frozen pre-spawn check: {error}"),
                ));
            }
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return Err(group.failure(
                        GroupNativeFailureKind::Spawn,
                        format!("Capture runtime root could not be started: {error}"),
                    ));
                }
            };
            group
                .unacquired_root_nonces
                .pop_front()
                .expect("pre-generated root nonce");
            group.roots.push(SuspendedGroupRoot {
                child,
                root_nonce,
                identity: None,
                ordinal: ordinal as u32,
                state: SuspendedRootState::Unassigned,
            });
            let index = group.roots.len() - 1;
            #[cfg(test)]
            if group
                .job
                .as_mut()
                .expect("group Job")
                .take_identity_failure(ordinal)
            {
                return Err(group.failure(
                    GroupNativeFailureKind::Identity,
                    format!("Injected identity capture failure for runtime root {ordinal}."),
                ));
            }
            let identity = match process_identity_from_handle(
                group.roots[index].child.as_raw_handle() as *mut c_void,
                group.roots[index].child.id(),
            ) {
                Ok(identity) => identity,
                Err(error) => {
                    return Err(group.failure(
                        GroupNativeFailureKind::Identity,
                        format!("Capture runtime root identity could not be captured: {error}"),
                    ));
                }
            };
            group.roots[index].identity = Some(identity);
            if let Err(error) = group
                .job
                .as_mut()
                .expect("group Job")
                .assign(&group.roots[index].child)
            {
                return Err(group.failure(GroupNativeFailureKind::Assignment, error));
            }
            group.roots[index].state = SuspendedRootState::AssignedSuspended;
            if let Err(error) = group
                .job
                .as_mut()
                .expect("group Job")
                .verify_assignment(&group.roots[index].child)
            {
                return Err(group.failure(GroupNativeFailureKind::Membership, error));
            }
        }
        Ok(group)
    }

    fn failure(
        self,
        kind: GroupNativeFailureKind,
        detail: impl Into<String>,
    ) -> GroupNativeFailure {
        GroupNativeFailure::with_owner(kind, detail, self)
    }

    fn verify_all_assigned_suspended(&mut self) -> Result<(), String> {
        if self.roots.is_empty() {
            return Err("A runtime group must contain at least one root.".into());
        }
        for root in &self.roots {
            if root.state != SuspendedRootState::AssignedSuspended {
                return Err(format!(
                    "Runtime root {} was not retained in the assigned suspended state.",
                    root.ordinal
                ));
            }
            let expected = root.identity.ok_or_else(|| {
                format!("Runtime root {} has no captured identity.", root.ordinal)
            })?;
            let observed = process_identity_from_handle(
                root.child.as_raw_handle() as *mut c_void,
                root.child.id(),
            )?;
            if !same_process_identity(expected, observed) {
                return Err(format!(
                    "Runtime root {} creation identity changed before resume.",
                    root.ordinal
                ));
            }
            self.job
                .as_mut()
                .expect("group Job")
                .verify_assignment(&root.child)?;
            verify_suspended_primary_thread(&root.child)?;
        }
        let expected = self
            .roots
            .iter()
            .map(|root| root.identity.expect("validated root identity"))
            .collect::<Vec<_>>();
        self.job
            .as_mut()
            .expect("group Job")
            .verify_membership_set(&expected)
    }

    #[allow(dead_code)]
    fn binding_snapshot(&mut self) -> Result<NativeBindingSnapshot, String> {
        self.verify_all_assigned_suspended()?;
        if !self.unacquired_root_nonces.is_empty() {
            return Err("Runtime group has planned roots without acquired owners.".into());
        }

        let mut seen_nonces = HashSet::with_capacity(self.roots.len().saturating_add(1));
        if !seen_nonces.insert(self.job_nonce) {
            return Err("Runtime group Job nonce was duplicated.".into());
        }
        let mut roots = Vec::with_capacity(self.roots.len());
        for (index, root) in self.roots.iter().enumerate() {
            let expected_ordinal = u32::try_from(index)
                .map_err(|_| "Runtime group root ordinal exceeded its native binding range.")?;
            if root.ordinal != expected_ordinal {
                return Err(format!(
                    "Runtime group root ordinal {} was out of order.",
                    root.ordinal
                ));
            }
            if !seen_nonces.insert(root.root_nonce) {
                return Err(format!(
                    "Runtime group root {expected_ordinal} nonce was duplicated."
                ));
            }
            let identity = root.identity.ok_or_else(|| {
                format!("Runtime group root {expected_ordinal} has no captured identity.")
            })?;
            roots.push(NativeRootObservation {
                ordinal: expected_ordinal,
                root_nonce: root.root_nonce,
                identity,
            });
        }
        Ok(NativeBindingSnapshot {
            job_nonce: self.job_nonce,
            roots,
        })
    }

    /// Consumes the owner. On failure the returned error contains the same
    /// owner, so the caller can reconcile without reconstructing native state.
    fn resume_all(mut self) -> Result<Self, GroupNativeFailure> {
        if let Err(error) = self.verify_all_assigned_suspended() {
            return Err(self.failure(GroupNativeFailureKind::Membership, error));
        }
        for index in 0..self.roots.len() {
            #[cfg(test)]
            if self
                .job
                .as_mut()
                .expect("group Job")
                .take_resume_failure(index)
            {
                return Err(self.failure(
                    GroupNativeFailureKind::Resume,
                    format!("Injected resume failure for runtime root {index}."),
                ));
            }
            if let Err(error) = resume_suspended_process(&self.roots[index].child) {
                return Err(self.failure(GroupNativeFailureKind::Resume, error));
            }
            self.roots[index].state = SuspendedRootState::Resumed;
        }
        Ok(self)
    }

    fn cleanup_inner(&mut self) -> Result<GroupCleanupProof, String> {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(u64::from(GROUP_CLEANUP_BUDGET_MS));
        let job = self.job.as_mut().expect("group Job");
        let _job_terminated = job.terminate().is_ok();
        for (index, root) in self.roots.iter_mut().enumerate() {
            #[cfg(not(test))]
            let _ = index;
            #[cfg(test)]
            if self.cleanup_failure_at == Some(index) {
                self.cleanup_failure_at = None;
                return Err("Injected suspended group cleanup failure.".into());
            }
            if let Some(identity) = root.identity {
                // Keep using each retained Child handle even after a Job kill;
                // this makes suspended roots and already-exited roots equally
                // proveable without reopening by PID.
                terminate_process_with_proof_with_timeout(
                    root.child.as_raw_handle() as *mut c_void,
                    identity,
                    remaining_timeout_ms(deadline),
                )?;
                reap_child_by_exact_handle(&mut root.child, remaining_timeout_ms(deadline))?;
            } else {
                terminate_child_by_exact_handle(&mut root.child, remaining_timeout_ms(deadline))?;
            }
        }
        if self.job.as_ref().expect("group Job").active_processes()? != 0 {
            self.job
                .as_mut()
                .expect("group Job")
                .terminate_remaining_owned_processes(deadline)?;
        }
        if self.job.as_ref().expect("group Job").active_processes()? != 0 {
            return Err("Runtime group Job still reports active processes.".into());
        }
        Ok(GroupCleanupProof {
            roots_reaped: true,
            descendants_terminated: true,
        })
    }

    fn cleanup_and_prove(mut self) -> Result<GroupCleanupProof, GroupCleanupFailure> {
        match self.cleanup_inner() {
            Ok(proof) => {
                self.cleanup_complete = true;
                Ok(proof)
            }
            Err(detail) => Err(GroupCleanupFailure {
                kind: GroupNativeFailureKind::Cleanup,
                detail,
                owner: self,
            }),
        }
    }

    #[cfg(test)]
    fn inject_cleanup_failure_after_first_for_test(&mut self) {
        self.cleanup_failure_at = Some(1);
    }
}

#[cfg(windows)]
impl fmt::Debug for SuspendedActivationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SuspendedActivationFailure")
            .field("kind", &self.kind)
            .field("owner_present", &self.owner.is_some())
            .finish()
    }
}

#[cfg(windows)]
impl fmt::Debug for SuspendedActivationCleanupFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SuspendedActivationCleanupFailure")
            .finish()
    }
}

#[cfg(windows)]
/// Connects the already-consumed prepared context to the existing native
/// suspended-group owner.  The returned value is intentionally private and
/// contains no readiness or lease claim.
#[allow(dead_code)]
pub(crate) fn acquire_suspended_for_activation(
    activation: ValidatedActivationContext,
) -> Result<SuspendedActivationOwner, SuspendedActivationFailure> {
    let staging = match crate::staging::materialize(activation) {
        Ok(owner) => owner,
        Err(StagingFailure::BeforeOwnership(kind)) => {
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Staging,
                detail: format!("Capture runtime staging acquisition stopped: {kind:?}."),
                owner: None,
            });
        }
        Err(StagingFailure::Owned { owner, kind }) => {
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Staging,
                detail: format!("Capture runtime staging acquisition stopped: {kind:?}."),
                owner: Some(SuspendedActivationOwner {
                    staging: owner,
                    native: None,
                    native_cleanup_proven: true,
                }),
            });
        }
    };

    acquire_suspended_from_staging(staging)
}

#[cfg(windows)]
/// Continues only from a staging owner returned by `materialize`; callers
/// cannot construct that owner or substitute an activation path themselves.
#[allow(dead_code)]
pub(crate) fn acquire_suspended_from_staging(
    staging: RunStagingOwner,
) -> Result<SuspendedActivationOwner, SuspendedActivationFailure> {
    // Recheck the interval between staging materialization and Job creation.
    let mut commands = match staging.checked_commands() {
        Ok(commands) => commands,
        Err(_detail) => {
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Staging,
                detail: "Capture runtime frozen command revalidation failed before Job setup."
                    .into(),
                owner: Some(SuspendedActivationOwner {
                    staging,
                    native: None,
                    native_cleanup_proven: true,
                }),
            });
        }
    };

    let native =
        match SuspendedGroup::spawn_with_prespawn_check(&mut commands, |ordinal, command| {
            staging.check_before_root_spawn(ordinal, command)
        }) {
            Ok(native) => native,
            Err(failure) => {
                let native = failure.owner;
                return Err(SuspendedActivationFailure {
                    kind: SuspendedActivationFailureKind::Native(failure.kind),
                    detail: failure.detail,
                    owner: Some(SuspendedActivationOwner {
                        staging,
                        native_cleanup_proven: native.is_none(),
                        native,
                    }),
                });
            }
        };

    let mut native = native;
    if let Err(detail) = native.binding_snapshot() {
        return Err(SuspendedActivationFailure {
            kind: SuspendedActivationFailureKind::Native(GroupNativeFailureKind::Membership),
            detail,
            owner: Some(SuspendedActivationOwner {
                staging,
                native: Some(native),
                native_cleanup_proven: false,
            }),
        });
    }
    if !staging.journal_is_still_prepared() {
        return Err(SuspendedActivationFailure {
            kind: SuspendedActivationFailureKind::Native(GroupNativeFailureKind::Membership),
            detail: "Capture runtime prepared binding changed after suspended acquisition.".into(),
            owner: Some(SuspendedActivationOwner {
                staging,
                native: Some(native),
                native_cleanup_proven: false,
            }),
        });
    }

    Ok(SuspendedActivationOwner {
        staging,
        native: Some(native),
        native_cleanup_proven: false,
    })
}

#[cfg(windows)]
impl SuspendedActivationOwner {
    /// Cleanup is native-first.  A staging retry after successful native
    /// proof retains only the staging owner and never recreates the group.
    #[allow(dead_code)]
    pub(crate) fn cleanup(mut self) -> Result<(), SuspendedActivationCleanupFailure> {
        if !self.native_cleanup_proven {
            if let Some(native) = self.native.take() {
                match native.cleanup_and_prove() {
                    Ok(_proof) => self.native_cleanup_proven = true,
                    Err(failure) => {
                        self.native = Some(failure.owner);
                        return Err(SuspendedActivationCleanupFailure {
                            detail: failure.detail,
                            owner: self,
                        });
                    }
                }
            } else {
                // No Job was ever acquired.  This is a valid staging-only
                // owner, so native cleanup is already vacuously complete.
                self.native_cleanup_proven = true;
            }
        }

        match self.staging.cleanup_pre_native() {
            Ok(_observation) => Ok(()),
            Err(error) => Err(SuspendedActivationCleanupFailure {
                detail: format!("Capture runtime staging cleanup stopped: {error:?}."),
                owner: self,
            }),
        }
    }
}

#[cfg(windows)]
impl Drop for SuspendedGroup {
    fn drop(&mut self) {
        if self.cleanup_complete {
            return;
        }
        // Drop is only a last-resort native safety net. It never fabricates a
        // cleanup proof; explicit cleanup retains this same owner on failure.
        if let Some(job) = self.job.as_mut() {
            let _ = job.terminate();
        }
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(u64::from(GROUP_CLEANUP_BUDGET_MS));
        for root in &mut self.roots {
            let _ = terminate_child_by_exact_handle(
                &mut root.child,
                remaining_timeout_ms(deadline).min(DROP_CLEANUP_WAIT_MS),
            );
        }
    }
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
    prove_process_terminated_with_timeout(handle, expected, PROCESS_WAIT_TIMEOUT_MS)
}

#[cfg(windows)]
fn prove_process_terminated_with_timeout(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    wait_timeout_ms: u32,
) -> Result<(), String> {
    let observed = process_identity_from_handle(handle, expected.pid)?;
    classify_terminated_process_with_timeout(handle, expected, observed, wait_timeout_ms)
}

#[cfg(windows)]
fn terminate_process_with_proof(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
) -> Result<(), String> {
    terminate_process_with_proof_with_timeout(handle, expected, PROCESS_WAIT_TIMEOUT_MS)
}

#[cfg(windows)]
fn terminate_process_with_proof_with_timeout(
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
fn classify_terminated_process(
    handle: *mut c_void,
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
) -> Result<(), String> {
    classify_terminated_process_with_timeout(handle, expected, observed, PROCESS_WAIT_TIMEOUT_MS)
}

#[cfg(windows)]
fn classify_terminated_process_with_timeout(
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

#[cfg(any(windows, test))]
fn next_process_list_capacity(
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
    #[cfg(test)]
    assignment_failure_at: Option<usize>,
    #[cfg(test)]
    assignment_attempts: usize,
    #[cfg(test)]
    membership_failure_at: Option<usize>,
    #[cfg(test)]
    membership_attempts: usize,
    #[cfg(test)]
    resume_failure_at: Option<usize>,
    #[cfg(test)]
    identity_failure_at: Option<usize>,
}

#[cfg(all(test, windows))]
#[derive(Default)]
struct GroupTestFaults {
    assignment_failure_at: Option<usize>,
    membership_failure_at: Option<usize>,
    resume_failure_at: Option<usize>,
    identity_failure_at: Option<usize>,
    nonce_generation_failure: bool,
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
    fn new_with_faults(faults: GroupTestFaults) -> Result<Self, String> {
        let mut job = Self::new()?;
        job.assignment_failure_at = faults.assignment_failure_at;
        job.membership_failure_at = faults.membership_failure_at;
        job.resume_failure_at = faults.resume_failure_at;
        job.identity_failure_at = faults.identity_failure_at;
        Ok(job)
    }

    fn assign(&mut self, child: &Child) -> Result<(), String> {
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

    fn verify_assignment(&mut self, child: &Child) -> Result<(), String> {
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

    #[allow(dead_code)]
    fn verify_membership_set(&mut self, expected: &[OwnedProcessIdentity]) -> Result<(), String> {
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

    #[allow(dead_code)]
    fn terminate_remaining_owned_processes(
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

    fn terminate_owned_process_with_timeout(
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

    fn prove_missing_process_terminated(
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

    #[cfg(test)]
    fn take_resume_failure(&mut self, ordinal: usize) -> bool {
        if self.resume_failure_at == Some(ordinal) {
            self.resume_failure_at = None;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn take_identity_failure(&mut self, ordinal: usize) -> bool {
        if self.identity_failure_at == Some(ordinal) {
            self.identity_failure_at = None;
            true
        } else {
            false
        }
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
#[allow(dead_code)]
fn remaining_timeout_ms(deadline: std::time::Instant) -> u32 {
    let millis = deadline
        .saturating_duration_since(std::time::Instant::now())
        .as_millis();
    u32::try_from(millis.min(u128::from(u32::MAX))).unwrap_or(u32::MAX)
}

#[cfg(windows)]
#[allow(dead_code)]
fn reap_child_by_exact_handle(child: &mut Child, wait_timeout_ms: u32) -> Result<(), String> {
    let handle = child.as_raw_handle() as *mut c_void;
    let wait_state = unsafe { WaitForSingleObject(handle, wait_timeout_ms) };
    if wait_state != WAIT_OBJECT_0 {
        return Err(match wait_state {
            WAIT_TIMEOUT => "Runtime group root did not exit within the cleanup budget.",
            WAIT_FAILED => "Runtime group root wait failed.",
            _ => "Runtime group root returned an unknown wait state.",
        }
        .into());
    }
    let mut exit_code = 0_u32;
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
        return Err(format!(
            "Runtime group root terminal exit code could not be queried: {}",
            io::Error::last_os_error()
        ));
    }
    if exit_code == 259 {
        return Err("Runtime group root still reports an active exit code.".into());
    }
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err("Runtime group root was signaled but could not be reaped.".into()),
        Err(error) => Err(format!("Runtime group root could not be reaped: {error}")),
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn terminate_child_by_exact_handle(child: &mut Child, wait_timeout_ms: u32) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("Runtime group root liveness could not be proven: {error}"))?
        .is_some()
    {
        return Ok(());
    }
    if let Err(error) = child.kill() {
        if child
            .try_wait()
            .map_err(|wait_error| {
                format!(
                    "Runtime group root kill failed ({error}) and liveness could not be proven: {wait_error}"
                )
            })?
            .is_some()
        {
            return Ok(());
        }
        return Err(format!("Runtime group root could not be stopped: {error}"));
    }
    reap_child_by_exact_handle(child, wait_timeout_ms)
}

#[cfg(windows)]
fn open_suspended_primary_thread(child: &Child) -> Result<ScopedWindowsHandle, String> {
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
#[allow(dead_code)]
fn verify_suspended_primary_thread(child: &Child) -> Result<(), String> {
    // CREATE_SUSPENDED provides the initial native suspension. Re-observe the
    // exact primary thread and temporarily move its count 1 -> 2 -> 1 so the
    // current count is proven rather than inferred from launch history.
    let thread = open_suspended_primary_thread(child)?;
    let previous_suspend_count = unsafe { SuspendThread(thread.raw()) };
    if previous_suspend_count == u32::MAX {
        return Err(format!(
            "The owned runtime primary thread suspend count could not be observed: {}",
            io::Error::last_os_error()
        ));
    }
    let restored_previous_count = unsafe { ResumeThread(thread.raw()) };
    if restored_previous_count == u32::MAX {
        return Err(format!(
            "The owned runtime primary thread suspend count could not be restored: {}",
            io::Error::last_os_error()
        ));
    }
    if previous_suspend_count != 1 || restored_previous_count != 2 {
        return Err(format!(
            "The owned runtime primary thread had an unexpected suspend transition {previous_suspend_count} -> {restored_previous_count}; expected 1 -> 2 -> 1."
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn resume_suspended_process(child: &Child) -> Result<(), String> {
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

    #[cfg(windows)]
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

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
    fn group_marker_path(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "capture-runtime-group-{label}-{}-{}-{}.txt",
            std::process::id(),
            tick,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[cfg(windows)]
    fn marker_command(marker: &Path, keep_alive: bool) -> Command {
        let marker = marker.to_string_lossy().replace('\'', "''");
        let script = if keep_alive {
            format!("Set-Content -LiteralPath '{marker}' -Value started; Start-Sleep -Seconds 30")
        } else {
            format!("Set-Content -LiteralPath '{marker}' -Value started")
        };
        let mut command = powershell_command(&script);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[cfg(windows)]
    fn wait_for_marker(path: &Path, expected: bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while path.exists() != expected && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            path.exists(),
            expected,
            "marker state for {}",
            path.display()
        );
    }

    #[cfg(windows)]
    fn cleanup_group_failure(failure: GroupNativeFailure) -> GroupCleanupProof {
        let owner = failure
            .owner
            .expect("native failure must retain group owner");
        owner
            .cleanup_and_prove()
            .unwrap_or_else(|failure| panic!("group cleanup proof: {}", failure.detail))
    }

    #[cfg(windows)]
    #[test]
    fn suspended_group_keeps_all_roots_suspended_until_one_resume_boundary() {
        let first_marker = group_marker_path("suspended-first");
        let second_marker = group_marker_path("suspended-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("group roots should be assigned while suspended");
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, false);
        let snapshot = group
            .binding_snapshot()
            .expect("verified suspended group binding snapshot");
        assert_eq!(snapshot.roots.len(), 2);
        assert_eq!(snapshot.roots[0].ordinal, 0);
        assert_eq!(snapshot.roots[1].ordinal, 1);
        assert_ne!(snapshot.job_nonce, [0_u8; NATIVE_NONCE_BYTES]);
        assert_ne!(snapshot.roots[0].root_nonce, snapshot.roots[1].root_nonce);
        assert_ne!(snapshot.job_nonce, snapshot.roots[0].root_nonce);
        assert_ne!(snapshot.job_nonce, snapshot.roots[1].root_nonce);
        assert_eq!(
            snapshot.roots[0].identity,
            group.roots[0].identity.expect("identity")
        );
        assert_eq!(
            snapshot.roots[1].identity,
            group.roots[1].identity.expect("identity")
        );
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, false);
        let group = group
            .resume_all()
            .expect("all roots should resume together");
        wait_for_marker(&first_marker, true);
        wait_for_marker(&second_marker, true);
        let proof = group
            .cleanup_and_prove()
            .expect("resumed group cleanup proof");
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn prespawn_check_failure_at_root_n_retains_prior_suspended_owner() {
        let first_marker = group_marker_path("prespawn-check-first");
        let second_marker = group_marker_path("prespawn-check-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let failure = SuspendedGroup::spawn_with_prespawn_check(&mut commands, |ordinal, _| {
            if ordinal == 1 {
                Err("injected frozen pre-spawn recheck failure".into())
            } else {
                Ok(())
            }
        })
        .expect_err("root N pre-spawn failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Spawn);
        let owner = failure.owner.as_ref().expect("native owner");
        assert_eq!(owner.roots.len(), 1);
        assert_eq!(owner.unacquired_root_nonces.len(), 1);
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, false);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn nonce_generation_failure_happens_before_job_or_child_acquisition() {
        let first_marker = group_marker_path("nonce-failure-first");
        let second_marker = group_marker_path("nonce-failure-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let failure = SuspendedGroup::spawn_with_faults(
            &mut commands,
            GroupTestFaults {
                nonce_generation_failure: true,
                ..Default::default()
            },
        )
        .expect_err("nonce generation failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Setup);
        assert!(failure.owner.is_none());
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, false);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn nonce_generation_retries_transient_zero_and_duplicate_values() {
        let values = [
            [1_u8; NATIVE_NONCE_BYTES],
            [1_u8; NATIVE_NONCE_BYTES],
            [0_u8; NATIVE_NONCE_BYTES],
            [2_u8; NATIVE_NONCE_BYTES],
        ];
        let mut values = values.into_iter();
        let nonces = generate_group_nonces_with_filler(1, |nonce| {
            *nonce = values.next().expect("test nonce filler value");
            Ok(())
        })
        .expect("transient invalid nonce values should be retried");
        assert_eq!(nonces.job_nonce, [1_u8; NATIVE_NONCE_BYTES]);
        assert_eq!(nonces.root_nonces, [[2_u8; NATIVE_NONCE_BYTES]]);
    }

    #[cfg(windows)]
    #[test]
    fn nonce_generation_exhaustion_is_bounded_for_zero_and_duplicate_values() {
        let mut zero_attempts = 0;
        let zero_failure = match generate_group_nonces_with_filler(1, |nonce| {
            zero_attempts += 1;
            *nonce = [0_u8; NATIVE_NONCE_BYTES];
            Ok(())
        }) {
            Ok(_) => panic!("repeated zero nonce must fail closed"),
            Err(error) => error,
        };
        assert!(zero_failure.contains("bounded retry budget"));
        assert_eq!(zero_attempts, NATIVE_NONCE_ATTEMPTS);

        let mut duplicate_attempts = 0;
        let duplicate_failure = match generate_group_nonces_with_filler(1, |nonce| {
            duplicate_attempts += 1;
            *nonce = [1_u8; NATIVE_NONCE_BYTES];
            Ok(())
        }) {
            Ok(_) => panic!("repeated duplicate nonce must fail closed"),
            Err(error) => error,
        };
        assert!(duplicate_failure.contains("bounded retry budget"));
        assert_eq!(duplicate_attempts, NATIVE_NONCE_ATTEMPTS + 1);
    }

    #[cfg(windows)]
    #[test]
    fn single_root_private_group_uses_the_same_suspend_resume_boundary() {
        let marker = group_marker_path("single-root");
        let mut commands = [marker_command(&marker, true)];
        let group = SuspendedGroup::spawn(&mut commands).expect("single group root should spawn");
        wait_for_marker(&marker, false);
        let group = group.resume_all().expect("single group root should resume");
        wait_for_marker(&marker, true);
        let proof = group
            .cleanup_and_prove()
            .expect("single group root cleanup proof");
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn unexpected_root_resume_is_rejected_before_any_group_root_resumes() {
        let first_marker = group_marker_path("unexpected-resume-first");
        let second_marker = group_marker_path("unexpected-resume-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let group = SuspendedGroup::spawn(&mut commands).expect("group roots should spawn");
        let thread = open_suspended_primary_thread(&group.roots[1].child)
            .expect("second root primary thread");
        assert_eq!(unsafe { SuspendThread(thread.raw()) }, 1);
        assert_eq!(unsafe { ResumeThread(thread.raw()) }, 2);
        assert_eq!(unsafe { ResumeThread(thread.raw()) }, 1);

        let failure = group
            .resume_all()
            .expect_err("unexpectedly resumed root must reject the whole group");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Membership);
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, true);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn group_cleanup_preserves_an_unrelated_baseline_process() {
        let baseline_marker = group_marker_path("baseline");
        let group_marker = group_marker_path("baseline-group");
        let mut baseline = marker_command(&baseline_marker, true)
            .spawn()
            .expect("unrelated baseline process");
        let mut commands = [marker_command(&group_marker, true)];
        let group = SuspendedGroup::spawn(&mut commands)
            .expect("group root should spawn")
            .resume_all()
            .expect("group root should resume");
        wait_for_marker(&group_marker, true);
        group
            .cleanup_and_prove()
            .expect("group cleanup proof should succeed");
        assert!(
            baseline.try_wait().expect("baseline status").is_none(),
            "group cleanup must not terminate an unrelated baseline process"
        );
        baseline.kill().expect("baseline cleanup");
        baseline.wait().expect("baseline reap");
        let _ = std::fs::remove_file(baseline_marker);
        let _ = std::fs::remove_file(group_marker);
    }

    #[cfg(windows)]
    #[test]
    fn group_cleanup_proves_job_descendants_are_reaped() {
        let marker = group_marker_path("descendant");
        let marker_text = marker.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; Set-Content -LiteralPath '{marker_text}' -Value started; Start-Sleep -Seconds 30"
        );
        let mut commands = [powershell_command(&script)];
        for command in &mut commands {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        let group = SuspendedGroup::spawn(&mut commands)
            .expect("group root should spawn")
            .resume_all()
            .expect("group root should resume");
        wait_for_marker(&marker, true);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while group
            .job
            .as_ref()
            .expect("group Job")
            .active_processes()
            .expect("group process query")
            < 2
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            group
                .job
                .as_ref()
                .expect("group Job")
                .active_processes()
                .expect("group process query")
                >= 2,
            "the group should observe its descendant before cleanup"
        );
        let proof = group
            .cleanup_and_prove()
            .expect("group descendant cleanup proof");
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn partial_group_assignment_returns_the_complete_owner_without_resuming() {
        let first_marker = group_marker_path("assignment-first");
        let second_marker = group_marker_path("assignment-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let failure = SuspendedGroup::spawn_with_faults(
            &mut commands,
            GroupTestFaults {
                assignment_failure_at: Some(1),
                ..Default::default()
            },
        )
        .expect_err("second assignment failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Assignment);
        let owner = failure.owner.as_ref().expect("complete group owner");
        assert_eq!(owner.roots.len(), 2);
        assert!(owner.unacquired_root_nonces.is_empty());
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, false);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn membership_failure_after_assignment_retains_the_complete_owner() {
        let first_marker = group_marker_path("membership-first");
        let second_marker = group_marker_path("membership-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let failure = SuspendedGroup::spawn_with_faults(
            &mut commands,
            GroupTestFaults {
                membership_failure_at: Some(1),
                ..Default::default()
            },
        )
        .expect_err("second membership verification failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Membership);
        let owner = failure.owner.as_ref().expect("complete group owner");
        assert_eq!(owner.roots.len(), 2);
        assert_eq!(owner.roots[1].state, SuspendedRootState::AssignedSuspended);
        assert!(owner.unacquired_root_nonces.is_empty());
        wait_for_marker(&first_marker, false);
        wait_for_marker(&second_marker, false);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn root_spawn_failure_retains_prior_job_and_roots_for_cleanup() {
        let first_marker = group_marker_path("spawn-first");
        let mut commands = [marker_command(&first_marker, true), {
            let mut command = Command::new("capture-runtime-command-that-does-not-exist.exe");
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            command
        }];
        let failure = SuspendedGroup::spawn(&mut commands).expect_err("second spawn failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Spawn);
        let owner = failure.owner.as_ref().expect("prior owner");
        assert_eq!(owner.roots.len(), 1);
        assert_eq!(owner.unacquired_root_nonces.len(), 1);
        wait_for_marker(&first_marker, false);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
    }

    #[cfg(windows)]
    #[test]
    fn identity_capture_failure_retains_the_exact_child_handle() {
        let marker = group_marker_path("identity");
        let mut commands = [marker_command(&marker, true)];
        let failure = SuspendedGroup::spawn_with_faults(
            &mut commands,
            GroupTestFaults {
                identity_failure_at: Some(0),
                ..Default::default()
            },
        )
        .expect_err("identity capture failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Identity);
        let owner = failure.owner.as_ref().expect("owner with child handle");
        assert_eq!(owner.roots.len(), 1);
        assert!(owner.roots[0].identity.is_none());
        assert!(owner.unacquired_root_nonces.is_empty());
        wait_for_marker(&marker, false);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn resume_failure_after_first_root_retains_owner_and_cleans_whole_group() {
        let first_marker = group_marker_path("resume-first");
        let second_marker = group_marker_path("resume-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let failure = SuspendedGroup::spawn_with_faults(
            &mut commands,
            GroupTestFaults {
                resume_failure_at: Some(1),
                ..Default::default()
            },
        )
        .expect("suspended group");
        let failure = failure.resume_all().expect_err("second resume failure");
        assert_eq!(failure.kind(), GroupNativeFailureKind::Resume);
        wait_for_marker(&first_marker, true);
        wait_for_marker(&second_marker, false);
        let proof = cleanup_group_failure(failure);
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn explicit_group_cleanup_failure_retains_same_owner_for_retry() {
        let first_marker = group_marker_path("cleanup-first");
        let second_marker = group_marker_path("cleanup-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        group
            .job
            .as_ref()
            .expect("group Job")
            .active_processes()
            .expect("active roots");
        let mut group = group;
        let job_nonce = group.job_nonce;
        let root_nonce = group.roots[0].root_nonce;
        let root_identity = group.roots[0].identity.expect("root identity");
        group
            .job
            .as_mut()
            .expect("group Job")
            .inject_termination_failure();
        group
            .job
            .as_mut()
            .expect("group Job")
            .inject_process_query_failure();
        let cleanup_failure = group
            .cleanup_and_prove()
            .expect_err("injected cleanup failure");
        assert_eq!(cleanup_failure.kind, GroupNativeFailureKind::Cleanup);
        assert_eq!(cleanup_failure.owner.job_nonce, job_nonce);
        assert_eq!(cleanup_failure.owner.roots[0].root_nonce, root_nonce);
        assert_eq!(cleanup_failure.owner.roots[0].identity, Some(root_identity));
        let proof = cleanup_failure.retry().expect("cleanup retry proof");
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
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
    fn process_list_count_inconsistency_at_capacity_fails_closed() {
        const MAX_CAPACITY: usize = 16_384;
        assert_eq!(
            next_process_list_capacity(16, 17, 17, MAX_CAPACITY).expect("capacity grows"),
            Some(32)
        );
        assert!(
            next_process_list_capacity(MAX_CAPACITY, MAX_CAPACITY + 1, 1, MAX_CAPACITY).is_err(),
            "a successful inconsistent count at the maximum must terminate enumeration"
        );
        assert!(
            next_process_list_capacity(MAX_CAPACITY, MAX_CAPACITY, MAX_CAPACITY + 1, MAX_CAPACITY)
                .is_err(),
            "an assigned count beyond the maximum must fail closed"
        );
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
