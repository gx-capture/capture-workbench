#![cfg(windows)]

use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        mpsc,
        mpsc::Sender,
        Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, MoveFileExW, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
    },
    System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    },
};

use capture_sidecar_launcher::{
    build_immutable_group_plan, ActivationCancelHandle, BindingAttemptId, CloseReason,
    CompleteGroupBinding, CompleteGroupBindingReceiptV1, GroupLease, GroupLifecycleState,
    GroupObservation, GroupProof, GroupRootPlanInput, ImmutableGroupPlan, LaunchError,
    LaunchErrorKind, LaunchPhase, OwnedRuntimeSession, PersistError, PreparedGroup,
    ReconcileRefSink, SidecarLaunchSpec, SidecarManifest, VerifiedGroupBinding,
};
use serde_json::json;
use sha2::{Digest, Sha256};

const SCHEMA_FILE_NAME: &str = "capture-document-v2.schema.json";
const SCHEMA_SHA256: &str = "850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335";
const FIXTURE_TOKEN: &str = "public-r3-fixture-token-012345678901234567890123456789";

struct Sink {
    binding: Mutex<Option<CompleteGroupBinding>>,
}

impl Sink {
    fn new() -> Self {
        Self {
            binding: Mutex::new(None),
        }
    }
}

impl ReconcileRefSink for Sink {
    fn persist(
        &self,
        _binding_attempt_id: &BindingAttemptId,
        binding: &CompleteGroupBinding,
    ) -> Result<(), PersistError> {
        *self.binding.lock().expect("sink lock") = Some(binding.clone());
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
        expected: &CompleteGroupBinding,
        read_back: &CompleteGroupBindingReceiptV1,
    ) -> Result<VerifiedGroupBinding, PersistError> {
        if read_back.binding() != expected {
            return Err(PersistError::Rejected);
        }
        VerifiedGroupBinding::from_receipt(read_back.clone())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum FixtureAdmissionError {
    Timeout,
}

struct FixtureLimiter {
    available: Mutex<usize>,
    wake: Condvar,
}
struct FixturePermit(Arc<FixtureLimiter>);
impl FixtureLimiter {
    fn acquire(
        self: &Arc<Self>,
        deadline: Instant,
    ) -> Result<FixturePermit, FixtureAdmissionError> {
        let mut available = self.available.lock().unwrap();
        while *available == 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(FixtureAdmissionError::Timeout);
            }
            available = self.wake.wait_timeout(available, remaining).unwrap().0;
        }
        *available -= 1;
        Ok(FixturePermit(self.clone()))
    }
}
impl Drop for FixturePermit {
    fn drop(&mut self) {
        *self.0.available.lock().unwrap() += 1;
        self.0.wake.notify_one();
    }
}
fn fixture_admission() -> FixturePermit {
    static LIMITER: OnceLock<Arc<FixtureLimiter>> = OnceLock::new();
    LIMITER
        .get_or_init(|| {
            Arc::new(FixtureLimiter {
                available: Mutex::new(2),
                wake: Condvar::new(),
            })
        })
        .acquire(Instant::now() + Duration::from_secs(120))
        .expect("bounded public fixture admission")
}

struct Fixture {
    _admission: FixturePermit,
    _directory: tempfile::TempDir,
    producer_root: PathBuf,
    plan: ImmutableGroupPlan,
    markers: Vec<PathBuf>,
    checkpoints: Vec<PathBuf>,
    listener_checkpoints: Vec<PathBuf>,
    response_gates: Vec<PathBuf>,
}

impl Fixture {
    fn new(ports: &[u16], modes: &[&str]) -> Self {
        Self::new_with_response_gate(ports, modes, false)
    }

    fn new_with_response_gate(ports: &[u16], modes: &[&str], use_response_gate: bool) -> Self {
        let admission = fixture_admission();
        assert_eq!(ports.len(), modes.len());
        assert!(!ports.is_empty());
        let directory = tempfile::tempdir().expect("fixture directory");
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
            "fixture must be built: {}",
            source.display()
        );
        let executable_path = producer_root.join("capture-runtime.exe");
        fs::copy(&source, &executable_path).expect("copy fixture executable");
        let executable_bytes = fs::read(&executable_path).expect("fixture bytes");

