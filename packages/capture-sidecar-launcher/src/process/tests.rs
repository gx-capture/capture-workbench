#![allow(unused_imports)]

use std::{
    cell::Cell,
    collections::{HashMap, HashSet, VecDeque},
    ffi::{c_void, OsString},
    fmt, fs, io,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{channel, sync_channel, Receiver, SyncSender},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::{ffi::OsStringExt, io::AsRawHandle, process::CommandExt};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::*, NetworkManagement::IpHelper::*, System::Diagnostics::ToolHelp::*,
    System::JobObjects::*, System::Threading::*,
};

#[cfg(windows)]
use super::activation::*;
use super::error::*;
#[cfg(windows)]
use super::fixture::*;
#[cfg(windows)]
use super::listener::*;
use super::native::*;
use super::session::*;
use super::sidecar_process::*;
use super::*;
use sha2::{Digest, Sha256};

use crate::{
    health::*, journal::*, journal_store::*, prepare::*, staging::*, GroupRootPlanInput,
    OwnedRuntimeSession, SidecarLaunchSpec, SidecarManifest,
};

const FIXTURE_EVENTUAL_WAIT: Duration = Duration::from_secs(60);

#[cfg(windows)]
struct CoordinatorSink {
    binding: Mutex<Option<CompleteGroupBinding>>,
}

#[cfg(windows)]
impl ReconcileRefSink for CoordinatorSink {
    fn persist(
        &self,
        _binding_attempt_id: &BindingAttemptId,
        binding: &CompleteGroupBinding,
    ) -> Result<(), PersistError> {
        *self.binding.lock().unwrap() = Some(binding.clone());
        Ok(())
    }

    fn read_back(
        &self,
        _binding_attempt_id: &BindingAttemptId,
    ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
        CompleteGroupBindingReceiptV1::from_binding(
            self.binding
                .lock()
                .unwrap()
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

#[cfg(windows)]
struct CoordinatorActivationFixture {
    admission: ScheduledFixtureAdmission,
    _directory: tempfile::TempDir,
    plan: ImmutableGroupPlan,
}

#[cfg(windows)]
impl CoordinatorActivationFixture {
    fn new() -> Self {
        let permit = http_fixture_limiter()
            .acquire(Duration::from_secs(120))
            .expect("bounded fixture scheduling admission");
        let directory = tempfile::tempdir().expect("coordinator fixture directory");
        let producer_root = directory.path().join("producer-root");
        fs::create_dir(&producer_root).expect("producer root");
        let executable_path = producer_root.join("capture-runtime.exe");
        fs::copy(
            std::env::current_exe().expect("test executable"),
            &executable_path,
        )
        .expect("executable fixture");
        let executable_bytes = fs::read(&executable_path).expect("executable bytes");
        let schema_bytes = include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json"
            ));
        fs::write(
            producer_root.join(crate::health::R3_SCHEMA_FILE_NAME),
            schema_bytes,
        )
        .expect("canonical schema fixture");
        let manifest = SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: executable_bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&executable_bytes)),
            schema_file_name: crate::health::R3_SCHEMA_FILE_NAME.into(),
            schema_sha256: crate::health::CANONICAL_CAPTURE_DOCUMENT_V2_SHA256.into(),
        };
        let manifest_path = producer_root.join("capture-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest JSON"),
        )
        .expect("manifest fixture");
        let plan = crate::build_immutable_group_plan(
            producer_root,
            1,
            vec![GroupRootPlanInput::new(
                "capture".into(),
                1,
                SidecarLaunchSpec::new(
                    executable_path,
                    42127,
                    "coordinator-test-token".into(),
                    vec![("CAPTURE_API_TOKEN".into(), "coordinator-test-token".into())],
                    Vec::new(),
                ),
                manifest_path,
            )],
        )
        .expect("immutable activation plan");
        let admission = ScheduledFixtureAdmission::new(&plan.context.store, permit);
        Self {
            admission,
            _directory: directory,
            plan,
        }
    }

    fn prepare(self) -> (Self, crate::prepare::PreparedGroup) {
        let sink = CoordinatorSink {
            binding: Mutex::new(None),
        };
        let prepared = OwnedRuntimeSession::prepare_group(&self.plan, &sink)
            .expect("prepared activation group");
        (self, prepared)
    }
}

#[cfg(windows)]
struct CoordinatorHttpFixture {
    _admission: ScheduledFixtureAdmission,
    _directory: tempfile::TempDir,
    producer_root: PathBuf,
    plan: ImmutableGroupPlan,
    marker_paths: Vec<PathBuf>,
    checkpoint_paths: Vec<PathBuf>,
    listener_checkpoint_paths: Vec<PathBuf>,
}

#[cfg(windows)]
impl CoordinatorHttpFixture {
    fn new(ports: &[u16], modes: &[&str]) -> Self {
        assert_eq!(ports.len(), modes.len());
        assert!(!ports.is_empty());
        let permit = http_fixture_limiter()
            .acquire(Duration::from_secs(120))
            .expect("bounded fixture scheduling admission");
        let directory = tempfile::tempdir().expect("coordinator HTTP fixture directory");
        let producer_root = directory.path().join("producer-root");
        fs::create_dir(&producer_root).expect("producer root");
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("activation-probe")
            .join("target")
            .join("debug")
            .join("capture-activation-probe.exe");
        assert!(
            source.is_file(),
            "activation probe must be built by cargo-fixture-build: {}",
            source.display()
        );
        let executable_path = producer_root.join("capture-runtime.exe");
        fs::copy(&source, &executable_path).expect("copy activation probe fixture");
        let executable_bytes = fs::read(&executable_path).expect("fixture bytes");
        let release_directory = producer_root.join("release");
        fs::create_dir(&release_directory).expect("readiness release directory");
        let schema_path = release_directory.join(crate::health::R3_SCHEMA_FILE_NAME);
        let schema_bytes = include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json"
            ));
        fs::write(&schema_path, schema_bytes).expect("canonical readiness schema");
        let manifest = SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: executable_bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&executable_bytes)),
            schema_file_name: crate::health::R3_SCHEMA_FILE_NAME.into(),
            schema_sha256: crate::health::CANONICAL_CAPTURE_DOCUMENT_V2_SHA256.into(),
        };
        let manifest_path = release_directory.join("capture-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest JSON"),
        )
        .expect("manifest fixture");
        let journal_path = producer_root
            .to_str()
            .expect("producer root is UTF-8")
            .to_owned();
        let token = "coordinator-http-token-012345678901234567890123456789";
        let marker_paths = ports
            .iter()
            .enumerate()
            .map(|(ordinal, _)| producer_root.join(format!("activation-http-{ordinal}.marker")))
            .collect::<Vec<_>>();
        let checkpoint_paths = ports
            .iter()
            .enumerate()
            .map(|(ordinal, _)| producer_root.join(format!("activation-http-{ordinal}.checkpoint")))
            .collect::<Vec<_>>();
        let listener_checkpoint_paths = ports
            .iter()
            .enumerate()
            .map(|(ordinal, _)| {
                producer_root.join(format!("activation-http-{ordinal}.listener-checkpoint"))
            })
            .collect::<Vec<_>>();
        let roots = ports
            .iter()
            .enumerate()
            .map(|(ordinal, port)| {
                let marker_path = marker_paths[ordinal]
                    .to_str()
                    .expect("marker path is UTF-8")
                    .to_owned();
                let checkpoint_path = checkpoint_paths[ordinal]
                    .to_str()
                    .expect("HTTP checkpoint path is UTF-8")
                    .to_owned();
                let listener_checkpoint_path = listener_checkpoint_paths[ordinal]
                    .to_str()
                    .expect("HTTP listener checkpoint path is UTF-8")
                    .to_owned();
                GroupRootPlanInput::new(
                    if ordinal == 0 {
                        "capture".into()
                    } else {
                        format!("worker-{ordinal}")
                    },
                    ordinal as u64 + 1,
                    SidecarLaunchSpec::new(
                        executable_path.clone(),
                        *port,
                        token.into(),
                        vec![
                            ("CAPTURE_API_TOKEN".into(), token.into()),
                            ("CAPTURE_TEST_JOURNAL_PATH".into(), journal_path.clone()),
                            ("CAPTURE_TEST_MARKER_PATH".into(), marker_path),
                            ("CAPTURE_TEST_HTTP_CHECKPOINT_PATH".into(), checkpoint_path),
                            (
                                "CAPTURE_TEST_HTTP_LISTENER_CHECKPOINT_PATH".into(),
                                listener_checkpoint_path,
                            ),
                            ("CAPTURE_TEST_ROOT_ORDINAL".into(), ordinal.to_string()),
                            (
                                "CAPTURE_TEST_HTTP_MODE".into(),
                                if modes[ordinal] == "ready" {
                                    "ready-hold"
                                } else {
                                    modes[ordinal]
                                }
                                .into(),
                            ),
                        ],
                        vec!["SystemRoot".into()],
                    ),
                    manifest_path.clone(),
                )
            })
            .collect();
        let plan = crate::build_immutable_group_plan(producer_root.clone(), 1, roots)
            .expect("immutable HTTP activation plan");
        let admission = ScheduledFixtureAdmission::new(&plan.context.store, permit);
        Self {
            _admission: admission,
            _directory: directory,
            producer_root,
            plan,
            marker_paths,
            checkpoint_paths,
            listener_checkpoint_paths,
        }
    }

    fn prepare(self) -> (Self, crate::prepare::PreparedGroup) {
        let sink = CoordinatorSink {
            binding: Mutex::new(None),
        };
        let prepared = OwnedRuntimeSession::prepare_group(&self.plan, &sink)
            .expect("prepared HTTP activation group");
        (self, prepared)
    }
}

#[cfg(windows)]
fn reserve_coordinator_ports(count: usize) -> (Vec<TcpListener>, Vec<u16>) {
    assert!(count > 0);
    let mut reservations = Vec::with_capacity(count);
    let mut ports = HashSet::with_capacity(count);
    while reservations.len() < count {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("ephemeral port");
        let port = listener.local_addr().expect("ephemeral address").port();
        if ports.insert(port) {
            reservations.push(listener);
        }
    }
    (reservations, ports.into_iter().collect())
}

#[cfg(windows)]
fn wait_for_exact_checkpoint(path: &Path, expected: &[u8]) {
    let deadline = std::time::Instant::now() + FIXTURE_EVENTUAL_WAIT;
    while std::fs::read(path).ok().as_deref() != Some(expected)
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read(path).expect("activation HTTP checkpoint was written"),
        expected,
        "activation HTTP checkpoint bytes for {}",
        path.display()
    );
}

#[cfg(windows)]
fn promoted_running_fixture() -> (
    CoordinatorHttpFixture,
    Arc<JournalStore>,
    RunningActivationOwner,
) {
    let (reservations, ports) = reserve_coordinator_ports(1);
    let fixture = CoordinatorHttpFixture::new(&ports, &["ready"]);
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    drop(reservations);
    let running = match activate_prepared_group(prepared) {
        Ok(running) => running,
        Err(failure) => panic!(
            "strict Running promotion: kind={:?}, detail={}, authorized={:?}, listeners={:?}",
            failure.kind_for_test(),
            failure.detail_for_test(),
            fixture
                .checkpoint_paths
                .iter()
                .map(|p| fs::read(p).ok().as_deref() == Some(b"authorized\n"))
                .collect::<Vec<_>>(),
            fixture
                .listener_checkpoint_paths
                .iter()
                .map(|p| fs::read(p).ok().as_deref() == Some(b"listener-bound\n"))
                .collect::<Vec<_>>()
        ),
    };
    (fixture, store, running)
}

#[cfg(windows)]
fn late_closing_commit_fixture() -> (
    CoordinatorHttpFixture,
    Arc<JournalStore>,
    CleanupError,
    RuntimeSessionJournalV1,
) {
    let (fixture, store, running) = promoted_running_fixture();
    let cancellation = Arc::new(AtomicBool::new(false));
    store.cancel_after_closing_replace_for_test(Arc::clone(&cancellation));
    let error = match close_running_owner(
        running,
        std::time::Instant::now() + Duration::from_secs(30),
        cancellation,
    ) {
        Ok(_) => panic!("late Closing CAS unexpectedly granted authority"),
        Err(error) => error,
    };
    let candidate = store.read(&fixture.plan.value).expect("Closing candidate");
    (fixture, store, error, candidate)
}

#[cfg(windows)]
fn late_terminal_commit_fixture() -> (
    CoordinatorHttpFixture,
    Arc<JournalStore>,
    CleanupError,
    RuntimeSessionJournalV1,
) {
    let (fixture, store, running) = promoted_running_fixture();
    let cancellation = Arc::new(AtomicBool::new(false));
    store.cancel_after_terminal_replace_for_test(Arc::clone(&cancellation));
    let error = match close_running_owner(
        running,
        std::time::Instant::now() + Duration::from_secs(30),
        cancellation,
    ) {
        Ok(_) => panic!("late Terminal CAS unexpectedly granted authority"),
        Err(error) => error,
    };
    let candidate = store.read(&fixture.plan.value).expect("Terminal candidate");
    (fixture, store, error, candidate)
}

