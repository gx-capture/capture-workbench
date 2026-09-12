use std::{
    fmt, io,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
};

use crate::prepare::{ImmutableGroupPlan, PrepareError, PreparedGroup, ReconcileRefSink};

#[cfg(windows)]
use crate::{
    health::{probe_service_ready, StrictProbeResult},
    journal::{
        CreationIdentity, JobBinding, JobSetupState, JournalRoot, JournalState,
        ResourceObservation, RootState, RuntimeSessionJournalV1,
    },
    journal_store::{ClosingCasError, ClosingCasResult, RunningCasError, RunningCasResult},
    prepare::ValidatedActivationContext,
    staging::{RunStagingOwner, StagingCleanupError, StagingFailure, StagingReleasedObservation},
};

#[cfg(windows)]
use std::collections::{HashMap, HashSet, VecDeque};

#[cfg(windows)]
use rand::{rngs::OsRng, RngCore};

#[cfg(windows)]
use sha2::{Digest, Sha256};

#[cfg(windows)]
use std::{
    ffi::{c_void, OsString},
    mem::size_of,
    os::windows::{ffi::OsStringExt, io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(all(test, windows))]
use std::{
    cell::Cell,
    sync::mpsc::{Receiver, SyncSender},
};

#[cfg(all(test, windows))]
thread_local! {
    static CANCEL_AFTER_LAUNCHING_CAS: Cell<bool> = const { Cell::new(false) };
    static CANCEL_BEFORE_RESUME_ROOT: Cell<Option<usize>> = const { Cell::new(None) };
}

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER,
        ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, INVALID_HANDLE_VALUE, WAIT_FAILED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCP_STATE_LISTEN,
        TCP_TABLE_OWNER_PID_LISTENER,
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
    #[cfg(test)]
    listener_query_failure: bool,
    #[cfg(test)]
    listener_identity_mutation_after_first: bool,
    #[cfg(test)]
    listener_identity_mutation_at_last: bool,
    #[cfg(test)]
    listener_observation_count: usize,
    #[cfg(test)]
    root_exit_after_first: bool,
    #[cfg(test)]
    cleanup_attempts: usize,
    #[cfg(test)]
    cancel_after_cleanup_root: Option<usize>,
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

/// A private observation of the exact loopback listener owned by each root.
/// The process identity is captured from the retained root handle and the
/// table contributes only the listener port; neither a PID supplied by a
/// caller nor Job membership alone can create this value.
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
struct NativeListenerObservation {
    roots: Vec<NativeListenerRootObservation>,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
struct NativeListenerRootObservation {
    ordinal: u32,
    identity: OwnedProcessIdentity,
    port: u16,
}

#[cfg(windows)]
#[allow(dead_code)]
impl NativeListenerObservation {
    fn root_count(&self) -> usize {
        self.roots.len()
    }

    fn root(&self, ordinal: usize) -> Option<&NativeListenerRootObservation> {
        self.roots.get(ordinal)
    }
}

#[cfg(windows)]
const TCP_TABLE_QUERY_ATTEMPTS: usize = 5;

#[cfg(windows)]
const MAX_TCP_TABLE_BYTES: usize = 4 * 1024 * 1024;

#[cfg(windows)]
const AF_INET: u32 = 2;

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

/// The private owner after the durable Launching CAS and native resume loop.
/// The journal is intentionally still Launching: the live listener/readiness
/// observation and Running transition belong to the next lifecycle slice.
#[cfg(windows)]
#[allow(dead_code)]
pub(crate) struct LaunchingActivationOwner {
    owner: SuspendedActivationOwner,
    launching_journal: RuntimeSessionJournalV1,
    #[cfg(all(test, windows))]
    running_admission_hook: Option<RunningAdmissionTestHook>,
}

#[cfg(all(test, windows))]
struct RunningAdmissionTestHook {
    reached: SyncSender<()>,
    acquired: Receiver<()>,
}

#[cfg(all(test, windows))]
struct ClosingAdmissionTestHook {
    reached: SyncSender<()>,
    acquired: Receiver<()>,
}

/// Private move-only authority after service readiness has been observed for
/// every resumed root and the exact Running CAS has been durably read back.
/// The native and staging owners remain together for the later lifecycle
/// slices; no public lease or terminal proof is created here.
#[cfg(windows)]
pub(crate) struct RunningActivationOwner {
    owner: SuspendedActivationOwner,
    running_journal: RuntimeSessionJournalV1,
    #[cfg(all(test, windows))]
    closing_admission_hook: Option<ClosingAdmissionTestHook>,
}

/// Private teardown-intent owner after the durable Running -> Closing CAS.
/// It retains the exact native and staging owners; cleanup proof and terminal
/// authority are deliberately later lifecycle steps.
#[cfg(windows)]
pub(crate) struct ClosingActivationOwner {
    owner: SuspendedActivationOwner,
    closing_journal: RuntimeSessionJournalV1,
    native_cleanup_proof: Option<NativeCleanupProof>,
    listener_release_proof: Option<NativeListenerReleaseProof>,
    staging_release_proof: Option<StagingReleasedObservation>,
    #[cfg(all(test, windows))]
    listener_query_failure_after_staging: bool,
    #[cfg(all(test, windows))]
    staging_release_cancel_before_authority: bool,
}

/// Private proof retained after the exact Job and root handles have proved
/// termination.  It deliberately retains the native identities needed by a
/// later listener-release observation; it is not a TerminalProof.
#[cfg(windows)]
#[derive(Clone, PartialEq, Eq)]
#[allow(dead_code)]
struct NativeCleanupProof {
    job_nonce: NativeNonce,
    roots: Vec<NativeCleanupRootProof>,
}

#[cfg(windows)]
#[derive(Clone, PartialEq, Eq)]
#[allow(dead_code)]
struct NativeCleanupRootProof {
    ordinal: u32,
    root_nonce: NativeNonce,
    identity: OwnedProcessIdentity,
}

/// Private listener-release evidence bound to the Closing journal identity
/// and to the same retained native cleanup proof.  Absence of a target row is
/// the only successful observation; a foreign row remains ambiguous and is
/// never touched.
#[cfg(windows)]
#[allow(dead_code)]
struct NativeListenerReleaseProof {
    session_nonce: String,
    plan_digest: String,
    closing_revision: u64,
    native: NativeCleanupProof,
    roots: Vec<NativeListenerReleaseRootProof>,
}

#[cfg(windows)]
#[derive(Clone, PartialEq, Eq)]
#[allow(dead_code)]
struct NativeListenerReleaseRootProof {
    ordinal: u32,
    root_nonce: String,
    creation_identity: CreationIdentity,
    reserved_listener_identity: String,
    readiness: String,
    port: u16,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingCleanupFailureKind {
    Cancelled,
    Deadline,
    Native,
    Listener,
    Validation,
}

#[cfg(windows)]
pub(crate) struct ClosingCleanupFailure {
    kind: ClosingCleanupFailureKind,
    detail: String,
    owner: ClosingActivationOwner,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingStagingReleaseFailureKind {
    Cancelled,
    Deadline,
    Listener,
    Validation,
    Storage,
}

#[cfg(windows)]
pub(crate) struct ClosingStagingReleaseFailure {
    kind: ClosingStagingReleaseFailureKind,
    detail: String,
    owner: ClosingActivationOwner,
}

#[cfg(windows)]
impl ClosingStagingReleaseFailure {
    pub(crate) fn into_owner(self) -> ClosingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> ClosingStagingReleaseFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }
}

#[cfg(windows)]
impl ClosingCleanupFailure {
    pub(crate) fn into_owner(self) -> ClosingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> ClosingCleanupFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClosingTransitionFailureKind {
    Cancelled,
    Deadline,
    Conflict,
    Storage,
    Validation,
}

#[cfg(windows)]
pub(crate) struct ClosingTransitionFailure {
    kind: ClosingTransitionFailureKind,
    detail: String,
    owner: RunningActivationOwner,
}

#[cfg(windows)]
impl ClosingTransitionFailure {
    pub(crate) fn into_owner(self) -> RunningActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> ClosingTransitionFailureKind {
        self.kind
    }
}

/// Every promotion failure retains the Launching owner.  In particular, a
/// store error after an atomic replacement is never inferred to have produced
/// a valid Running authority from a later read.
#[cfg(windows)]
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunningPromotionFailureKind {
    Cancelled,
    Deadline,
    NotReady,
    Storage,
    Validation,
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) struct RunningPromotionFailure {
    kind: RunningPromotionFailureKind,
    detail: String,
    owner: LaunchingActivationOwner,
}

#[cfg(windows)]
impl RunningPromotionFailure {
    pub(crate) fn into_owner(self) -> LaunchingActivationOwner {
        self.owner
    }

    #[cfg(test)]
    pub(crate) fn detail_for_test(&self) -> &str {
        &self.detail
    }

    #[cfg(test)]
    pub(crate) fn kind_for_test(&self) -> RunningPromotionFailureKind {
        self.kind
    }
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) enum ActivationLaunchOwner {
    Ready(ReadySuspendedActivationOwner),
    Launching(LaunchingActivationOwner),
}

#[cfg(windows)]
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivationLaunchFailureKind {
    Cancellation,
    Staging,
    Journal,
    Native(GroupNativeFailureKind),
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) struct ActivationLaunchFailure {
    kind: ActivationLaunchFailureKind,
    detail: String,
    owner: Option<ActivationLaunchOwner>,
}

#[cfg(windows)]
#[allow(dead_code)]
impl ActivationLaunchFailure {
    pub(crate) fn into_owner(self) -> Option<ActivationLaunchOwner> {
        self.owner
    }
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
        self.resource_observation_with_started_at(None)
    }

    #[allow(dead_code)]
    fn resource_observation_for_journal(
        &mut self,
        expected: &RuntimeSessionJournalV1,
    ) -> Result<ResourceObservation, String> {
        let observation = self.resource_observation_with_started_at(Some(&expected.roots))?;
        let expected_observation = ResourceObservation {
            job_binding: expected
                .job_binding
                .clone()
                .ok_or_else(|| "Capture runtime Ready Job binding was missing.".to_string())?,
            staging_binding: expected.staging_binding.clone(),
            roots: expected.roots.clone(),
        };
        if observation != expected_observation {
            return Err(
                "Capture runtime native or staging identity changed after durable Ready.".into(),
            );
        }
        Ok(observation)
    }

    fn resource_observation_with_started_at(
        &mut self,
        started_at_by_root: Option<&[JournalRoot]>,
    ) -> Result<ResourceObservation, String> {
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
        if let Some(expected_roots) = started_at_by_root {
            if expected_roots.len() != planned_roots.len() {
                return Err("Capture runtime Ready root observation was incomplete.".into());
            }
        }
        let shared_started_at = match started_at_by_root {
            Some(_) => None,
            None => Some(self.staging.next_timestamp()?),
        };
        let mut roots = Vec::with_capacity(planned_roots.len());
        for (planned, actual) in planned_roots.iter().zip(snapshot.roots) {
            let ordinal = usize::try_from(planned.ordinal)
                .map_err(|_| "Capture runtime root ordinal was invalid.")?;
            if actual.ordinal != planned.ordinal {
                return Err("Capture runtime native root order changed before Ready.".into());
            }
            let started_at = match started_at_by_root {
                Some(expected_roots) => expected_roots
                    .get(ordinal)
                    .ok_or_else(|| "Capture runtime Ready root timestamp was missing.".to_string())?
                    .started_at
                    .clone(),
                None => shared_started_at
                    .as_ref()
                    .expect("shared Ready timestamp")
                    .clone(),
            };
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
                started_at,
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
    #[allow(dead_code)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.native.as_ref().map(|native| native.roots.len())
    }

    #[cfg(test)]
    #[allow(dead_code)]
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
    pub(crate) fn inject_resume_failure_at_for_test(&mut self, ordinal: usize) {
        let native = self.native.as_mut().expect("native owner");
        native.inject_resume_failure_at_for_test(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn inject_native_membership_failure_for_test(&mut self) {
        let native = self.native.as_mut().expect("native owner");
        native.inject_membership_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_journal_drift_before_ready_for_test(&self) {
        self.staging.inject_journal_drift_before_ready_for_test();
    }

    #[cfg(test)]
    pub(crate) fn terminate_root_for_test(&mut self, ordinal: usize) -> Result<(), String> {
        let native = self
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing.".to_string())?;
        native.terminate_root_for_test(ordinal)
    }
}

#[cfg(windows)]
impl ReadySuspendedActivationOwner {
    /// Consume the Ready owner, durably record Launching, then resume each
    /// already-assigned root through the existing native loop.  Cancellation
    /// is accepted only through this private crate seam; no caller can supply
    /// replacement commands or native identity.
    #[allow(dead_code)]
    pub(crate) fn launch_with_cancellation(
        self,
        cancellation: Option<&AtomicBool>,
    ) -> Result<LaunchingActivationOwner, ActivationLaunchFailure> {
        let mut ready = self;
        if cancellation_requested(cancellation) {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Cancellation,
                detail: "Capture runtime Launching was cancelled before CAS.".into(),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }

        if ready.ready_journal.state != crate::journal::JournalState::Ready {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail: "Capture runtime retained journal was not Ready.".into(),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready
            .owner
            .staging
            .validate_ready_journal(&ready.ready_journal)
        {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail: format!("Capture runtime Ready journal validation failed: {detail:?}."),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready
            .owner
            .staging
            .revalidate_ready_snapshot(&ready.ready_journal)
        {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready.owner.staging.revalidate_address_index() {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        if let Err(detail) = ready.owner.staging.checked_commands() {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Staging,
                detail,
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }

        let observation = match ready
            .owner
            .resource_observation_for_journal(&ready.ready_journal)
        {
            Ok(observation) => observation,
            Err(detail) => {
                return Err(ActivationLaunchFailure {
                    kind: ActivationLaunchFailureKind::Native(GroupNativeFailureKind::Membership),
                    detail,
                    owner: Some(ActivationLaunchOwner::Ready(ready)),
                });
            }
        };
        if cancellation_requested(cancellation) {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Cancellation,
                detail: "Capture runtime Launching was cancelled before CAS.".into(),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        let timestamp = match ready.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => {
                return Err(ActivationLaunchFailure {
                    kind: ActivationLaunchFailureKind::Journal,
                    detail,
                    owner: Some(ActivationLaunchOwner::Ready(ready)),
                });
            }
        };
        if timestamp < ready.ready_journal.updated_at {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Journal,
                detail: "Capture runtime producer clock moved backwards before Launching CAS."
                    .into(),
                owner: Some(ActivationLaunchOwner::Ready(ready)),
            });
        }
        let launching_journal = match ready.owner.staging.persist_launching(
            &ready.ready_journal,
            observation,
            timestamp,
        ) {
            Ok(journal) => journal,
            Err(detail) => {
                return Err(ActivationLaunchFailure {
                    kind: ActivationLaunchFailureKind::Journal,
                    detail,
                    owner: Some(ActivationLaunchOwner::Ready(ready)),
                });
            }
        };

        #[cfg(all(test, windows))]
        if CANCEL_AFTER_LAUNCHING_CAS.with(|cancel| cancel.replace(false)) {
            if let Some(cancellation) = cancellation {
                cancellation.store(true, Ordering::Release);
            }
        }

        let mut launching = LaunchingActivationOwner {
            owner: ready.owner,
            launching_journal,
            #[cfg(all(test, windows))]
            running_admission_hook: None,
        };
        if cancellation_requested(cancellation) {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Cancellation,
                detail: "Capture runtime Launching was cancelled after durable CAS.".into(),
                owner: Some(ActivationLaunchOwner::Launching(launching)),
            });
        }
        let Some(native) = launching.owner.native.take() else {
            return Err(ActivationLaunchFailure {
                kind: ActivationLaunchFailureKind::Native(GroupNativeFailureKind::Membership),
                detail: "Capture runtime native owner was missing before resume.".into(),
                owner: Some(ActivationLaunchOwner::Launching(launching)),
            });
        };
        match native.resume_all_with_cancellation(cancellation) {
            Ok(native) => {
                launching.owner.native = Some(native);
                Ok(launching)
            }
            Err(failure) => {
                let native = failure.owner.expect(
                    "native resume failure after an owned group must retain the native owner",
                );
                launching.owner.native = Some(native);
                Err(ActivationLaunchFailure {
                    kind: if failure.kind == GroupNativeFailureKind::Resume
                        && cancellation_requested(cancellation)
                    {
                        ActivationLaunchFailureKind::Cancellation
                    } else {
                        ActivationLaunchFailureKind::Native(failure.kind)
                    },
                    detail: failure.detail,
                    owner: Some(ActivationLaunchOwner::Launching(launching)),
                })
            }
        }
    }

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

    #[cfg(test)]
    pub(crate) fn inject_resume_failure_at_for_test(&mut self, ordinal: usize) {
        self.owner.inject_resume_failure_at_for_test(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn inject_native_membership_failure_for_test(&mut self) {
        self.owner.inject_native_membership_failure_for_test();
    }
}

#[cfg(windows)]
impl LaunchingActivationOwner {
    /// Promote an already-resumed Launching owner after strict service and
    /// native listener observations for every root.  The caller supplies one
    /// absolute deadline for the whole operation; no root receives a fresh
    /// timeout.  Running authority is returned only after the exact CAS value
    /// has been durably written and read back by the staging/store owner.
    pub(crate) fn promote_running_with_cancellation(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<RunningActivationOwner, RunningPromotionFailure> {
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        if cancellation.load(Ordering::Acquire) {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Running promotion was cancelled before validation.",
            ));
        }
        if std::time::Instant::now() >= deadline {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Running promotion expired before validation.",
            ));
        }

        if let Err(detail) = self
            .owner
            .staging
            .validate_launching_journal(&self.launching_journal)
        {
            return Err(running_promotion_failure(
                self,
                format!("Capture runtime Launching journal validation failed: {detail}"),
            ));
        }
        if let Err(detail) = self
            .owner
            .staging
            .revalidate_address_index_for_running(deadline, Arc::clone(&cancellation))
        {
            return Err(running_promotion_failure_for_bounded_error(
                self,
                detail,
                deadline,
                cancellation.as_ref(),
            ));
        }
        let descriptor = self.owner.staging.activation_descriptor();
        if let Err(detail) = self.owner.staging.checked_commands_for_running() {
            return Err(running_promotion_failure(self, detail));
        }
        // Schema context is a required input for this service-only Running
        // promotion.  Validate all roots before touching the native listener
        // table so a value-only or partially described descriptor cannot be
        // mistaken for a live service proof.
        for ordinal in 0..self.launching_journal.roots.len() {
            let (_, manifest, schema_context, _) = match descriptor.strict_readiness_inputs(ordinal)
            {
                Ok(inputs) => inputs,
                Err(detail) => return Err(running_promotion_failure(self, detail)),
            };
            if let Err(detail) = schema_context.revalidate(manifest) {
                return Err(running_promotion_failure(
                    self,
                    format!("Capture runtime readiness schema revalidation failed: {detail}"),
                ));
            }
        }
        let expected_staging = match self.owner.staging.staging_binding_for_running() {
            Ok(binding) => binding,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if self.launching_journal.staging_binding.as_ref() != Some(&expected_staging) {
            return Err(running_promotion_failure(
                self,
                "Capture runtime staging identity changed before Running promotion.",
            ));
        }
        let launching_snapshot = self.launching_journal.clone();
        let first_listener_observation = match self.observe_native_listeners_for_running(
            &launching_snapshot,
            deadline,
            Some(cancellation.as_ref()),
        ) {
            Ok(observation) => observation,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        let mut readiness = Vec::with_capacity(self.launching_journal.roots.len());
        for ordinal in 0..self.launching_journal.roots.len() {
            if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
                return Err(running_promotion_failure(self, detail));
            }
            // A fresh checked command revalidates the frozen executable and
            // its manifest/schema context at this root's probe boundary.  It
            // is deliberately discarded because the native child already
            // owns the command used for Launching.
            if let Err(detail) = descriptor.checked_command(ordinal) {
                return Err(running_promotion_failure(self, detail));
            }
            let (token, manifest, schema_context, port) =
                match descriptor.strict_readiness_inputs(ordinal) {
                    Ok(inputs) => inputs,
                    Err(detail) => return Err(running_promotion_failure(self, detail)),
                };
            if let Err(detail) = schema_context.revalidate(manifest) {
                return Err(running_promotion_failure(
                    self,
                    format!("Capture runtime readiness schema revalidation failed: {detail}"),
                ));
            }
            match probe_service_ready(
                port,
                token,
                manifest,
                schema_context.schema(),
                deadline,
                cancellation.as_ref(),
            ) {
                Ok(StrictProbeResult::Ready(facts)) => readiness.push(facts),
                Ok(StrictProbeResult::NotReady) => {
                    return Err(running_promotion_failure(
                        self,
                        format!(
                            "Capture runtime root {ordinal} did not report strict service readiness."
                        ),
                    ));
                }
                Ok(StrictProbeResult::Cancelled) => {
                    return Err(running_promotion_failure(
                        self,
                        "Capture runtime Running promotion was cancelled during readiness.",
                    ));
                }
                Err(detail) => return Err(running_promotion_failure(self, detail)),
            }
        }
        if readiness.len() != self.launching_journal.roots.len() {
            return Err(running_promotion_failure(
                self,
                "Capture runtime readiness observations were incomplete.",
            ));
        }

        // Acquire the journal lock before the final validation pass.  The
        // guard remains held through the typed Running CAS; a cancellation or
        // deadline during contention therefore cannot promote an old snapshot.
        #[cfg(all(test, windows))]
        if let Some(hook) = self.running_admission_hook.take() {
            if hook.reached.send(()).is_err() {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running admission test rendezvous closed.",
                ));
            }
            if hook
                .acquired
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running admission test rendezvous timed out.",
                ));
            }
        }
        let admission = match self.owner.staging.begin_running_admission(
            &self.launching_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(running_promotion_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Running admission failed.",
                ));
            }
        };
        if admission.current() != &self.launching_journal {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Launching journal changed during Running admission.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }
        // Reopening the immutable address index also reopens the journal to
        // cross-check its plan, so it cannot run while this journal lock is
        // held.  Release only this read-only admission, revalidate the index,
        // and reacquire an exact snapshot before any native observation.
        drop(admission);
        if let Err(detail) = self
            .owner
            .staging
            .revalidate_address_index_for_running(deadline, Arc::clone(&cancellation))
        {
            return Err(running_promotion_failure_for_bounded_error(
                self,
                detail,
                deadline,
                cancellation.as_ref(),
            ));
        }
        let admission = match self.owner.staging.begin_running_admission(
            &self.launching_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(running_promotion_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Running admission failed.",
                ));
            }
        };
        if admission.current() != &self.launching_journal {
            return Err(running_promotion_failure(
                self,
                "Capture runtime Launching journal changed during Running admission.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }
        let launching_snapshot = self.launching_journal.clone();
        let final_listener_observation = match self.observe_native_listeners_for_running(
            &launching_snapshot,
            deadline,
            Some(cancellation.as_ref()),
        ) {
            Ok(observation) => observation,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if first_listener_observation != final_listener_observation {
            return Err(running_promotion_failure(
                self,
                "Capture runtime native listener identity changed during readiness.",
            ));
        }
        if let Err(detail) = self.owner.staging.checked_commands_for_running() {
            return Err(running_promotion_failure(self, detail));
        }
        // Revalidate the frozen schema bytes after the lock wait and before
        // the last native observation.  The readiness facts must still be
        // anchored to the same producer manifest at the commit boundary.
        for ordinal in 0..self.launching_journal.roots.len() {
            let (_, manifest, schema_context, _) = match descriptor.strict_readiness_inputs(ordinal)
            {
                Ok(inputs) => inputs,
                Err(detail) => return Err(running_promotion_failure(self, detail)),
            };
            if let Err(detail) = schema_context.revalidate(manifest) {
                return Err(running_promotion_failure(
                    self,
                    format!("Capture runtime readiness schema revalidation failed: {detail}"),
                ));
            }
        }
        let final_staging = match self.owner.staging.staging_binding_for_running() {
            Ok(binding) => binding,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if final_staging != expected_staging {
            return Err(running_promotion_failure(
                self,
                "Capture runtime staging identity changed before Running CAS.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }

        let mut roots = self.launching_journal.roots.clone();
        for (index, ((root, facts), listener)) in roots
            .iter_mut()
            .zip(&readiness)
            .zip(&final_listener_observation)
            .enumerate()
        {
            if root.ordinal != index as u32 || listener.ordinal != root.ordinal {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running root order changed before CAS.",
                ));
            }
            root.state = RootState::Running;
            root.live_listener_readiness = Some(running_readiness_digest(
                &self.launching_journal,
                root,
                listener,
                facts,
            ));
        }
        let job_binding = match self.launching_journal.job_binding.clone() {
            Some(binding) => binding,
            None => {
                return Err(running_promotion_failure(
                    self,
                    "Capture runtime Running Job binding was missing.",
                ));
            }
        };
        let timestamp = match self.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if timestamp < self.launching_journal.updated_at {
            return Err(running_promotion_failure(
                self,
                "Capture runtime producer clock moved backwards before Running CAS.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(running_promotion_failure(self, detail));
        }
        // Recheck native root/liveness identity at the last possible point
        // before the typed CAS.  The lock is still held, so a root that dies
        // while earlier validation or lock contention is in progress cannot
        // produce Running authority from a stale observation.
        let precommit_listener_observation = match self.observe_native_listeners_for_running(
            &self.launching_journal.clone(),
            deadline,
            Some(cancellation.as_ref()),
        ) {
            Ok(observation) => observation,
            Err(detail) => return Err(running_promotion_failure(self, detail)),
        };
        if precommit_listener_observation != final_listener_observation {
            return Err(running_promotion_failure(
                self,
                "Capture runtime native listener identity changed before Running CAS.",
            ));
        }
        let observation = ResourceObservation {
            job_binding,
            staging_binding: Some(final_staging),
            roots,
        };
        let result = match self.owner.staging.persist_running_admission(
            admission,
            &self.launching_journal,
            observation,
            timestamp,
        ) {
            Ok(result) => result,
            Err(cause) => {
                return Err(running_promotion_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Running journal CAS failed.",
                ));
            }
        };
        let running_journal = match result {
            RunningCasResult::Committed(journal) => journal,
            RunningCasResult::CommittedAfterBudget(_) => {
                // The exact Running record is durable, but cancellation or
                // deadline was observed before authority issuance.  Keep the
                // Launching owner and leave the disk record for reconciliation;
                // never fabricate a Running owner after the boundary.
                let detail = if cancellation.load(Ordering::Acquire) {
                    "Capture runtime Running CAS completed after cancellation."
                } else {
                    "Capture runtime Running CAS completed after its deadline."
                };
                return Err(running_promotion_failure(self, detail));
            }
        };
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            // The disk record remains the exact durable Running candidate;
            // cancellation observed before this owner is issued leaves it for
            // reconciliation rather than rolling it back or issuing authority.
            return Err(running_promotion_failure(self, detail));
        }
        Ok(RunningActivationOwner {
            owner: self.owner,
            running_journal,
            #[cfg(all(test, windows))]
            closing_admission_hook: None,
        })
    }

    fn observe_native_listeners_for_running(
        &mut self,
        expected: &RuntimeSessionJournalV1,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<Vec<NativeListenerRootObservation>, String> {
        let expected_job = expected
            .job_binding
            .as_ref()
            .ok_or_else(|| "Capture runtime Launching Job binding was missing.".to_string())?;
        let native = self
            .owner
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing.".to_string())?;
        if native_nonce_text(&native.job_nonce) != expected_job.job_nonce {
            return Err(
                "Capture runtime native Job nonce changed during Running promotion.".into(),
            );
        }
        let ports = expected
            .roots
            .iter()
            .map(|root| root.loopback_port)
            .collect::<Vec<_>>();
        let observation = native.observe_root_listeners(&ports, deadline, cancellation)?;
        if observation.roots.len() != expected.roots.len()
            || native.roots.len() != expected.roots.len()
            || !native.unacquired_root_nonces.is_empty()
        {
            return Err("Capture runtime native listener observation was incomplete.".into());
        }
        for (index, ((expected_root, observed), native_root)) in expected
            .roots
            .iter()
            .zip(&observation.roots)
            .zip(&native.roots)
            .enumerate()
        {
            if expected_root.ordinal != index as u32
                || observed.ordinal != expected_root.ordinal
                || observed.port != expected_root.loopback_port
                || native_root.ordinal != expected_root.ordinal
                || native_nonce_text(&native_root.root_nonce) != expected_root.root_nonce
            {
                return Err(
                    "Capture runtime native root binding changed during Running promotion.".into(),
                );
            }
            let creation_time = parse_creation_identity(expected_root)?;
            let expected_identity = OwnedProcessIdentity {
                pid: expected_root.pid,
                creation_time,
            };
            if observed.identity != expected_identity
                || native_root.identity != Some(expected_identity)
            {
                return Err(
                    "Capture runtime native process identity changed during Running promotion."
                        .into(),
                );
            }
        }
        Ok(observation.roots)
    }

    /// Cleanup remains native-first.  Staging is deliberately retained for
    /// reconciliation because the current journal is Launching, not
    /// PreparedBound, and this slice has no terminal proof.
    #[allow(dead_code)]
    pub(crate) fn cleanup_without_terminal_proof(
        self,
    ) -> Result<(), SuspendedActivationCleanupFailure> {
        self.owner.cleanup()
    }

    #[cfg(test)]
    pub(crate) fn launching_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.launching_journal
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn native_is_suspended_for_test(&mut self) -> bool {
        self.owner.native_is_suspended_for_test()
    }

    #[cfg(test)]
    pub(crate) fn observe_native_listeners_for_test(
        &mut self,
        ports: &[u16],
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<usize, String> {
        let native = self
            .owner
            .native
            .as_mut()
            .ok_or_else(|| "Capture runtime native owner was missing.".to_string())?;
        Ok(native
            .observe_root_listeners(ports, deadline, cancellation)?
            .root_count())
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_query_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_identity_mutation_after_first_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_identity_mutation_after_first_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_root_exit_after_first_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_root_exit_after_first_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_identity_mutation_at_last_observation_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_identity_mutation_at_last_observation_for_test();
    }

    #[cfg(test)]
    pub(crate) fn listener_observation_count_for_test(&self) -> usize {
        self.owner
            .native
            .as_ref()
            .map_or(0, |native| native.listener_observation_count)
    }

    #[cfg(test)]
    pub(crate) fn coordinate_running_admission_for_test(
        &mut self,
        reached: SyncSender<()>,
        acquired: Receiver<()>,
    ) {
        self.running_admission_hook = Some(RunningAdmissionTestHook { reached, acquired });
    }
}

#[cfg(windows)]
impl RunningActivationOwner {
    /// Consume the Running owner and persist only teardown intent.  This
    /// boundary deliberately does not require a live root, listener, HTTP
    /// readiness, or unchanged executable/schema bytes: those observations
    /// belong to cleanup proof.  The retained Running journal and immutable
    /// address index still have to match before the typed CAS.
    #[allow(unused_mut)]
    pub(crate) fn begin_closing_with_cancellation(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<ClosingActivationOwner, ClosingTransitionFailure> {
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(closing_transition_failure(self, detail));
        }

        if let Err(detail) = self.owner.staging.revalidate_running_snapshot_for_closing(
            &self.running_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(closing_transition_failure_for_bounded_error(
                self,
                detail,
                deadline,
                cancellation.as_ref(),
            ));
        }

        #[cfg(all(test, windows))]
        if let Some(hook) = self.closing_admission_hook.take() {
            if hook.reached.send(()).is_err() {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Closing admission test rendezvous closed.",
                ));
            }
            if hook
                .acquired
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_err()
            {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Closing admission test rendezvous timed out.",
                ));
            }
        }
        let admission = match self.owner.staging.begin_closing_admission(
            &self.running_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(closing_transition_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Closing admission failed before CAS.",
                ));
            }
        };
        if admission.current() != &self.running_journal {
            return Err(closing_transition_failure(
                self,
                "Capture runtime Running journal changed before Closing CAS.",
            ));
        }
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            return Err(closing_transition_failure(self, detail));
        }

        let mut roots = self.running_journal.roots.clone();
        for root in &mut roots {
            if root.state != RootState::Running || root.live_listener_readiness.is_none() {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Running journal did not contain complete live observations before Closing CAS.",
                ));
            }
            root.state = RootState::Closing;
        }
        let job_binding = match self.running_journal.job_binding.clone() {
            Some(binding) => binding,
            None => {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Running Job binding was missing before Closing CAS.",
                ));
            }
        };
        let staging_binding = match self.running_journal.staging_binding.clone() {
            Some(binding) => Some(binding),
            None => {
                return Err(closing_transition_failure(
                    self,
                    "Capture runtime Running staging binding was missing before Closing CAS.",
                ));
            }
        };
        let observation = ResourceObservation {
            job_binding,
            staging_binding,
            roots,
        };
        let timestamp = match self.owner.staging.next_timestamp() {
            Ok(timestamp) => timestamp,
            Err(detail) => return Err(closing_transition_failure(self, detail)),
        };
        if timestamp < self.running_journal.updated_at {
            return Err(closing_transition_failure(
                self,
                "Capture runtime producer clock moved backwards before Closing CAS.",
            ));
        }

        let result = match self.owner.staging.persist_closing_admission(
            admission,
            &self.running_journal,
            observation,
            timestamp,
        ) {
            Ok(result) => result,
            Err(cause) => {
                return Err(closing_transition_failure_for_cas(
                    self,
                    cause,
                    "Capture runtime Closing journal CAS was ambiguous; no Closing authority was issued and the disk state (possibly Closing) requires reconciliation.",
                ));
            }
        };
        let closing_journal = match result {
            ClosingCasResult::Committed(journal) => journal,
            ClosingCasResult::CommittedAfterBudget(_) => {
                let detail = if cancellation.load(Ordering::Acquire) {
                    "Capture runtime Closing CAS completed after cancellation; the durable Closing record remains for reconciliation."
                } else {
                    "Capture runtime Closing CAS completed after its deadline; the durable Closing record remains for reconciliation."
                };
                return Err(closing_transition_failure(self, detail));
            }
        };
        if let Err(detail) = check_running_promotion_budget(deadline, cancellation.as_ref()) {
            // The complete Closing candidate is already durable, but the
            // owner boundary has not been issued.  Keep the original Running
            // owner so reconciliation can account for the disk Closing
            // intent without fabricating a typed Closing authority.
            return Err(closing_transition_failure(self, detail));
        }

        Ok(ClosingActivationOwner {
            owner: self.owner,
            closing_journal,
            native_cleanup_proof: None,
            listener_release_proof: None,
            staging_release_proof: None,
            #[cfg(all(test, windows))]
            listener_query_failure_after_staging: false,
            #[cfg(all(test, windows))]
            staging_release_cancel_before_authority: false,
        })
    }

    /// The Running owner keeps the exact durable CAS value for the next
    /// lifecycle slice.  Cleanup is still native-first; staging is retained
    /// for reconciliation because this slice has no Closing/Terminal proof.
    #[allow(dead_code)]
    pub(crate) fn cleanup_without_terminal_proof(
        self,
    ) -> Result<(), SuspendedActivationCleanupFailure> {
        self.owner.cleanup()
    }

    #[cfg(test)]
    pub(crate) fn running_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.running_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_query_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn terminate_root_for_test(&mut self, ordinal: usize) -> Result<(), String> {
        self.owner.terminate_root_for_test(ordinal)
    }

    #[cfg(test)]
    pub(crate) fn coordinate_closing_admission_for_test(
        &mut self,
        reached: SyncSender<()>,
        acquired: Receiver<()>,
    ) {
        self.closing_admission_hook = Some(ClosingAdmissionTestHook { reached, acquired });
    }
}