        let release = producer_root.join("release");
        fs::create_dir(&release).expect("release directory");
        let schema_path = release.join(SCHEMA_FILE_NAME);
        fs::write(
            &schema_path,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json"
            )),
        )
        .expect("canonical schema");
        let manifest = SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: executable_bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&executable_bytes)),
            schema_file_name: SCHEMA_FILE_NAME.into(),
            schema_sha256: SCHEMA_SHA256.into(),
        };
        let manifest_path = release.join("capture-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest JSON"),
        )
        .expect("manifest");

        let journal_path = producer_root
            .to_str()
            .expect("UTF-8 producer root")
            .to_owned();
        let mut markers = Vec::with_capacity(ports.len());
        let mut checkpoints = Vec::with_capacity(ports.len());
        let mut listener_checkpoints = Vec::with_capacity(ports.len());
        let mut response_gates = Vec::with_capacity(ports.len());
        let roots = ports
            .iter()
            .enumerate()
            .map(|(ordinal, port)| {
                let marker = producer_root.join(format!("root-{ordinal}.marker"));
                let checkpoint = producer_root.join(format!("root-{ordinal}.checkpoint"));
                let listener_checkpoint =
                    producer_root.join(format!("root-{ordinal}.listener-checkpoint"));
                let response_gate_path =
                    producer_root.join(format!("root-{ordinal}.response-gate"));
                markers.push(marker.clone());
                checkpoints.push(checkpoint.clone());
                listener_checkpoints.push(listener_checkpoint.clone());
                response_gates.push(response_gate_path.clone());
                let env = |path: &Path| path.to_str().expect("UTF-8 fixture path").to_owned();
                let mut environment = vec![
                    ("CAPTURE_API_TOKEN".into(), FIXTURE_TOKEN.into()),
                    ("CAPTURE_TEST_JOURNAL_PATH".into(), journal_path.clone()),
                    ("CAPTURE_TEST_MARKER_PATH".into(), env(&marker)),
                    ("CAPTURE_TEST_HTTP_CHECKPOINT_PATH".into(), env(&checkpoint)),
                    (
                        "CAPTURE_TEST_HTTP_LISTENER_CHECKPOINT_PATH".into(),
                        env(&listener_checkpoint),
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
                ];
                if use_response_gate {
                    environment.push((
                        "CAPTURE_TEST_HTTP_RESPONSE_GATE_PATH".into(),
                        env(&response_gate_path),
                    ));
                }
                SidecarLaunchSpec::new(
                    executable_path.clone(),
                    *port,
                    FIXTURE_TOKEN.into(),
                    environment,
                    vec!["SystemRoot".into()],
                )
                .pipe(|spec| {
                    GroupRootPlanInput::new(
                        if ordinal == 0 {
                            "capture".into()
                        } else {
                            format!("worker-{ordinal}")
                        },
                        ordinal as u64 + 1,
                        spec,
                        manifest_path.clone(),
                    )
                })
            })
            .collect();
        let plan = build_immutable_group_plan(producer_root.clone(), 1, roots)
            .expect("immutable fixture plan");
        Self {
            _admission: admission,
            _directory: directory,
            producer_root,
            plan,
            markers,
            checkpoints,
            listener_checkpoints,
            response_gates,
        }
    }

    fn prepare(&self) -> capture_sidecar_launcher::PreparedGroup {
        OwnedRuntimeSession::prepare_group(&self.plan, &Sink::new()).expect("prepare group")
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

fn reservations(count: usize) -> (Vec<TcpListener>, Vec<u16>) {
    let mut held = Vec::with_capacity(count);
    let mut ports = Vec::with_capacity(count);
    while held.len() < count {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("ephemeral port");
        let port = listener.local_addr().expect("port address").port();
        if !ports.contains(&port) {
            ports.push(port);
            held.push(listener);
        }
    }
    (held, ports)
}

fn wait_for(path: &Path, expected: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while fs::read(path).ok().as_deref() != Some(expected) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fs::read(path).expect("fixture checkpoint"), expected);
}

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.is_file() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        path.is_file(),
        "fixture marker was not created: {}",
        path.display()
    );
}

fn assert_staging_groups_released(root: &Path) {
    let staging = root.join("private-run-staging");
    if staging.exists() {
        assert!(
            fs::read_dir(staging)
                .expect("staging parent")
                .next()
                .is_none(),
            "owned staging group remains"
        );
    }
}

fn assert_running(observation: GroupObservation, count: usize) {
    assert_eq!(observation.state(), GroupLifecycleState::Running);
    assert_eq!(observation.root_count(), count);
    assert!(observation.roots_ready());
    assert!(observation.all_roots_ready());
    assert!(observation.listeners_bound());
    assert!(observation.all_listeners_bound());
}

fn assert_terminal(proof: GroupProof, count: usize) {
    assert_eq!(proof.state(), GroupLifecycleState::Terminal);
    assert_eq!(proof.root_count(), count);
    assert!(proof.is_terminal());
    assert!(proof.root_reaped());
    // These public fixtures create roots only. This checks the semantic proof
    // field; actual descendant reaping is exercised by private native tests.
    assert!(proof.descendants_terminated());
    assert!(proof.listeners_released());
    assert!(proof.staging_released());
}

fn assert_terminal_journal_preserves_running(
    running_bytes: &[u8],
    terminal_bytes: &[u8],
    count: usize,
) {
    let running =
        serde_json::from_slice::<serde_json::Value>(running_bytes).expect("running journal JSON");
    let terminal =
        serde_json::from_slice::<serde_json::Value>(terminal_bytes).expect("terminal journal JSON");
    assert_eq!(
        running.get("state").and_then(serde_json::Value::as_str),
        Some("running")
    );
    assert_eq!(
        terminal.get("state").and_then(serde_json::Value::as_str),
        Some("terminal")
    );
    for field in [
        "schemaVersion",
        "producer",
        "sessionNonce",
        "planDigest",
        "createdAt",
        "binding",
        "jobBinding",
        "stagingBinding",
        "attempt",
        "recoveryEpoch",
    ] {
        assert_eq!(
            running.get(field),
            terminal.get(field),
            "journal field {field}"
        );
    }
    let running_revision = running
        .get("journalRevision")
        .and_then(serde_json::Value::as_u64)
        .expect("running revision");
    assert_eq!(
        terminal
            .get("journalRevision")
            .and_then(serde_json::Value::as_u64),
        Some(running_revision + 2),
        "Closing and Terminal are the only close CASes"
    );
    let running_roots = running
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .expect("running roots");
    let terminal_roots = terminal
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .expect("terminal roots");
    assert_eq!(running_roots.len(), count);
    assert_eq!(terminal_roots.len(), count);
    for (running_root, terminal_root) in running_roots.iter().zip(terminal_roots) {
        for field in [
            "ordinal",
            "role",
            "rootRefDigest",
            "rootGeneration",
            "rootNonce",
            "pid",
            "creationIdentity",
            "reservedListenerIdentity",
            "loopbackPort",
            "startedAt",
        ] {
            assert_eq!(
                running_root.get(field),
                terminal_root.get(field),
                "root field {field}"
            );
        }
        assert_eq!(
            terminal_root
                .get("state")
                .and_then(serde_json::Value::as_str),
            Some("terminal")
        );
        assert_eq!(
            terminal_root.get("liveListenerReadiness"),
            Some(&serde_json::Value::Null)
        );
    }
    let proof = terminal.get("proof").expect("terminal proof");
    for field in [
        "rootReaped",
        "descendantsTerminated",
        "listenersReleased",
        "stagingReleased",
    ] {
        assert_eq!(
            proof.get(field),
            Some(&serde_json::Value::Bool(true)),
            "proof field {field}"
        );
    }
    assert_eq!(
        proof
            .get("proofGeneration")
            .and_then(serde_json::Value::as_u64),
        terminal
            .get("journalRevision")
            .and_then(serde_json::Value::as_u64)
    );
    assert_eq!(
        proof
            .get("unacquiredRootBindings")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len),
        Some(0)
    );
}

