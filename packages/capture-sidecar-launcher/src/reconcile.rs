//! Producer-owned restart lookup foundation.
//!
//! This module owns the producer restart read/observation seam. It does not
//! mutate a journal, perform cleanup, adopt native resources, or call restart
//! reconciliation transitions. Native/listener observations remain point-in-
//! time facts for a later producer-owned transition with staging evidence.

#![allow(dead_code)]

use std::path::PathBuf;

use crate::{index::reopen_from_ref, prepare::ReconcileRef};

#[cfg(windows)]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[cfg(windows)]
use crate::{
    index::AddressIndexError,
    journal::{CasSnapshot, JournalPlanValue, RuntimeSessionJournalV1},
    journal_store::{install_running_read_budget, JournalStoreError},
    process::{observe_restart_native, RestartNativeObservationError},
};

/// A sanitized reason for why a restarted record cannot yet be reported as a
/// completed terminal record. It intentionally contains no filesystem path,
/// native identifier, or storage diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartJournalReason {
    ActiveRecord,
    InvalidReference,
    RecordUnavailable,
    InvalidRecord,
}

/// Read-only semantic status from the producer restart lookup seam.
///
/// `TerminalRecord` reports only a previously committed, fully validated
/// terminal value. It is not a newly observed cleanup proof. Every other
/// status remains blocked until the later observe-only reconciliation seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartJournalStatus {
    TerminalRecord,
    ReconcileRequired { reason: RestartJournalReason },
}

/// Sanitized result of the read-only native/listener restart observer.  It is
/// deliberately separate from `RestartJournalStatus`: this observation has no
/// journal transition authority and cannot claim terminal cleanup.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartNativeObservationReason {
    InvalidReference,
    RecordUnavailable,
    InvalidRecord,
    MissingNativeIdentity,
    InvalidState,
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

/// A complete point-in-time absence observation retained with the exact
/// reopened journal and plan.  The private fields prevent a caller from
/// constructing a terminal or cleanup proof by hand; later lifecycle code
/// must still revalidate this snapshot before any CAS or resource action.
#[cfg(windows)]
pub(crate) struct RestartNativeAbsenceObservation {
    plan: JournalPlanValue,
    journal: RuntimeSessionJournalV1,
    snapshot: CasSnapshot,
}

#[cfg(windows)]
impl RestartNativeAbsenceObservation {
    pub(crate) fn plan(&self) -> &JournalPlanValue {
        &self.plan
    }

    pub(crate) fn journal(&self) -> &RuntimeSessionJournalV1 {
        &self.journal
    }

    pub(crate) fn snapshot(&self) -> &CasSnapshot {
        &self.snapshot
    }
}

/// Read-only native/listener restart observation.  `CompleteAbsence` is only
/// an observation of the exact recorded roots and ports; it is not a terminal
/// proof and never deletes, adopts, or mutates a resource.
#[cfg(windows)]
pub(crate) enum RestartNativeObservationStatus {
    CompleteAbsence(RestartNativeAbsenceObservation),
    Unknown {
        reason: RestartNativeObservationReason,
    },
}

/// The producer-owned context needed to resolve an opaque reference after a
/// restart. The constructor remains crate-private so a caller cannot select
/// an arbitrary root and turn it into cleanup authority.
pub(crate) struct ProducerJournalContext {
    producer_root: PathBuf,
}

impl ProducerJournalContext {
    pub(crate) fn from_configured_root(producer_root: PathBuf) -> Self {
        Self { producer_root }
    }
}

/// Read-only restart lookup. This is intentionally named as a lookup rather
/// than reconciliation: `read_status` performs no native/staging observation
/// and no journal CAS, so it cannot claim a completed reconciliation.
pub(crate) struct RestartJournalLookup {
    context: ProducerJournalContext,
}

impl RestartJournalLookup {
    pub(crate) fn new(context: ProducerJournalContext) -> Self {
        Self { context }
    }