#[cfg(windows)]
#[test]
fn private_coordinator_promotes_one_and_many_strict_ready_fixture_groups() {
    for root_count in [1_usize, 2] {
        let (reservations, ports) = reserve_coordinator_ports(root_count);
        let modes = vec!["ready"; root_count];
        let fixture = CoordinatorHttpFixture::new(&ports, &modes);
        let store = Arc::clone(&fixture.plan.context.store);
        let (fixture, prepared) = fixture.prepare();
        drop(reservations);

        let running = match activate_prepared_group(prepared) {
            Ok(running) => running,
            Err(failure) => panic!(
                "strict Running promotion failed: {}",
                failure.detail_for_test()
            ),
        };
        assert_eq!(
            running.running_journal_for_test().state,
            crate::journal::JournalState::Running
        );
        assert_eq!(running.running_journal_for_test().roots.len(), root_count);
        assert!(
            running
                .running_journal_for_test()
                .roots
                .iter()
                .all(|root| root.state == RootState::Running
                    && root.live_listener_readiness.is_some())
        );
        assert_eq!(
            store
                .read(&fixture.plan.value)
                .expect("Running journal")
                .state,
            crate::journal::JournalState::Running
        );
        for path in &fixture.marker_paths {
            wait_for_marker(path, true);
        }
        for path in &fixture.checkpoint_paths {
            wait_for_exact_checkpoint(path, b"authorized\n");
        }
        for path in &fixture.listener_checkpoint_paths {
            wait_for_exact_checkpoint(path, b"listener-bound\n");
        }
        let cleanup = cleanup_activation_for_test(running.into_suspended_owner());
        assert!(cleanup.native_cleanup_proven_for_test());
    }
}