#[cfg(windows)]
impl ClosingActivationOwner {
    /// Consume the Closing owner through the native teardown boundary.  The
    /// current Closing journal/index and every retained native identity are
    /// checked before the first destructive operation.  A successful native
    /// proof stays inside this same owner so a later listener-query failure
    /// can be retried without reacquiring or reconstructing native state.
    #[allow(dead_code)]
    pub(crate) fn cleanup_native_and_observe_listener_release(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<Self, ClosingCleanupFailure> {
        // A release proof is valid only for the observation that produced it.
        // Clear it before every retry, including validation and cancellation
        // exits, so a rebound or failed listener query can never inherit an
        // earlier absence observation.
        self.listener_release_proof = None;
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(closing_cleanup_failure(self, detail));
        }
        if let Err(detail) = self.owner.staging.revalidate_closing_index_for_cleanup(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(closing_cleanup_failure(self, detail));
        }

        // Keep the exact Closing journal snapshot locked through native
        // termination and listener-release observation.  A reconciler may
        // still read the filesystem, but it cannot advance this journal and
        // leave an older owner acting on a stale teardown intent.
        let cleanup_admission = match self.owner.staging.begin_closing_cleanup_admission(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(closing_cleanup_failure_for_admission(self, cause));
            }
        };
        if cleanup_admission.current() != &self.closing_journal {
            return Err(closing_cleanup_failure(
                self,
                "Capture runtime Closing journal changed before native cleanup admission.",
            ));
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing cleanup admission budget ended: {cause:?}."),
            ));
        }

        if self.native_cleanup_proof.is_none() {
            let expected = match self
                .owner
                .native
                .as_mut()
                .ok_or_else(|| {
                    "Capture runtime native owner was missing before Closing cleanup.".to_string()
                })
                .and_then(|native| native.validate_closing_binding(&self.closing_journal))
            {
                Ok(expected) => expected,
                Err(detail) => return Err(closing_cleanup_failure(self, detail)),
            };
            let proof = match self
                .owner
                .cleanup_native_for_closing(deadline, Some(cancellation.as_ref()))
            {
                Ok(proof) => proof,
                Err(detail) => return Err(closing_cleanup_failure(self, detail)),
            };
            if proof != expected {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime native cleanup proof did not retain the Closing identity tuple.",
                ));
            }
            self.native_cleanup_proof = Some(proof);
        } else {
            // A retry after a failed listener observation must still bind the
            // retained native proof to this exact Closing tuple.  The journal
            // admission is unchanged, but the retained handles and all root
            // identities are rechecked before another table observation.
            let expected = match self
                .owner
                .native
                .as_mut()
                .ok_or_else(|| {
                    "Capture runtime native owner was missing before listener retry.".to_string()
                })
                .and_then(|native| native.validate_closing_binding(&self.closing_journal))
            {
                Ok(expected) => expected,
                Err(detail) => return Err(closing_cleanup_failure(self, detail)),
            };
            if self.native_cleanup_proof.as_ref() != Some(&expected) {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime retained native cleanup proof no longer matched Closing.",
                ));
            }
        }
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(closing_cleanup_failure(self, detail));
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing cleanup admission budget ended: {cause:?}."),
            ));
        }

        let native = match self.owner.native.as_mut() {
            Some(native) => native,
            None => {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime native owner was lost after cleanup proof.",
                ));
            }
        };
        let native_proof = self
            .native_cleanup_proof
            .as_ref()
            .expect("native cleanup proof after successful cleanup")
            .clone();
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing listener proof budget ended: {cause:?}."),
            ));
        }
        let release_roots = match self
            .closing_journal
            .roots
            .iter()
            .zip(&native_proof.roots)
            .map(|(journal_root, native_root)| {
                if journal_root.ordinal != native_root.ordinal
                    || journal_root.root_nonce != native_nonce_text(&native_root.root_nonce)
                    || journal_root.loopback_port == 0
                    || journal_root.reserved_listener_identity.is_empty()
                    || journal_root.live_listener_readiness.is_none()
                {
                    return None;
                }
                Some(NativeListenerReleaseRootProof {
                    ordinal: journal_root.ordinal,
                    root_nonce: journal_root.root_nonce.clone(),
                    creation_identity: journal_root.creation_identity.clone(),
                    reserved_listener_identity: journal_root.reserved_listener_identity.clone(),
                    readiness: journal_root.live_listener_readiness.clone()?,
                    port: journal_root.loopback_port,
                })
            })
            .collect::<Option<Vec<_>>>()
        {
            Some(roots) if roots.len() == self.closing_journal.roots.len() => roots,
            _ => {
                return Err(closing_cleanup_failure(
                    self,
                    "Capture runtime listener release tuple was incomplete or reordered.",
                ));
            }
        };
        let release = match native.observe_listener_release_for_closing(
            &self.closing_journal,
            &native_proof,
            deadline,
            Some(cancellation.as_ref()),
        ) {
            Ok(()) => NativeListenerReleaseProof {
                session_nonce: self.closing_journal.session_nonce.clone(),
                plan_digest: self.closing_journal.plan_digest.clone(),
                closing_revision: self.closing_journal.journal_revision,
                native: native_proof,
                roots: release_roots,
            },
            Err(detail) => return Err(closing_cleanup_failure(self, detail)),
        };
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_cleanup_failure(
                self,
                format!("Capture runtime Closing listener proof budget ended: {cause:?}."),
            ));
        }
        self.listener_release_proof = Some(release);
        drop(cleanup_admission);
        Ok(self)
    }

    /// Consume the native/listener-proven Closing owner through the staging
    /// release boundary.  The journal admission remains held for the first
    /// listener absence observation, every staging mutation, and the final
    /// listener absence observation.  A failure retains this exact owner,
    /// including any native proof and partial staging-release progress.
    #[allow(dead_code)]
    pub(crate) fn release_staging_after_native_cleanup(
        mut self,
        deadline: std::time::Instant,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<(Self, StagingReleasedObservation), ClosingStagingReleaseFailure> {
        self.listener_release_proof = None;
        let local_cancellation = Arc::new(AtomicBool::new(false));
        let cancellation = cancellation.unwrap_or_else(|| Arc::clone(&local_cancellation));
        let native_proof = match self.native_cleanup_proof.clone() {
            Some(proof) => proof,
            None => {
                return Err(closing_staging_release_failure(
                    self,
                    ClosingStagingReleaseFailureKind::Validation,
                    "Capture runtime staging release lacked the exact native cleanup proof.",
                ));
            }
        };
        if let Err(detail) = check_native_cleanup_budget(deadline, Some(cancellation.as_ref())) {
            return Err(closing_staging_release_failure(
                self,
                staging_release_kind_from_detail(
                    &detail,
                    ClosingStagingReleaseFailureKind::Validation,
                ),
                detail,
            ));
        }
        if let Err(detail) = self.owner.staging.revalidate_closing_index_for_cleanup(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            return Err(closing_staging_release_failure(
                self,
                ClosingStagingReleaseFailureKind::Validation,
                detail,
            ));
        }
        let cleanup_admission = match self.owner.staging.begin_closing_cleanup_admission(
            &self.closing_journal,
            deadline,
            Arc::clone(&cancellation),
        ) {
            Ok(admission) => admission,
            Err(cause) => {
                return Err(closing_staging_release_failure_for_admission(self, cause));
            }
        };
        if cleanup_admission.current() != &self.closing_journal {
            return Err(closing_staging_release_failure(
                self,
                ClosingStagingReleaseFailureKind::Validation,
                "Capture runtime Closing cleanup admission did not retain the exact journal.",
            ));
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }

        {
            let native = match self.owner.native.as_mut() {
                Some(native) => native,
                None => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        "Capture runtime native owner was missing before staging release.",
                    ));
                }
            };
            let retained = match native.validate_closing_binding(&self.closing_journal) {
                Ok(proof) => proof,
                Err(detail) => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        detail,
                    ));
                }
            };
            if retained != native_proof {
                return Err(closing_staging_release_failure(
                    self,
                    ClosingStagingReleaseFailureKind::Validation,
                    "Capture runtime retained native cleanup proof no longer matched Closing.",
                ));
            }
            if let Err(detail) = native.observe_listener_release_for_closing(
                &self.closing_journal,
                &native_proof,
                deadline,
                Some(cancellation.as_ref()),
            ) {
                return Err(closing_staging_release_failure(
                    self,
                    staging_release_kind_from_detail(
                        &detail,
                        ClosingStagingReleaseFailureKind::Listener,
                    ),
                    detail,
                ));
            }
        }
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }

        let observation = match self.owner.staging.cleanup_after_closing(
            &self.closing_journal,
            deadline,
            cancellation.as_ref(),
        ) {
            Ok(observation) => observation,
            Err(error) => {
                return Err(closing_staging_release_failure_for_staging(self, error));
            }
        };
        self.staging_release_proof = Some(observation.clone());
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }

        {
            let native = match self.owner.native.as_mut() {
                Some(native) => native,
                None => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        "Capture runtime native owner was missing after staging release.",
                    ));
                }
            };
            #[cfg(all(test, windows))]
            if self.listener_query_failure_after_staging {
                self.listener_query_failure_after_staging = false;
                native.inject_listener_query_failure_for_test();
            }
            if let Err(detail) = native.observe_listener_release_for_closing(
                &self.closing_journal,
                &native_proof,
                deadline,
                Some(cancellation.as_ref()),
            ) {
                return Err(closing_staging_release_failure(
                    self,
                    staging_release_kind_from_detail(
                        &detail,
                        ClosingStagingReleaseFailureKind::Listener,
                    ),
                    detail,
                ));
            }
        }
        let listener_release_proof =
            match listener_release_proof_for_closing(&self.closing_journal, native_proof) {
                Ok(proof) => proof,
                Err(detail) => {
                    return Err(closing_staging_release_failure(
                        self,
                        ClosingStagingReleaseFailureKind::Validation,
                        detail,
                    ));
                }
            };
        #[cfg(all(test, windows))]
        if self.staging_release_cancel_before_authority {
            self.staging_release_cancel_before_authority = false;
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        }
        // The proof builder walks the complete retained root tuple.  Check
        // the shared budget after that bounded observation and immediately
        // before issuing the returned proof.
        if let Err(cause) = cleanup_admission.check_budget() {
            return Err(closing_staging_release_failure_for_store_error(self, cause));
        }
        self.listener_release_proof = Some(listener_release_proof);
        drop(cleanup_admission);
        Ok((self, observation))
    }

    #[cfg(test)]
    pub(crate) fn native_cleanup_proven_for_test(&self) -> bool {
        self.native_cleanup_proof.is_some()
    }

    #[cfg(test)]
    pub(crate) fn listener_release_proven_for_test(&self) -> bool {
        self.listener_release_proof.is_some()
    }

    #[cfg(test)]
    pub(crate) fn native_cleanup_attempts_for_test(&self) -> usize {
        self.owner
            .native
            .as_ref()
            .map_or(0, |native| native.cleanup_attempts)
    }

    #[cfg(test)]
    pub(crate) fn staging_release_proven_for_test(&self) -> bool {
        self.staging_release_proof.is_some()
    }

    #[cfg(test)]
    pub(crate) fn staging_release_binding_matches_for_test(&self) -> bool {
        self.staging_release_proof.as_ref().is_some_and(|proof| {
            proof.matches_identity(
                &self.closing_journal.session_nonce,
                &self.closing_journal.plan_digest,
                self.owner
                    .staging
                    .activation_descriptor()
                    .group_staging_identity(),
            )
        })
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_after_staging_for_test(&mut self) {
        self.listener_query_failure_after_staging = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_cancel_before_authority_for_test(&mut self) {
        self.staging_release_cancel_before_authority = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_delete_failure_at_for_test(&self, mutation: usize) {
        self.owner
            .staging
            .inject_release_delete_failure_at_for_test(mutation);
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_cancel_after_delete_at_for_test(&self, mutation: usize) {
        self.owner
            .staging
            .inject_release_cancel_after_delete_at_for_test(mutation);
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_entry_limit_for_test(&self, limit: usize) {
        self.owner
            .staging
            .inject_release_entry_limit_for_test(limit);
    }

    #[cfg(test)]
    pub(crate) fn inject_staging_release_depth_limit_for_test(&self, limit: usize) {
        self.owner
            .staging
            .inject_release_depth_limit_for_test(limit);
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_listener_query_failure_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_native_cleanup_failure_for_test(&mut self) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_cleanup_failure_after_first_for_test();
    }

    #[cfg(test)]
    pub(crate) fn inject_cancellation_after_native_cleanup_root_for_test(
        &mut self,
        ordinal: usize,
    ) {
        let native = self.owner.native.as_mut().expect("native owner");
        native.inject_cancellation_after_cleanup_root_for_test(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn closing_journal_for_test(&self) -> &RuntimeSessionJournalV1 {
        &self.closing_journal
    }

    #[cfg(test)]
    pub(crate) fn native_root_count_for_test(&self) -> Option<usize> {
        self.owner.native_root_count_for_test()
    }
}

#[cfg(windows)]
fn closing_cleanup_failure(
    owner: ClosingActivationOwner,
    detail: impl Into<String>,
) -> ClosingCleanupFailure {
    let detail = detail.into();
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        ClosingCleanupFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        ClosingCleanupFailureKind::Deadline
    } else if lower.contains("listener") {
        ClosingCleanupFailureKind::Listener
    } else if lower.contains("native")
        || lower.contains("job")
        || lower.contains("process")
        || lower.contains("cleanup")
    {
        ClosingCleanupFailureKind::Native
    } else {
        ClosingCleanupFailureKind::Validation
    };
    ClosingCleanupFailure {
        kind,
        detail,
        owner,
    }
}

#[cfg(windows)]
fn closing_cleanup_failure_for_admission(
    owner: ClosingActivationOwner,
    cause: ClosingCasError,
) -> ClosingCleanupFailure {
    let kind = match cause {
        ClosingCasError::Cancelled => ClosingCleanupFailureKind::Cancelled,
        ClosingCasError::Deadline => ClosingCleanupFailureKind::Deadline,
        // A conflict means the exact Closing tuple was stale before any
        // native operation.  Keep this distinct from native cleanup/storage
        // failures so callers can reconcile the foreign journal safely.
        ClosingCasError::Conflict => ClosingCleanupFailureKind::Validation,
        ClosingCasError::Storage => ClosingCleanupFailureKind::Native,
    };
    let detail = match cause {
        ClosingCasError::Cancelled => {
            "Capture runtime Closing cleanup admission was cancelled before native cleanup."
        }
        ClosingCasError::Deadline => {
            "Capture runtime Closing cleanup admission expired before native cleanup."
        }
        ClosingCasError::Conflict => {
            "Capture runtime Closing cleanup admission found a stale journal snapshot."
        }
        ClosingCasError::Storage => {
            "Capture runtime Closing cleanup admission could not read its exact snapshot."
        }
    };
    ClosingCleanupFailure {
        kind,
        detail: detail.into(),
        owner,
    }
}

#[cfg(windows)]
fn closing_staging_release_failure(
    owner: ClosingActivationOwner,
    kind: ClosingStagingReleaseFailureKind,
    detail: impl Into<String>,
) -> ClosingStagingReleaseFailure {
    ClosingStagingReleaseFailure {
        kind,
        detail: detail.into(),
        owner,
    }
}

#[cfg(windows)]
fn closing_staging_release_failure_for_staging(
    owner: ClosingActivationOwner,
    error: StagingCleanupError,
) -> ClosingStagingReleaseFailure {
    let kind = match error {
        StagingCleanupError::Cancelled => ClosingStagingReleaseFailureKind::Cancelled,
        StagingCleanupError::Deadline => ClosingStagingReleaseFailureKind::Deadline,
        StagingCleanupError::DeleteFailed => ClosingStagingReleaseFailureKind::Storage,
        StagingCleanupError::JournalChanged
        | StagingCleanupError::TraversalBound
        | StagingCleanupError::OwnershipUnknown
        | StagingCleanupError::Reparse
        | StagingCleanupError::IdentityChanged
        | StagingCleanupError::ForeignEntry
        | StagingCleanupError::HardLink
        | StagingCleanupError::NonEmpty => ClosingStagingReleaseFailureKind::Validation,
    };
    closing_staging_release_failure(
        owner,
        kind,
        format!("Capture runtime staging release stopped: {error:?}."),
    )
}

#[cfg(windows)]
fn closing_staging_release_failure_for_store_error(
    owner: ClosingActivationOwner,
    error: crate::journal_store::JournalStoreError,
) -> ClosingStagingReleaseFailure {
    let kind = match error {
        crate::journal_store::JournalStoreError::AdmissionCancelled => {
            ClosingStagingReleaseFailureKind::Cancelled
        }
        crate::journal_store::JournalStoreError::AdmissionDeadline => {
            ClosingStagingReleaseFailureKind::Deadline
        }
        crate::journal_store::JournalStoreError::Conflict
        | crate::journal_store::JournalStoreError::Journal(_) => {
            ClosingStagingReleaseFailureKind::Validation
        }
        _ => ClosingStagingReleaseFailureKind::Storage,
    };
    closing_staging_release_failure(
        owner,
        kind,
        format!("Capture runtime Closing staging-release admission stopped: {error:?}."),
    )
}

#[cfg(windows)]
fn closing_staging_release_failure_for_admission(
    owner: ClosingActivationOwner,
    cause: ClosingCasError,
) -> ClosingStagingReleaseFailure {
    let kind = match cause {
        ClosingCasError::Cancelled => ClosingStagingReleaseFailureKind::Cancelled,
        ClosingCasError::Deadline => ClosingStagingReleaseFailureKind::Deadline,
        ClosingCasError::Conflict => ClosingStagingReleaseFailureKind::Validation,
        ClosingCasError::Storage => ClosingStagingReleaseFailureKind::Storage,
    };
    closing_staging_release_failure(
        owner,
        kind,
        format!("Capture runtime Closing staging-release admission stopped: {cause:?}."),
    )
}

#[cfg(windows)]
fn staging_release_kind_from_detail(
    detail: &str,
    fallback: ClosingStagingReleaseFailureKind,
) -> ClosingStagingReleaseFailureKind {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("cancel") {
        ClosingStagingReleaseFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        ClosingStagingReleaseFailureKind::Deadline
    } else {
        fallback
    }
}

#[cfg(windows)]
fn listener_release_proof_for_closing(
    closing: &RuntimeSessionJournalV1,
    native: NativeCleanupProof,
) -> Result<NativeListenerReleaseProof, String> {
    let roots = closing
        .roots
        .iter()
        .zip(&native.roots)
        .map(|(journal_root, native_root)| {
            if journal_root.ordinal != native_root.ordinal
                || journal_root.root_nonce != native_nonce_text(&native_root.root_nonce)
                || journal_root.loopback_port == 0
                || journal_root.reserved_listener_identity.is_empty()
                || journal_root.live_listener_readiness.is_none()
            {
                return None;
            }
            Some(NativeListenerReleaseRootProof {
                ordinal: journal_root.ordinal,
                root_nonce: journal_root.root_nonce.clone(),
                creation_identity: journal_root.creation_identity.clone(),
                reserved_listener_identity: journal_root.reserved_listener_identity.clone(),
                readiness: journal_root.live_listener_readiness.clone()?,
                port: journal_root.loopback_port,
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            "Capture runtime listener release tuple was incomplete or reordered.".to_string()
        })?;
    if roots.len() != closing.roots.len() || roots.is_empty() {
        return Err("Capture runtime listener release tuple was incomplete or reordered.".into());
    }
    Ok(NativeListenerReleaseProof {
        session_nonce: closing.session_nonce.clone(),
        plan_digest: closing.plan_digest.clone(),
        closing_revision: closing.journal_revision,
        native,
        roots,
    })
}

#[cfg(windows)]
fn closing_transition_failure(
    owner: RunningActivationOwner,
    detail: impl Into<String>,
) -> ClosingTransitionFailure {
    let detail = detail.into();
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        ClosingTransitionFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        ClosingTransitionFailureKind::Deadline
    } else if lower.contains("conflict") || lower.contains("changed") {
        ClosingTransitionFailureKind::Conflict
    } else if lower.contains("cas") || lower.contains("storage") {
        ClosingTransitionFailureKind::Storage
    } else {
        ClosingTransitionFailureKind::Validation
    };
    ClosingTransitionFailure {
        kind,
        detail,
        owner,
    }
}

#[cfg(windows)]
fn closing_transition_failure_for_cas(
    owner: RunningActivationOwner,
    cause: ClosingCasError,
    detail: &str,
) -> ClosingTransitionFailure {
    let kind = match cause {
        ClosingCasError::Cancelled => ClosingTransitionFailureKind::Cancelled,
        ClosingCasError::Deadline => ClosingTransitionFailureKind::Deadline,
        ClosingCasError::Conflict => ClosingTransitionFailureKind::Conflict,
        ClosingCasError::Storage => ClosingTransitionFailureKind::Storage,
    };
    ClosingTransitionFailure {
        kind,
        detail: detail.to_owned(),
        owner,
    }
}

#[cfg(windows)]
fn closing_transition_failure_for_bounded_error(
    owner: RunningActivationOwner,
    detail: String,
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> ClosingTransitionFailure {
    if cancellation.load(Ordering::Acquire) {
        return closing_transition_failure(
            owner,
            "Capture runtime Closing admission was cancelled during bounded revalidation.",
        );
    }
    if std::time::Instant::now() >= deadline {
        return closing_transition_failure(
            owner,
            "Capture runtime Closing admission expired during bounded revalidation.",
        );
    }
    closing_transition_failure(owner, detail)
}

#[cfg(windows)]
fn running_promotion_failure(
    owner: LaunchingActivationOwner,
    detail: impl Into<String>,
) -> RunningPromotionFailure {
    let detail = detail.into();
    let lower = detail.to_ascii_lowercase();
    let kind = if lower.contains("cancel") {
        RunningPromotionFailureKind::Cancelled
    } else if lower.contains("deadline") || lower.contains("expired") {
        RunningPromotionFailureKind::Deadline
    } else if lower.contains("did not report strict service readiness") {
        RunningPromotionFailureKind::NotReady
    } else if lower.contains("journal cas") || lower.contains("admission failed") {
        RunningPromotionFailureKind::Storage
    } else {
        RunningPromotionFailureKind::Validation
    };
    RunningPromotionFailure {
        kind,
        detail,
        owner,
    }
}

#[cfg(windows)]
fn running_promotion_failure_for_cas(
    owner: LaunchingActivationOwner,
    cause: RunningCasError,
    detail: &str,
) -> RunningPromotionFailure {
    let kind = match cause {
        RunningCasError::Cancelled => RunningPromotionFailureKind::Cancelled,
        RunningCasError::Deadline => RunningPromotionFailureKind::Deadline,
        RunningCasError::Conflict => RunningPromotionFailureKind::Storage,
        RunningCasError::Storage => RunningPromotionFailureKind::Storage,
    };
    let detail = match cause {
        RunningCasError::Cancelled => format!("{detail} AdmissionCancelled."),
        RunningCasError::Deadline => format!("{detail} AdmissionDeadline."),
        RunningCasError::Conflict => format!("{detail} Conflict."),
        RunningCasError::Storage => detail.to_owned(),
    };
    RunningPromotionFailure {
        kind,
        detail,
        owner,
    }
}

#[cfg(windows)]
fn running_promotion_failure_for_bounded_error(
    owner: LaunchingActivationOwner,
    detail: String,
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> RunningPromotionFailure {
    if cancellation.load(Ordering::Acquire) {
        return running_promotion_failure_for_cas(owner, RunningCasError::Cancelled, &detail);
    }
    if std::time::Instant::now() >= deadline {
        return running_promotion_failure_for_cas(owner, RunningCasError::Deadline, &detail);
    }
    running_promotion_failure(owner, detail)
}

#[cfg(windows)]
fn check_running_promotion_budget(
    deadline: std::time::Instant,
    cancellation: &AtomicBool,
) -> Result<(), String> {
    if cancellation.load(Ordering::Acquire) {
        return Err("Capture runtime Running promotion was cancelled.".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("Capture runtime Running promotion exceeded its group deadline.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn parse_creation_identity(root: &JournalRoot) -> Result<u64, String> {
    if root.creation_identity.kind != "windows-process-creation" {
        return Err("Capture runtime root creation identity had an unsupported kind.".into());
    }
    if root.creation_identity.value.len() != 16
        || !root
            .creation_identity
            .value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Capture runtime root creation identity was malformed.".into());
    }
    u64::from_str_radix(&root.creation_identity.value, 16)
        .map_err(|_| "Capture runtime root creation identity was malformed.".into())
}

#[cfg(windows)]
fn running_readiness_digest(
    journal: &RuntimeSessionJournalV1,
    root: &JournalRoot,
    listener: &NativeListenerRootObservation,
    facts: &crate::health::ServiceReadinessFacts,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/running-readiness/v1\0");
    digest_field(&mut hasher, journal.session_nonce.as_bytes());
    digest_field(&mut hasher, journal.plan_digest.as_bytes());
    digest_field(&mut hasher, &root.ordinal.to_be_bytes());
    digest_field(&mut hasher, root.role.as_bytes());
    digest_field(&mut hasher, root.root_ref_digest.as_bytes());
    digest_field(&mut hasher, &root.root_generation.to_be_bytes());
    digest_field(&mut hasher, root.root_nonce.as_bytes());
    digest_field(&mut hasher, &root.pid.to_be_bytes());
    digest_field(&mut hasher, root.creation_identity.kind.as_bytes());
    digest_field(&mut hasher, root.creation_identity.value.as_bytes());
    digest_field(&mut hasher, root.reserved_listener_identity.as_bytes());
    digest_field(&mut hasher, &root.loopback_port.to_be_bytes());
    digest_field(&mut hasher, root.started_at.as_bytes());
    digest_field(&mut hasher, &listener.identity.pid.to_be_bytes());
    digest_field(&mut hasher, &listener.identity.creation_time.to_be_bytes());
    digest_field(&mut hasher, &listener.port.to_be_bytes());
    digest_field(&mut hasher, facts.facts_digest().as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(windows)]
fn digest_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

#[cfg(windows)]
fn cancellation_requested(cancellation: Option<&AtomicBool>) -> bool {
    cancellation.is_some_and(|flag| flag.load(Ordering::Acquire))
}

#[cfg(all(test, windows))]
pub(crate) fn inject_cancellation_after_launching_cas_for_test() {
    CANCEL_AFTER_LAUNCHING_CAS.with(|cancel| cancel.set(true));
}

#[cfg(all(test, windows))]
#[allow(dead_code)]
pub(crate) fn inject_cancellation_before_resume_root_for_test(index: usize) {
    CANCEL_BEFORE_RESUME_ROOT.with(|cancel_at| cancel_at.set(Some(index)));
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
            #[cfg(test)]
            listener_query_failure: false,
            #[cfg(test)]
            listener_identity_mutation_after_first: false,
            #[cfg(test)]
            listener_identity_mutation_at_last: false,
            #[cfg(test)]
            listener_observation_count: 0,
            #[cfg(test)]
            root_exit_after_first: false,
            #[cfg(test)]
            cleanup_attempts: 0,
            #[cfg(test)]
            cancel_after_cleanup_root: None,
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

    /// Validate the retained native identities against the exact Closing
    /// journal without requiring the roots or listeners to remain live.  This
    /// is the last non-destructive gate before Job termination.
    fn validate_closing_binding(
        &mut self,
        expected: &RuntimeSessionJournalV1,
    ) -> Result<NativeCleanupProof, String> {
        if expected.state != JournalState::Closing {
            return Err("Capture runtime native cleanup required a Closing journal.".into());
        }
        let job = expected
            .job_binding
            .as_ref()
            .ok_or_else(|| "Capture runtime Closing Job binding was missing.".to_string())?;
        if job.setup_state != JobSetupState::Committed
            || native_nonce_text(&self.job_nonce) != job.job_nonce
            || self.job.is_none()
        {
            return Err("Capture runtime Closing Job identity changed before cleanup.".into());
        }
        if self.roots.len() != expected.roots.len()
            || self.roots.is_empty()
            || !self.unacquired_root_nonces.is_empty()
        {
            return Err("Capture runtime Closing native root set was incomplete.".into());
        }
        let mut seen_nonces = HashSet::with_capacity(self.roots.len().saturating_add(1));
        if !seen_nonces.insert(self.job_nonce) {
            return Err("Capture runtime Closing Job nonce was duplicated.".into());
        }
        let mut roots = Vec::with_capacity(self.roots.len());
        for (index, (native_root, journal_root)) in
            self.roots.iter_mut().zip(&expected.roots).enumerate()
        {
            let ordinal = u32::try_from(index)
                .map_err(|_| "Capture runtime Closing root ordinal exceeded its range.")?;
            if native_root.ordinal != ordinal
                || journal_root.ordinal != ordinal
                || native_root.state != SuspendedRootState::Resumed
                || journal_root.state != RootState::Closing
                || journal_root.live_listener_readiness.is_none()
                || journal_root.loopback_port == 0
            {
                return Err(
                    "Capture runtime Closing root binding was incomplete or reordered.".into(),
                );
            }
            if !seen_nonces.insert(native_root.root_nonce) {
                return Err("Capture runtime Closing root nonce was duplicated.".into());
            }
            let expected_identity = parse_creation_identity(journal_root).map(|creation_time| {
                OwnedProcessIdentity {
                    pid: journal_root.pid,
                    creation_time,
                }
            })?;
            let retained_identity = native_root.identity.ok_or_else(|| {
                format!("Capture runtime Closing root {ordinal} identity was missing.")
            })?;
            if retained_identity != expected_identity
                || native_nonce_text(&native_root.root_nonce) != journal_root.root_nonce
            {
                return Err(
                    "Capture runtime Closing native root identity changed before cleanup.".into(),
                );
            }
            let observed = process_identity_from_handle(
                native_root.child.as_raw_handle() as *mut c_void,
                native_root.child.id(),
            )?;
            if observed != retained_identity {
                return Err(
                    "Capture runtime Closing retained root handle identity changed before cleanup."
                        .into(),
                );
            }
            roots.push(NativeCleanupRootProof {
                ordinal,
                root_nonce: native_root.root_nonce,
                identity: retained_identity,
            });
        }
        Ok(NativeCleanupProof {
            job_nonce: self.job_nonce,
            roots,
        })
    }

    /// Stop and prove the exact retained Job while leaving this group in the
    /// owner.  A subsequent listener observation can therefore use the same
    /// root handles and cannot accidentally reacquire by PID.
    fn cleanup_and_retain_proof(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<NativeCleanupProof, String> {
        if self.cleanup_complete {
            return self
                .retained_cleanup_proof()
                .ok_or_else(|| "Capture runtime native cleanup proof was incomplete.".into());
        }
        let _proof = self.cleanup_inner_with_budget(deadline, cancellation)?;
        self.cleanup_complete = true;
        self.retained_cleanup_proof()
            .ok_or_else(|| "Capture runtime native cleanup proof was incomplete.".into())
    }

    fn retained_cleanup_proof(&self) -> Option<NativeCleanupProof> {
        if !self.cleanup_complete
            || self.roots.is_empty()
            || !self.unacquired_root_nonces.is_empty()
        {
            return None;
        }
        let roots = self
            .roots
            .iter()
            .enumerate()
            .map(|(index, root)| {
                Some(NativeCleanupRootProof {
                    ordinal: u32::try_from(index).ok()?,
                    root_nonce: root.root_nonce,
                    identity: root.identity?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(NativeCleanupProof {
            job_nonce: self.job_nonce,
            roots,
        })
    }

    fn verify_listener_roots(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<Vec<OwnedProcessIdentity>, String> {
        check_listener_budget(deadline, cancellation)?;
        if self.roots.is_empty() || !self.unacquired_root_nonces.is_empty() {
            return Err("The runtime group does not have a complete native root set.".into());
        }
        let mut identities = Vec::with_capacity(self.roots.len());
        let mut seen = HashSet::with_capacity(self.roots.len());
        for index in 0..self.roots.len() {
            check_listener_budget(deadline, cancellation)?;
            let root = &mut self.roots[index];
            if root.state != SuspendedRootState::Resumed {
                return Err(format!(
                    "Runtime root {} was not retained in the resumed state for listener observation.",
                    root.ordinal
                ));
            }
            let expected = root.identity.ok_or_else(|| {
                format!("Runtime root {} has no captured identity.", root.ordinal)
            })?;
            if !seen.insert(expected) {
                return Err("The runtime group contained duplicate root identities.".into());
            }
            let observed = process_identity_from_handle(
                root.child.as_raw_handle() as *mut c_void,
                root.child.id(),
            )?;
            validate_listener_process_identity(expected, observed)?;
            if root
                .child
                .try_wait()
                .map_err(|error| format!("The runtime root liveness check failed: {error}"))?
                .is_some()
            {
                return Err(format!(
                    "Runtime root {} was no longer live during listener observation.",
                    root.ordinal
                ));
            }
            self.job
                .as_mut()
                .expect("group Job")
                .verify_assignment(&root.child)?;
            identities.push(expected);
        }
        Ok(identities)
    }

    /// Observe one exact loopback listener for every already-resumed root.
    /// The table is evidence only: each PID is matched to the creation
    /// identity read from the retained root process handle before and after
    /// the table query, and Job membership is checked at both boundaries.
    ///
    /// This is intentionally private until the activation journal has a
    /// canonical place for the resulting observation.  In particular, this
    /// method never opens or terminates a process by a PID from the table.
    #[allow(dead_code)]
    fn observe_root_listeners(
        &mut self,
        ports: &[u16],
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<NativeListenerObservation, String> {
        check_listener_budget(deadline, cancellation)?;
        validate_listener_inputs(self, ports)?;
        let before = self.verify_listener_roots(deadline, cancellation)?;
        check_listener_budget(deadline, cancellation)?;
        #[cfg(test)]
        if self.listener_query_failure {
            self.listener_query_failure = false;
            return Err("Injected listener table query failure.".into());
        }
        let table = query_listener_table(deadline, cancellation)?;
        #[cfg(test)]
        let mut observation = parse_listener_table(&table, &before, ports)?;
        #[cfg(not(test))]
        let observation = parse_listener_table(&table, &before, ports)?;
        #[cfg(test)]
        {
            let mutate = (self.listener_identity_mutation_after_first
                && self.listener_observation_count > 0)
                || (self.listener_identity_mutation_at_last
                    && self.listener_observation_count >= 2);
            self.listener_observation_count = self.listener_observation_count.saturating_add(1);
            if mutate {
                if let Some(root) = observation.roots.first_mut() {
                    root.port = root.port.wrapping_add(1);
                }
            }
        }
        #[cfg(test)]
        if self.root_exit_after_first && self.listener_observation_count > 0 {
            let root = self
                .roots
                .first_mut()
                .ok_or_else(|| "Injected root exit had no root owner.".to_string())?;
            terminate_child_by_exact_handle(&mut root.child, remaining_timeout_ms(deadline))?;
        }
        let after = self.verify_listener_roots(deadline, cancellation)?;
        if before != after {
            return Err(
                "A runtime root identity or Job membership changed during listener observation."
                    .into(),
            );
        }
        for (index, observed) in observation.roots.iter().enumerate() {
            if observed.identity != before[index] {
                return Err(
                    "A listener row did not retain the exact root creation identity.".into(),
                );
            }
        }
        check_listener_budget(deadline, cancellation)?;
        Ok(observation)
    }

    /// Prove that every listener reserved by the exact Closing roots is gone.
    /// This runs after native termination and never opens, terminates, or
    /// otherwise acts on a PID from the table.  Any row on a reserved port,
    /// including a foreign or wildcard row, remains ambiguous and fails
    /// closed.
    fn observe_listener_release(
        &mut self,
        expected: &NativeCleanupProof,
        ports: &[u16],
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), String> {
        check_listener_budget(deadline, cancellation)?;
        if !self.cleanup_complete
            || self.retained_cleanup_proof().as_ref() != Some(expected)
            || expected.roots.len() != ports.len()
            || ports.is_empty()
        {
            return Err(
                "Capture runtime listener release lacked the exact native cleanup proof.".into(),
            );
        }
        let mut seen_ports = HashSet::with_capacity(ports.len());
        for (index, (&port, root)) in ports.iter().zip(&expected.roots).enumerate() {
            let ordinal = u32::try_from(index)
                .map_err(|_| "Capture runtime listener release root ordinal exceeded its range.")?;
            if root.ordinal != ordinal || port == 0 || !seen_ports.insert(port) {
                return Err(
                    "Capture runtime listener release ports were incomplete or reordered.".into(),
                );
            }
        }
        #[cfg(test)]
        if self.listener_query_failure {
            self.listener_query_failure = false;
            return Err("Injected listener release table query failure.".into());
        }
        let table = query_listener_table(deadline, cancellation)?;
        let rows = listener_table_rows(&table)?;
        for row in rows {
            let port = u16::from_be(row.dwLocalPort as u16);
            if ports.contains(&port) {
                return Err(format!(
                    "A listener remained on reserved port {port}; release was ambiguous."
                ));
            }
        }
        check_listener_budget(deadline, cancellation)?;
        Ok(())
    }

    /// Closing's production caller supplies the already admitted journal
    /// tuple; ports are projected here rather than accepted as an unrelated
    /// helper argument.  The lower-level function remains useful for the
    /// native parser tests, but the lifecycle owner cannot ask it to inspect
    /// arbitrary caller-selected ports.
    fn observe_listener_release_for_closing(
        &mut self,
        closing: &RuntimeSessionJournalV1,
        expected: &NativeCleanupProof,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<(), String> {
        if closing.state != JournalState::Closing
            || closing.roots.len() != expected.roots.len()
            || closing.roots.is_empty()
        {
            return Err("Capture runtime Closing listener tuple was incomplete.".into());
        }
        let ports = closing
            .roots
            .iter()
            .zip(&expected.roots)
            .map(|(journal_root, native_root)| {
                if journal_root.ordinal != native_root.ordinal
                    || journal_root.loopback_port == 0
                    || journal_root.root_nonce != native_nonce_text(&native_root.root_nonce)
                {
                    return None;
                }
                Some(journal_root.loopback_port)
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| "Capture runtime Closing listener tuple was reordered.".to_string())?;
        self.observe_listener_release(expected, &ports, deadline, cancellation)
    }

    #[cfg(test)]
    fn terminate_root_for_test(&mut self, ordinal: usize) -> Result<(), String> {
        let root = self
            .roots
            .get_mut(ordinal)
            .ok_or_else(|| format!("Runtime group root {ordinal} was not retained."))?;
        terminate_child_by_exact_handle(&mut root.child, PROCESS_WAIT_TIMEOUT_MS)
    }

    /// Consumes the owner. On failure the returned error contains the same
    /// owner, so the caller can reconcile without reconstructing native state.
    fn resume_all(self) -> Result<Self, GroupNativeFailure> {
        self.resume_all_with_cancellation(None)
    }

    fn resume_all_with_cancellation(
        mut self,
        cancellation: Option<&AtomicBool>,
    ) -> Result<Self, GroupNativeFailure> {
        if let Err(error) = self.verify_all_assigned_suspended() {
            return Err(self.failure(GroupNativeFailureKind::Membership, error));
        }
        for index in 0..self.roots.len() {
            #[cfg(all(test, windows))]
            if CANCEL_BEFORE_RESUME_ROOT.with(|cancel_at| cancel_at.get() == Some(index)) {
                CANCEL_BEFORE_RESUME_ROOT.with(|cancel_at| cancel_at.set(None));
                if let Some(cancellation) = cancellation {
                    cancellation.store(true, Ordering::Release);
                }
            }
            if cancellation_requested(cancellation) {
                return Err(self.failure(
                    GroupNativeFailureKind::Resume,
                    format!("Capture runtime resume was cancelled before root {index}."),
                ));
            }
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
        self.cleanup_inner_with_budget(deadline, None)
    }

    fn cleanup_inner_with_budget(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<GroupCleanupProof, String> {
        check_native_cleanup_budget(deadline, cancellation)?;
        #[cfg(test)]
        {
            self.cleanup_attempts = self.cleanup_attempts.saturating_add(1);
        }
        let job = self.job.as_mut().expect("group Job");
        let _job_terminated = job.terminate().is_ok();
        for (index, root) in self.roots.iter_mut().enumerate() {
            check_native_cleanup_budget(deadline, cancellation)?;
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
            #[cfg(test)]
            if self.cancel_after_cleanup_root == Some(index) {
                self.cancel_after_cleanup_root = None;
                if let Some(cancellation) = cancellation {
                    cancellation.store(true, Ordering::Release);
                }
            }
        }
        check_native_cleanup_budget(deadline, cancellation)?;
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

    #[cfg(test)]
    fn inject_cancellation_after_cleanup_root_for_test(&mut self, ordinal: usize) {
        self.cancel_after_cleanup_root = Some(ordinal);
    }

    #[cfg(test)]
    fn inject_resume_failure_at_for_test(&mut self, ordinal: usize) {
        self.job.as_mut().expect("group Job").resume_failure_at = Some(ordinal);
    }

    #[cfg(test)]
    fn inject_membership_failure_for_test(&mut self) {
        let job = self.job.as_mut().expect("group Job");
        job.membership_failure_at = Some(job.membership_attempts);
    }

    #[cfg(test)]
    fn inject_listener_query_failure_for_test(&mut self) {
        self.listener_query_failure = true;
    }

    #[cfg(test)]
    fn inject_listener_identity_mutation_after_first_for_test(&mut self) {
        self.listener_identity_mutation_after_first = true;
    }

    #[cfg(test)]
    fn inject_listener_identity_mutation_at_last_observation_for_test(&mut self) {
        self.listener_identity_mutation_at_last = true;
    }

    #[cfg(test)]
    fn inject_root_exit_after_first_for_test(&mut self) {
        self.root_exit_after_first = true;
    }
}

#[cfg(windows)]
fn check_listener_budget(
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
fn check_native_cleanup_budget(
    deadline: std::time::Instant,
    cancellation: Option<&AtomicBool>,
) -> Result<(), String> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Capture runtime native cleanup was cancelled.".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("Capture runtime native cleanup exceeded its group deadline.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn validate_listener_process_identity(
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
fn validate_listener_inputs(group: &SuspendedGroup, ports: &[u16]) -> Result<(), String> {
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
fn query_listener_table(
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
fn parse_listener_table(
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
        if row.dwState != MIB_TCP_STATE_LISTEN as u32 {
            return Err("The Windows listener table contained a non-listening target row.".into());
        }
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
fn listener_table_rows(table: &[u8]) -> Result<Vec<MIB_TCPROW_OWNER_PID>, String> {
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
    fn cleanup_native_for_closing(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<NativeCleanupProof, String> {
        if self.native_cleanup_proven {
            return self
                .native
                .as_ref()
                .and_then(SuspendedGroup::retained_cleanup_proof)
                .ok_or_else(|| "Capture runtime native cleanup proof was incomplete.".into());
        }
        let native = self.native.as_mut().ok_or_else(|| {
            "Capture runtime native owner was missing before Closing cleanup.".to_string()
        })?;
        let proof = native.cleanup_and_retain_proof(deadline, cancellation)?;
        self.native_cleanup_proven = true;
        Ok(proof)
    }

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
        net::{TcpListener, TcpStream},
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
    fn listener_command(port: u16, address: &str) -> Command {
        let script = format!(
            "$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('{address}'), {port}); $listener.Start(); Start-Sleep -Seconds 30"
        );
        let mut command = powershell_command(&script);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[cfg(windows)]
    fn free_loopback_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .expect("free loopback port")
            .local_addr()
            .expect("loopback address")
            .port()
    }

    #[cfg(windows)]
    fn wait_for_listener_observation(
        group: &mut SuspendedGroup,
        ports: &[u16],
    ) -> NativeListenerObservation {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match group.observe_root_listeners(ports, deadline, None) {
                Ok(observation) => return observation,
                Err(error) if std::time::Instant::now() < deadline => {
                    assert!(
                        !error.contains("foreign") && !error.contains("wildcard"),
                        "listener table reported a permanent ownership error: {error}"
                    );
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => panic!("listener observation did not complete: {error}"),
            }
        }
    }

    #[cfg(windows)]
    fn wait_for_listener_error(
        group: &mut SuspendedGroup,
        ports: &[u16],
        expected_fragment: &str,
    ) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match group.observe_root_listeners(ports, deadline, None) {
                Ok(_) => panic!("unexpected listener observation success"),
                Err(error) if error.contains(expected_fragment) => return error,
                Err(_error) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => {
                    panic!("listener observation did not report {expected_fragment:?}: {error}")
                }
            }
        }
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
    fn listener_creation_identity_mismatch_fails_closed() {
        let expected = OwnedProcessIdentity {
            pid: 42,
            creation_time: 100,
        };
        let observed = OwnedProcessIdentity {
            pid: expected.pid,
            creation_time: expected.creation_time + 1,
        };
        let error = validate_listener_process_identity(expected, observed)
            .expect_err("PID reuse with a different creation identity");
        assert!(error.contains("creation identity"));
    }

    #[cfg(windows)]
    #[test]
    fn malformed_listener_tables_are_bounded_and_fail_closed() {
        let expected = [OwnedProcessIdentity {
            pid: 42,
            creation_time: 100,
        }];
        let ports = [45_001_u16];
        assert!(parse_listener_table(&[0_u8; 3], &expected, &ports).is_err());
        assert!(parse_listener_table(&u32::MAX.to_ne_bytes(), &expected, &ports).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn listener_observation_requires_cancellation_before_native_query() {
        let marker = group_marker_path("listener-cancelled");
        let mut commands = [marker_command(&marker, true)];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        let cancelled = std::sync::atomic::AtomicBool::new(true);
        let error = group
            .observe_root_listeners(
                &[free_loopback_port()],
                std::time::Instant::now() + Duration::from_secs(5),
                Some(&cancelled),
            )
            .err()
            .expect("cancelled observation");
        assert!(error.contains("cancelled"));
        let proof = group
            .cleanup_and_prove()
            .expect("cleanup after cancelled observation");
        assert!(proof.roots_reaped);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn direct_root_loopback_listener_is_observed_by_retained_identity() {
        let port = free_loopback_port();
        let mut commands = [listener_command(port, "127.0.0.1")];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended listener root")
            .resume_all()
            .expect("resumed listener root");
        let expected_identity = group.roots[0].identity.expect("root identity");
        let observation = wait_for_listener_observation(&mut group, &[port]);
        assert_eq!(observation.root_count(), 1);
        let root = observation.root(0).expect("listener root");
        assert_eq!(root.ordinal, 0);
        assert_eq!(root.port, port);
        assert_eq!(root.identity, expected_identity);
        let proof = group.cleanup_and_prove().expect("listener group cleanup");
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
    }

    #[cfg(windows)]
    #[test]
    fn ordered_multi_root_loopback_listeners_are_observed_without_pid_substitution() {
        let first_port = free_loopback_port();
        let second_port = free_loopback_port();
        assert_ne!(first_port, second_port);
        let mut commands = [
            listener_command(first_port, "127.0.0.1"),
            listener_command(second_port, "127.0.0.1"),
        ];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended listener roots")
            .resume_all()
            .expect("resumed listener roots");
        let expected = group
            .roots
            .iter()
            .map(|root| root.identity.expect("root identity"))
            .collect::<Vec<_>>();
        let observation = wait_for_listener_observation(&mut group, &[first_port, second_port]);
        assert_eq!(observation.root_count(), 2);
        for (ordinal, (port, identity)) in [first_port, second_port]
            .into_iter()
            .zip(expected)
            .enumerate()
        {
            let root = observation.root(ordinal).expect("ordered listener root");
            assert_eq!(root.ordinal, ordinal as u32);
            assert_eq!(root.port, port);
            assert_eq!(root.identity, identity);
        }
        let proof = group
            .cleanup_and_prove()
            .expect("multi-root listener cleanup");
        assert!(proof.roots_reaped);
        assert!(proof.descendants_terminated);
    }

    #[cfg(windows)]
    #[test]
    fn foreign_loopback_listener_on_target_port_is_rejected_without_touching_it() {
        let foreign = TcpListener::bind(("127.0.0.1", 0)).expect("foreign listener");
        let port = foreign.local_addr().expect("foreign address").port();
        let marker = group_marker_path("listener-foreign");
        let mut commands = [marker_command(&marker, true)];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        let error = wait_for_listener_error(&mut group, &[port], "foreign");
        assert!(error.contains("foreign"));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        let proof = group
            .cleanup_and_prove()
            .expect("foreign listener group cleanup");
        assert!(proof.roots_reaped);
        drop(foreign);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn listener_release_foreign_row_is_ambiguous_without_touching_foreign_listener() {
        let foreign = TcpListener::bind(("127.0.0.1", 0)).expect("foreign listener");
        let port = foreign.local_addr().expect("foreign address").port();
        let marker = group_marker_path("listener-release-foreign");
        let mut commands = [marker_command(&marker, true)];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        let cleanup_proof = group
            .cleanup_and_retain_proof(std::time::Instant::now() + Duration::from_secs(5), None)
            .expect("native cleanup proof");
        let error = group
            .observe_listener_release(
                &cleanup_proof,
                &[port],
                std::time::Instant::now() + Duration::from_secs(5),
                None,
            )
            .expect_err("foreign listener must block release proof");
        assert!(error.contains("reserved port"));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        drop(foreign);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn wildcard_listener_on_target_port_is_rejected() {
        let wildcard = TcpListener::bind(("0.0.0.0", 0)).expect("wildcard listener");
        let port = wildcard.local_addr().expect("wildcard address").port();
        let marker = group_marker_path("listener-wildcard");
        let mut commands = [marker_command(&marker, true)];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        let error = wait_for_listener_error(&mut group, &[port], "wildcard");
        assert!(error.contains("wildcard"));
        let proof = group
            .cleanup_and_prove()
            .expect("wildcard listener group cleanup");
        assert!(proof.roots_reaped);
        drop(wildcard);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn dead_root_cannot_supply_a_listener_observation() {
        let marker = group_marker_path("listener-dead");
        let mut commands = [marker_command(&marker, false)];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended short-lived root")
            .resume_all()
            .expect("resumed short-lived root");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while group.roots[0]
            .child
            .try_wait()
            .expect("root status")
            .is_none()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(group.roots[0]
            .child
            .try_wait()
            .expect("root status")
            .is_some());
        let error = group
            .observe_root_listeners(
                &[free_loopback_port()],
                std::time::Instant::now() + Duration::from_secs(5),
                None,
            )
            .err()
            .expect("dead root listener observation");
        assert!(error.contains("no longer live"));
        let proof = group.cleanup_and_prove().expect("dead root cleanup");
        assert!(proof.roots_reaped);
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_group_listener_ports_are_rejected_before_table_query() {
        let first_marker = group_marker_path("listener-duplicate-first");
        let second_marker = group_marker_path("listener-duplicate-second");
        let port = free_loopback_port();
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        let error = group
            .observe_root_listeners(
                &[port, port],
                std::time::Instant::now() + Duration::from_secs(5),
                None,
            )
            .err()
            .expect("duplicate listener ports");
        assert!(error.contains("distinct nonzero"));
        let proof = group
            .cleanup_and_prove()
            .expect("duplicate listener cleanup");
        assert!(proof.roots_reaped);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn noncontiguous_group_listener_ordinals_are_rejected_before_table_query() {
        let first_marker = group_marker_path("listener-ordinal-first");
        let second_marker = group_marker_path("listener-ordinal-second");
        let mut commands = [
            marker_command(&first_marker, true),
            marker_command(&second_marker, true),
        ];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        group.roots[1].ordinal = 2;
        let first_port = free_loopback_port();
        let second_port = free_loopback_port();
        let error = group
            .observe_root_listeners(
                &[first_port, second_port],
                std::time::Instant::now() + Duration::from_secs(5),
                None,
            )
            .err()
            .expect("noncontiguous listener ordinals");
        assert!(error.contains("contiguous and ordered"));
        let proof = group
            .cleanup_and_prove()
            .expect("ordinal validation cleanup");
        assert!(proof.roots_reaped);
        let _ = std::fs::remove_file(first_marker);
        let _ = std::fs::remove_file(second_marker);
    }

    #[cfg(windows)]
    #[test]
    fn listener_table_query_failure_retains_native_owner() {
        let marker = group_marker_path("listener-query-failure");
        let port = free_loopback_port();
        let mut commands = [marker_command(&marker, true)];
        let mut group = SuspendedGroup::spawn(&mut commands)
            .expect("suspended group")
            .resume_all()
            .expect("resumed group");
        group.inject_listener_query_failure_for_test();
        let error = group
            .observe_root_listeners(
                &[port],
                std::time::Instant::now() + Duration::from_secs(5),
                None,
            )
            .err()
            .expect("injected listener query failure");
        assert!(error.contains("Injected listener table query failure"));
        assert_eq!(group.roots.len(), 1);
        let proof = group
            .cleanup_and_prove()
            .expect("listener query failure cleanup");
        assert!(proof.roots_reaped);
        let _ = std::fs::remove_file(marker);
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
        group.inject_cleanup_failure_after_first_for_test();
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