fn journal_file(root: &Path) -> PathBuf {
    let mut records = fs::read_dir(root)
        .expect("producer root")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("runtime-session-")
                && entry.path().extension().and_then(|value| value.to_str()) == Some("json")
        });
    let record = records.next().expect("runtime journal");
    assert!(records.next().is_none(), "one exact journal record");
    record.path()
}

fn journal_bytes(root: &Path) -> Vec<u8> {
    fs::read(journal_file(root)).expect("journal bytes")
}

fn journal_state(root: &Path) -> String {
    serde_json::from_slice::<serde_json::Value>(&journal_bytes(root))
        .expect("journal JSON")
        .get("state")
        .and_then(serde_json::Value::as_str)
        .expect("journal state")
        .to_owned()
}

fn journal_pids(root: &Path) -> Vec<u32> {
    serde_json::from_slice::<serde_json::Value>(&journal_bytes(root))
        .expect("journal JSON")
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .expect("journal roots")
        .iter()
        .map(|root| {
            root.get("pid")
                .and_then(serde_json::Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .expect("root PID")
        })
        .collect()
}

fn journal_ports(root: &Path) -> Vec<u16> {
    serde_json::from_slice::<serde_json::Value>(&journal_bytes(root))
        .expect("journal JSON")
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .expect("journal roots")
        .iter()
        .map(|root| {
            root.get("loopbackPort")
                .and_then(serde_json::Value::as_u64)
                .and_then(|port| u16::try_from(port).ok())
                .expect("root listener port")
        })
        .collect()
}

fn journal_ordinals(root: &Path) -> Vec<u32> {
    serde_json::from_slice::<serde_json::Value>(&journal_bytes(root))
        .expect("journal JSON")
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .expect("journal roots")
        .iter()
        .map(|root| {
            root.get("ordinal")
                .and_then(serde_json::Value::as_u64)
                .and_then(|ordinal| u32::try_from(ordinal).ok())
                .expect("root ordinal")
        })
        .collect()
}

#[cfg(windows)]
struct ExactProcessHandle(isize, Option<Arc<AtomicU8>>);

#[cfg(windows)]
impl ExactProcessHandle {
    fn from_raw(handle: HANDLE) -> Self {
        Self(handle as isize, None)
    }

    fn raw(&self) -> HANDLE {
        self.0 as HANDLE
    }
}

#[cfg(windows)]
impl Drop for ExactProcessHandle {
    fn drop(&mut self) {
        let closed = unsafe { CloseHandle(self.raw()) } != 0;
        if let Some(observed) = &self.1 {
            observed.store(if closed { 1 } else { 2 }, Ordering::Release);
        }
    }
}

#[cfg(windows)]
struct MetadataHandle(isize, Option<Arc<AtomicU8>>);

#[cfg(windows)]
impl MetadataHandle {
    fn from_raw(handle: HANDLE) -> Self {
        Self(handle as isize, None)
    }

    fn raw(&self) -> HANDLE {
        self.0 as HANDLE
    }
}

#[cfg(windows)]
impl Drop for MetadataHandle {
    fn drop(&mut self) {
        let closed = unsafe { CloseHandle(self.raw()) } != 0;
        if let Some(observed) = &self.1 {
            observed.store(if closed { 1 } else { 2 }, Ordering::Release);
        }
    }
}

#[cfg(windows)]
fn process_creation_time(handle: HANDLE, pid: u32) -> u64 {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    assert_ne!(
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) },
        0,
        "creation-time query failed for owned fixture PID {pid}"
    );
    (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime)
}

#[cfg(windows)]
fn exact_process_handles(root: &Path) -> Vec<ExactProcessHandle> {
    let journal = serde_json::from_slice::<serde_json::Value>(&journal_bytes(root))
        .expect("runtime journal JSON");
    journal
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .expect("journal roots")
        .iter()
        .map(|root| {
            let pid = root
                .get("pid")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .expect("journal root PID");
            let expected = root
                .get("creationIdentity")
                .and_then(|identity| identity.get("value"))
                .and_then(serde_json::Value::as_str)
                .and_then(|value| u64::from_str_radix(value, 16).ok())
                .expect("journal root creation identity");
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                panic!("owned fixture PID {pid} was not live");
            }
            let handle = ExactProcessHandle::from_raw(handle);
            assert_eq!(
                process_creation_time(handle.raw(), pid),
                expected,
                "owned fixture PID {pid} had a different creation identity"
            );
            handle
        })
        .collect()
}

#[cfg(windows)]
fn try_exact_process_handles(root: &Path) -> Option<Vec<ExactProcessHandle>> {
    try_exact_process_handles_observed(root, None)
}

