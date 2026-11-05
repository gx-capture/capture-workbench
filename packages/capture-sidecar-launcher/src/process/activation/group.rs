#[cfg(test)]
use crate::process::native::PROCESS_WAIT_TIMEOUT_MS;
use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
#[cfg(test)]
use std::sync::atomic::Ordering;

#[cfg(windows)]
use std::{ffi::c_void, sync::atomic::AtomicBool};

#[cfg(all(test, windows))]
use crate::process::fixture::{
    CANCEL_AFTER_RESUME_ROOT, CANCEL_BEFORE_RESUME_ROOT, EXPIRE_AFTER_SPAWN_BEFORE_ASSIGNMENT,
};
#[cfg(all(test, windows))]
use crate::process::native::GroupTestFaults;
#[cfg(windows)]
use rand::{rngs::OsRng, RngCore};

#[cfg(windows)]
use crate::journal_store::ActivationBudget;

use crate::journal::{JobSetupState, JournalState, RootState, RuntimeSessionJournalV1};
use crate::process::native::{
    process_identity_from_handle, reap_child_by_exact_handle, remaining_timeout_ms,
    resume_suspended_process, same_process_identity, terminate_child_by_exact_handle,
    terminate_process_with_proof_with_timeout, verify_suspended_primary_thread,
    OwnedProcessIdentity, WindowsJob,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

#[cfg(windows)]
use crate::process::listener::{
    check_listener_budget, listener_table_rows, parse_listener_table, query_listener_table,
    validate_listener_inputs, validate_listener_process_identity, NativeListenerObservation,
    NativeRootObservation,
};

use super::failure::{
    activation_budget_error_detail, check_native_cleanup_budget, GroupNativeFailure,
    GroupNativeFailureKind,
};
#[cfg(windows)]
use super::launching::parse_creation_identity;
use super::{
    cancellation_requested, NativeNonce, DROP_CLEANUP_WAIT_MS, GROUP_CLEANUP_BUDGET_MS,
    NATIVE_NONCE_ATTEMPTS, NATIVE_NONCE_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SuspendedRootState {
    Unassigned,
    AssignedSuspended,
    Resumed,
}

/// Private ownership for a group before the journal/activation seam is wired.
/// The Job and every Child remain together so a partial native operation can
/// never return a cleanup-free error.
#[cfg(windows)]
pub(crate) struct SuspendedGroup {
    pub(crate) job: Option<WindowsJob>,
    pub(crate) job_nonce: NativeNonce,
    pub(crate) roots: Vec<SuspendedGroupRoot>,
    // Only planned roots that have not acquired a Child are retained here.
    // Once a root exists, its nonce moves into that root's owner record.
    pub(crate) unacquired_root_nonces: VecDeque<NativeNonce>,
    pub(crate) cleanup_complete: bool,
    #[cfg(test)]
    pub(crate) cleanup_failure_at: Option<usize>,
    #[cfg(test)]
    pub(crate) listener_query_failure: bool,
    #[cfg(test)]
    pub(crate) listener_identity_mutation_after_first: bool,
    #[cfg(test)]
    pub(crate) listener_identity_mutation_at_last: bool,
    #[cfg(test)]
    pub(crate) listener_observation_count: usize,
    #[cfg(test)]
    pub(crate) root_exit_after_first: bool,
    #[cfg(test)]
    pub(crate) cleanup_attempts: usize,
    #[cfg(test)]
    pub(crate) cancel_after_cleanup_root: Option<usize>,
}

#[cfg(windows)]
pub(crate) struct SuspendedGroupRoot {
    pub(crate) child: Child,
    pub(crate) root_nonce: NativeNonce,
    pub(crate) identity: Option<OwnedProcessIdentity>,
    pub(crate) ordinal: u32,
    pub(crate) state: SuspendedRootState,
}

#[cfg(windows)]
pub(crate) struct PreallocatedNativeNonces {
    pub(crate) job_nonce: NativeNonce,
    pub(crate) root_nonces: Vec<NativeNonce>,
}

/// A private observation produced only after the existing native ownership
/// checks pass. It carries binding evidence for the future activation seam;
/// it is deliberately not a readiness or terminal proof and has no
/// serialization or Debug authority.
#[cfg(windows)]
pub(crate) struct NativeBindingSnapshot {
    pub(crate) job_nonce: NativeNonce,
    pub(crate) roots: Vec<NativeRootObservation>,
}

#[cfg(windows)]
pub(crate) fn generate_group_nonces(root_count: usize) -> Result<PreallocatedNativeNonces, String> {
    generate_group_nonces_with_filler(root_count, |nonce| {
        OsRng.try_fill_bytes(nonce).map_err(|_| ())
    })
}

#[cfg(windows)]
pub(crate) fn generate_group_nonces_with_filler<F>(
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
pub(crate) fn generate_unique_nonce<F>(
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
pub(crate) fn native_nonce_text(nonce: &NativeNonce) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(nonce.len() * 2);
    for byte in nonce {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0x0f) as usize] as char);
    }
    text
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct NativeCleanupProof {
    pub(crate) job_nonce: NativeNonce,
    pub(crate) roots: Vec<NativeCleanupRootProof>,
    /// Activation-failure cleanup may complete with no root identity (for
    /// example when CreateProcess succeeded but identity capture failed).
    /// Such evidence is usable only to retain the activation owner for
    /// reconciliation; normal Closing/Terminal proof must remain complete.
    pub(crate) activation_failure_only: bool,
}

#[cfg(windows)]
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct NativeCleanupRootProof {
    pub(crate) ordinal: u32,
    pub(crate) root_nonce: NativeNonce,
    pub(crate) identity: OwnedProcessIdentity,
}

/// Marker that the Closing listener-release checks succeeded. Terminalization
/// freshly validates the retained native identities and listener absence.
#[cfg(windows)]
pub(crate) struct NativeListenerReleaseProof {}

#[cfg(windows)]
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GroupCleanupProof {
    pub(crate) roots_reaped: bool,
    pub(crate) descendants_terminated: bool,
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
#[cfg(windows)]
impl SuspendedGroup {
    /// Shared native acquisition loop with a private last-moment check.  The
    /// connected activation path uses this hook to replace each command from
    /// the frozen descriptor immediately before CreateProcess; legacy tests
    /// and callers use the no-op adapter above.
    pub(crate) fn spawn_with_prespawn_check<F>(
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
        Self::spawn_with_job(
            commands,
            job,
            nonces,
            before_spawn,
            None,
            #[cfg(all(test, windows))]
            false,
        )
    }

    /// Budget-aware variant used only by the private activation handoff.  It
    /// checks before Job creation and at every root's identity, assignment,
    /// and membership boundary, retaining the same partial group on failure.
    pub(crate) fn spawn_with_budget<F>(
        commands: &mut [Command],
        budget: &ActivationBudget,
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
        #[cfg(all(test, windows))]
        // Consume the hook before any admission, nonce, or Job setup failure
        // can leave it armed for a later test on this thread.
        let expire_after_spawn_before_assignment =
            EXPIRE_AFTER_SPAWN_BEFORE_ASSIGNMENT.with(|expire| expire.replace(false));
        budget.check().map_err(|error| {
            GroupNativeFailure::without_owner(
                GroupNativeFailureKind::Setup,
                activation_budget_error_detail(error),
            )
        })?;
        let nonces = generate_group_nonces(commands.len()).map_err(|error| {
            GroupNativeFailure::without_owner(GroupNativeFailureKind::Setup, error)
        })?;
        budget.check().map_err(|error| {
            GroupNativeFailure::without_owner(
                GroupNativeFailureKind::Setup,
                activation_budget_error_detail(error),
            )
        })?;
        let job = WindowsJob::new().map_err(|error| {
            GroupNativeFailure::without_owner(GroupNativeFailureKind::Setup, error)
        })?;
        Self::spawn_with_job(
            commands,
            job,
            nonces,
            before_spawn,
            Some(budget),
            #[cfg(all(test, windows))]
            expire_after_spawn_before_assignment,
        )
    }

    #[cfg(test)]
    pub(crate) fn spawn_with_faults(
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
        Self::spawn_with_job(
            commands,
            job,
            nonces,
            |_, _| Ok(()),
            None,
            #[cfg(all(test, windows))]
            false,
        )
    }

    pub(crate) fn spawn_with_job<F>(
        commands: &mut [Command],
        job: WindowsJob,
        nonces: PreallocatedNativeNonces,
        mut before_spawn: F,
        budget: Option<&ActivationBudget>,
        #[cfg(all(test, windows))] expire_after_spawn_before_assignment: bool,
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
            if let Some(budget) = budget {
                if let Err(error) = budget.check() {
                    return Err(group.failure(
                        GroupNativeFailureKind::Setup,
                        activation_budget_error_detail(error),
                    ));
                }
            }
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
            if let Some(budget) = budget {
                // The callback revalidates the frozen descriptor and journal,
                // and may observe a request cancellation while doing so.  A
                // check before that callback alone leaves a child egress
                // window; this second check is the final admission boundary
                // immediately before CreateProcess.
                if let Err(error) = budget.check() {
                    return Err(group.failure(
                        GroupNativeFailureKind::Setup,
                        activation_budget_error_detail(error),
                    ));
                }
            }
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return Err(group.failure(
                        GroupNativeFailureKind::Spawn,
                        format!("Capture runtime root could not be started: {error}"),
                    ));
                }
            };
            #[cfg(all(test, windows))]
            if budget.is_some() && expire_after_spawn_before_assignment {
                // Keep the real CreateProcess-to-assignment gap deterministic
                // for the cleanup regression. The child remains owned by this
                // local group through its exact Child handle while the same
                // activation budget expires, before any identity is assigned.
                // The test chooses an adequate absolute deadline; waiting on
                // that actual deadline avoids a scheduler-dependent 5 ms
                // sleep and never introduces a production timeout.
                let deadline = budget.expect("budgeted expiry hook").deadline();
                while std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
            if let Some(budget) = budget {
                if let Err(error) = budget.check() {
                    group.unacquired_root_nonces.pop_front();
                    group.roots.push(SuspendedGroupRoot {
                        child,
                        root_nonce,
                        identity: None,
                        ordinal: ordinal as u32,
                        state: SuspendedRootState::Unassigned,
                    });
                    return Err(group.failure(
                        GroupNativeFailureKind::Setup,
                        activation_budget_error_detail(error),
                    ));
                }
            }
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
            if let Some(budget) = budget {
                if let Err(error) = budget.check() {
                    return Err(group.failure(
                        GroupNativeFailureKind::Assignment,
                        activation_budget_error_detail(error),
                    ));
                }
            }
            if let Err(error) = group
                .job
                .as_mut()
                .expect("group Job")
                .assign(&group.roots[index].child)
            {
                return Err(group.failure(GroupNativeFailureKind::Assignment, error));
            }
            group.roots[index].state = SuspendedRootState::AssignedSuspended;
            if let Some(budget) = budget {
                if let Err(error) = budget.check() {
                    return Err(group.failure(
                        GroupNativeFailureKind::Membership,
                        activation_budget_error_detail(error),
                    ));
                }
            }
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

    pub(crate) fn failure(
        self,
        kind: GroupNativeFailureKind,
        detail: impl Into<String>,
    ) -> GroupNativeFailure {
        GroupNativeFailure::with_owner(kind, detail, self)
    }

    pub(crate) fn verify_all_assigned_suspended(&mut self) -> Result<(), String> {
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

    pub(crate) fn binding_snapshot(&mut self) -> Result<NativeBindingSnapshot, String> {
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
    pub(crate) fn validate_closing_binding(
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
            activation_failure_only: false,
        })
    }

    /// Stop and prove the exact retained Job while leaving this group in the
    /// owner.  A subsequent listener observation can therefore use the same
    /// root handles and cannot accidentally reacquire by PID.
    pub(crate) fn cleanup_and_retain_proof(
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

    pub(crate) fn cleanup_and_retain_proof_after_activation_failure(
        &mut self,
        deadline: std::time::Instant,
    ) -> Result<NativeCleanupProof, String> {
        if self.cleanup_complete {
            return self
                .retained_activation_cleanup_proof()
                .ok_or_else(|| "Capture runtime native cleanup proof was incomplete.".into());
        }
        let _proof = self.cleanup_inner_for_activation_failure(deadline)?;
        self.cleanup_complete = true;
        self.retained_activation_cleanup_proof()
            .ok_or_else(|| "Capture runtime native cleanup proof was incomplete.".into())
    }

    /// Project only the evidence needed to retain an activation-failure owner.
    /// Every retained Child has already been terminated and waited by
    /// `cleanup_inner_for_activation_failure`, and the Job has reported zero
    /// active processes. Unknown identities are intentionally omitted: this
    /// method never invents a creation identity or reacquires a PID.
    pub(crate) fn retained_activation_cleanup_proof(&mut self) -> Option<NativeCleanupProof> {
        if !self.cleanup_complete
            || self
                .job
                .as_ref()
                .and_then(|job| job.active_processes().ok())
                != Some(0)
            || self
                .roots
                .iter_mut()
                .any(|root| root.child.try_wait().ok().flatten().is_none())
        {
            return None;
        }
        let roots = self
            .roots
            .iter()
            .enumerate()
            .filter_map(|(index, root)| {
                Some(NativeCleanupRootProof {
                    ordinal: u32::try_from(index).ok()?,
                    root_nonce: root.root_nonce,
                    identity: root.identity?,
                })
            })
            .collect();
        Some(NativeCleanupProof {
            job_nonce: self.job_nonce,
            roots,
            activation_failure_only: true,
        })
    }

    pub(crate) fn retained_cleanup_proof(&self) -> Option<NativeCleanupProof> {
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
            activation_failure_only: false,
        })
    }

    pub(crate) fn verify_listener_roots(
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
    pub(crate) fn observe_root_listeners(
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
    pub(crate) fn observe_listener_release(
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
    pub(crate) fn observe_listener_release_for_closing(
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
    pub(crate) fn terminate_root_for_test(&mut self, ordinal: usize) -> Result<(), String> {
        let root = self
            .roots
            .get_mut(ordinal)
            .ok_or_else(|| format!("Runtime group root {ordinal} was not retained."))?;
        terminate_child_by_exact_handle(&mut root.child, PROCESS_WAIT_TIMEOUT_MS)
    }

    pub(crate) fn resume_all_with_cancellation(
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

    /// Resume the complete assigned group under the activation's one
    /// absolute budget.  A budget failure after an OS resume returns this
    /// same owner so the caller can close the whole Job; it never leaves a
    /// partial group as a successful result.
    pub(crate) fn resume_all_with_budget(
        mut self,
        budget: &ActivationBudget,
    ) -> Result<Self, GroupNativeFailure> {
        if let Err(error) = budget.check() {
            return Err(self.failure(
                GroupNativeFailureKind::Resume,
                activation_budget_error_detail(error),
            ));
        }
        if let Err(error) = self.verify_all_assigned_suspended() {
            return Err(self.failure(GroupNativeFailureKind::Membership, error));
        }
        for index in 0..self.roots.len() {
            if let Err(error) = budget.check() {
                return Err(self.failure(
                    GroupNativeFailureKind::Resume,
                    activation_budget_error_detail(error),
                ));
            }
            #[cfg(all(test, windows))]
            if CANCEL_BEFORE_RESUME_ROOT.with(|cancel_at| cancel_at.get() == Some(index)) {
                CANCEL_BEFORE_RESUME_ROOT.with(|cancel_at| cancel_at.set(None));
                // This test seam models cancellation arriving between two
                // root resumes, while the production budget remains the
                // sole authority for the check.
                budget.cancellation().store(true, Ordering::Release);
            }
            if let Err(error) = budget.check() {
                return Err(self.failure(
                    GroupNativeFailureKind::Resume,
                    activation_budget_error_detail(error),
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
            #[cfg(all(test, windows))]
            if CANCEL_AFTER_RESUME_ROOT.with(|cancel_at| cancel_at.get() == Some(index)) {
                CANCEL_AFTER_RESUME_ROOT.with(|cancel_at| cancel_at.set(None));
                budget.cancellation().store(true, Ordering::Release);
            }
            if let Err(error) = budget.check() {
                return Err(self.failure(
                    GroupNativeFailureKind::Resume,
                    activation_budget_error_detail(error),
                ));
            }
        }
        Ok(self)
    }

    pub(crate) fn cleanup_inner_with_budget(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<GroupCleanupProof, String> {
        self.cleanup_inner_with_budget_mode(deadline, cancellation, false)
    }

    /// Activation failure cleanup is intentionally different from a normal
    /// caller cancellation check: once an owned Job exists, request its
    /// termination even when cancellation or the absolute deadline has
    /// already fired.  The remaining waits and identity proofs stay bounded
    /// by that same deadline and any incomplete proof keeps this owner.
    pub(crate) fn cleanup_inner_for_activation_failure(
        &mut self,
        deadline: std::time::Instant,
    ) -> Result<GroupCleanupProof, String> {
        self.cleanup_inner_with_budget_mode(deadline, None, true)
    }

    pub(crate) fn cleanup_inner_with_budget_mode(
        &mut self,
        deadline: std::time::Instant,
        cancellation: Option<&AtomicBool>,
        force_job_termination: bool,
    ) -> Result<GroupCleanupProof, String> {
        let force_termination_error = if force_job_termination {
            // Keep the Job result separate from per-root cleanup. Exact Child
            // handles still have to be waited even when the native Job call
            // fails, but a zero active-process count alone must never be
            // treated as proof that the Job termination itself succeeded.
            self.job.as_mut().expect("group Job").terminate().err()
        } else {
            None
        };

        if force_job_termination {
            // A root created immediately before the budget check may still be
            // outside the Job and have no captured identity.  Start a kill
            // through every retained exact Child handle before consulting the
            // expired admission again.  The same deadline bounds each wait;
            // a failed proof keeps this owner for a later cleanup attempt.
            let mut first_error = None;
            for (index, root) in self.roots.iter_mut().enumerate() {
                #[cfg(not(test))]
                let _ = index;
                #[cfg(test)]
                if self.cleanup_failure_at == Some(index) {
                    self.cleanup_failure_at = None;
                    return Err("Injected suspended group cleanup failure.".into());
                }
                let result = if let Some(identity) = root.identity {
                    terminate_process_with_proof_with_timeout(
                        root.child.as_raw_handle() as *mut c_void,
                        identity,
                        remaining_timeout_ms(deadline),
                    )
                    .and_then(|_| {
                        reap_child_by_exact_handle(&mut root.child, remaining_timeout_ms(deadline))
                    })
                } else {
                    terminate_child_by_exact_handle(&mut root.child, remaining_timeout_ms(deadline))
                };
                if let Err(error) = result {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
            if let Some(error) = first_error {
                return Err(error);
            }
            if let Some(error) = force_termination_error {
                return Err(error);
            }
        }
        check_native_cleanup_budget(deadline, cancellation)?;
        #[cfg(test)]
        {
            self.cleanup_attempts = self.cleanup_attempts.saturating_add(1);
        }
        let job = self.job.as_mut().expect("group Job");
        // A zero active-process count proves only that no members remain in
        // the Job. It cannot prove that the required Job termination call
        // succeeded. Keep the owner and withhold all normal cleanup proof
        // when that native call fails; a fresh retry may then repeat the exact
        // Job and Child handle sequence.
        if !force_job_termination {
            job.terminate()?;
        }
        if !force_job_termination {
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
                    terminate_child_by_exact_handle(
                        &mut root.child,
                        remaining_timeout_ms(deadline),
                    )?;
                }
                #[cfg(test)]
                if self.cancel_after_cleanup_root == Some(index) {
                    self.cancel_after_cleanup_root = None;
                    if let Some(cancellation) = cancellation {
                        cancellation.store(true, Ordering::Release);
                    }
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

    #[cfg(test)]
    pub(crate) fn inject_cleanup_failure_after_first_for_test(&mut self) {
        self.cleanup_failure_at = Some(1);
    }

    #[cfg(all(test, windows))]
    pub(crate) fn inject_job_termination_failure_for_test(&mut self) {
        self.job
            .as_mut()
            .expect("group Job")
            .inject_termination_failure();
    }

    #[cfg(test)]
    pub(crate) fn inject_cancellation_after_cleanup_root_for_test(&mut self, ordinal: usize) {
        self.cancel_after_cleanup_root = Some(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn inject_resume_failure_at_for_test(&mut self, ordinal: usize) {
        self.job.as_mut().expect("group Job").resume_failure_at = Some(ordinal);
    }

    #[cfg(test)]
    pub(crate) fn inject_membership_failure_for_test(&mut self) {
        let job = self.job.as_mut().expect("group Job");
        job.membership_failure_at = Some(job.membership_attempts);
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_query_failure_for_test(&mut self) {
        self.listener_query_failure = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_identity_mutation_after_first_for_test(&mut self) {
        self.listener_identity_mutation_after_first = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_listener_identity_mutation_at_last_observation_for_test(&mut self) {
        self.listener_identity_mutation_at_last = true;
    }

    #[cfg(test)]
    pub(crate) fn inject_root_exit_after_first_for_test(&mut self) {
        self.root_exit_after_first = true;
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