    pub(crate) fn read_status(&self, reference: &ReconcileRef) -> RestartJournalStatus {
        let reopened = match reopen_from_ref(self.context.producer_root.clone(), reference.as_str())
        {
            Ok(reopened) => reopened,
            Err(error) => return Self::map_error(error),
        };

        // `reopen_from_ref` has already decoded and validated the complete
        // index, reconstructed the complete plan, and read the journal under
        // the store's lock. Keep this explicit guard at the semantic seam so
        // a future index implementation cannot turn an unvalidated terminal
        // value into a terminal result.
        if reopened
            .journal
            .validate_against_plan(&reopened.plan)
            .is_err()
        {
            return RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::InvalidRecord,
            };
        }

        if matches!(
            reopened.journal.state,
            crate::journal::JournalState::Terminal
        ) {
            RestartJournalStatus::TerminalRecord
        } else {
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        }
    }

    /// Perform the producer-owned, observe-only native/listener check for a
    /// reopened resource-bearing record.  The read budget is installed before
    /// reopening so both the immutable index lock and journal lock share the
    /// caller's absolute deadline; this method performs no CAS or cleanup.
    #[cfg(windows)]
    pub(crate) fn observe_native(
        &self,
        reference: &ReconcileRef,
        deadline: Instant,
        cancellation: Arc<AtomicBool>,
    ) -> RestartNativeObservationStatus {
        if cancellation.load(Ordering::Acquire) {
            return RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::Cancelled,
            };
        }
        if Instant::now() >= deadline {
            return RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::Deadline,
            };
        }

        let _budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
        let reopened = match reopen_from_ref(self.context.producer_root.clone(), reference.as_str())
        {
            Ok(reopened) => reopened,
            Err(error) => return Self::map_native_reopen_error(error),
        };

        if Instant::now() >= deadline {
            return RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::Deadline,
            };
        }
        let journal = reopened.journal;
        let plan = reopened.plan;
        if journal.validate_against_plan(&plan).is_err() {
            return RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::InvalidRecord,
            };
        }
        if let Err(error) = observe_restart_native(&journal, &plan, deadline, &cancellation) {
            return RestartNativeObservationStatus::Unknown {
                reason: Self::map_native_observation_error(error),
            };
        }
        if cancellation.load(Ordering::Acquire) {
            return RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::Cancelled,
            };
        }
        if Instant::now() >= deadline {
            return RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::Deadline,
            };
        }
        let snapshot = journal.cas_snapshot();
        RestartNativeObservationStatus::CompleteAbsence(RestartNativeAbsenceObservation {
            plan,
            journal,
            snapshot,
        })
    }

    #[cfg(windows)]
    fn map_native_reopen_error(error: AddressIndexError) -> RestartNativeObservationStatus {
        let reason = match error {
            AddressIndexError::InvalidReference => RestartNativeObservationReason::InvalidReference,
            AddressIndexError::InvalidRecord
            | AddressIndexError::ReferenceMismatch
            | AddressIndexError::PlanMismatch => RestartNativeObservationReason::InvalidRecord,
            AddressIndexError::Storage(JournalStoreError::NotFound)
            | AddressIndexError::Storage(JournalStoreError::InvalidConfig)
            | AddressIndexError::Storage(JournalStoreError::PathSecurity) => {
                RestartNativeObservationReason::RecordUnavailable
            }
            AddressIndexError::Storage(JournalStoreError::AdmissionCancelled) => {
                RestartNativeObservationReason::Cancelled
            }
            AddressIndexError::Storage(JournalStoreError::AdmissionDeadline) => {
                RestartNativeObservationReason::Deadline
            }
            AddressIndexError::Storage(_) => RestartNativeObservationReason::InvalidRecord,
        };
        RestartNativeObservationStatus::Unknown { reason }
    }

    #[cfg(windows)]
    fn map_native_observation_error(
        error: RestartNativeObservationError,
    ) -> RestartNativeObservationReason {
        match error {
            RestartNativeObservationError::MissingNativeIdentity => {
                RestartNativeObservationReason::MissingNativeIdentity
            }
            RestartNativeObservationError::InvalidState => {
                RestartNativeObservationReason::InvalidState
            }
            RestartNativeObservationError::InvalidRecord => {
                RestartNativeObservationReason::InvalidRecord
            }
            RestartNativeObservationError::RootPresent => {
                RestartNativeObservationReason::RootPresent
            }
            RestartNativeObservationError::RootReused => RestartNativeObservationReason::RootReused,
            RestartNativeObservationError::RootAccessDenied => {
                RestartNativeObservationReason::RootAccessDenied
            }
            RestartNativeObservationError::RootUnqueryable => {
                RestartNativeObservationReason::RootUnqueryable
            }
            RestartNativeObservationError::ListenerPresent => {
                RestartNativeObservationReason::ListenerPresent
            }
            RestartNativeObservationError::ListenerAmbiguous => {
                RestartNativeObservationReason::ListenerAmbiguous
            }
            RestartNativeObservationError::ListenerQuery => {
                RestartNativeObservationReason::ListenerQuery
            }
            RestartNativeObservationError::Cancelled => RestartNativeObservationReason::Cancelled,
            RestartNativeObservationError::Deadline => RestartNativeObservationReason::Deadline,
        }
    }

    fn map_error(error: crate::index::AddressIndexError) -> RestartJournalStatus {
        use crate::{index::AddressIndexError, journal_store::JournalStoreError};

        let reason = match error {
            AddressIndexError::InvalidReference => RestartJournalReason::InvalidReference,
            AddressIndexError::InvalidRecord | AddressIndexError::ReferenceMismatch => {
                RestartJournalReason::InvalidRecord
            }
            AddressIndexError::PlanMismatch => RestartJournalReason::InvalidRecord,
            AddressIndexError::Storage(
                JournalStoreError::NotFound
                | JournalStoreError::InvalidConfig
                | JournalStoreError::PathSecurity,
            ) => RestartJournalReason::RecordUnavailable,
            AddressIndexError::Storage(_) => RestartJournalReason::InvalidRecord,
        };
        RestartJournalStatus::ReconcileRequired { reason }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::{atomic::AtomicBool, Arc, Mutex},
        time::{Duration, Instant},
    };

    use std::os::windows::process::CommandExt;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{
            GetProcessTimes, OpenProcess, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };

    use tempfile::{tempdir, TempDir};

    use super::*;
    use crate::{
        index::{persist_address_index, ReconcileAddressIndexV1},
        journal::{
            CreationIdentity, JobBinding, JobSetupState, JournalPlanValue, JournalRoot,
            JournalState, RootState, RuntimeSessionJournalV1, StagingBinding,
        },
        journal_store::JournalStore,
        prepare::{build_immutable_group_plan, PreparePlanDraft, PrepareRootDraft},
        prepare::{
            BindingAttemptId, CompleteGroupBinding, CompleteGroupBindingReceiptV1, PersistError,
            ReconcileRefSink, VerifiedGroupBinding,
        },
    };

    const SPEC_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Default)]
    struct TestSink {
        binding: Mutex<Option<CompleteGroupBinding>>,
    }

    impl ReconcileRefSink for TestSink {
        fn persist(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            binding: &CompleteGroupBinding,
        ) -> Result<(), PersistError> {
            *self.binding.lock().expect("sink lock") =
                Some(CompleteGroupBinding::decode(&binding.encode()?)?);
            Ok(())
        }

        fn read_back(
            &self,
            _binding_attempt_id: &BindingAttemptId,
        ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
            CompleteGroupBindingReceiptV1::from_binding(
                self.binding
                    .lock()
                    .expect("sink lock")
                    .clone()
                    .ok_or(PersistError::Storage)?,
            )
        }

        fn verify(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            _expected: &CompleteGroupBinding,
            read_back: &CompleteGroupBindingReceiptV1,
        ) -> Result<VerifiedGroupBinding, PersistError> {
            VerifiedGroupBinding::from_receipt(read_back.clone())
        }
    }

    struct Fixture {
        directory: TempDir,
        group_ref: ReconcileRef,
        root_refs: Vec<ReconcileRef>,
        plan: JournalPlanValue,
        store: std::sync::Arc<JournalStore>,
        retained_roots: Vec<RestartObservationChild>,
    }

    fn fixture(root_count: usize) -> Fixture {
        let directory = tempdir().expect("fixture directory");
        let roots = (0..root_count)
            .map(|ordinal| PrepareRootDraft {
                ordinal: ordinal as u32,
                role: format!("root-{ordinal}"),
                root_generation: ordinal as u64 + 1,
                spec_digest: SPEC_DIGEST.into(),
                reserved_listener_identity: format!("listener-{ordinal}"),
            })
            .collect();
        let plan = build_immutable_group_plan(
            PreparePlanDraft {
                group_generation: 1,
                roots,
            },
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("immutable plan");
        let group_ref = plan.context.group_ref_for_test();
        let root_refs = plan.context.root_refs_for_test();
        let journal = RuntimeSessionJournalV1::planned(
            &plan.value,
            plan.context.session_nonce.clone(),
            "2026-01-01T00:00:00Z".into(),
        )
        .expect("planned journal");
        plan.context
            .store
            .create_initial(&plan.value, &journal)
            .expect("initial journal");
        let root_ref_values = root_refs
            .iter()
            .map(|root_ref| root_ref.as_str().to_owned())
            .collect::<Vec<_>>();
        let index = ReconcileAddressIndexV1::from_plan(
            &plan.value,
            plan.context.session_nonce.clone(),
            group_ref.as_str().into(),
            &root_ref_values,
        )
        .expect("address index");
        persist_address_index(&plan.context.store, &index).expect("persist index");

        Fixture {
            directory,
            group_ref,
            root_refs,
            plan: plan.value,
            store: plan.context.store.clone(),
            retained_roots: Vec::new(),
        }
    }

    fn lookup(directory: &Path) -> RestartJournalLookup {
        RestartJournalLookup::new(ProducerJournalContext::from_configured_root(
            directory.to_path_buf(),
        ))
    }

    fn journal_path(directory: &Path) -> PathBuf {
        directory
            .read_dir()
            .expect("directory")
            .map(|entry| entry.expect("entry").path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("runtime-session-") && name.ends_with(".json")
                    })
            })
            .expect("journal path")
    }

    fn mutate_journal(directory: &Path, mutation: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let path = journal_path(directory);
        let original = fs::read(&path).expect("journal bytes");
        let mut value: serde_json::Value = serde_json::from_slice(&original).expect("journal json");
        mutation(&mut value);
        let bytes = serde_json::to_vec(&value).expect("journal bytes");
        fs::write(path, &bytes).expect("write journal fixture");
        bytes
    }

    struct RestartObservationChild {
        child: Option<Child>,
        pid: u32,
        creation_time: u64,
        reaped: bool,
    }

    impl RestartObservationChild {
        fn spawn() -> Result<Self, String> {
            let executable = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or_else(|| "SystemRoot was unavailable for the restart fixture.".to_owned())?
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            let mut command = Command::new(executable);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 2",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);
            let child = command
                .spawn()
                .map_err(|error| format!("restart fixture child could not start: {error}"))?;
            let pid = child.id();
            let mut owned = Self {
                child: Some(child),
                pid,
                creation_time: 0,
                reaped: false,
            };
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                return Err(format!(
                    "restart fixture child identity could not be opened: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            let result = unsafe {
                GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
            };
            unsafe {
                CloseHandle(handle);
            }
            if result == 0 {
                return Err(format!(
                    "restart fixture child creation identity could not be read: {}",
                    std::io::Error::last_os_error()
                ));
            }
            owned.creation_time =
                (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
            if owned.creation_time == 0 {
                return Err("restart fixture child creation identity was zero.".into());
            }
            Ok(owned)
        }

        fn wait(&mut self) {
            if self.reaped {
                return;
            }
            self.child
                .as_mut()
                .expect("restart fixture child")
                .wait()
                .expect("restart fixture child reap");
            self.reaped = true;
        }
    }

    impl Drop for RestartObservationChild {
        fn drop(&mut self) {
            let Some(child) = self.child.as_mut() else {
                return;
            };
            if !self.reaped {
                let running = child.try_wait().ok().flatten().is_none();
                if running {
                    let _ = child.kill();
                }
                let _ = child.wait();
                self.reaped = true;
            }
        }
    }

    fn reserve_free_loopback_ports(count: usize) -> Vec<u16> {
        let listeners = (0..count)
            .map(|_| {
                std::net::TcpListener::bind(("127.0.0.1", 0)).expect("reserved free loopback port")
            })
            .collect::<Vec<_>>();
        let ports = listeners
            .iter()
            .map(|listener| listener.local_addr().expect("reserved address").port())
            .collect::<Vec<_>>();
        let mut distinct = ports.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(
            distinct.len(),
            count,
            "reserved root ports must be distinct"
        );
        drop(listeners);
        ports
    }

    fn prepared_running_fixture(root_count: usize) -> Fixture {
        let directory = tempdir().expect("fixture directory");
        let roots = (0..root_count)
            .map(|ordinal| PrepareRootDraft {
                ordinal: ordinal as u32,
                role: format!("root-{ordinal}"),
                root_generation: ordinal as u64 + 1,
                spec_digest: SPEC_DIGEST.into(),
                reserved_listener_identity: format!("listener-{ordinal}"),
            })
            .collect();
        let plan = build_immutable_group_plan(
            PreparePlanDraft {
                group_generation: 1,
                roots,
            },
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("immutable plan");
        let group_ref = plan.context.group_ref_for_test();
        let sink = TestSink::default();
        crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let mut retained_roots = (0..root_count)
            .map(|_| RestartObservationChild::spawn().expect("restart fixture root"))
            .collect::<Vec<_>>();
        retained_roots
            .iter_mut()
            .for_each(RestartObservationChild::wait);
        let ports = reserve_free_loopback_ports(root_count);
        let mut journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("prepared journal");
        journal.state = JournalState::Running;
        journal.job_binding = Some(JobBinding {
            setup_state: JobSetupState::Committed,
            job_nonce: "job-nonce".into(),
        });
        journal.staging_binding = Some(StagingBinding {
            run_nonce: "run-nonce".into(),
            root_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            scope: "run".into(),
        });
        journal.roots = plan
            .value
            .roots
            .iter()
            .enumerate()
            .map(|(ordinal, planned)| JournalRoot {
                ordinal: ordinal as u32,
                role: planned.role.clone(),
                root_ref_digest: planned.root_ref_digest.clone(),
                root_generation: planned.root_generation,
                root_nonce: format!("root-nonce-{ordinal}"),
                pid: retained_roots[ordinal].pid,
                creation_identity: CreationIdentity {
                    kind: "windows-process-creation".into(),
                    value: format!("{:016x}", retained_roots[ordinal].creation_time),
                },
                state: RootState::Running,
                reserved_listener_identity: planned.reserved_listener_identity.clone(),
                loopback_port: ports[ordinal],
                live_listener_readiness: Some(format!("readiness-{ordinal}")),
                started_at: "2026-01-01T00:00:00Z".into(),
            })
            .collect();
        let journal_bytes = journal.encode_private().expect("running journal bytes");
        fs::write(journal_path(directory.path()), journal_bytes).expect("running journal fixture");
        let root_refs = plan.context.root_refs_for_test().into_iter().collect();
        Fixture {
            directory,
            group_ref,
            root_refs,
            plan: plan.value,
            store: plan.context.store.clone(),
            retained_roots,
        }
    }

    #[test]
    fn lookup_reopens_from_new_context_without_the_plan_address_map() {
        let fixture = fixture(2);
        let first = lookup(fixture.directory.path());
        assert_eq!(
            first.read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
        drop(first);

        let second = lookup(fixture.directory.path());
        assert_eq!(
            second.read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
        for root_ref in &fixture.root_refs {
            assert_eq!(
                second.read_status(root_ref),
                RestartJournalStatus::ReconcileRequired {
                    reason: RestartJournalReason::ActiveRecord,
                }
            );
        }
    }

    #[test]
    fn lookup_can_run_in_a_fresh_process_without_native_or_journal_mutation() {
        let fixture = fixture(1);
        let child = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg("reconcile::tests::fresh_process_child_lookup")
            .arg("--nocapture")
            .env("CAPTURE_RECONCILE_TEST_ROOT", fixture.directory.path())
            .env("CAPTURE_RECONCILE_TEST_REF", fixture.group_ref.as_str())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("fresh lookup child");
        assert!(child.success());
        assert_eq!(
            lookup(fixture.directory.path()).read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
    }

    #[test]
    fn fresh_process_child_lookup() {
        let Ok(root) = std::env::var("CAPTURE_RECONCILE_TEST_ROOT") else {
            return;
        };
        let reference = std::env::var("CAPTURE_RECONCILE_TEST_REF").expect("opaque ref");
        let status = lookup(Path::new(&root)).read_status(&ReconcileRef::from_test(reference));
        assert_eq!(
            status,
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
    }

    #[test]
    fn terminal_record_is_reported_only_after_strict_plan_bound_validation() {
        let fixture = fixture(1);
        let valid_bytes = mutate_journal(fixture.directory.path(), |record| {
            record["state"] = serde_json::json!("terminal");
            record["journalRevision"] = serde_json::json!(1);
            record["updatedAt"] = serde_json::json!("2026-01-01T00:00:01Z");
            record["proof"] = serde_json::json!({
                "rootReaped": true,
                "descendantsTerminated": true,
                "listenersReleased": true,
                "stagingReleased": true,
                "proofGeneration": 1,
                "unacquiredRootBindings": [],
            });
        });
        assert_eq!(
            lookup(fixture.directory.path()).read_status(&fixture.group_ref),
            RestartJournalStatus::TerminalRecord
        );

        let invalid_bytes = mutate_journal(fixture.directory.path(), |record| {
            record["proof"]["rootReaped"] = serde_json::json!(false);
        });
        assert_eq!(
            lookup(fixture.directory.path()).read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::InvalidRecord,
            }
        );
        assert_ne!(invalid_bytes, valid_bytes);
        let path = journal_path(fixture.directory.path());
        assert_eq!(
            fs::read(path).expect("unchanged invalid record"),
            invalid_bytes
        );
    }

    #[test]
    fn unknown_foreign_and_torn_records_are_sanitized_and_untouched() {
        let primary = fixture(2);
        let foreign = fixture(1);
        assert_eq!(
            lookup(primary.directory.path()).read_status(&foreign.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::RecordUnavailable,
            }
        );
        assert_eq!(
            lookup(tempdir().expect("wrong root").path()).read_status(&primary.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::RecordUnavailable,
            }
        );

        let path = journal_path(primary.directory.path());
        let original = fs::read(&path).expect("journal");
        fs::write(&path, br#"{"schemaVersion":"RuntimeSessionJournalV1"}"#).expect("torn journal");
        assert_eq!(
            lookup(primary.directory.path()).read_status(&primary.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::InvalidRecord,
            }
        );
        assert_eq!(
            fs::read(&path).expect("torn bytes retained"),
            br#"{"schemaVersion":"RuntimeSessionJournalV1"}"#
        );
        fs::write(&path, original).expect("restore fixture");
    }

    #[test]
    fn prepared_state_is_never_reopened_as_an_activation_permit() {
        let directory = tempdir().expect("fixture directory");
        let plan = build_immutable_group_plan(
            PreparePlanDraft {
                group_generation: 1,
                roots: vec![PrepareRootDraft {
                    ordinal: 0,
                    role: "root-0".into(),
                    root_generation: 1,
                    spec_digest: SPEC_DIGEST.into(),
                    reserved_listener_identity: "listener-0".into(),
                }],
            },
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("immutable plan");
        let group_ref = plan.context.group_ref_for_test();
        let sink = TestSink::default();
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared value");
        drop(prepared);

        let status = lookup(directory.path()).read_status(&group_ref);
        assert!(matches!(
            status,
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord
            }
        ));
        assert_eq!(plan.value.roots.len(), 1);
        assert_eq!(
            plan.context.store.read(&plan.value).unwrap().state,
            JournalState::PreparedBound
        );
    }

    #[test]
    fn native_restart_observation_rejects_planned_without_querying_native_state() {
        let fixture = fixture(1);
        let cancellation = Arc::new(AtomicBool::new(false));
        let status = lookup(fixture.directory.path()).observe_native(
            &fixture.group_ref,
            Instant::now() + Duration::from_secs(5),
            cancellation,
        );
        assert!(matches!(
            status,
            RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::MissingNativeIdentity
            }
        ));
        assert_eq!(
            fixture.store.read(&fixture.plan).unwrap().state,
            JournalState::PlannedUnbound
        );
    }

    #[test]
    fn native_restart_observation_rejects_zero_creation_before_native_query() {
        let fixture = prepared_running_fixture(1);
        let mut journal = fixture.store.read(&fixture.plan).expect("running journal");
        journal.roots[0].creation_identity.value = "0000000000000000".into();
        fs::write(
            journal_path(fixture.directory.path()),
            journal.encode_private().expect("zero identity journal"),
        )
        .expect("zero identity journal write");

        assert!(matches!(
            lookup(fixture.directory.path()).observe_native(
                &fixture.group_ref,
                Instant::now() + Duration::from_secs(5),
                Arc::new(AtomicBool::new(false)),
            ),
            RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::InvalidRecord
            }
        ));
    }

    #[test]
    fn cancelled_native_restart_observation_is_bounded_before_reopen() {
        let fixture = fixture(1);
        let cancellation = Arc::new(AtomicBool::new(true));
        let status = lookup(fixture.directory.path()).observe_native(
            &fixture.group_ref,
            Instant::now() + Duration::from_secs(5),
            cancellation,
        );
        assert!(matches!(
            status,
            RestartNativeObservationStatus::Unknown {
                reason: RestartNativeObservationReason::Cancelled
            }
        ));
    }

    #[test]
    fn native_restart_observation_retains_complete_absence_snapshot_for_each_root() {
        let fixture = prepared_running_fixture(2);
        let status = lookup(fixture.directory.path()).observe_native(
            &fixture.group_ref,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        );
        let RestartNativeObservationStatus::CompleteAbsence(observation) = status else {
            panic!("complete absence observation");
        };
        assert_eq!(observation.plan(), &fixture.plan);
        assert_eq!(observation.journal().state, JournalState::Running);
        assert_eq!(observation.journal().roots.len(), 2);
        assert_eq!(
            observation.snapshot(),
            &observation.journal().cas_snapshot()
        );
        assert_eq!(
            fs::read(journal_path(fixture.directory.path())).expect("journal bytes"),
            observation
                .journal()
                .encode_private()
                .expect("journal encoding")
        );
    }
}