#[cfg(windows)]
fn try_exact_process_handles_observed(
    root: &Path,
    observed_handles: Option<&Sender<Arc<AtomicU8>>>,
) -> Option<Vec<ExactProcessHandle>> {
    let journal_path = root
        .read_dir()
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("runtime-session-") && name.ends_with(".json"))
        })?;
    let journal =
        serde_json::from_slice::<serde_json::Value>(&fs::read(journal_path).ok()?).ok()?;
    let roots = journal.get("roots")?.as_array()?;
    if roots.is_empty() {
        return None;
    }
    let mut handles = Vec::with_capacity(roots.len());
    for root in roots {
        let pid = u32::try_from(root.get("pid")?.as_u64()?).ok()?;
        let expected =
            u64::from_str_radix(root.get("creationIdentity")?.get("value")?.as_str()?, 16).ok()?;
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return None;
        }
        let mut handle = ExactProcessHandle::from_raw(handle);
        if let Some(observed_handles) = observed_handles {
            let closed = Arc::new(AtomicU8::new(0));
            handle.1 = Some(closed.clone());
            observed_handles
                .send(closed)
                .expect("observed process handle receiver");
        }
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let queried = unsafe {
            GetProcessTimes(
                handle.raw(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } != 0;
        let observed =
            (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        if !queried || observed != expected {
            return None;
        }
        handles.push(handle);
    }
    Some(handles)
}

#[cfg(windows)]
fn watch_exact_process_handles_with_gate_observed(
    root: PathBuf,
    response_gates: Vec<PathBuf>,
    armed: Option<Sender<()>>,
    handles_ready: Option<Sender<()>>,
    observed_handles: Option<Sender<Arc<AtomicU8>>>,
) -> Vec<ExactProcessHandle> {
    if let Some(armed) = armed {
        armed.send(()).expect("exact process watcher armed");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(handles) = try_exact_process_handles_observed(&root, observed_handles.as_ref())
        {
            for path in response_gates {
                write_response_gate(&path);
            }
            if let Some(handles_ready) = handles_ready {
                handles_ready
                    .send(())
                    .expect("exact process handles acquired");
            }
            return handles;
        }
        if Instant::now() >= deadline {
            panic!("could not acquire exact live process handles before cleanup");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScenarioCheckpoint {
    ExactHandles,
    TargetAuthorization,
}
#[derive(Debug, PartialEq, Eq)]
enum ScenarioFailure {
    EarlyActivation {
        checkpoint: ScenarioCheckpoint,
        outcome: Option<(LaunchErrorKind, LaunchPhase)>,
    },
    Timeout(ScenarioCheckpoint),
    ActivationDisconnected(ScenarioCheckpoint),
}

fn observer_progress(
    completed: &mpsc::Receiver<Option<(LaunchErrorKind, LaunchPhase)>>,
    checkpoint: ScenarioCheckpoint,
    deadline: Instant,
) -> Result<(), ScenarioFailure> {
    match completed.try_recv() {
        Ok(outcome) => {
            return Err(ScenarioFailure::EarlyActivation {
                checkpoint,
                outcome,
            })
        }
        Err(mpsc::TryRecvError::Disconnected) => {
            return Err(ScenarioFailure::ActivationDisconnected(checkpoint))
        }
        Err(mpsc::TryRecvError::Empty) => {}
    }
    if Instant::now() >= deadline {
        return Err(ScenarioFailure::Timeout(checkpoint));
    }
    Ok(())
}

fn observe_failure_scenario(
    fixture: &Fixture,
    cancel_target: Option<(usize, ActivationCancelHandle)>,
    completed: mpsc::Receiver<Option<(LaunchErrorKind, LaunchPhase)>>,
    deadline: Instant,
) -> Result<Vec<ExactProcessHandle>, ScenarioFailure> {
    let handles = loop {
        observer_progress(&completed, ScenarioCheckpoint::ExactHandles, deadline)?;
        if let Some(handles) = try_exact_process_handles(&fixture.producer_root) {
            break handles;
        }
        thread::sleep(Duration::from_millis(5));
    };
    for handle in &handles {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.raw(), 0) },
            WAIT_TIMEOUT,
            "exact roots must be live before releasing responses"
        );
    }
    // Release the first response before waiting for later authorizations:
    // the producer probes roots sequentially.
    for gate in &fixture.response_gates {
        write_response_gate(gate);
    }
    if let Some((ordinal, cancel)) = cancel_target {
        loop {
            observer_progress(
                &completed,
                ScenarioCheckpoint::TargetAuthorization,
                deadline,
            )?;
            if fs::read(&fixture.checkpoints[ordinal]).ok().as_deref() == Some(b"authorized\n") {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        for handle in &handles {
            assert_eq!(
                unsafe { WaitForSingleObject(handle.raw(), 0) },
                WAIT_TIMEOUT,
                "roots must remain live until intended cancellation"
            );
        }
        cancel.cancel();
    }
    Ok(handles)
}

fn activate_failure_scenario(
    fixture: &Fixture,
    prepared: PreparedGroup,
    cancel_target: Option<usize>,
) -> (LaunchError, Vec<ExactProcessHandle>) {
    let cancel = prepared.cancel_handle();
    let (completed, completion) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_secs(10);
    let (activation, observer) = thread::scope(|scope| {
        let observer = scope.spawn(|| {
            observe_failure_scenario(
                fixture,
                cancel_target.map(|ordinal| (ordinal, cancel)),
                completion,
                deadline,
            )
        });
        let activation = OwnedRuntimeSession::activate_group(prepared);
        let outcome = activation.as_ref().err().map(|e| (e.kind(), e.phase()));
        let _ = completed.send(outcome);
        // Always collect the worker result before any assertions about activation.
        let observer = observer.join();
        (activation, observer)
    });
    let outcome = activation.as_ref().err().map(|e| (e.kind(), e.phase()));
    let handles = observer
        .unwrap_or_else(|_| panic!("observer panicked; activation={outcome:?}"))
        .unwrap_or_else(|failure| panic!("scenario failed: {failure:?}; activation={outcome:?}"));
    let error = match activation {
        Err(error) => error,
        Ok(lease) => {
            drop(lease);
            panic!("failed readiness issued a lease");
        }
    };
    if cancel_target.is_some() {
        assert_eq!(error.kind(), LaunchErrorKind::Cancellation);
    }
    (error, handles)
}

#[cfg(windows)]
fn write_response_gate(path: &Path) {
    const RELEASE: &[u8] = b"release\n";
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .expect("response gate parent");
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("response gate filename");
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => panic!("response gate must be absent before publication"),
        Err(error) => panic!("response gate absence could not be verified: {error}"),
    }
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .unwrap_or_else(|error| panic!("response gate temporary creation failed: {error}"));
    use std::io::Write;
    if let Err(error) = file
        .write_all(RELEASE)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        panic!("response gate temporary publication failed: {error}");
    }
    drop(file);
    let from = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0;
    if !moved {
        let _ = fs::remove_file(&temporary);
        panic!("response gate atomic publication failed");
    }
    match fs::symlink_metadata(&temporary) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => panic!("response gate temporary remained after publication"),
        Err(error) => panic!("response gate temporary absence could not be verified: {error}"),
    }
    assert_eq!(fs::read(path).expect("response gate readback"), RELEASE);
}

#[cfg(windows)]
fn wait_for_exact_processes_gone(handles: &[ExactProcessHandle]) {
    for handle in handles {
        let status = unsafe { WaitForSingleObject(handle.raw(), 10_000) };
        assert_ne!(status, WAIT_FAILED, "exact owned process wait failed");
        assert_ne!(status, WAIT_TIMEOUT, "exact owned fixture process remained");
        assert_eq!(
            status, WAIT_OBJECT_0,
            "exact owned process wait was unknown"
        );
    }
}