#[cfg(windows)]
#[test]
fn private_coordinator_reconciles_status503_and_silent_with_cancel_exact_http_evidence() {
    for mode in ["status503", "silent"] {
        let (reservations, ports) = reserve_coordinator_ports(1);
        let fixture = CoordinatorHttpFixture::new(&ports, &[mode]);
        let store = Arc::clone(&fixture.plan.context.store);
        let (fixture, prepared) = fixture.prepare();
        let cancellation = prepared.cancellation_arc();
        let budget = ActivationBudget::new(
            std::time::Instant::now() + Duration::from_secs(60),
            Arc::clone(&cancellation),
        );
        let cancel_watcher = if mode == "silent" {
            let handle = prepared.cancel_handle();
            let checkpoint = fixture.checkpoint_paths[0].clone();
            Some(std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(60);
                while fs::read(&checkpoint).ok().as_deref() != Some(b"authorized\n")
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert_eq!(
                    fs::read(&checkpoint).expect("silent authorized checkpoint"),
                    b"authorized\n"
                );
                handle.cancel();
            }))
        } else {
            None
        };
        drop(reservations);
        let failure = match activate_prepared_group_with_budget(prepared, &budget) {
            Ok(_) => panic!("{mode} service must not produce Running authority"),
            Err(failure) => failure,
        };
        if let Some(watcher) = cancel_watcher {
            watcher.join().expect("cancellation watcher");
        }
        for path in &fixture.checkpoint_paths {
            wait_for_exact_checkpoint(path, b"authorized\n");
        }
        for path in &fixture.listener_checkpoint_paths {
            wait_for_exact_checkpoint(path, b"listener-bound\n");
        }
        match mode {
            "status503" => {
                assert_eq!(
                    failure.kind_for_test(),
                    PrivateActivationFailureKind::Native
                );
                assert!(failure
                    .detail_for_test()
                    .contains("strict service readiness"));
            }
            "silent" => {
                assert_eq!(
                    failure.kind_for_test(),
                    PrivateActivationFailureKind::Cancellation
                );
                assert!(failure.detail_for_test().contains("cancelled"));
            }
            _ => unreachable!(),
        }
        match failure.into_owner().expect("failed group owner") {
            PrivateActivationFailureOwner::Reconciled(owner) => {
                assert_eq!(
                    owner.journal_for_test().state,
                    crate::journal::JournalState::ReconcileRequired
                );
                assert!(owner.owner_for_test().native_cleanup_proven_for_test());
            }
            PrivateActivationFailureOwner::Suspended(owner) => {
                panic!(
                    "{mode} cleanup exceeded its bounded budget: native_proven={}",
                    owner.native_cleanup_proven_for_test()
                );
            }
        }
        assert_eq!(
            store
                .read(&fixture.plan.value)
                .expect("reconciled journal")
                .state,
            crate::journal::JournalState::ReconcileRequired
        );
    }

    let (reservations, ports) = reserve_coordinator_ports(2);
    let fixture = CoordinatorHttpFixture::new(&ports, &["ready", "status503"]);
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    drop(reservations);
    let failure = match activate_prepared_group(prepared) {
        Ok(_) => panic!("a failed root must withhold Running authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Native
    );
    assert!(failure
        .detail_for_test()
        .contains("strict service readiness"));
    match failure.into_owner().expect("failed multi-root owner") {
        PrivateActivationFailureOwner::Reconciled(owner) => {
            assert_eq!(
                owner.journal_for_test().state,
                crate::journal::JournalState::ReconcileRequired
            );
            assert_eq!(owner.journal_for_test().roots.len(), 2);
            assert!(owner.owner_for_test().native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Suspended(owner) => {
            panic!(
                "multi-root cleanup did not complete: native_proven={}",
                owner.native_cleanup_proven_for_test()
            );
        }
    }
    for path in &fixture.checkpoint_paths {
        wait_for_exact_checkpoint(path, b"authorized\n");
    }
    for path in &fixture.listener_checkpoint_paths {
        wait_for_exact_checkpoint(path, b"listener-bound\n");
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("multi-root journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn late_closing_candidate_retries_by_full_readback_without_second_cas() {
    let (fixture, store, error, candidate) = late_closing_commit_fixture();
    assert_eq!(candidate.state, crate::journal::JournalState::Closing);
    let revision = candidate.journal_revision;
    let proof = retry_cleanup_error(error).expect("known Closing candidate retry");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    let terminal = store.read(&fixture.plan.value).expect("Terminal journal");
    assert_eq!(terminal.state, crate::journal::JournalState::Terminal);
    assert_eq!(terminal.journal_revision, revision + 1);
}

#[cfg(windows)]
#[test]
fn ambiguous_closing_replace_retains_exact_candidate_for_fresh_predecessor_retry() {
    let (fixture, store, running) = promoted_running_fixture();
    store.fail_after_replace_and_durability_recheck();
    let error = close_running_owner(
        running,
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
    .expect_err("ambiguous Closing replacement must retain the owner");
    let candidate = match error.owner.as_ref() {
        Some(CleanupFailureOwner::Running {
            committed_candidate: Some(candidate),
            ..
        }) => candidate.clone(),
        _ => panic!("ambiguous Closing candidate was lost"),
    };
    assert_eq!(candidate.state, crate::journal::JournalState::Closing);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("durable Closing candidate"),
        candidate,
        "replacement fault must retain the exact candidate on disk"
    );
    let proof = retry_cleanup_error(error).expect("fresh exact Closing retry");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("Terminal journal")
            .state,
        crate::journal::JournalState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn nonambiguous_closing_prewrite_failure_does_not_claim_candidate_authority() {
    let (fixture, store, running) = promoted_running_fixture();
    store.fail_next_before_replace_for_test();
    let error = close_running_owner(
        running,
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
    .expect_err("pre-replacement failure must retain Running owner");
    match error.owner.as_ref() {
        Some(CleanupFailureOwner::Running {
            committed_candidate: None,
            ..
        }) => {}
        _ => panic!("pre-replacement failure claimed Closing authority"),
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("unchanged Running journal")
            .state,
        crate::journal::JournalState::Running
    );
    assert_eq!(
        retry_cleanup_error(error)
            .expect("fresh Running -> Closing retry")
            .state,
        GroupLifecycleState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn late_closing_candidate_conflicts_retain_owner_for_missing_corrupt_or_changed_readback() {
    for mode in ["missing", "corrupt", "changed"] {
        let (fixture, store, error, candidate) = late_closing_commit_fixture();
        if mode == "missing" {
            store.remove_journal_for_test();
        } else if mode == "corrupt" {
            store.corrupt_journal_for_test();
        } else {
            let mut changed = candidate.clone();
            changed.recovery_epoch = changed.recovery_epoch.saturating_add(1);
            store.replace_journal_for_test(&changed);
        }
        let retained = match retry_cleanup_error(error) {
            Ok(_) => panic!("{mode} Closing readback unexpectedly granted authority"),
            Err(error) => error,
        };
        store.replace_journal_for_test(&candidate);
        let proof = retry_cleanup_error(retained)
            .unwrap_or_else(|_| panic!("restored Closing candidate retry for {mode}"));
        assert_eq!(proof.state, GroupLifecycleState::Terminal);
        let terminal = store.read(&fixture.plan.value).expect("Terminal journal");
        assert_eq!(terminal.state, crate::journal::JournalState::Terminal);
        assert_eq!(terminal.journal_revision, candidate.journal_revision + 1);
    }
}

#[cfg(windows)]
#[test]
fn late_terminal_candidate_retries_by_full_readback_without_second_cas() {
    let (fixture, store, error, candidate) = late_terminal_commit_fixture();
    assert_eq!(candidate.state, crate::journal::JournalState::Terminal);
    let attempt = candidate.attempt;
    let recovery_epoch = candidate.recovery_epoch;
    let revision = candidate.journal_revision;
    let proof = retry_cleanup_error(error).expect("known Terminal candidate retry");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    let terminal = store.read(&fixture.plan.value).expect("Terminal journal");
    assert_eq!(terminal, candidate);
    assert_eq!(terminal.journal_revision, revision);
    assert_eq!(terminal.attempt, attempt);
    assert_eq!(terminal.recovery_epoch, recovery_epoch);
}

#[cfg(windows)]
#[test]
fn ambiguous_terminal_replace_retains_exact_candidate_for_fresh_projection() {
    let (fixture, store, running) = promoted_running_fixture();
    let cancellation = Arc::new(AtomicBool::new(false));
    let closing = running
        .begin_closing_with_cancellation(
            std::time::Instant::now() + Duration::from_secs(30),
            Some(Arc::clone(&cancellation)),
        )
        .unwrap_or_else(|failure| panic!("Running -> Closing: {}", failure.detail_for_test()));
    let closing = closing
        .cleanup_native_and_observe_listener_release(
            std::time::Instant::now() + Duration::from_secs(30),
            Some(Arc::clone(&cancellation)),
        )
        .unwrap_or_else(|failure| panic!("native cleanup: {}", failure.detail_for_test()));
    let (closing, _) = closing
        .release_staging_after_native_cleanup(
            std::time::Instant::now() + Duration::from_secs(30),
            Some(Arc::clone(&cancellation)),
        )
        .unwrap_or_else(|failure| panic!("staging cleanup: {}", failure.detail_for_test()));
    store.fail_after_replace_and_durability_recheck();
    let failure = match closing.terminalize_after_release(
        std::time::Instant::now() + Duration::from_secs(30),
        Some(cancellation),
    ) {
        Ok(_) => panic!("ambiguous Terminal replacement unexpectedly succeeded"),
        Err(failure) => failure,
    };
    let error = cleanup_error_from_terminal(failure);
    assert_eq!(error.phase(), CleanupPhase::StagingReleased);
    let candidate = match error.owner.as_ref() {
        Some(CleanupFailureOwner::Closing {
            committed_candidate: Some(candidate),
            ..
        }) => candidate.clone(),
        _ => panic!("ambiguous Terminal candidate was lost"),
    };
    assert_eq!(candidate.state, crate::journal::JournalState::Terminal);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("durable Terminal candidate"),
        candidate,
        "replacement fault must retain the exact Terminal candidate on disk"
    );
    let proof = retry_cleanup_error(error).expect("fresh exact Terminal projection");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    assert_eq!(
        store.read(&fixture.plan.value).expect("Terminal journal"),
        candidate
    );
}

#[cfg(windows)]
#[test]
fn normal_cleanup_with_failed_job_termination_retains_owner_for_fresh_retry() {
    let (fixture, store, running) = promoted_running_fixture();
    let closing = running
        .begin_closing_with_cancellation(
            std::time::Instant::now() + Duration::from_secs(30),
            Some(Arc::new(AtomicBool::new(false))),
        )
        .unwrap_or_else(|failure| panic!("Running -> Closing: {}", failure.detail_for_test()));
    let mut closing = closing;
    closing.inject_job_termination_failure_for_test();
    let error = close_closing_owner(
        closing,
        CleanupPhase::Closing,
        None,
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
    .expect_err("failed TerminateJobObject must retain native owner");
    assert_eq!(error.phase, CleanupPhase::Closing);
    match error.owner.as_ref() {
        Some(CleanupFailureOwner::Closing { owner, .. }) => {
            assert!(!owner.native_cleanup_proven_for_test());
        }
        _ => panic!("normal native failure lost Closing owner"),
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
    let proof = retry_cleanup_error(error).expect("fresh native cleanup retry");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
}

#[cfg(windows)]
#[test]
fn staging_release_proof_survives_post_delete_listener_failure_and_retries_join() {
    let (fixture, store, running) = promoted_running_fixture();
    let closing = running
        .begin_closing_with_cancellation(
            std::time::Instant::now() + Duration::from_secs(30),
            Some(Arc::new(AtomicBool::new(false))),
        )
        .unwrap_or_else(|failure| panic!("Running -> Closing: {}", failure.detail_for_test()));
    let mut closing = closing;
    closing.inject_listener_query_failure_after_staging_for_test();
    let error = close_closing_owner(
        closing,
        CleanupPhase::Closing,
        None,
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
    .expect_err("post-delete listener failure must retain staging proof");
    assert_eq!(error.phase, CleanupPhase::StagingReleased);
    match error.owner.as_ref() {
        Some(CleanupFailureOwner::Closing { owner, .. }) => {
            assert!(owner.staging_release_proven_for_test());
        }
        _ => panic!("staging proof owner was lost"),
    }
    let proof = retry_cleanup_error(error).expect("fresh terminal join retry");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("Terminal journal")
            .state,
        crate::journal::JournalState::Terminal
    );
    let staging_parent = fixture.producer_root.join("private-run-staging");
    assert_eq!(
        fs::read_dir(staging_parent)
            .expect("staging parent")
            .filter_map(Result::ok)
            .count(),
        0,
        "staging deletion must not be repeated during terminal join retry"
    );
}

#[cfg(windows)]
#[test]
fn terminal_listener_rebind_after_staging_release_keeps_foreign_owner_and_skips_delete_retry() {
    let (fixture, store, running) = promoted_running_fixture();
    let closing = running
        .begin_closing_with_cancellation(
            std::time::Instant::now() + Duration::from_secs(30),
            Some(Arc::new(AtomicBool::new(false))),
        )
        .unwrap_or_else(|failure| panic!("Running -> Closing: {}", failure.detail_for_test()));
    let closing_revision = closing.closing_journal_for_test().journal_revision;
    let port = closing.closing_journal_for_test().roots[0].loopback_port;
    let mut closing = closing;
    closing.inject_terminal_listener_rebind_after_clock_for_test(port);
    let mut error = close_closing_owner(
        closing,
        CleanupPhase::Closing,
        None,
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
    .expect_err("foreign listener rebound after staging release");
    assert_eq!(error.kind, CleanupErrorKind::Listener);
    assert_eq!(error.phase, CleanupPhase::StagingReleased);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("Closing journal")
            .journal_revision,
        closing_revision
    );
    let staging_parent = fixture.producer_root.join("private-run-staging");
    assert_eq!(
        fs::read_dir(&staging_parent)
            .expect("staging parent")
            .filter_map(Result::ok)
            .count(),
        0,
        "staging was released before the foreign listener was observed"
    );
    let (mut owner, phase, candidate) = match error.owner.take() {
        Some(CleanupFailureOwner::Closing {
            owner,
            phase,
            committed_candidate,
        }) => {
            assert_eq!(phase, CleanupPhase::StagingReleased);
            assert!(owner.staging_release_proven_for_test());
            (owner, phase, committed_candidate)
        }
        _ => panic!("foreign listener failure lost the Closing owner"),
    };
    owner.release_terminal_foreign_listener_for_test();
    let proof = close_closing_owner(
        owner,
        phase,
        candidate,
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
    .expect("terminal join after foreign listener release");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("Terminal journal")
            .journal_revision,
        closing_revision + 1
    );
    assert_eq!(
        fs::read_dir(staging_parent)
            .expect("staging parent after retry")
            .filter_map(Result::ok)
            .count(),
        0,
        "terminal retry must not repeat staging deletion"
    );
}

#[cfg(windows)]
#[test]
fn public_observe_contention_expires_without_journal_mutation() {
    let (fixture, store, running) = promoted_running_fixture();
    let before = store.read(&fixture.plan.value).expect("Running journal");
    let lease = Arc::new(GroupLease::new(running));
    let guard = lease.owner.lock().expect("observe contention owner lock");
    let observer_lease = Arc::clone(&lease);
    let deadline = std::time::Instant::now() + Duration::from_millis(100);
    let observer = std::thread::spawn(move || {
        observe_group_with_budget(&observer_lease, deadline, Arc::new(AtomicBool::new(false)))
    });
    std::thread::sleep(Duration::from_millis(200));
    let error = observer
        .join()
        .expect("bounded observe thread")
        .expect_err("contention held through deadline must not enter journal observation");
    assert!(matches!(
        error.kind(),
        LifecycleErrorKind::Busy | LifecycleErrorKind::Deadline
    ));
    drop(guard);
    assert_eq!(
        store.read(&fixture.plan.value).expect("unchanged journal"),
        before
    );
    let lease = Arc::try_unwrap(lease)
        .ok()
        .expect("observe contention released its shared lease");
    OwnedRuntimeSession::close(lease, CloseReason::Shutdown).expect("close after contention");
}

#[cfg(windows)]
#[test]
fn public_observe_uses_remaining_budget_after_lock_release() {
    let (fixture, _store, running) = promoted_running_fixture();
    let lease = Arc::new(GroupLease::new(running));
    let guard = lease.owner.lock().expect("observe release owner lock");
    let observer_lease = Arc::clone(&lease);
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    let observer = std::thread::spawn(move || {
        observe_group_with_budget(&observer_lease, deadline, Arc::new(AtomicBool::new(false)))
    });
    std::thread::sleep(Duration::from_millis(50));
    drop(guard);
    observer
        .join()
        .expect("observe release thread")
        .expect("observation after timely lock release");
    let lease = Arc::try_unwrap(lease)
        .ok()
        .expect("observe release consumed its shared lease");
    OwnedRuntimeSession::close(lease, CloseReason::Shutdown).expect("close after observation");
    assert_eq!(
        fixture
            .plan
            .context
            .store
            .read(&fixture.plan.value)
            .expect("Terminal journal")
            .state,
        crate::journal::JournalState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn public_observe_poison_fails_closed_and_lease_remains_closable() {
    let (fixture, store, running) = promoted_running_fixture();
    let lease = Arc::new(GroupLease::new(running));
    let poison_lease = Arc::clone(&lease);
    let _ = std::thread::spawn(move || {
        let _guard = poison_lease.owner.lock().expect("poison owner lock");
        panic!("poison observe owner lock");
    })
    .join();
    let error = observe_group_with_budget(
        &lease,
        std::time::Instant::now() + Duration::from_secs(1),
        Arc::new(AtomicBool::new(false)),
    )
    .expect_err("poisoned observe owner must fail closed");
    assert_eq!(error.kind(), LifecycleErrorKind::InvalidState);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("unchanged journal")
            .state,
        crate::journal::JournalState::Running
    );
    let lease = Arc::try_unwrap(lease)
        .ok()
        .expect("poisoned observe shared lease");
    OwnedRuntimeSession::close(lease, CloseReason::Shutdown)
        .expect("poisoned lease remains closable");
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("Terminal journal")
            .state,
        crate::journal::JournalState::Terminal
    );
    let _ = fixture;
}

#[cfg(windows)]
#[test]
fn late_terminal_candidate_post_readback_deadline_retains_exact_candidate_for_retry() {
    let (fixture, store, error, candidate) = late_terminal_commit_fixture();
    store.expire_after_terminal_candidate_readback_for_test();
    let retained = match retry_cleanup_error(error) {
        Ok(_) => panic!("late Terminal readback unexpectedly granted authority"),
        Err(error) => error,
    };
    assert_eq!(retained.kind, CleanupErrorKind::Deadline);
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("unchanged Terminal candidate"),
        candidate,
        "late readback must not issue a second Terminal CAS"
    );
    let proof = retry_cleanup_error(retained).expect("fresh exact Terminal retry");
    assert_eq!(proof.state, GroupLifecycleState::Terminal);
    assert_eq!(
        store.read(&fixture.plan.value).expect("Terminal journal"),
        candidate
    );
}

#[cfg(windows)]
#[test]
fn late_terminal_candidate_conflicts_retain_owner_for_missing_corrupt_or_changed_readback() {
    for mode in ["missing", "corrupt", "changed"] {
        let (fixture, store, error, candidate) = late_terminal_commit_fixture();
        let revision = candidate.journal_revision;
        if mode == "missing" {
            store.remove_journal_for_test();
        } else if mode == "corrupt" {
            store.corrupt_journal_for_test();
        } else {
            let mut changed = candidate.clone();
            changed.recovery_epoch = changed.recovery_epoch.saturating_add(1);
            store.replace_journal_for_test(&changed);
        }
        let retained = match retry_cleanup_error(error) {
            Ok(_) => panic!("{mode} Terminal readback unexpectedly granted authority"),
            Err(error) => error,
        };
        store.replace_journal_for_test(&candidate);
        let proof = retry_cleanup_error(retained)
            .unwrap_or_else(|_| panic!("restored Terminal candidate retry for {mode}"));
        assert_eq!(proof.state, GroupLifecycleState::Terminal);
        let terminal = store
            .read(&fixture.plan.value)
            .expect("restored Terminal journal");
        assert_eq!(terminal, candidate);
        assert_eq!(terminal.journal_revision, revision);
    }
}

#[cfg(windows)]
#[test]
fn private_coordinator_cancellation_after_root_zero_readiness_is_deterministic() {
    let (reservations, ports) = reserve_coordinator_ports(2);
    let fixture = CoordinatorHttpFixture::new(&ports, &["ready", "ready"]);
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let handle = prepared.cancel_handle();
    let cancellation = prepared.cancellation_arc();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(60),
        Arc::clone(&cancellation),
    );
    let hook_hit = Arc::new(AtomicBool::new(false));
    let activation = prepared
        .consume_for_activation_with_budget(&budget)
        .expect("validated activation context");
    let suspended = match acquire_suspended_for_activation_with_budget(activation, &budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("suspended activation group: {}", failure.detail),
    };
    let ready = match suspended.persist_ready_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Ready activation group: {}", failure.detail),
    };
    drop(reservations);
    let suspended = match ready.launch_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Launching activation group: {}", failure.detail),
    };
    let mut launching = suspended;
    launching.coordinate_readiness_probe_for_test(0, Arc::clone(&hook_hit), handle);
    let failure = match launching
        .promote_running_with_cancellation(budget.deadline(), Some(Arc::clone(&cancellation)))
    {
        Ok(_) => panic!("cancellation between probes must withhold Running authority"),
        Err(failure) => failure,
    };
    assert!(
        hook_hit.load(Ordering::Acquire),
        "readiness hook was not reached"
    );
    wait_for_exact_checkpoint(&fixture.checkpoint_paths[0], b"authorized\n");
    assert!(!fixture.checkpoint_paths[1].exists(), "root 1 was probed");
    for path in &fixture.listener_checkpoint_paths {
        wait_for_exact_checkpoint(path, b"listener-bound\n");
    }
    let failure = private_failure_from_running_promotion_failure(failure, &budget);
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Cancellation
    );
    match failure.into_owner().expect("cancelled group owner") {
        PrivateActivationFailureOwner::Reconciled(owner) => {
            assert_eq!(
                owner.journal_for_test().state,
                crate::journal::JournalState::ReconcileRequired
            );
            assert_eq!(owner.journal_for_test().roots.len(), 2);
            assert!(owner.owner_for_test().native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Suspended(owner) => {
            panic!(
                "cancelled multi-root cleanup did not complete: native_proven={}",
                owner.native_cleanup_proven_for_test()
            );
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("cancelled journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn running_late_cas_candidate_is_retained_before_private_reconcile() {
    let (reservations, ports) = reserve_coordinator_ports(1);
    let fixture = CoordinatorHttpFixture::new(&ports, &["ready"]);
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = prepared.cancellation_arc();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(60),
        Arc::clone(&cancellation),
    );
    let activation = match prepared.consume_for_activation_with_budget(&budget) {
        Ok(activation) => activation,
        Err(error) => panic!("activation validation failed: {error:?}"),
    };
    let suspended = match acquire_suspended_for_activation_with_budget(activation, &budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("suspended activation failed: {}", failure.detail),
    };
    let ready = match suspended.persist_ready_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Ready activation failed: {}", failure.detail),
    };
    drop(reservations);
    let launching = match ready.launch_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Launching activation failed: {}", failure.detail),
    };
    store.cancel_after_running_replace_for_test(Arc::clone(&cancellation));
    let failure = match launching
        .promote_running_with_cancellation(budget.deadline(), Some(Arc::clone(&cancellation)))
    {
        Ok(_) => panic!("late Running CAS cancellation must withhold authority"),
        Err(failure) => failure,
    };
    let candidate = failure
        .committed_candidate_for_test()
        .expect("exact Running candidate")
        .clone();
    assert_eq!(candidate.state, crate::journal::JournalState::Running);
    assert_eq!(
        store.read(&fixture.plan.value).expect("durable candidate"),
        candidate,
        "late CAS must retain the entire durable Running candidate"
    );

    let private_failure = private_failure_from_running_promotion_failure(failure, &budget);
    match private_failure
        .into_owner()
        .expect("retained reconcile owner")
    {
        PrivateActivationFailureOwner::Reconciled(owner) => {
            let mut expected = candidate.clone();
            expected.state = crate::journal::JournalState::ReconcileRequired;
            expected.journal_revision += 1;
            expected.updated_at = owner.journal_for_test().updated_at.clone();
            assert_eq!(
                owner.journal_for_test(),
                &expected,
                "reconcile must preserve the complete Running identity"
            );
            assert!(owner.owner_for_test().native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Suspended(owner) => {
            panic!(
                "late candidate cleanup did not complete: native_proven={}",
                owner.native_cleanup_proven_for_test()
            );
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("reconciled candidate")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn running_outer_post_cas_cancellation_retains_exact_candidate() {
    let (reservations, ports) = reserve_coordinator_ports(1);
    let fixture = CoordinatorHttpFixture::new(&ports, &["ready"]);
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = prepared.cancellation_arc();
    let cancel_handle = prepared.cancel_handle();
    let hook_hit = Arc::new(AtomicBool::new(false));
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(60),
        Arc::clone(&cancellation),
    );
    let activation = prepared
        .consume_for_activation_with_budget(&budget)
        .expect("validated activation context");
    let suspended = match acquire_suspended_for_activation_with_budget(activation, &budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("suspended activation group: {}", failure.detail),
    };
    let ready = match suspended.persist_ready_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Ready activation group: {}", failure.detail),
    };
    drop(reservations);
    let suspended = match ready.launch_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Launching activation group: {}", failure.detail),
    };
    let mut launching = suspended;
    launching.cancel_after_running_commit_for_test(Arc::clone(&hook_hit), cancel_handle);

    let failure = match launching
        .promote_running_with_cancellation(budget.deadline(), Some(Arc::clone(&cancellation)))
    {
        Ok(_) => panic!("outer post-CAS cancellation must withhold authority"),
        Err(failure) => failure,
    };
    assert!(
        hook_hit.load(Ordering::Acquire),
        "post-CAS hook was not reached"
    );
    let candidate = failure
        .committed_candidate_for_test()
        .expect("outer cancellation exact Running candidate")
        .clone();
    assert_eq!(candidate.state, crate::journal::JournalState::Running);
    assert_eq!(
        store.read(&fixture.plan.value).expect("durable candidate"),
        candidate,
        "outer cancellation must retain the entire durable Running candidate"
    );

    let private_failure = private_failure_from_running_promotion_failure(failure, &budget);
    assert_eq!(
        private_failure.kind_for_test(),
        PrivateActivationFailureKind::Cancellation
    );
    match private_failure
        .into_owner()
        .expect("outer cancellation reconcile owner")
    {
        PrivateActivationFailureOwner::Reconciled(owner) => {
            let mut expected = candidate.clone();
            expected.state = crate::journal::JournalState::ReconcileRequired;
            expected.journal_revision += 1;
            expected.updated_at = owner.journal_for_test().updated_at.clone();
            assert_eq!(
                owner.journal_for_test(),
                &expected,
                "outer cancellation reconcile must preserve full identity"
            );
            assert!(owner.owner_for_test().native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Suspended(owner) => {
            panic!(
                "outer post-CAS cleanup did not complete: native_proven={}",
                owner.native_cleanup_proven_for_test()
            );
        }
    }
}

#[cfg(windows)]
#[test]
fn running_deadline_after_durable_readback_retains_candidate_and_native_owner() {
    let (reservations, ports) = reserve_coordinator_ports(2);
    let fixture = CoordinatorHttpFixture::new(&ports, &["ready", "ready"]);
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = prepared.cancellation_arc();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(15),
        Arc::clone(&cancellation),
    );
    let activation = prepared
        .consume_for_activation_with_budget(&budget)
        .expect("validated activation context");
    let suspended = match acquire_suspended_for_activation_with_budget(activation, &budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("suspended activation group: {}", failure.detail),
    };
    let ready = match suspended.persist_ready_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Ready activation group: {}", failure.detail),
    };
    drop(reservations);
    let suspended = match ready.launch_with_budget(&budget) {
        Ok(owner) => owner,
        Err(failure) => panic!("Launching activation group: {}", failure.detail),
    };
    let mut launching = suspended;
    launching.inject_native_cleanup_failure_for_test();
    store.expire_after_running_readback_for_test();

    let failure = match launching
        .promote_running_with_cancellation(budget.deadline(), Some(Arc::clone(&cancellation)))
    {
        Ok(_) => panic!("deadline crossing after Running readback must withhold authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        RunningPromotionFailureKind::Deadline
    );
    let candidate = failure
        .committed_candidate_for_test()
        .expect("deadline exact Running candidate")
        .clone();
    assert_eq!(candidate.state, crate::journal::JournalState::Running);
    assert_eq!(
        store.read(&fixture.plan.value).expect("durable candidate"),
        candidate,
        "deadline crossing must retain the entire durable Running candidate"
    );

    let private_failure = private_failure_from_running_promotion_failure(failure, &budget);
    assert_eq!(
        private_failure.kind_for_test(),
        PrivateActivationFailureKind::Reconcile
    );
    assert_eq!(
        private_failure
            .committed_candidate_for_test()
            .expect("candidate remains accessible after incomplete cleanup"),
        &candidate
    );
    let mut public_error = launch_error_from_private_failure(private_failure);
    assert_eq!(public_error.committed_candidate.as_ref(), Some(&candidate));
    let owner = match public_error.owner.as_mut().expect("retained public owner") {
        LaunchFailureOwner::Suspended(owner) => owner,
        LaunchFailureOwner::Reconciled(_) => {
            panic!("incomplete cleanup must not issue a reconcile authority")
        }
    };
    assert!(!owner.native_cleanup_proven_for_test());
    {
        let native = owner
            .native
            .as_mut()
            .expect("incomplete cleanup retains native owner");
        assert_eq!(native.roots.len(), 2);
    }
    assert!(
        owner.failure_context.is_some(),
        "incomplete cleanup retains the staging identity context"
    );

    // The original deadline has expired by design, so the incomplete
    // force-cleanup result above makes no liveness claim for root 0.  Use
    // a separate post-test budget to terminate and reap that exact
    // retained Child handle, then assert the handle itself reports exit.
    let teardown_deadline = std::time::Instant::now() + Duration::from_secs(15);
    {
        let native = owner
            .native
            .as_mut()
            .expect("incomplete cleanup retains native owner");
        let root = &mut native.roots[0];
        let identity = root
            .identity
            .expect("retained first root has an exact identity");
        terminate_process_with_proof_with_timeout(
            root.child.as_raw_handle() as *mut c_void,
            identity,
            remaining_timeout_ms(teardown_deadline),
        )
        .and_then(|_| {
            reap_child_by_exact_handle(&mut root.child, remaining_timeout_ms(teardown_deadline))
        })
        .expect("post-deadline exact retained root reap");
        assert!(
            root.child
                .try_wait()
                .expect("exact retained root handle status")
                .is_some(),
            "post-deadline reap must be proved through the exact retained handle"
        );
    }
    let cleanup = public_error
        .retry_cleanup()
        .expect("fresh public cleanup budget");
    assert!(cleanup.native_closed && cleanup.staging_retained);
    let reconciled = store.read(&fixture.plan.value).expect("reconciled journal");
    let mut expected = candidate;
    expected.state = crate::journal::JournalState::ReconcileRequired;
    expected.journal_revision += 1;
    expected.updated_at = reconciled.updated_at.clone();
    assert_eq!(reconciled, expected);
}

#[cfg(windows)]
#[test]
fn activation_budget_cancellation_arc_mismatch_has_zero_resources_and_preserves_prepared_bound() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let before = store
        .read(&fixture.plan.value)
        .expect("PreparedBound journal");
    assert_eq!(before.state, crate::journal::JournalState::PreparedBound);
    let mismatched = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(15),
        Arc::new(AtomicBool::new(false)),
    );

    let failure = match activate_prepared_group_with_budget(prepared, &mismatched) {
        Ok(_) => panic!("mismatched cancellation source must fail before acquisition"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Preparation
    );
    assert!(failure.into_owner().is_none());
    assert_eq!(
        store.read(&fixture.plan.value).expect("unchanged journal"),
        before
    );
    let descriptor = fixture
        .plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("activation descriptor");
    assert!(!descriptor.planned_group_staging_path().exists());
    assert!(descriptor
        .planned_root_staging_paths()
        .all(|path| !path.exists()));
}

#[cfg(windows)]
#[test]
fn cloned_cancel_handles_signal_the_same_prepared_activation_source() {
    let fixture = CoordinatorActivationFixture::new();
    let (fixture, prepared) = fixture.prepare();
    let cancellation = prepared.cancellation_arc();
    let first = prepared.cancel_handle();
    let second = first.clone();
    assert!(!cancellation.load(Ordering::Acquire));
    first.cancel();
    assert!(cancellation.load(Ordering::Acquire));
    second.cancel();
    assert!(cancellation.load(Ordering::Acquire));
    assert_eq!(
        fixture
            .plan
            .context
            .store
            .read(&fixture.plan.value)
            .expect("PreparedBound journal")
            .state,
        crate::journal::JournalState::PreparedBound
    );
}

#[cfg(windows)]
#[test]
fn coordinator_ready_late_cancellation_reconciles_the_exact_ready_candidate() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = Arc::new(AtomicBool::new(false));
    crate::staging::cancel_after_ready_cas_for_test();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::clone(&cancellation),
    );

    let failure = match activate_for_launch_with_budget(prepared, &budget) {
        Ok(_) => panic!("late Ready cancellation must fail activation"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Cancellation,
        "{}",
        failure.detail_for_test()
    );
    match failure
        .into_owner()
        .expect("cleanup retains reconcile owner")
    {
        PrivateActivationFailureOwner::Reconciled(reconciled) => {
            assert_eq!(
                reconciled.journal_for_test().state,
                crate::journal::JournalState::ReconcileRequired
            );
        }
        PrivateActivationFailureOwner::Suspended(_) => {
            panic!("exact Ready CAS candidate must reconcile")
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("reconciled journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn coordinator_ready_handoff_cancellation_reconciles_the_exact_ready_candidate() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = Arc::new(AtomicBool::new(false));
    inject_cancellation_after_ready_helper_for_test();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::clone(&cancellation),
    );

    let failure = match activate_for_launch_with_budget(prepared, &budget) {
        Ok(_) => panic!("handoff cancellation after Ready helper must fail activation"),
        Err(failure) => failure,
    };
    assert!(
        !CANCEL_AFTER_READY_HELPER.with(|flag| flag.get()),
        "Ready handoff injection was reached"
    );
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Cancellation,
        "{}",
        failure.detail_for_test()
    );
    match failure
        .into_owner()
        .expect("handoff cancellation retains reconcile owner")
    {
        PrivateActivationFailureOwner::Reconciled(reconciled) => {
            assert_eq!(
                reconciled.journal_for_test().state,
                crate::journal::JournalState::ReconcileRequired
            );
            assert!(reconciled.journal_for_test().job_binding.is_some());
            assert_eq!(reconciled.journal_for_test().roots.len(), 1);
            assert!(reconciled.owner_for_test().native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Suspended(_) => {
            panic!("exact Ready handoff candidate must reconcile")
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("reconciled handoff journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn coordinator_launching_late_cancellation_reconciles_the_exact_launching_candidate() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = Arc::new(AtomicBool::new(false));
    crate::staging::cancel_after_launching_cas_for_test();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::clone(&cancellation),
    );

    let failure = match activate_for_launch_with_budget(prepared, &budget) {
        Ok(_) => panic!("late Launching cancellation must fail activation"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Cancellation,
        "{}",
        failure.detail_for_test()
    );
    match failure
        .into_owner()
        .expect("cleanup retains reconcile owner")
    {
        PrivateActivationFailureOwner::Reconciled(reconciled) => {
            assert_eq!(
                reconciled.journal_for_test().state,
                crate::journal::JournalState::ReconcileRequired
            );
        }
        PrivateActivationFailureOwner::Suspended(_) => {
            panic!("exact Launching CAS candidate must reconcile")
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("reconciled journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn coordinator_resume_handoff_cancellation_reconciles_without_launch_authority() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = Arc::new(AtomicBool::new(false));
    inject_cancellation_after_resume_all_for_test();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::clone(&cancellation),
    );

    let failure = match activate_for_launch_with_budget(prepared, &budget) {
        Ok(_) => panic!("late resume handoff cancellation must fail activation"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Cancellation,
        "{}",
        failure.detail_for_test()
    );
    match failure
        .into_owner()
        .expect("resume handoff cancellation retains reconcile owner")
    {
        PrivateActivationFailureOwner::Reconciled(reconciled) => {
            assert_eq!(
                reconciled.journal_for_test().state,
                crate::journal::JournalState::ReconcileRequired
            );
            assert!(reconciled.journal_for_test().job_binding.is_some());
            assert_eq!(reconciled.journal_for_test().roots.len(), 1);
            assert!(reconciled.owner_for_test().native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Suspended(_) => {
            panic!("resumed group must reconcile before any launch authority escapes")
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("reconciled resume handoff journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn budgeted_native_handoff_rejects_invalid_staging_before_job_setup() {
    for fault in [
        "artifact",
        "partial-marker",
        "partial-root",
        "foreign-entry",
    ] {
        let (fixture, prepared) = CoordinatorActivationFixture::new().prepare();
        let budget = activation_budget_for_test();
        let activation = prepared
            .consume_for_activation_with_budget(&budget)
            .expect("validated activation context");
        let group_path = activation.descriptor.planned_group_staging_path();
        let executable_path = activation
            .descriptor
            .producer_root()
            .join("capture-runtime.exe");
        let failure_context = Some(ActivationFailureJournalContext {
            store: Arc::clone(&activation.context.store),
            plan: activation.journal_plan.clone(),
            predecessor: activation.expected_journal.clone(),
            candidate: activation.expected_journal.clone(),
            disposition: CasDisposition::Prewrite,
        });
        match fault {
            "partial-marker" => crate::staging::fail_next_marker_flush_for_test(),
            "partial-root" => crate::staging::fail_next_root_mkdir_for_test(0),
            _ => {}
        }
        let staging = match crate::staging::materialize(activation) {
            Ok(owner) if matches!(fault, "artifact" | "foreign-entry") => owner,
            Err(crate::staging::StagingFailure::Owned { owner, .. })
                if matches!(fault, "partial-marker" | "partial-root") =>
            {
                owner
            }
            _ => panic!("expected owned staging fixture for {fault}"),
        };
        let foreign = group_path.join("foreign.txt");
        if fault == "artifact" {
            let mut bytes = fs::read(&executable_path).expect("fixture bytes");
            bytes[0] ^= 0xff;
            fs::write(&executable_path, bytes).expect("artifact drift");
        } else if fault == "foreign-entry" {
            fs::write(&foreign, b"preserve").expect("foreign entry");
        }
        let failure = acquire_suspended_from_staging_with_permit(
            staging,
            fixture.admission.take(),
            failure_context,
            Some(&budget),
        )
        .err()
        .expect("invalid staging must stop before Job setup");
        assert_eq!(failure.kind, SuspendedActivationFailureKind::Staging);
        let owner = failure.owner.expect("staging owner retained");
        assert!(owner.native.is_none());
        assert!(owner.native_cleanup_proven);
        assert!(owner.failure_context.is_some());
        assert!(group_path.is_dir());
        if fault == "foreign-entry" {
            assert_eq!(
                fs::read(&foreign).expect("foreign entry retained"),
                b"preserve"
            );
        }
    }
}

#[cfg(windows)]
#[test]
fn budgeted_root_n_journal_drift_retains_native_owner_through_cleanup() {
    let ports = [free_loopback_port(), free_loopback_port()];
    let (fixture, prepared) = CoordinatorHttpFixture::new(&ports, &["ready", "ready"]).prepare();
    let budget = activation_budget_for_test();
    let activation = prepared
        .consume_for_activation_with_budget(&budget)
        .expect("activation");
    let group_path = activation.descriptor.planned_group_staging_path();
    let failure_context = Some(ActivationFailureJournalContext {
        store: Arc::clone(&activation.context.store),
        plan: activation.journal_plan.clone(),
        predecessor: activation.expected_journal.clone(),
        candidate: activation.expected_journal.clone(),
        disposition: CasDisposition::Prewrite,
    });
    let staging = crate::staging::materialize(activation).expect("materialized scope");
    staging
        .inject_journal_drift_before_root_for_test(1)
        .expect("drift injection");
    let failure =
        acquire_suspended_from_staging_with_permit(staging, None, failure_context, Some(&budget))
            .err()
            .expect("root-n drift must stop acquisition");
    let owner = failure.owner.expect("partial native owner retained");
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    let owner = cleanup_activation_for_test(owner);
    assert!(owner.native_cleanup_proven);
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    assert!(group_path.is_dir());
    assert_eq!(
        fixture
            .plan
            .context
            .store
            .read(&fixture.plan.value)
            .expect("journal")
            .state,
        JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn staging_to_native_budget_failure_retains_scope_and_fixture_permit() {
    let fixture = CoordinatorActivationFixture::new();
    let (fixture, prepared) = fixture.prepare();
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let failure_context = Some(ActivationFailureJournalContext {
        store: Arc::clone(&activation.context.store),
        plan: activation.journal_plan.clone(),
        predecessor: activation.expected_journal.clone(),
        candidate: activation.expected_journal.clone(),
        disposition: CasDisposition::Prewrite,
    });
    let staging = crate::staging::materialize(activation).expect("materialized scope");
    let permit = fixture
        .admission
        .take()
        .expect("pre-admitted fixture permit");
    let cancellation = Arc::new(AtomicBool::new(false));
    let budget = ActivationBudget::new(
        std::time::Instant::now() - Duration::from_millis(1),
        Arc::clone(&cancellation),
    );

    let failure = match acquire_suspended_from_staging_with_permit(
        staging,
        Some(permit),
        failure_context,
        Some(&budget),
    ) {
        Ok(_) => panic!("expired staging-to-native admission must fail"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind,
        SuspendedActivationFailureKind::Native(GroupNativeFailureKind::Setup)
    );
    let owner = failure.into_owner().expect("staging owner retained");
    assert!(owner.native.is_none());
    assert!(owner.native_cleanup_proven);
    assert!(owner.failure_context.is_some());
    assert!(owner._http_fixture_permit.is_some());
    let owner = cleanup_activation_for_test(owner);
    assert!(owner.native_cleanup_proven_for_test());
    assert!(fixture
        .plan
        .context
        .activation_descriptor
        .as_ref()
        .unwrap()
        .planned_group_staging_path()
        .exists());
}

#[cfg(windows)]
#[test]
fn coordinator_reconcile_after_readback_expiry_retains_exact_committed_candidate() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    let cancellation = Arc::new(AtomicBool::new(false));
    crate::staging::cancel_after_ready_cas_for_test();
    store.expire_after_activation_reconcile_readback_for_test();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        Arc::clone(&cancellation),
    );

    let failure = match activate_for_launch_with_budget(prepared, &budget) {
        Ok(_) => panic!("reconcile must not issue authority after its deadline"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        PrivateActivationFailureKind::Reconcile,
        "{}",
        failure.detail_for_test()
    );
    assert_eq!(
        failure
            .committed_candidate_for_test()
            .expect("exact committed reconcile candidate")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
    match failure.into_owner().expect("retained owner") {
        PrivateActivationFailureOwner::Suspended(owner) => {
            assert!(owner.native_cleanup_proven_for_test());
        }
        PrivateActivationFailureOwner::Reconciled(_) => {
            panic!("late reconcile commit must not return normal authority")
        }
    }
    assert_eq!(
        store
            .read(&fixture.plan.value)
            .expect("durable reconcile journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn public_retry_reads_back_late_reconcile_candidate_without_replaying_cas() {
    let fixture = CoordinatorActivationFixture::new();
    let store = Arc::clone(&fixture.plan.context.store);
    let (fixture, prepared) = fixture.prepare();
    crate::staging::cancel_after_ready_cas_for_test();
    store.expire_after_activation_reconcile_readback_for_test();

    let error = match OwnedRuntimeSession::activate_group(prepared) {
        Ok(_) => panic!("late reconcile commit must withhold public lease"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), LaunchErrorKind::Reconcile);
    assert_eq!(error.phase(), LaunchPhase::Reconcile);
    let before_retry = store.read(&fixture.plan.value).expect("late candidate");
    assert_eq!(
        before_retry.state,
        crate::journal::JournalState::ReconcileRequired
    );
    let cleanup = error
        .retry_cleanup()
        .expect("exact late reconcile candidate readback");
    assert_eq!(
        cleanup.state,
        SemanticActivationCleanupState::ReconcileRequired
    );
    assert!(cleanup.native_closed);
    assert!(cleanup.staging_retained);
    assert_eq!(
        store.read(&fixture.plan.value).expect("same candidate"),
        before_retry
    );
}

#[cfg(windows)]
#[test]
fn public_retry_reconcile_preserves_disposition_across_conflict_and_predecessor() {
    for ambiguous in [false, true] {
        let fixture = CoordinatorActivationFixture::new();
        let store = Arc::clone(&fixture.plan.context.store);
        let (fixture, prepared) = fixture.prepare();
        let error = if ambiguous {
            let budget = ActivationBudget::new(
                std::time::Instant::now() + Duration::from_secs(30),
                prepared.cancellation_arc(),
            );
            let activation = prepared
                .consume_for_activation_with_budget(&budget)
                .expect("activation");
            let suspended = acquire_suspended_for_activation_with_budget(activation, &budget)
                .unwrap_or_else(|failure| panic!("native acquisition: {}", failure.detail));
            let ready = suspended
                .persist_ready_with_budget(&budget)
                .unwrap_or_else(|failure| panic!("Ready: {}", failure.detail));
            store.fail_after_replace_and_durability_recheck();
            launch_error_from_private_failure(private_failure_after_cleanup(
                PrivateActivationFailureKind::Cancellation,
                "test cancellation".into(),
                ready.owner,
                &budget,
            ))
        } else {
            crate::staging::cancel_after_ready_cas_for_test();
            store.expire_after_activation_reconcile_readback_for_test();
            match OwnedRuntimeSession::activate_group(prepared) {
                Ok(_) => panic!("late reconcile"),
                Err(error) => error,
            }
        };
        let (candidate, predecessor) = match error.owner.as_ref().expect("cleanup owner") {
            LaunchFailureOwner::Suspended(owner) => {
                let context = owner.failure_context.as_ref().expect("retained context");
                assert_eq!(
                    context.disposition,
                    if ambiguous {
                        CasDisposition::AmbiguousWrite
                    } else {
                        CasDisposition::ConfirmedLate
                    }
                );
                (context.candidate.clone(), context.predecessor.clone())
            }
            _ => panic!("late reconcile must retain suspended owner"),
        };
        let mut conflict = predecessor.clone();
        conflict.recovery_epoch += 1;
        store.replace_journal_for_test(&conflict);
        let error = error.retry_cleanup().expect_err("conflicting record");
        assert_eq!(store.read(&fixture.plan.value).unwrap(), conflict);
        assert_eq!(error.committed_candidate.as_ref(), Some(&candidate));
        store.replace_journal_for_test(&predecessor);
        if ambiguous {
            let cleanup = error
                .retry_cleanup()
                .expect("exact ambiguous predecessor retry");
            assert!(cleanup.native_closed && cleanup.staging_retained);
            let journal = store.read(&fixture.plan.value).unwrap();
            assert_eq!(journal.state, JournalState::ReconcileRequired);
            assert_eq!(journal.journal_revision, candidate.journal_revision);
        } else {
            let error = error
                .retry_cleanup()
                .expect_err("confirmed predecessor replay");
            assert_eq!(store.read(&fixture.plan.value).unwrap(), predecessor);
            assert_eq!(error.committed_candidate.as_ref(), Some(&candidate));
            store.replace_journal_for_test(&candidate);
            error
                .retry_cleanup()
                .expect("restored exact confirmed candidate");
            assert_eq!(store.read(&fixture.plan.value).unwrap(), candidate);
        }
    }
}

#[cfg(windows)]
#[test]
fn confirmed_closing_and_terminal_reject_predecessor_restoration_without_cas() {
    for terminal in [false, true] {
        let (fixture, store, error, candidate) = if terminal {
            late_terminal_commit_fixture()
        } else {
            late_closing_commit_fixture()
        };
        let context = match error.owner.as_ref().unwrap() {
            CleanupFailureOwner::Running { owner, .. } => {
                owner.owner.failure_context.as_ref().unwrap()
            }
            CleanupFailureOwner::Closing { owner, .. } => {
                owner.owner.failure_context.as_ref().unwrap()
            }
        };
        assert_eq!(context.candidate, candidate);
        assert_eq!(context.disposition, CasDisposition::ConfirmedLate);
        let predecessor = context.predecessor.clone();
        store.replace_journal_for_test(&predecessor);
        let before = store.owned_cas_calls_for_test();
        let error =
            retry_cleanup_error(error).expect_err("confirmed predecessor replay must conflict");
        assert_eq!(error.kind(), CleanupErrorKind::Conflict);
        assert_eq!(store.owned_cas_calls_for_test(), before, "no repeated CAS");
        assert_eq!(store.read(&fixture.plan.value).unwrap(), predecessor);
        store.replace_journal_for_test(&candidate);
        retry_cleanup_error(error).expect("exact candidate restores cleanup");
    }
}

#[cfg(windows)]
fn ambiguous_cleanup_fixture(
    terminal: bool,
) -> (
    CoordinatorHttpFixture,
    Arc<JournalStore>,
    CleanupError,
    RuntimeSessionJournalV1,
) {
    let (fixture, store, running) = promoted_running_fixture();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let cancel = Arc::new(AtomicBool::new(false));
    let error = if terminal {
        let closing = running
            .begin_closing_with_cancellation(deadline, Some(cancel.clone()))
            .unwrap_or_else(|e| panic!("Closing: {}", e.detail));
        let closing = closing
            .cleanup_native_and_observe_listener_release(deadline, Some(cancel.clone()))
            .unwrap_or_else(|e| panic!("native: {}", e.detail));
        let (closing, _) = closing
            .release_staging_after_native_cleanup(deadline, Some(cancel.clone()))
            .unwrap_or_else(|e| panic!("staging: {}", e.detail));
        store.fail_after_replace_and_durability_recheck();
        let failure = match closing.terminalize_after_release(deadline, Some(cancel)) {
            Err(e) => e,
            Ok(_) => panic!("expected ambiguous Terminal"),
        };
        cleanup_error_from_terminal(failure)
    } else {
        store.fail_after_replace_and_durability_recheck();
        close_running_owner(running, deadline, cancel).expect_err("ambiguous Closing")
    };
    let candidate = store.read(&fixture.plan.value).unwrap();
    (fixture, store, error, candidate)
}

#[cfg(windows)]
fn cleanup_context(error: &CleanupError) -> &ActivationFailureJournalContext {
    match error.owner.as_ref().unwrap() {
        CleanupFailureOwner::Running { owner, .. } => owner.owner.failure_context.as_ref().unwrap(),
        CleanupFailureOwner::Closing { owner, .. } => owner.owner.failure_context.as_ref().unwrap(),
    }
}

#[cfg(windows)]
fn retry_cleanup_with_budget(
    error: CleanupError,
    candidate: RuntimeSessionJournalV1,
    budget: &ActivationBudget,
) -> CleanupError {
    match error.owner.unwrap() {
        CleanupFailureOwner::Running { owner, .. } => {
            match adopt_known_closing_candidate(owner, candidate, budget) {
                Err(e) => e,
                Ok(_) => panic!("expected failed Closing adoption"),
            }
        }
        CleanupFailureOwner::Closing { owner, .. } => {
            retry_known_terminal_candidate(owner, candidate, budget)
                .expect_err("failed Terminal adoption")
        }
    }
}

#[cfg(windows)]
#[test]
fn durable_adoption_confirms_before_later_cancellation_and_rejects_replay() {
    for (terminal, expire) in [(false, false), (true, false), (false, true), (true, true)] {
        let (fixture, store, error, candidate) = ambiguous_cleanup_fixture(terminal);
        let predecessor = cleanup_context(&error).predecessor.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let deadline = std::time::Instant::now()
            + if expire {
                Duration::from_millis(250)
            } else {
                Duration::from_secs(30)
            };
        store.after_durable_read_for_test(move || {
            if expire {
                std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()));
            } else {
                signal.store(true, Ordering::Release);
            }
        });
        let budget = ActivationBudget::new(deadline, cancel);
        let error = retry_cleanup_with_budget(error, candidate.clone(), &budget);
        assert_eq!(cleanup_context(&error).candidate, candidate);
        assert_eq!(
            cleanup_context(&error).disposition,
            CasDisposition::ConfirmedLate
        );
        store.replace_journal_for_test(&predecessor);
        let before = store.owned_cas_calls_for_test();
        let error = retry_cleanup_error(error).expect_err("confirmed predecessor conflicts");
        assert_eq!(error.kind(), CleanupErrorKind::Conflict);
        assert_eq!(store.owned_cas_calls_for_test(), before);
        assert_eq!(store.read(&fixture.plan.value).unwrap(), predecessor);
        store.replace_journal_for_test(&candidate);
        retry_cleanup_error(error).expect("restored candidate recovers");
    }
}

#[cfg(windows)]
#[test]
fn durable_adoption_prewrite_retry_preserves_pending_candidate() {
    for (terminal, prewrite) in [(false, false), (true, false), (false, true), (true, true)] {
        let (_fixture, store, error, candidate) = ambiguous_cleanup_fixture(terminal);
        store.replace_journal_for_test(&cleanup_context(&error).predecessor);
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        if prewrite {
            store.fail_next_before_replace_for_test();
        } else {
            store.after_durable_read_for_test(move || signal.store(true, Ordering::Release));
        }
        let budget =
            ActivationBudget::new(std::time::Instant::now() + Duration::from_secs(30), cancel);
        let error = retry_cleanup_with_budget(error, candidate.clone(), &budget);
        assert_eq!(cleanup_context(&error).candidate, candidate);
        assert_eq!(
            cleanup_context(&error).disposition,
            CasDisposition::AmbiguousWrite
        );
        match error.owner.as_ref().unwrap() {
            CleanupFailureOwner::Running {
                committed_candidate,
                ..
            }
            | CleanupFailureOwner::Closing {
                committed_candidate,
                ..
            } => assert_eq!(committed_candidate.as_ref(), Some(&candidate)),
        }
        store.replace_journal_for_test(&candidate);
        retry_cleanup_error(error).expect("public retry discovers pending candidate");
    }
}

#[cfg(windows)]
#[test]
fn durable_adoption_reconcile_confirms_all_activation_phases_before_later_failure() {
    for state in [
        JournalState::Ready,
        JournalState::Launching,
        JournalState::Running,
        JournalState::ReconcileRequired,
    ] {
        let (reservations, ports) = reserve_coordinator_ports(1);
        let fixture = CoordinatorHttpFixture::new(&ports, &["ready"]);
        let store = fixture.plan.context.store.clone();
        let (fixture, prepared) = fixture.prepare();
        let budget = ActivationBudget::new(
            std::time::Instant::now() + Duration::from_secs(30),
            prepared.cancellation_arc(),
        );
        let activation = prepared
            .consume_for_activation_with_budget(&budget)
            .unwrap();
        let suspended = acquire_suspended_for_activation_with_budget(activation, &budget)
            .unwrap_or_else(|e| panic!("{}", e.detail));
        let owner = if state == JournalState::Ready {
            store.fail_after_replace_and_durability_recheck();
            match suspended.persist_ready_with_budget(&budget) {
                Err(e) => e.owner.unwrap(),
                Ok(_) => panic!("ambiguous Ready"),
            }
        } else {
            let ready = suspended
                .persist_ready_with_budget(&budget)
                .unwrap_or_else(|e| panic!("{}", e.detail));
            drop(reservations);
            if state == JournalState::Launching {
                store.fail_after_replace_and_durability_recheck();
                match ready.launch_with_budget(&budget) {
                    Err(e) => match e.owner.unwrap() {
                        ActivationLaunchOwner::Ready(o) => o.owner,
                        ActivationLaunchOwner::Launching(o) => o.owner,
                    },
                    Ok(_) => panic!("ambiguous Launching"),
                }
            } else if state == JournalState::Running {
                let launching = ready
                    .launch_with_budget(&budget)
                    .unwrap_or_else(|e| panic!("{}", e.detail));
                store.fail_after_replace_and_durability_recheck();
                match launching.promote_running_with_cancellation(
                    budget.deadline(),
                    Some(budget.cancellation_arc()),
                ) {
                    Err(e) => e.owner.owner,
                    Ok(_) => panic!("ambiguous Running"),
                }
            } else {
                store.fail_after_replace_and_durability_recheck();
                match ready.owner.cleanup_and_reconcile(&budget) {
                    Err(e) => e.owner,
                    Ok(_) => panic!("ambiguous Reconcile"),
                }
            }
        };
        let context = owner.failure_context.as_ref().unwrap();
        assert_eq!(context.disposition, CasDisposition::AmbiguousWrite);
        assert_eq!(context.candidate.state, state);
        let candidate = context.candidate.clone();
        let predecessor = context.predecessor.clone();
        // Complete native cleanup first without adopting the candidate, so
        // the controlled deadline measures only the durable adoption seam.
        store.fail_durable_read_for_test();
        let owner = match owner.cleanup_and_reconcile(&budget) {
            Err(e) => e.owner,
            Ok(_) => panic!("injected read failure"),
        };
        assert!(owner.native_cleanup_proven);
        let deadline = std::time::Instant::now() + Duration::from_millis(100);
        store.after_durable_read_for_test(move || {
            std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()))
        });
        let short = ActivationBudget::new(deadline, Arc::new(AtomicBool::new(false)));
        let failure = match owner.cleanup_and_reconcile(&short) {
            Err(e) => e,
            Ok(_) => panic!("late adoption"),
        };
        assert_eq!(failure.committed_candidate.as_ref(), Some(&candidate));
        assert_eq!(
            failure.candidate_disposition,
            Some(CasDisposition::ConfirmedLate)
        );
        let context = failure.owner.failure_context.as_ref().unwrap();
        assert_eq!(context.candidate, candidate);
        assert_eq!(context.disposition, CasDisposition::ConfirmedLate);
        store.replace_journal_for_test(&predecessor);
        let before = store.owned_cas_calls_for_test();
        let failure = match failure.owner.cleanup_and_reconcile(&budget) {
            Err(e) => e,
            Ok(_) => panic!("confirmed predecessor"),
        };
        assert_eq!(failure.kind, ActivationReconcileFailureKind::Conflict);
        assert_eq!(store.owned_cas_calls_for_test(), before);
        assert_eq!(store.read(&fixture.plan.value).unwrap(), predecessor);
        assert!(failure.owner.native_cleanup_proven);
        store.replace_journal_for_test(&candidate);
        let recovered = failure
            .owner
            .cleanup_and_reconcile(&budget)
            .unwrap_or_else(|e| panic!("{}", e.detail));
        assert_eq!(recovered.journal.state, JournalState::ReconcileRequired);
    }
}

#[cfg(windows)]
#[test]
fn durable_adoption_terminal_later_read_failure_keeps_confirmation_and_proofs() {
    let (_fixture, store, error, candidate) = ambiguous_cleanup_fixture(true);
    let predecessor = cleanup_context(&error).predecessor.clone();
    let fault_store = store.clone();
    store.after_durable_read_for_test(move || fault_store.fail_exact_durability_for_test());
    let error = retry_cleanup_error(error).expect_err("second read fails");
    assert_eq!(
        cleanup_context(&error).disposition,
        CasDisposition::ConfirmedLate
    );
    match error.owner.as_ref().unwrap() {
        CleanupFailureOwner::Closing { owner, .. } => {
            assert!(owner.native_cleanup_proof.is_some());
            // Terminalization invalidates the earlier live listener snapshot;
            // the exact candidate carries the fresh complete release proof.
            assert!(owner.listener_release_proof.is_none());
            assert!(candidate.proof.as_ref().unwrap().listeners_released);
            assert!(owner.staging_release_proof.is_some());
        }
        _ => panic!("lost Closing owner"),
    }
    store.replace_journal_for_test(&predecessor);
    let before = store.owned_cas_calls_for_test();
    let error = retry_cleanup_error(error).expect_err("confirmed predecessor");
    assert_eq!(error.kind(), CleanupErrorKind::Conflict);
    assert_eq!(store.owned_cas_calls_for_test(), before);
    store.replace_journal_for_test(&candidate);
    retry_cleanup_error(error).expect("restore exact Terminal");
}

#[cfg(windows)]
#[test]
fn durable_adoption_new_reconcile_attempt_supersedes_confirmed_ready() {
    let fixture = CoordinatorActivationFixture::new();
    let store = fixture.plan.context.store.clone();
    let (_fixture, prepared) = fixture.prepare();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        prepared.cancellation_arc(),
    );
    let activation = prepared
        .consume_for_activation_with_budget(&budget)
        .unwrap();
    let suspended = acquire_suspended_for_activation_with_budget(activation, &budget)
        .unwrap_or_else(|e| panic!("{}", e.detail));
    store.fail_after_replace_and_durability_recheck();
    let owner = match suspended.persist_ready_with_budget(&budget) {
        Err(e) => e.owner.unwrap(),
        Ok(_) => panic!("ambiguous Ready"),
    };
    let ready = owner.failure_context.as_ref().unwrap().candidate.clone();
    store.fail_after_replace_and_durability_recheck();
    let failure = match owner.cleanup_and_reconcile(&budget) {
        Err(e) => e,
        Ok(_) => panic!("ambiguous Reconcile"),
    };
    let context = failure.owner.failure_context.as_ref().unwrap();
    assert_eq!(context.predecessor, ready);
    assert_eq!(context.candidate.state, JournalState::ReconcileRequired);
    assert_eq!(context.disposition, CasDisposition::AmbiguousWrite);
    assert_eq!(
        failure.committed_candidate.as_ref(),
        Some(&context.candidate)
    );
    assert_eq!(
        failure.candidate_disposition,
        Some(CasDisposition::AmbiguousWrite)
    );
    failure
        .owner
        .cleanup_and_reconcile(&budget)
        .unwrap_or_else(|e| panic!("{}", e.detail));
}

#[cfg(windows)]
#[test]
fn scheduled_fixture_permit_is_transferred_once_before_scenario_budget() {
    let fixture = CoordinatorActivationFixture::new();
    let (_fixture, prepared) = fixture.prepare();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(30),
        prepared.cancellation_arc(),
    );
    let activation = prepared
        .consume_for_activation_with_budget(&budget)
        .unwrap();
    let owner = acquire_suspended_for_activation_with_budget(activation, &budget)
        .unwrap_or_else(|e| panic!("{}", e.detail));
    assert!(owner._http_fixture_permit.is_some());
    assert!(
        _fixture.admission.take().is_none(),
        "native owner took the single scheduled permit"
    );
    let mut owner = owner;
    owner
        .cleanup_native_for_closing(budget.deadline(), None)
        .expect("native cleanup");
    assert!(owner.native_cleanup_proven);
    assert!(owner._http_fixture_permit.is_none());
}

#[cfg(windows)]
#[test]
fn durable_adoption_failed_flush_does_not_confirm_matching_bytes() {
    for terminal in [false, true] {
        let (_fixture, store, error, candidate) = ambiguous_cleanup_fixture(terminal);
        store.fail_durable_read_for_test();
        let error = retry_cleanup_error(error).expect_err("failed durability");
        assert_eq!(
            cleanup_context(&error).disposition,
            CasDisposition::AmbiguousWrite
        );
        store.replace_journal_for_test(&cleanup_context(&error).predecessor);
        retry_cleanup_error(error).expect("unconfirmed predecessor remains retryable");
        assert_eq!(
            candidate.state,
            if terminal {
                JournalState::Terminal
            } else {
                JournalState::Closing
            }
        );
    }
}

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
fn http_fixture_limiter_bounds_wait_and_releases_for_reacquisition() {
    let limiter = HttpFixtureLimiter::new(1);
    let first = limiter
        .acquire(Duration::from_millis(40))
        .expect("local limiter first permit");
    let started = std::time::Instant::now();
    match limiter.acquire(Duration::from_millis(25)) {
        Err(HttpFixturePermitError::Timeout) => {}
        Err(HttpFixturePermitError::Poisoned) => panic!("local limiter was poisoned"),
        Ok(_) => panic!("local limiter exceeded its capacity"),
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "bounded limiter wait took too long"
    );
    drop(first);
    let second = limiter
        .acquire(Duration::from_millis(40))
        .expect("permit should be reacquirable after Drop");
    drop(second);
}

#[cfg(windows)]
#[test]
fn unbudgeted_fixture_admission_waits_for_available_permit() {
    let limiter = HttpFixtureLimiter::new(1);
    let first = limiter
        .acquire_available()
        .expect("local limiter first permit");
    let (sender, receiver) = std::sync::mpsc::channel();
    let waiter = {
        let limiter = Arc::clone(&limiter);
        std::thread::spawn(move || {
            let permit = limiter.acquire_available().expect("queued permit");
            sender.send(()).expect("queued admission signal");
            permit
        })
    };
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    drop(first);
    receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("queued admission should proceed after release");
    drop(waiter.join().expect("queued admission thread"));
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
    let deadline = std::time::Instant::now() + FIXTURE_EVENTUAL_WAIT;
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
    let deadline = std::time::Instant::now() + FIXTURE_EVENTUAL_WAIT;
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
    let deadline = std::time::Instant::now() + FIXTURE_EVENTUAL_WAIT;
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
    let mut owner = failure
        .owner
        .expect("native failure must retain group owner");
    owner
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
        .unwrap_or_else(|failure| panic!("group cleanup proof: {failure}"))
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
        .expect("cleanup after cancelled observation");
    assert!(proof.roots_reaped);
    let _ = std::fs::remove_file(marker);
}

#[cfg(windows)]
#[test]
fn direct_root_loopback_listener_is_observed_by_retained_identity() {
    let port = free_loopback_port();
    let mut commands = [listener_command(port, "127.0.0.1")];
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended listener root")
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("resumed listener root");
    let expected_identity = group.roots[0].identity.expect("root identity");
    let observation = wait_for_listener_observation(&mut group, &[port]);
    assert_eq!(observation.root_count(), 1);
    let root = observation.root(0).expect("listener root");
    assert_eq!(root.ordinal, 0);
    assert_eq!(root.port, port);
    assert_eq!(root.identity, expected_identity);
    let proof = group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
        .expect("listener group cleanup");
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended listener roots")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("resumed group");
    let error = wait_for_listener_error(&mut group, &[port], "foreign");
    assert!(error.contains("foreign"));
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    let proof = group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("resumed group");
    let error = wait_for_listener_error(&mut group, &[port], "wildcard");
    assert!(error.contains("wildcard"));
    let proof = group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended short-lived root")
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("resumed short-lived root");
    let deadline = std::time::Instant::now() + FIXTURE_EVENTUAL_WAIT;
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
    let proof = group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
        .expect("dead root cleanup");
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
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
    let mut group = group
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("all roots should resume together");
    wait_for_marker(&first_marker, true);
    wait_for_marker(&second_marker, true);
    let proof = group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
fn activation_budget_expires_before_job_creation_without_native_owner() {
    let first_marker = group_marker_path("activation-budget-before-job-first");
    let second_marker = group_marker_path("activation-budget-before-job-second");
    let mut commands = [
        marker_command(&first_marker, true),
        marker_command(&second_marker, true),
    ];
    let cancellation = Arc::new(AtomicBool::new(false));
    let budget = ActivationBudget::new(
        std::time::Instant::now() - Duration::from_millis(1),
        cancellation,
    );
    let failure = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |_, _| Ok(()))
        .expect_err("expired activation must stop before Job creation");
    assert_eq!(failure.kind(), GroupNativeFailureKind::Setup);
    assert!(failure.owner.is_none());
    wait_for_marker(&first_marker, false);
    wait_for_marker(&second_marker, false);
    let _ = std::fs::remove_file(first_marker);
    let _ = std::fs::remove_file(second_marker);
}

#[cfg(windows)]
#[test]
fn activation_callback_cancellation_before_first_root_starts_no_child() {
    let first_marker = group_marker_path("activation-cancel-callback-first");
    let mut commands = [marker_command(&first_marker, true)];
    let cancellation = Arc::new(AtomicBool::new(false));
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(15),
        Arc::clone(&cancellation),
    );
    let failure = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |ordinal, _| {
        assert_eq!(ordinal, 0);
        cancellation.store(true, Ordering::Release);
        Ok(())
    })
    .expect_err("callback cancellation must block the first child");
    assert_eq!(failure.kind(), GroupNativeFailureKind::Setup);
    let mut owner = failure
        .owner
        .expect("Job owner retained after callback cancel");
    assert!(owner.roots.is_empty());
    assert_eq!(owner.unacquired_root_nonces.len(), 1);
    let proof = owner
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
        .expect("empty Job cleanup after callback cancellation");
    assert!(proof.roots_reaped);
    assert!(proof.descendants_terminated);
    wait_for_marker(&first_marker, false);
    let _ = std::fs::remove_file(first_marker);
}

#[cfg(windows)]
#[test]
fn activation_callback_cancellation_between_roots_retains_prior_owner() {
    let first_marker = group_marker_path("activation-cancel-callback-prior");
    let second_marker = group_marker_path("activation-cancel-callback-next");
    let mut commands = [
        marker_command(&first_marker, true),
        marker_command(&second_marker, true),
    ];
    let cancellation = Arc::new(AtomicBool::new(false));
    let budget = ActivationBudget::new(
        std::time::Instant::now() + Duration::from_secs(15),
        Arc::clone(&cancellation),
    );
    let failure = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |ordinal, _| {
        if ordinal == 1 {
            cancellation.store(true, Ordering::Release);
        }
        Ok(())
    })
    .expect_err("callback cancellation must block the next child");
    assert_eq!(failure.kind(), GroupNativeFailureKind::Setup);
    let owner = failure.owner.as_ref().expect("Job owner retained");
    assert_eq!(owner.roots.len(), 1);
    assert_eq!(owner.unacquired_root_nonces.len(), 1);
    assert!(owner.roots[0].identity.is_some());
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
fn activation_callback_deadline_before_first_root_starts_no_child() {
    let first_marker = group_marker_path("activation-deadline-callback-first");
    let mut commands = [marker_command(&first_marker, true)];
    let cancellation = Arc::new(AtomicBool::new(false));
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    let callback_called = Arc::new(AtomicBool::new(false));
    let callback_called_in_hook = Arc::clone(&callback_called);
    let budget = ActivationBudget::new(deadline, cancellation);
    let failure = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |ordinal, _| {
        assert_eq!(ordinal, 0);
        callback_called_in_hook.store(true, Ordering::Release);
        while std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    })
    .expect_err("callback deadline expiry must block the first child");
    assert!(callback_called.load(Ordering::Acquire));
    assert_eq!(failure.kind(), GroupNativeFailureKind::Setup);
    let mut owner = failure
        .owner
        .expect("Job owner retained after callback expiry");
    assert!(owner.roots.is_empty());
    assert_eq!(owner.unacquired_root_nonces.len(), 1);
    let proof = owner
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
        .expect("empty Job cleanup after callback expiry");
    assert!(proof.roots_reaped);
    assert!(proof.descendants_terminated);
    wait_for_marker(&first_marker, false);
    let _ = std::fs::remove_file(first_marker);
}

#[cfg(windows)]
#[test]
fn activation_cancellation_between_roots_retains_owner_for_forced_cleanup() {
    let first_marker = group_marker_path("activation-cancel-between-roots-first");
    let second_marker = group_marker_path("activation-cancel-between-roots-second");
    let mut commands = [
        marker_command(&first_marker, true),
        marker_command(&second_marker, true),
    ];
    let cancellation = Arc::new(AtomicBool::new(false));
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let budget = ActivationBudget::new(deadline, Arc::clone(&cancellation));
    let group = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |_, _| Ok(()))
        .expect("budgeted group acquisition");
    inject_cancellation_before_resume_root_for_test(1);
    let failure = group
        .resume_all_with_budget(&budget)
        .expect_err("cancellation between roots must retain the group");
    assert_eq!(failure.kind(), GroupNativeFailureKind::Resume);
    assert!(cancellation.load(Ordering::Acquire));
    let owner = failure.owner.expect("cancelled resume must retain owner");
    wait_for_marker(&first_marker, true);
    wait_for_marker(&second_marker, false);
    let mut owner = owner;
    let proof = owner
        .cleanup_and_retain_proof_after_activation_failure(deadline)
        .expect("forced cleanup must ignore cancellation while closing Job");
    assert_eq!(proof.roots.len(), 2);
    assert_ne!(proof.job_nonce, [0_u8; NATIVE_NONCE_BYTES]);
    assert!(owner.cleanup_complete);
    let _ = std::fs::remove_file(first_marker);
    let _ = std::fs::remove_file(second_marker);
}

#[cfg(windows)]
#[test]
fn activation_cancellation_after_resume_retains_owner_for_forced_cleanup() {
    let first_marker = group_marker_path("activation-cancel-after-resume-first");
    let second_marker = group_marker_path("activation-cancel-after-resume-second");
    let mut commands = [
        marker_command(&first_marker, true),
        marker_command(&second_marker, true),
    ];
    let cancellation = Arc::new(AtomicBool::new(false));
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let budget = ActivationBudget::new(deadline, Arc::clone(&cancellation));
    let group = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |_, _| Ok(()))
        .expect("budgeted group acquisition");
    inject_cancellation_after_resume_root_for_test(0);
    let failure = group
        .resume_all_with_budget(&budget)
        .expect_err("cancellation after a root resume must retain the group");
    assert_eq!(failure.kind(), GroupNativeFailureKind::Resume);
    assert!(cancellation.load(Ordering::Acquire));
    let owner = failure.owner.expect("cancelled resume must retain owner");
    wait_for_marker(&first_marker, true);
    wait_for_marker(&second_marker, false);
    let mut owner = owner;
    let proof = owner
        .cleanup_and_retain_proof_after_activation_failure(deadline)
        .expect("forced cleanup must close a partially resumed group");
    assert_eq!(proof.roots.len(), 2);
    assert!(owner.cleanup_complete);
    let _ = std::fs::remove_file(first_marker);
    let _ = std::fs::remove_file(second_marker);
}

#[cfg(windows)]
#[test]
fn activation_failure_cleanup_terminates_owned_job_after_cancellation() {
    let marker = group_marker_path("activation-forced-cleanup");
    let mut commands = [marker_command(&marker, true)];
    let cancellation = Arc::new(AtomicBool::new(false));
    let mut group = SuspendedGroup::spawn_with_budget(
        &mut commands,
        &ActivationBudget::new(
            std::time::Instant::now() + Duration::from_secs(15),
            Arc::clone(&cancellation),
        ),
        |_, _| Ok(()),
    )
    .expect("budgeted group acquisition");
    cancellation.store(true, Ordering::Release);
    let proof = group
        .cleanup_inner_for_activation_failure(std::time::Instant::now() + Duration::from_secs(5))
        .expect("owned Job cleanup must proceed after cancellation");
    assert!(proof.roots_reaped);
    assert!(proof.descendants_terminated);
    let _ = std::fs::remove_file(marker);
}

#[cfg(windows)]
#[test]
fn postspawn_budget_expiry_terminates_unassigned_exact_child_without_false_cleanup_proof() {
    let marker = group_marker_path("activation-postspawn-expiry");
    let mut commands = [marker_command(&marker, true)];
    let cancellation = Arc::new(AtomicBool::new(false));
    // The two second absolute budget gives CreateProcess adequate room
    // under a loaded Windows test runner. The hook then waits on that
    // same budget after confirming the exact Child exists, making expiry
    // deterministic without a second production deadline.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    expire_after_spawn_before_assignment_for_test();
    let budget = ActivationBudget::new(deadline, Arc::clone(&cancellation));
    let failure = SuspendedGroup::spawn_with_budget(&mut commands, &budget, |_, _| Ok(()))
        .expect_err("postspawn budget expiry must retain the unassigned root");
    let mut owner = failure.owner.expect("unassigned child owner retained");
    assert_eq!(owner.roots.len(), 1);
    assert!(owner.roots[0].identity.is_none());
    assert!(owner.roots[0]
        .child
        .try_wait()
        .expect("pre-assignment child liveness")
        .is_none());

    let cleanup = owner.cleanup_and_retain_proof_after_activation_failure(deadline);
    assert!(
        cleanup.is_err(),
        "an unassigned root must not fabricate cleanup proof"
    );
    let reap_deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if owner.roots[0]
            .child
            .try_wait()
            .expect("exact child liveness after forced termination")
            .is_some()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < reap_deadline,
            "the exact pre-assignment child survived forced termination"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = std::fs::remove_file(marker);
}

#[cfg(windows)]
#[test]
fn single_root_private_group_uses_the_same_suspend_resume_boundary() {
    let marker = group_marker_path("single-root");
    let mut commands = [marker_command(&marker, true)];
    let group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("single group root should spawn");
    wait_for_marker(&marker, false);
    let mut group = group
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("single group root should resume");
    wait_for_marker(&marker, true);
    let proof = group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("group roots should spawn");
    let thread =
        open_suspended_primary_thread(&group.roots[1].child).expect("second root primary thread");
    assert_eq!(unsafe { SuspendThread(thread.raw()) }, 1);
    assert_eq!(unsafe { ResumeThread(thread.raw()) }, 2);
    assert_eq!(unsafe { ResumeThread(thread.raw()) }, 1);

    let failure = group
        .resume_all_with_budget(&activation_budget_for_test())
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("group root should spawn")
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("group root should resume");
    wait_for_marker(&group_marker, true);
    group
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("group root should spawn")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_inner_with_budget(activation_budget_for_test().deadline(), None)
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
    let failure =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect_err("second spawn failure");
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
fn activation_spawn_failure_with_zero_roots_proves_job_cleanup_without_identity() {
    let mut command = Command::new("capture-runtime-command-that-does-not-exist.exe");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let failure = SuspendedGroup::spawn_with_budget(
        std::slice::from_mut(&mut command),
        &activation_budget_for_test(),
        |_, _| Ok(()),
    )
    .expect_err("first CreateProcess failure");
    assert_eq!(failure.kind(), GroupNativeFailureKind::Spawn);
    let mut owner = failure
        .owner
        .expect("Job owner survives zero-root spawn failure");
    assert!(owner.roots.is_empty());
    assert_eq!(owner.unacquired_root_nonces.len(), 1);

    let proof = owner
        .cleanup_and_retain_proof_after_activation_failure(
            std::time::Instant::now() + Duration::from_secs(5),
        )
        .expect("activation cleanup proof for empty root set");
    assert!(proof.activation_failure_only);
    assert!(proof.roots.is_empty());
    assert!(owner.cleanup_complete);
    assert_eq!(
        owner
            .job
            .as_ref()
            .expect("retained Job")
            .active_processes()
            .expect("Job process query"),
        0
    );
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
    let mut owner = failure.owner.expect("identity failure owner");
    let proof = owner
        .cleanup_and_retain_proof_after_activation_failure(
            std::time::Instant::now() + Duration::from_secs(5),
        )
        .expect("activation cleanup proof with unknown child identity");
    assert!(proof.activation_failure_only);
    assert!(
        proof.roots.is_empty(),
        "unknown identity is never fabricated"
    );
    assert!(owner.cleanup_complete);
    assert!(owner.roots[0]
        .child
        .try_wait()
        .expect("exact child wait")
        .is_some());
    let _ = std::fs::remove_file(marker);
}

#[cfg(windows)]
#[test]
fn activation_spawn_failure_keeps_unacquired_suffix_outside_cleanup_proof() {
    let first_marker = group_marker_path("activation-spawn-first");
    let mut commands = [marker_command(&first_marker, true), {
        let mut command = Command::new("capture-runtime-command-that-does-not-exist.exe");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }];
    let failure =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect_err("second spawn failure");
    let mut owner = failure.owner.expect("partial group owner");
    assert_eq!(owner.roots.len(), 1);
    assert_eq!(owner.unacquired_root_nonces.len(), 1);
    wait_for_marker(&first_marker, false);

    let proof = owner
        .cleanup_and_retain_proof_after_activation_failure(
            std::time::Instant::now() + Duration::from_secs(5),
        )
        .expect("activation cleanup proof with unacquired suffix");
    assert!(proof.activation_failure_only);
    assert_eq!(proof.roots.len(), 1);
    assert_eq!(owner.unacquired_root_nonces.len(), 1);
    assert!(owner.cleanup_complete);
    assert!(owner.roots[0]
        .child
        .try_wait()
        .expect("exact child wait")
        .is_some());
    let _ = std::fs::remove_file(first_marker);
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
    let failure = failure
        .resume_all_with_budget(&activation_budget_for_test())
        .expect_err("second resume failure");
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
    let group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
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
        .cleanup_and_retain_proof(activation_budget_for_test().deadline(), None)
        .err()
        .expect("injected cleanup failure");
    assert!(cleanup_failure.contains("Injected suspended group cleanup failure"));
    assert_eq!(group.job_nonce, job_nonce);
    assert_eq!(group.roots[0].root_nonce, root_nonce);
    assert_eq!(group.roots[0].identity, Some(root_identity));
    let proof = group
        .cleanup_and_retain_proof(activation_budget_for_test().deadline(), None)
        .expect("cleanup retry proof");
    assert!(group.cleanup_complete);
    assert_eq!(proof.roots.len(), 2);
    assert_eq!(proof.roots[0].identity, root_identity);
    assert_eq!(
        group
            .job
            .as_ref()
            .expect("retained Job")
            .active_processes()
            .expect("Job query"),
        0
    );
    for root in &mut group.roots {
        assert!(root.child.try_wait().expect("root reaped").is_some());
    }
    let _ = std::fs::remove_file(first_marker);
    let _ = std::fs::remove_file(second_marker);
}

#[cfg(windows)]
#[test]
fn activation_cleanup_job_failure_retains_owner_for_a_fresh_retry() {
    let marker = group_marker_path("activation-job-failure");
    let mut commands = [marker_command(&marker, true)];
    let mut group =
        SuspendedGroup::spawn_with_budget(&mut commands, &activation_budget_for_test(), |_, _| {
            Ok(())
        })
        .expect("suspended group")
        .resume_all_with_budget(&activation_budget_for_test())
        .expect("resumed group");
    wait_for_marker(&marker, true);
    group
        .job
        .as_mut()
        .expect("group Job")
        .inject_termination_failure();

    let first = match group.cleanup_and_retain_proof_after_activation_failure(
        std::time::Instant::now() + Duration::from_secs(5),
    ) {
        Ok(_) => panic!("injected Job failure unexpectedly proved cleanup"),
        Err(error) => error,
    };
    assert!(first.contains("Injected Job termination failure"));
    assert!(!group.cleanup_complete);
    assert!(group.roots[0]
        .child
        .try_wait()
        .expect("exact child wait")
        .is_some());

    let proof = group
        .cleanup_and_retain_proof_after_activation_failure(
            std::time::Instant::now() + Duration::from_secs(5),
        )
        .expect("fresh activation cleanup retry");
    assert!(proof.activation_failure_only);
    assert_eq!(proof.roots.len(), 1);
    assert!(group.cleanup_complete);
    let _ = std::fs::remove_file(marker);
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

#[cfg(windows)]
fn restart_root_for_identity(identity: OwnedProcessIdentity) -> JournalRoot {
    JournalRoot {
        ordinal: 0,
        role: "root".into(),
        root_ref_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        root_generation: 1,
        root_nonce: "root-nonce".into(),
        pid: identity.pid,
        creation_identity: CreationIdentity {
            kind: "windows-process-creation".into(),
            value: format!("{:016x}", identity.creation_time),
        },
        state: RootState::Running,
        reserved_listener_identity: "listener-nonce".into(),
        loopback_port: 45_001,
        live_listener_readiness: Some("readiness".into()),
        started_at: "2026-01-01T00:00:00Z".into(),
    }
}

#[cfg(windows)]
struct RestartObservationChild {
    child: Option<Child>,
    identity: OwnedProcessIdentity,
    reaped: bool,
}

#[cfg(windows)]
impl RestartObservationChild {
    fn spawn(mut command: Command) -> Self {
        command.creation_flags(CREATE_NO_WINDOW);
        let child = command.spawn().expect("restart observation child");
        let mut owned = Self::from_spawned(child);
        let pid = owned.identity.pid;
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        assert!(!handle.is_null(), "child process handle");
        let handle = ScopedWindowsHandle(handle as usize);
        let identity = process_identity_from_handle(handle.raw(), pid).expect("child identity");
        owned.identity = identity;
        owned
    }

    fn from_spawned(child: Child) -> Self {
        Self {
            identity: OwnedProcessIdentity {
                pid: child.id(),
                creation_time: 0,
            },
            child: Some(child),
            reaped: false,
        }
    }

    fn spawn_then_inject_identity_panic(mut command: Command) -> u32 {
        command.creation_flags(CREATE_NO_WINDOW);
        let child = command.spawn().expect("restart identity fault child");
        let pid = child.id();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _owned = Self::from_spawned(child);
            panic!("injected restart identity capture failure");
        }));
        assert!(result.is_err(), "identity fault must unwind the owner");
        pid
    }

    fn exited(exit_code: u32) -> Self {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", &format!("exit /B {exit_code}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Self::spawn(command)
    }

    fn is_alive(&mut self) -> bool {
        self.child
            .as_mut()
            .expect("restart observation child")
            .try_wait()
            .expect("child status")
            .is_none()
    }

    fn wait(&mut self) {
        if self.reaped {
            return;
        }
        self.child
            .as_mut()
            .expect("restart observation child")
            .wait()
            .expect("child reap");
        self.reaped = true;
    }
}

#[cfg(windows)]
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

#[cfg(windows)]
#[test]
fn restart_observer_rejects_zero_creation_before_native_query() {
    let root = restart_root_for_identity(OwnedProcessIdentity {
        pid: 4,
        creation_time: 0,
    });
    assert_eq!(
        observe_restart_root_process(
            &root,
            std::time::Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        ),
        Err(RestartNativeObservationError::InvalidRecord)
    );
}

#[cfg(windows)]
#[test]
fn restart_observer_identity_failure_reaps_the_exact_spawned_child() {
    let mut command = powershell_command("Start-Sleep -Seconds 30");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let pid = RestartObservationChild::spawn_then_inject_identity_panic(command);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            assert_eq!(unsafe { GetLastError() }, ERROR_INVALID_PARAMETER);
            break;
        }
        let handle = ScopedWindowsHandle(handle as usize);
        assert_eq!(
            unsafe { WaitForSingleObject(handle.raw(), 0) },
            WAIT_OBJECT_0,
            "the injected identity-failure child must be terminated before its owner drops"
        );
        if std::time::Instant::now() >= deadline {
            panic!("the exact injected identity-failure child was not reaped");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[cfg(windows)]
fn restart_observer_keeps_access_denied_distinct_from_other_query_errors() {
    assert_eq!(
        restart_native_query_error_for_code(ERROR_ACCESS_DENIED),
        RestartNativeObservationError::RootAccessDenied
    );
    assert_eq!(
        restart_native_query_error_for_code(ERROR_INVALID_PARAMETER),
        RestartNativeObservationError::RootUnqueryable
    );
}

#[cfg(windows)]
#[test]
fn restart_observer_treats_signaled_exit_code_259_as_absent() {
    let mut child = RestartObservationChild::exited(259);
    child.wait();
    assert_eq!(
        observe_restart_root_process(
            &restart_root_for_identity(child.identity),
            std::time::Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .expect("exact exited root observation"),
        RestartRootProcessState::Absent
    );
}

#[cfg(windows)]
fn spawn_restart_observation_child() -> RestartObservationChild {
    let mut command = powershell_command("Start-Sleep -Seconds 30");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    RestartObservationChild::spawn(command)
}

#[cfg(windows)]
#[test]
fn restart_observer_reports_exact_exited_root_as_absent() {
    let mut child = RestartObservationChild::exited(17);
    child.wait();

    assert_eq!(
        observe_restart_root_process(
            &restart_root_for_identity(child.identity),
            std::time::Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .expect("exact exited root observation"),
        RestartRootProcessState::Absent
    );
}

#[cfg(windows)]
#[test]
fn restart_observer_reports_live_root_without_touching_it() {
    let mut child = spawn_restart_observation_child();
    let state = observe_restart_root_process(
        &restart_root_for_identity(child.identity),
        std::time::Instant::now() + Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .expect("live root observation");
    assert_eq!(state, RestartRootProcessState::Present);
    assert!(child.is_alive());
}

#[cfg(windows)]
#[test]
fn restart_observer_classifies_creation_mismatch_as_reused_pid() {
    let mut child = spawn_restart_observation_child();
    let mut mismatched = restart_root_for_identity(child.identity);
    mismatched.creation_identity.value = format!("{:016x}", child.identity.creation_time + 1);
    assert_eq!(
        observe_restart_root_process(
            &mismatched,
            std::time::Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        ),
        Err(RestartNativeObservationError::RootReused)
    );
    assert!(child.is_alive());
}

#[cfg(windows)]
fn encoded_listener_table(rows: &[MIB_TCPROW_OWNER_PID]) -> Vec<u8> {
    let row_size = size_of::<MIB_TCPROW_OWNER_PID>();
    let mut table = vec![0_u8; size_of::<u32>() + rows.len() * row_size];
    table[..size_of::<u32>()].copy_from_slice(&(rows.len() as u32).to_ne_bytes());
    for (index, row) in rows.iter().enumerate() {
        unsafe {
            ptr::write_unaligned(
                table
                    .as_mut_ptr()
                    .add(size_of::<u32>() + index * row_size)
                    .cast::<MIB_TCPROW_OWNER_PID>(),
                *row,
            );
        }
    }
    table
}

#[cfg(windows)]
#[test]
fn listener_parsers_ignore_row_state_reported_by_the_listener_table() {
    let identity = OwnedProcessIdentity {
        pid: 42,
        creation_time: 100,
    };
    let root = restart_root_for_identity(identity);
    let mut row = MIB_TCPROW_OWNER_PID {
        dwState: MIB_TCP_STATE_LISTEN as u32,
        dwLocalAddr: 0x0100_007f,
        dwLocalPort: u32::from(root.loopback_port.to_be()),
        dwRemoteAddr: 0,
        dwRemotePort: 0,
        dwOwningPid: identity.pid,
    };
    let table = encoded_listener_table(&[row]);
    assert!(parse_listener_table(&table, &[identity], &[root.loopback_port]).is_ok());

    // Windows 11 build 26300 reports 0 and FIN_WAIT1 (6) for rows of the
    // listener-only table; the parsers must rely on address, port and owner.
    for state in [
        0,
        MIB_TCP_STATE_LISTEN as u32,
        MIB_TCP_STATE_CLOSED as u32,
        MIB_TCP_STATE_ESTAB as u32,
        MIB_TCP_STATE_FIN_WAIT1 as u32,
    ] {
        row.dwState = state;
        let table = encoded_listener_table(&[row]);
        assert!(
            parse_listener_table(&table, &[identity], &[root.loopback_port]).is_ok(),
            "TCP state {state} of a listener-table row must not block readiness"
        );
        assert_eq!(
            parse_restart_listener_absence(&table, std::slice::from_ref(&root)),
            Err(RestartNativeObservationError::ListenerPresent),
            "TCP state {state} must not hide the owned listener during restart"
        );
    }
    row.dwLocalAddr = 0;
    let wildcard = encoded_listener_table(&[row]);
    assert!(parse_listener_table(&wildcard, &[identity], &[root.loopback_port]).is_err());
}

#[cfg(windows)]
#[test]
fn restart_listener_absence_rejects_target_foreign_and_wildcard_rows() {
    let identity = OwnedProcessIdentity {
        pid: 42,
        creation_time: 100,
    };
    let root = restart_root_for_identity(identity);
    let empty = encoded_listener_table(&[]);
    assert!(parse_restart_listener_absence(&empty, std::slice::from_ref(&root)).is_ok());

    let mut row = MIB_TCPROW_OWNER_PID {
        dwState: MIB_TCP_STATE_LISTEN as u32,
        dwLocalAddr: 0x0100_007f,
        dwLocalPort: u32::from(root.loopback_port.to_be()),
        dwRemoteAddr: 0,
        dwRemotePort: 0,
        dwOwningPid: root.pid,
    };
    let target = encoded_listener_table(&[row]);
    assert_eq!(
        parse_restart_listener_absence(&target, std::slice::from_ref(&root)),
        Err(RestartNativeObservationError::ListenerPresent)
    );

    row.dwOwningPid = root.pid + 1;
    let foreign = encoded_listener_table(&[row]);
    assert_eq!(
        parse_restart_listener_absence(&foreign, std::slice::from_ref(&root)),
        Err(RestartNativeObservationError::ListenerAmbiguous)
    );

    row.dwOwningPid = root.pid;
    row.dwLocalAddr = 0;
    let wildcard = encoded_listener_table(&[row]);
    assert_eq!(
        parse_restart_listener_absence(&wildcard, std::slice::from_ref(&root)),
        Err(RestartNativeObservationError::ListenerAmbiguous)
    );
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
    assert!(classify_terminated_observation(expected, expected, 0, Err("query".into())).is_err());
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
    while session.try_wait().expect("root status").is_none() && std::time::Instant::now() < deadline
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