#[cfg(windows)]
fn metadata_identity(path: &Path) -> (u32, u64) {
    let handle = open_metadata_handle(path);
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    assert_ne!(
        unsafe { GetFileInformationByHandle(handle.raw(), &mut information) },
        0,
        "owned staging identity query"
    );
    (
        information.dwVolumeSerialNumber,
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    )
}

#[cfg(windows)]
fn open_metadata_handle(path: &Path) -> MetadataHandle {
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        panic!("owned staging identity handle");
    }
    MetadataHandle::from_raw(handle)
}

#[cfg(windows)]
struct StagingSnapshot {
    group: PathBuf,
    group_identity: (u32, u64),
    roots: Vec<(PathBuf, (u32, u64))>,
    marker: PathBuf,
    marker_identity: (u32, u64),
    marker_bytes: Vec<u8>,
    entries: Vec<PathBuf>,
}

#[cfg(windows)]
fn owned_staging_snapshot(root: &Path, count: usize) -> StagingSnapshot {
    let groups = root
        .join("private-run-staging")
        .read_dir()
        .expect("staging parent")
        .map(|entry| entry.expect("staging group entry").path())
        .filter(|path| path.join(".capture-run-staging-v1").is_file())
        .collect::<Vec<_>>();
    assert_eq!(groups.len(), 1, "one marker owned staging group");
    let group = groups.into_iter().next().expect("owned staging group");
    let marker = group.join(".capture-run-staging-v1");
    let roots = (0..count)
        .map(|ordinal| {
            let path = group.join(format!("root-{ordinal:08}"));
            let identity = metadata_identity(&path);
            (path, identity)
        })
        .collect();
    let entries = fs::read_dir(&group)
        .expect("owned staging group entries")
        .map(|entry| entry.expect("staging entry").path())
        .collect();
    StagingSnapshot {
        group_identity: metadata_identity(&group),
        marker_identity: metadata_identity(&marker),
        marker_bytes: fs::read(&marker).expect("staging marker bytes"),
        group,
        roots,
        marker,
        entries,
    }
}

#[cfg(windows)]
fn assert_staging_snapshot_preserved(snapshot: &StagingSnapshot) {
    assert_eq!(metadata_identity(&snapshot.group), snapshot.group_identity);
    assert_eq!(
        metadata_identity(&snapshot.marker),
        snapshot.marker_identity
    );
    assert_eq!(
        fs::read(&snapshot.marker).expect("staging marker bytes"),
        snapshot.marker_bytes
    );
    for (path, identity) in &snapshot.roots {
        assert_eq!(metadata_identity(path), *identity);
    }
    let mut entries = fs::read_dir(&snapshot.group)
        .expect("owned staging group entries")
        .map(|entry| entry.expect("staging entry").path())
        .collect::<Vec<_>>();
    entries.sort();
    let mut expected = snapshot.entries.clone();
    expected.sort();
    assert_eq!(entries, expected, "owned staging scope changed after drop");
}

fn wait_for_ports_free(ports: &[u16]) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while ports
        .iter()
        .any(|port| TcpListener::bind(("127.0.0.1", *port)).is_err())
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(25));
    }
    for port in ports {
        TcpListener::bind(("127.0.0.1", *port))
            .unwrap_or_else(|error| panic!("owned listener remained on {port}: {error}"));
    }
}

#[cfg(windows)]
fn assert_group_native_resources_released(root: &Path, handles: &[ExactProcessHandle]) {
    wait_for_exact_processes_gone(handles);
    wait_for_ports_free(&journal_ports(root));
}

#[cfg(windows)]
fn current_process_creation_identity() -> u64 {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            std::process::id(),
        )
    };
    if handle.is_null() {
        panic!("current process could not be opened for handle-guard test");
    }
    let handle = ExactProcessHandle::from_raw(handle);
    process_creation_time(handle.raw(), std::process::id())
}

#[cfg(windows)]
fn write_watcher_test_journal(root: &Path, roots: serde_json::Value) {
    fs::write(
        root.join("runtime-session-handle-test.json"),
        serde_json::to_vec(&json!({ "roots": roots })).expect("watcher test journal"),
    )
    .expect("watcher test journal bytes");
}

fn assert_observed_handle_closed(observation: Arc<AtomicU8>) {
    assert_eq!(
        observation.load(Ordering::Acquire),
        1,
        "the exact guard must successfully close its owned handle"
    );
}

#[cfg(windows)]
#[test]
fn public_r3_partial_root_parse_drops_prefix_process_handles() {
    let directory = tempfile::tempdir().expect("handle test directory");
    let pid = std::process::id();
    let identity = current_process_creation_identity();
    write_watcher_test_journal(
        directory.path(),
        json!([
            { "pid": pid, "creationIdentity": { "value": format!("{identity:016x}") } },
            { "pid": "malformed" }
        ]),
    );
    let (observed_sender, observed_receiver) = mpsc::channel();
    assert!(try_exact_process_handles_observed(directory.path(), Some(&observed_sender)).is_none());
    drop(observed_sender);
    let raw = observed_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("prefix handle observation");
    assert_observed_handle_closed(raw);
}

#[cfg(windows)]
#[test]
fn public_r3_gate_publish_panic_drops_process_handles() {
    let directory = tempfile::tempdir().expect("handle test directory");
    let pid = std::process::id();
    let identity = current_process_creation_identity();
    write_watcher_test_journal(
        directory.path(),
        json!([{ "pid": pid, "creationIdentity": { "value": format!("{identity:016x}") } }]),
    );
    let gate = directory.path().join("already-published-gate");
    fs::write(&gate, b"foreign").expect("foreign gate");
    let (observed_sender, observed_receiver) = mpsc::channel();
    let watcher = thread::spawn({
        let root = directory.path().to_path_buf();
        move || {
            watch_exact_process_handles_with_gate_observed(
                root,
                vec![gate],
                None,
                None,
                Some(observed_sender),
            )
        }
    });
    assert!(
        watcher.join().is_err(),
        "existing gate must panic the publisher"
    );
    let raw = observed_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("gate panic handle observation");
    assert_observed_handle_closed(raw);
}

#[cfg(windows)]
#[test]
fn public_r3_receiver_disconnect_drops_process_handles() {
    let directory = tempfile::tempdir().expect("handle test directory");
    let pid = std::process::id();
    let identity = current_process_creation_identity();
    write_watcher_test_journal(
        directory.path(),
        json!([{ "pid": pid, "creationIdentity": { "value": format!("{identity:016x}") } }]),
    );
    let (handles_ready, handles_ready_receiver) = mpsc::channel();
    drop(handles_ready_receiver);
    let (observed_sender, observed_receiver) = mpsc::channel();
    let watcher = thread::spawn({
        let root = directory.path().to_path_buf();
        move || {
            watch_exact_process_handles_with_gate_observed(
                root,
                Vec::new(),
                None,
                Some(handles_ready),
                Some(observed_sender),
            )
        }
    });
    assert!(
        watcher.join().is_err(),
        "disconnected handle receiver must panic the watcher"
    );
    let raw = observed_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("receiver disconnect handle observation");
    assert_observed_handle_closed(raw);
}

#[cfg(windows)]
#[test]
fn public_r3_metadata_query_panic_drops_open_file_handle() {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let directory = tempfile::tempdir().expect("metadata test directory");
    let path = directory.path().join("metadata.txt");
    fs::write(&path, b"metadata").expect("metadata test file");
    let (observed_sender, observed_receiver) = mpsc::channel();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut handle = open_metadata_handle(&path);
        let closed = Arc::new(AtomicU8::new(0));
        handle.1 = Some(closed.clone());
        observed_sender
            .send(closed)
            .expect("metadata handle observation");
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        assert_ne!(
            unsafe { GetFileInformationByHandle(INVALID_HANDLE_VALUE, &mut information) },
            0,
            "injected metadata query failure"
        );
    }));
    assert!(result.is_err(), "injected metadata query must panic");
    let raw = observed_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("metadata handle observation");
    assert_observed_handle_closed(raw);
}

#[test]
fn public_r3_fixture_admission_delay_precedes_scenario_clock() {
    let limiter = Arc::new(FixtureLimiter {
        available: Mutex::new(1),
        wake: Condvar::new(),
    });
    let held = limiter
        .acquire(Instant::now() + Duration::from_secs(1))
        .unwrap();
    let (requested, request) = mpsc::channel();
    let (admitted, admission) = mpsc::channel();
    let worker = thread::spawn(move || {
        requested.send(()).unwrap();
        let permit = limiter
            .acquire(Instant::now() + Duration::from_secs(2))
            .unwrap();
        let scenario_start = Instant::now();
        admitted.send(scenario_start).unwrap();
        permit
    });
    let requested = request.recv_timeout(Duration::from_secs(1));
    let blocked = admission.recv_timeout(Duration::from_millis(25));
    let released = Instant::now();
    drop(held);
    let admitted = admission.recv_timeout(Duration::from_secs(1));
    let joined = worker.join();
    assert!(requested.is_ok());
    assert!(matches!(blocked, Err(mpsc::RecvTimeoutError::Timeout)));
    assert!(admitted.unwrap() >= released);
    drop(joined.unwrap());
}

#[test]
fn public_r3_early_activation_failure_is_distinct_from_checkpoint_timeout() {
    let (held_ports, ports) = reservations(1);
    let fixture = Fixture::new_with_response_gate(&ports, &["silent"], true);
    let prepared = fixture.prepare();
    prepared.cancel_handle().cancel();
    drop(held_ports);
    let (completed, completion) = mpsc::channel();
    let cancel = prepared.cancel_handle();
    let (activation, observed) = thread::scope(|scope| {
        let observer = scope.spawn(|| {
            observe_failure_scenario(
                &fixture,
                Some((0, cancel)),
                completion,
                Instant::now() + Duration::from_secs(10),
            )
        });
        let activation = OwnedRuntimeSession::activate_group(prepared);
        let _ = completed.send(activation.as_ref().err().map(|e| (e.kind(), e.phase())));
        (activation, observer.join())
    });
    let error = activation.err().expect("pre-native cancellation");
    assert_eq!(error.kind(), LaunchErrorKind::Cancellation);
    assert!(matches!(
        observed.unwrap(),
        Err(ScenarioFailure::EarlyActivation {
            checkpoint: ScenarioCheckpoint::ExactHandles,
            outcome: Some((LaunchErrorKind::Cancellation, _)),
        })
    ));
    assert!(fixture.checkpoints.iter().all(|path| !path.exists()));
    assert!(fixture.response_gates.iter().all(|path| !path.exists()));
}

#[test]
fn public_r3_activates_observes_and_closes_one_and_two_root_groups() {
    for count in [1_usize, 2] {
        let (held_ports, ports) = reservations(count);
        let fixture = Fixture::new(&ports, &vec!["ready"; count]);
        let prepared = fixture.prepare();
        drop(held_ports);
        let lease = OwnedRuntimeSession::activate_group(prepared).expect("group lease");
        for path in &fixture.markers {
            wait_for_file(path);
        }
        for path in &fixture.listener_checkpoints {
            wait_for(path, b"listener-bound\n");
        }
        for path in &fixture.checkpoints {
            wait_for(path, b"authorized\n");
        }
        assert_running(
            OwnedRuntimeSession::observe(&lease).unwrap_or_else(|error| {
                panic!("observation: {error:?}; roots={count}");
            }),
            count,
        );
        let process_handles = exact_process_handles(&fixture.producer_root);
        let running_journal = journal_bytes(&fixture.producer_root);
        let proof = OwnedRuntimeSession::close(lease, CloseReason::Shutdown).expect("close proof");
        assert_terminal(proof, count);
        assert_eq!(journal_state(&fixture.producer_root), "terminal");
        assert_eq!(
            journal_ordinals(&fixture.producer_root),
            (0..count as u32).collect::<Vec<_>>()
        );
        let terminal_journal = journal_bytes(&fixture.producer_root);
        assert_terminal_journal_preserves_running(&running_journal, &terminal_journal, count);
        assert_group_native_resources_released(&fixture.producer_root, &process_handles);
        assert_staging_groups_released(&fixture.producer_root);
    }
}

#[test]
fn public_r3_readiness_failure_cannot_revive_observation_and_retains_close_owner() {
    let (held_ports, ports) = reservations(1);
    let fixture = Fixture::new(&ports, &["ready"]);
    let prepared = fixture.prepare();
    drop(held_ports);
    let lease = OwnedRuntimeSession::activate_group(prepared).expect("group lease");
    let handles = exact_process_handles(&fixture.producer_root);
    assert_running(
        OwnedRuntimeSession::observe(&lease).expect("initial readiness"),
        1,
    );
    // Exercise the listener beyond the legacy two-second idle exit.
    thread::sleep(Duration::from_millis(2200));
    assert_running(
        OwnedRuntimeSession::observe(&lease).expect("bounded hold readiness"),
        1,
    );
    let not_ready = fixture.markers[0].with_extension("not-ready");
    fs::write(&not_ready, b"not-ready").expect("readiness switch");
    assert_eq!(
        OwnedRuntimeSession::observe(&lease)
            .expect_err("confirmed 503")
            .kind(),
        capture_sidecar_launcher::LifecycleErrorKind::Listener
    );
    fs::remove_file(not_ready).expect("restore ready fixture response");
    assert_eq!(
        OwnedRuntimeSession::observe(&lease)
            .expect_err("revoked authority")
            .kind(),
        capture_sidecar_launcher::LifecycleErrorKind::InvalidState
    );
    assert_terminal(
        OwnedRuntimeSession::close(lease, CloseReason::Shutdown).expect("retained close owner"),
        1,
    );
    assert_group_native_resources_released(&fixture.producer_root, &handles);
    assert_staging_groups_released(&fixture.producer_root);
}

#[test]
fn public_r3_failure_cleanup_returns_semantic_reconcile_without_a_lease() {
    for mode in ["status503", "silent"] {
        let (held_ports, ports) = reservations(1);
        let fixture = Fixture::new_with_response_gate(&ports, &[mode], true);
        let prepared = fixture.prepare();
        drop(held_ports);
        let (error, process_handles) =
            activate_failure_scenario(&fixture, prepared, (mode == "silent").then_some(0));
        let debug = format!("{error:?}");
        let display = error.to_string();
        assert!(!debug.contains(FIXTURE_TOKEN));
        assert!(!display.contains(FIXTURE_TOKEN));
        assert!(!debug.contains(fixture.producer_root.to_string_lossy().as_ref()));
        assert!(!display.contains(fixture.producer_root.to_string_lossy().as_ref()));
        let pids = journal_pids(&fixture.producer_root);
        assert!(!pids.is_empty());
        for pid in &pids {
            assert!(!debug.contains(&pid.to_string()));
            assert!(!display.contains(&pid.to_string()));
        }
        for path in &fixture.listener_checkpoints {
            wait_for(path, b"listener-bound\n");
        }
        wait_for(&fixture.checkpoints[0], b"authorized\n");
        let ports = journal_ports(&fixture.producer_root);
        let staging = owned_staging_snapshot(&fixture.producer_root, 1);
        let cleanup = error
            .retry_cleanup()
            .expect("activation reconcile observation");
        assert_eq!(
            cleanup.state(),
            capture_sidecar_launcher::SemanticActivationCleanupState::ReconcileRequired
        );
        assert!(cleanup.native_closed());
        assert!(cleanup.staging_retained());
        assert_eq!(journal_state(&fixture.producer_root), "reconcile-required");
        assert!(!pids.is_empty());
        assert_group_native_resources_released(&fixture.producer_root, &process_handles);
        assert_eq!(journal_ports(&fixture.producer_root), ports);
        assert_staging_snapshot_preserved(&staging);
    }

    let (held_ports, ports) = reservations(2);
    let fixture = Fixture::new_with_response_gate(&ports, &["ready", "status503"], true);
    let prepared = fixture.prepare();
    drop(held_ports);
    let (error, process_handles) = activate_failure_scenario(&fixture, prepared, None);
    for path in &fixture.listener_checkpoints {
        wait_for(path, b"listener-bound\n");
    }
    for path in &fixture.checkpoints {
        wait_for(path, b"authorized\n");
    }
    assert!(!format!("{error:?}").contains(FIXTURE_TOKEN));
    let pids = journal_pids(&fixture.producer_root);
    let ports = journal_ports(&fixture.producer_root);
    let staging = owned_staging_snapshot(&fixture.producer_root, 2);
    for pid in &pids {
        assert!(!format!("{error:?}").contains(&pid.to_string()));
        assert!(!error.to_string().contains(&pid.to_string()));
    }
    let cleanup = error
        .retry_cleanup()
        .expect("multi-root reconcile observation");
    assert_eq!(
        cleanup.state(),
        capture_sidecar_launcher::SemanticActivationCleanupState::ReconcileRequired
    );
    assert!(cleanup.native_closed());
    assert!(cleanup.staging_retained());
    assert_eq!(journal_state(&fixture.producer_root), "reconcile-required");
    assert_eq!(pids.len(), 2);
    assert_group_native_resources_released(&fixture.producer_root, &process_handles);
    assert_eq!(journal_ports(&fixture.producer_root), ports);
    assert_staging_snapshot_preserved(&staging);
    drop(fixture);

    let (held_ports, ports) = reservations(2);
    let fixture = Fixture::new_with_response_gate(&ports, &["ready", "silent"], true);
    let prepared = fixture.prepare();
    drop(held_ports);
    let (error, process_handles) = activate_failure_scenario(&fixture, prepared, Some(1));
    for path in &fixture.listener_checkpoints {
        wait_for(path, b"listener-bound\n");
    }
    for path in &fixture.checkpoints {
        wait_for(path, b"authorized\n");
    }
    assert!(!format!("{error:?}").contains(FIXTURE_TOKEN));
    let staging = owned_staging_snapshot(&fixture.producer_root, 2);
    let pids = journal_pids(&fixture.producer_root);
    let ports = journal_ports(&fixture.producer_root);
    let cleanup = error
        .retry_cleanup()
        .expect("N-ready silent reconcile observation");
    assert_eq!(
        cleanup.state(),
        capture_sidecar_launcher::SemanticActivationCleanupState::ReconcileRequired
    );
    assert!(cleanup.native_closed());
    assert!(cleanup.staging_retained());
    assert_eq!(journal_state(&fixture.producer_root), "reconcile-required");
    assert_eq!(pids.len(), 2);
    assert_group_native_resources_released(&fixture.producer_root, &process_handles);
    assert_eq!(journal_ports(&fixture.producer_root), ports);
    assert_staging_snapshot_preserved(&staging);
}

#[test]
fn public_r3_close_retries_staging_validation_after_test_hardlink() {
    let (held_ports, ports) = reservations(1);
    let fixture = Fixture::new(&ports, &["ready"]);
    let prepared = fixture.prepare();
    drop(held_ports);
    let lease: GroupLease = OwnedRuntimeSession::activate_group(prepared).expect("group lease");
    wait_for(&fixture.listener_checkpoints[0], b"listener-bound\n");
    wait_for(&fixture.checkpoints[0], b"authorized\n");
    assert_running(
        OwnedRuntimeSession::observe(&lease).expect("observation"),
        1,
    );
    let process_handles = exact_process_handles(&fixture.producer_root);
    let pids = journal_pids(&fixture.producer_root);

    let group = fixture
        .producer_root
        .join("private-run-staging")
        .read_dir()
        .expect("staging parent")
        .next()
        .expect("staging group")
        .expect("staging group entry")
        .path();
    let root = group.join("root-00000000");
    let outside = fixture.producer_root.join("outside-hardlink-payload");
    let inside = root.join("foreign-hardlink");
    fs::write(&outside, b"outside bytes").expect("outside payload");
    fs::hard_link(&outside, &inside).expect("foreign hardlink");
    let outside_before = fs::read(&outside).expect("outside bytes");

    let error = match OwnedRuntimeSession::close(lease, CloseReason::Shutdown) {
        Ok(proof) => panic!("hardlink unexpectedly yielded proof: {proof:?}"),
        Err(error) => error,
    };
    assert_eq!(
        error.kind(),
        capture_sidecar_launcher::CleanupErrorKind::Validation
    );
    assert_eq!(
        error.phase(),
        capture_sidecar_launcher::CleanupPhase::NativeCleaned
    );
    let debug = format!("{error:?}");
    let display = error.to_string();
    for text in [&debug, &display] {
        assert!(!text.contains(FIXTURE_TOKEN));
        assert!(!text.contains(fixture.producer_root.to_string_lossy().as_ref()));
        for pid in &pids {
            assert!(!text.contains(&pid.to_string()));
        }
    }
    fs::remove_file(&inside).expect("remove only test hardlink");
    let proof = error.retry().expect("close retry proof");
    assert_terminal(proof, 1);
    assert_group_native_resources_released(&fixture.producer_root, &process_handles);
    assert_eq!(
        fs::read(&outside).expect("outside bytes after retry"),
        outside_before
    );
    assert_staging_groups_released(&fixture.producer_root);
}

#[test]
fn public_r3_borrowed_observe_error_is_sanitized_and_lease_remains_closable() {
    let (held_ports, ports) = reservations(1);
    let fixture = Fixture::new(&ports, &["ready"]);
    let prepared = fixture.prepare();
    drop(held_ports);
    let lease = OwnedRuntimeSession::activate_group(prepared).expect("group lease");
    wait_for(&fixture.listener_checkpoints[0], b"listener-bound\n");
    wait_for(&fixture.checkpoints[0], b"authorized\n");
    let process_handles = exact_process_handles(&fixture.producer_root);
    let pids = journal_pids(&fixture.producer_root);
    let journal = journal_file(&fixture.producer_root);
    let original = fs::read(&journal).expect("running journal bytes");
    fs::write(&journal, b"corrupt-journal").expect("corrupt journal for observation");
    let error = OwnedRuntimeSession::observe(&lease).expect_err("corrupt journal observation");
    let debug = format!("{error:?}");
    let display = error.to_string();
    for text in [&debug, &display] {
        assert!(!text.contains(FIXTURE_TOKEN));
        assert!(!text.contains(fixture.producer_root.to_string_lossy().as_ref()));
        assert!(!text.contains(journal.to_string_lossy().as_ref()));
        for pid in &pids {
            assert!(!text.contains(&pid.to_string()));
        }
    }
    fs::write(&journal, &original).expect("restore running journal");
    assert_running(
        OwnedRuntimeSession::observe(&lease).expect("observation after restoring journal"),
        1,
    );
    let proof = OwnedRuntimeSession::close(lease, CloseReason::Shutdown).expect("close proof");
    assert_terminal(proof, 1);
    wait_for_exact_processes_gone(&process_handles);
    wait_for_ports_free(&ports);
}

#[test]
fn public_r3_drop_invalidates_lease_without_fabricating_terminal_or_deleting_staging() {
    let (held_ports, ports) = reservations(1);
    let fixture = Fixture::new(&ports, &["ready"]);
    let prepared = fixture.prepare();
    drop(held_ports);
    let lease = OwnedRuntimeSession::activate_group(prepared).expect("group lease");
    wait_for(&fixture.listener_checkpoints[0], b"listener-bound\n");
    wait_for(&fixture.checkpoints[0], b"authorized\n");
    let process_handles = exact_process_handles(&fixture.producer_root);
    let staging = owned_staging_snapshot(&fixture.producer_root, 1);
    let running_journal = journal_bytes(&fixture.producer_root);
    let ports = journal_ports(&fixture.producer_root);
    drop(lease);
    wait_for_exact_processes_gone(&process_handles);
    wait_for_ports_free(&ports);
    assert_eq!(journal_state(&fixture.producer_root), "running");
    assert_eq!(journal_bytes(&fixture.producer_root), running_journal);
    assert_staging_snapshot_preserved(&staging);
}
