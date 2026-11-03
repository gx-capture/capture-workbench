#[cfg(windows)]
use crate::journal_store::activation_budget_for_test;
#[cfg(windows)]
use crate::process::cleanup_activation_for_test;

use super::super::command::freeze_launch_command_from_environment;
use super::super::fixture::{
    command_environment, token_environment, verified, write_canonical_readiness_manifest,
};
use super::*;

use std::{fs, time::Duration};

#[cfg(windows)]
use crate::constants::LOOPBACK_HOST;
#[cfg(windows)]
use crate::prepare::{
    CompleteGroupBinding, CompleteGroupBindingReceiptV1, PersistError, ReconcileRefSink,
    VerifiedGroupBinding,
};
#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::sync_channel,
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

/// Upper bound for waiting on fixture processes, markers and listeners to
/// reach a state. Waits return as soon as the condition holds; the bound
/// only matters on failure and leaves Windows CI room for first-launch
/// antivirus scans. Budgets under test keep their own exact values.
const FIXTURE_EVENTUAL_WAIT: Duration = Duration::from_secs(60);

#[cfg(windows)]
const ACTIVATION_HTTP_TOKEN: &str = "fixture-bearer-token-0123456789abcdef";

fn spec_from_frozen_command(command: &FrozenLaunchCommand, port: u16) -> SidecarLaunchSpec {
    SidecarLaunchSpec::new(
        command.executable_path.clone(),
        port,
        command.token.clone(),
        command
            .environment
            .iter()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect(),
        Vec::new(),
    )
}

fn activation_test_descriptor(
    producer_root: &Path,
    executable_path: &Path,
    ports: &[u16],
) -> FrozenActivationDescriptor {
    FrozenActivationDescriptor::from_activation_inputs(
        producer_root.to_path_buf(),
        "session-1".into(),
        4,
        ports
            .iter()
            .enumerate()
            .map(|(index, port)| ActivationRootInput {
                ordinal: index as u32,
                role: if index == 0 {
                    "capture".into()
                } else {
                    format!("worker-{index}")
                },
                root_generation: index as u64 + 1,
                verified: verified(executable_path.to_path_buf()),
                spec: SidecarLaunchSpec::new(
                    executable_path.to_path_buf(),
                    *port,
                    "secret-token".into(),
                    token_environment("secret-token"),
                    Vec::new(),
                ),
                readiness_manifest_path: None,
            })
            .collect(),
    )
    .expect("activation descriptor")
}

#[cfg(windows)]
fn real_activation_test_descriptor(
    producer_root: &Path,
    ports: &[u16],
) -> (FrozenActivationDescriptor, PathBuf) {
    let source = std::env::current_exe().expect("test executable");
    let executable_path = producer_root.join("capture-runtime.exe");
    fs::copy(&source, &executable_path).expect("copy executable fixture");
    let bytes = fs::read(&executable_path).expect("fixture bytes");
    let manifest = crate::SidecarManifest {
        manifest_version: "1".into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        api_version: "2.0".into(),
        capture_document_schema_version: "2".into(),
        platform: "windows".into(),
        arch: "x86_64".into(),
        file_name: "capture-runtime.exe".into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        schema_file_name: "capture-document-v2.schema.json".into(),
        schema_sha256: "0".repeat(64),
    };
    let descriptor = FrozenActivationDescriptor::from_activation_inputs(
        producer_root.to_path_buf(),
        "session-1".into(),
        4,
        ports
            .iter()
            .enumerate()
            .map(|(index, port)| ActivationRootInput {
                ordinal: index as u32,
                role: if index == 0 {
                    "capture".into()
                } else {
                    format!("worker-{index}")
                },
                root_generation: index as u64 + 1,
                verified: VerifiedSidecar {
                    manifest: manifest.clone(),
                    executable_path: executable_path.clone(),
                },
                spec: SidecarLaunchSpec::new(
                    executable_path.clone(),
                    *port,
                    "secret-token".into(),
                    token_environment("secret-token"),
                    Vec::new(),
                ),
                readiness_manifest_path: None,
            })
            .collect(),
    )
    .expect("real activation descriptor");
    (descriptor, executable_path)
}

#[cfg(windows)]
fn activation_probe_test_descriptor(
    producer_root: &Path,
    ports: &[u16],
) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
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
    let bytes = fs::read(&executable_path).expect("fixture bytes");
    let manifest = crate::SidecarManifest {
        manifest_version: "1".into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        api_version: "2.0".into(),
        capture_document_schema_version: "2".into(),
        platform: "windows".into(),
        arch: "x86_64".into(),
        file_name: "capture-runtime.exe".into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        schema_file_name: "capture-document-v2.schema.json".into(),
        schema_sha256: "0".repeat(64),
    };
    let journal_path = producer_root
        .to_str()
        .expect("producer root is UTF-8")
        .to_owned();
    let marker_paths = ports
        .iter()
        .enumerate()
        .map(|(ordinal, _)| producer_root.join(format!("activation-probe-{ordinal}.marker")))
        .collect::<Vec<_>>();
    let descriptor = FrozenActivationDescriptor::from_activation_inputs(
        producer_root.to_path_buf(),
        "session-1".into(),
        4,
        ports
            .iter()
            .enumerate()
            .map(|(ordinal, port)| {
                let marker_path = marker_paths[ordinal]
                    .to_str()
                    .expect("marker path is UTF-8")
                    .to_owned();
                ActivationRootInput {
                    ordinal: ordinal as u32,
                    role: if ordinal == 0 {
                        "capture".into()
                    } else {
                        format!("worker-{ordinal}")
                    },
                    root_generation: ordinal as u64 + 1,
                    verified: VerifiedSidecar {
                        manifest: manifest.clone(),
                        executable_path: executable_path.clone(),
                    },
                    spec: SidecarLaunchSpec::new(
                        executable_path.clone(),
                        *port,
                        "secret-token".into(),
                        vec![
                            ("CAPTURE_API_TOKEN".into(), "secret-token".into()),
                            ("CAPTURE_TEST_JOURNAL_PATH".into(), journal_path.clone()),
                            ("CAPTURE_TEST_MARKER_PATH".into(), marker_path),
                            ("CAPTURE_TEST_SESSION_NONCE".into(), "session-1".into()),
                            ("CAPTURE_TEST_ROOT_ORDINAL".into(), ordinal.to_string()),
                        ],
                        Vec::new(),
                    ),
                    readiness_manifest_path: None,
                }
            })
            .collect(),
    )
    .expect("activation probe descriptor");
    (descriptor, marker_paths)
}

#[cfg(windows)]
static TEST_PORT_ALLOCATIONS: std::sync::OnceLock<Mutex<HashSet<u16>>> = std::sync::OnceLock::new();

#[cfg(windows)]
fn held_distinct_loopback_ports(count: usize) -> (Vec<TcpListener>, Vec<u16>) {
    assert!(count > 0);
    let mut reservations = Vec::with_capacity(count);
    let mut ports = HashSet::with_capacity(count);
    let allocated = TEST_PORT_ALLOCATIONS.get_or_init(|| Mutex::new(HashSet::new()));
    for _ in 0..128 {
        if reservations.len() == count {
            break;
        }
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("ephemeral port");
        let port = listener.local_addr().expect("ephemeral address").port();
        if allocated.lock().unwrap().insert(port) {
            ports.insert(port);
            reservations.push(listener);
        }
    }
    assert_eq!(reservations.len(), count, "distinct loopback ports");
    (reservations, ports.into_iter().collect())
}

#[cfg(windows)]
fn activation_http_test_descriptor(
    producer_root: &Path,
    ports: &[u16],
) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
    activation_http_test_descriptor_with_mode(producer_root, ports, "ready")
}

#[cfg(windows)]
fn activation_http_test_descriptor_with_mode(
    producer_root: &Path,
    ports: &[u16],
    http_mode: &str,
) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
    let modes = vec![http_mode; ports.len()];
    activation_http_test_descriptor_with_modes(producer_root, ports, &modes)
}

#[cfg(windows)]
fn activation_http_test_descriptor_with_modes(
    producer_root: &Path,
    ports: &[u16],
    http_modes: &[&str],
) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
    activation_http_test_descriptor_with_modes_and_delay(producer_root, ports, http_modes, None)
}

#[cfg(windows)]
fn activation_http_test_descriptor_with_modes_and_delay(
    producer_root: &Path,
    ports: &[u16],
    http_modes: &[&str],
    startup_delay_ms: Option<u64>,
) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
    assert_eq!(ports.len(), http_modes.len());
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
    let release_directory = producer_root.join("release");
    fs::create_dir_all(&release_directory).expect("readiness release directory");
    let manifest_path = write_canonical_readiness_manifest(&release_directory, &executable_path);
    let manifest = crate::manifest::load_manifest(&manifest_path).expect("readiness manifest");
    let journal_path = producer_root
        .to_str()
        .expect("producer root is UTF-8")
        .to_owned();
    let marker_paths = ports
        .iter()
        .enumerate()
        .map(|(ordinal, _)| producer_root.join(format!("activation-http-{ordinal}.marker")))
        .collect::<Vec<_>>();
    let descriptor = FrozenActivationDescriptor::from_activation_inputs(
        producer_root.to_path_buf(),
        "session-1".into(),
        4,
        ports
            .iter()
            .enumerate()
            .map(|(ordinal, port)| {
                let marker_path = marker_paths[ordinal]
                    .to_str()
                    .expect("marker path is UTF-8")
                    .to_owned();
                let mut test_environment = vec![
                    ("CAPTURE_API_TOKEN".into(), ACTIVATION_HTTP_TOKEN.into()),
                    ("CAPTURE_TEST_JOURNAL_PATH".into(), journal_path.clone()),
                    ("CAPTURE_TEST_MARKER_PATH".into(), marker_path),
                    (
                        "CAPTURE_TEST_HTTP_CHECKPOINT_PATH".into(),
                        producer_root
                            .join(format!("activation-http-{ordinal}.checkpoint"))
                            .to_str()
                            .expect("HTTP checkpoint path is UTF-8")
                            .to_owned(),
                    ),
                    (
                        "CAPTURE_TEST_HTTP_LISTENER_CHECKPOINT_PATH".into(),
                        producer_root
                            .join(format!("activation-http-{ordinal}.listener-checkpoint"))
                            .to_str()
                            .expect("HTTP listener checkpoint path is UTF-8")
                            .to_owned(),
                    ),
                    ("CAPTURE_TEST_SESSION_NONCE".into(), "session-1".into()),
                    ("CAPTURE_TEST_ROOT_ORDINAL".into(), ordinal.to_string()),
                    ("CAPTURE_TEST_HTTP_MODE".into(), http_modes[ordinal].into()),
                ];
                if let Some(startup_delay_ms) = startup_delay_ms {
                    test_environment.push((
                        "CAPTURE_TEST_HTTP_START_DELAY_MS".into(),
                        startup_delay_ms.to_string(),
                    ));
                }
                ActivationRootInput {
                    ordinal: ordinal as u32,
                    role: if ordinal == 0 {
                        "capture".into()
                    } else {
                        format!("worker-{ordinal}")
                    },
                    root_generation: ordinal as u64 + 1,
                    verified: VerifiedSidecar {
                        manifest: manifest.clone(),
                        executable_path: executable_path.clone(),
                    },
                    spec: SidecarLaunchSpec::new(
                        executable_path.clone(),
                        *port,
                        ACTIVATION_HTTP_TOKEN.into(),
                        test_environment,
                        vec!["SystemRoot".into()],
                    ),
                    readiness_manifest_path: Some(manifest_path.clone()),
                }
            })
            .collect(),
    )
    .expect("HTTP activation probe descriptor");
    (descriptor, marker_paths)
}

#[cfg(windows)]
fn launch_http_owner_for_test(
    producer_root: &Path,
    ports: &[u16],
) -> (
    crate::prepare::ImmutableGroupPlan,
    Vec<PathBuf>,
    crate::process::LaunchingActivationOwner,
) {
    let modes = vec!["ready"; ports.len()];
    launch_http_owner_with_modes_for_test(producer_root, ports, &modes)
}

#[cfg(windows)]
fn launch_http_owner_with_modes_for_test(
    producer_root: &Path,
    ports: &[u16],
    http_modes: &[&str],
) -> (
    crate::prepare::ImmutableGroupPlan,
    Vec<PathBuf>,
    crate::process::LaunchingActivationOwner,
) {
    launch_http_owner_with_modes_and_delay_for_test(producer_root, ports, http_modes, None)
}

#[cfg(windows)]
fn launch_http_owner_with_modes_and_delay_for_test(
    producer_root: &Path,
    ports: &[u16],
    http_modes: &[&str],
    startup_delay_ms: Option<u64>,
) -> (
    crate::prepare::ImmutableGroupPlan,
    Vec<PathBuf>,
    crate::process::LaunchingActivationOwner,
) {
    let (reservations, ports) = {
        let mut reservations = Vec::new();
        let mut distinct = HashSet::new();
        for port in ports {
            let listener =
                TcpListener::bind((LOOPBACK_HOST, *port)).expect("test port reservation");
            distinct.insert(*port);
            reservations.push(listener);
        }
        assert_eq!(distinct.len(), ports.len());
        (reservations, ports.to_vec())
    };
    let (descriptor, marker_paths) = activation_http_test_descriptor_with_modes_and_delay(
        producer_root,
        &ports,
        http_modes,
        startup_delay_ms,
    );
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    for (ordinal, marker_path) in marker_paths.iter().enumerate() {
        wait_for_activation_probe_marker(
            marker_path,
            ordinal,
            journal.roots[ordinal].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_checkpoint(ports[ordinal], marker_path);
    }
    (plan, marker_paths, launching)
}

#[cfg(windows)]
fn running_http_owner_for_test(
    producer_root: &Path,
    root_count: usize,
) -> (
    crate::prepare::ImmutableGroupPlan,
    Vec<PathBuf>,
    crate::process::RunningActivationOwner,
    crate::journal::RuntimeSessionJournalV1,
) {
    let (reservations, ports) = held_distinct_loopback_ports(root_count);
    let (descriptor, marker_paths) = activation_http_test_descriptor(producer_root, &ports);
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = ready
        .launch_with_budget(&activation_budget_for_test())
        .unwrap_or_else(|_| panic!("durable Launching and native resume"));
    let launching_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    for (ordinal, marker_path) in marker_paths.iter().enumerate() {
        wait_for_activation_probe_marker(
            marker_path,
            ordinal,
            launching_journal.roots[ordinal].pid,
            launching_journal.journal_revision,
        );
        wait_for_activation_probe_http_checkpoint(ports[ordinal], marker_path);
    }
    for port in ports.iter().copied() {
        wait_for_activation_probe_http_status(
            &marker_paths,
            port,
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{port}"),
            200,
            false,
        );
    }
    let running = launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
        .unwrap_or_else(|_| panic!("roots should reach Running"));
    let running_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Running journal");
    (plan, marker_paths, running, running_journal)
}

#[cfg(windows)]
fn closing_owner_with_staging_for_test(
    producer_root: &Path,
    root_count: usize,
) -> (
    crate::prepare::ImmutableGroupPlan,
    crate::process::ClosingActivationOwner,
    PathBuf,
    Vec<PathBuf>,
) {
    let (plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(producer_root, root_count);
    let descriptor = plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("activation descriptor")
        .clone();
    let group_path = descriptor.planned_group_staging_path();
    let root_paths = descriptor
        .planned_root_staging_paths()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    let cleaned = closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("native cleanup and listener absence proof"));
    (plan, cleaned, group_path, root_paths)
}

/// The probe writes `<marker>.error` when it exits before listening (for
/// example on a rejected journal). Waiters check it every iteration so a
/// dead probe fails the test at once with its reason, not after a timeout.
#[cfg(windows)]
fn activation_probe_exit_reason<P: AsRef<Path>>(marker_paths: &[P]) -> Option<String> {
    marker_paths.iter().find_map(|marker| {
        let path = marker.as_ref().with_extension("error");
        fs::read_to_string(&path)
            .ok()
            .map(|reason| format!("{}: {}", path.display(), reason.trim()))
    })
}

#[cfg(windows)]
fn wait_for_activation_probe_marker(
    marker_path: &Path,
    ordinal: usize,
    expected_pid: u32,
    expected_revision: u64,
) {
    let expected = format!(
        "state=launching\nordinal={ordinal}\npid={expected_pid}\njournalRevision={expected_revision}\n"
    );
    let deadline = std::time::Instant::now() + FIXTURE_EVENTUAL_WAIT;
    let mut last_observation = None;
    while std::time::Instant::now() < deadline {
        if let Some(reason) = activation_probe_exit_reason(&[marker_path]) {
            panic!("activation probe exited before writing its marker: {reason}");
        }
        match fs::read_to_string(marker_path) {
            Ok(marker) if marker == expected => return,
            Ok(marker) => last_observation = Some(format!("partial or mismatching {marker:?}")),
            Err(error) => last_observation = Some(format!("unreadable: {error}")),
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!(
        "fixture marker {} did not reach the exact expected four-line record; expected {:?}, last {}",
        marker_path.display(),
        expected,
        last_observation.unwrap_or_else(|| "absent".into())
    );
}

#[cfg(windows)]
fn wait_for_activation_probe_http_status(
    marker_paths: &[PathBuf],
    port: u16,
    authorization: Option<&str>,
    host: &str,
    expected_status: u16,
    expect_bearer_challenge: bool,
) {
    // Loaded CI runners can delay fixture startup and first response bytes;
    // keep retrying until a complete status line arrives, then assert it.
    let started = Instant::now();
    let deadline = started + FIXTURE_EVENTUAL_WAIT;
    let authorization = authorization
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET /v2/health/ready HTTP/1.1\r\nHost: {host}\r\n{authorization}Connection: close\r\n\r\n"
    );
    let mut connect_failures = 0usize;
    let mut incomplete_responses = 0usize;
    while Instant::now() < deadline {
        if let Some(reason) = activation_probe_exit_reason(marker_paths) {
            panic!("activation probe exited before serving HTTP: {reason}");
        }
        let Ok(mut stream) = TcpStream::connect_timeout(
            &format!("{LOOPBACK_HOST}:{port}")
                .parse()
                .expect("loopback address"),
            Duration::from_millis(250),
        ) else {
            connect_failures += 1;
            thread::sleep(Duration::from_millis(10));
            continue;
        };
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .expect("HTTP test read timeout");
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut response = Vec::new();
        let mut chunk = [0_u8; 512];
        while !response.windows(4).any(|window| window == b"\r\n\r\n") {
            match std::io::Read::read(&mut stream, &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => response.extend_from_slice(&chunk[..count]),
            }
            if response.len() > 4096 {
                break;
            }
        }
        let status = response
            .split(|byte| *byte == b'\n')
            .next()
            .and_then(|line| std::str::from_utf8(line).ok())
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok());
        let Some(status) = status else {
            incomplete_responses += 1;
            thread::sleep(Duration::from_millis(10));
            continue;
        };
        if status == expected_status {
            if expect_bearer_challenge
                && !response
                    .windows(b"WWW-Authenticate: Bearer\r\n".len())
                    .any(|window| window == b"WWW-Authenticate: Bearer\r\n")
            {
                panic!("activation probe omitted the Bearer challenge");
            }
            return;
        }
        panic!("activation probe returned an unexpected HTTP status");
    }
    panic!(
        "activation probe HTTP server did not become reachable \
         (connect_failures={connect_failures}, incomplete_responses={incomplete_responses}, \
         elapsed_ms={})",
        started.elapsed().as_millis()
    );
}

#[cfg(windows)]
fn wait_for_activation_probe_http_checkpoint(port: u16, marker_path: &Path) {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum CheckpointState {
        Missing,
        Complete,
        Partial,
        Unreadable,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TransportState {
        NotAttempted,
        ConnectFailed,
        WriteFailed,
        ReadTimedOutOrFailed,
        ResponseTooLarge,
        Complete,
    }

    fn checkpoint_state(path: &Path, expected: &[u8]) -> CheckpointState {
        match fs::read(path) {
            Ok(bytes) if bytes == expected => CheckpointState::Complete,
            Ok(_) => CheckpointState::Partial,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => CheckpointState::Missing,
            Err(_) => CheckpointState::Unreadable,
        }
    }

    fn response_status(response: &[u8]) -> Option<u16> {
        response
            .split(|byte| *byte == b'\n')
            .next()
            .and_then(|line| std::str::from_utf8(line).ok())
            .and_then(|line| line.trim_end_matches('\r').split_whitespace().nth(1))
            .and_then(|value| value.parse().ok())
    }

    let checkpoint_path = marker_path.with_extension("checkpoint");
    let listener_checkpoint_path = marker_path.with_extension("listener-checkpoint");
    const MAX_RESPONSE_BYTES: usize = 4096;
    let started = Instant::now();
    let deadline = Instant::now() + FIXTURE_EVENTUAL_WAIT;
    let request = format!(
        "GET /v2/health/ready HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {ACTIVATION_HTTP_TOKEN}\r\nConnection: close\r\n\r\n"
    );
    let mut listener_state;
    let mut authorization_state;
    let mut transport_state = TransportState::NotAttempted;
    let mut last_status = None;
    let mut response_bytes = 0usize;
    let mut attempts = 0usize;
    while Instant::now() < deadline {
        if let Some(reason) = activation_probe_exit_reason(&[marker_path]) {
            panic!("activation probe exited before its HTTP checkpoint: {reason}");
        }
        listener_state = checkpoint_state(&listener_checkpoint_path, b"listener-bound\n");
        authorization_state = checkpoint_state(&checkpoint_path, b"authorized\n");
        if authorization_state == CheckpointState::Complete {
            return;
        }
        if listener_state != CheckpointState::Complete {
            let remaining = deadline.saturating_duration_since(Instant::now());
            thread::sleep(Duration::from_millis(10).min(remaining));
            continue;
        }

        attempts += 1;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let address = format!("{LOOPBACK_HOST}:{port}")
            .parse()
            .expect("loopback address");
        let connect_timeout = remaining.min(Duration::from_millis(250));
        let Ok(mut stream) = TcpStream::connect_timeout(&address, connect_timeout) else {
            transport_state = TransportState::ConnectFailed;
            continue;
        };
        let write_timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(250));
        if write_timeout.is_zero() || stream.set_write_timeout(Some(write_timeout)).is_err() {
            transport_state = TransportState::WriteFailed;
            continue;
        }
        if stream.write_all(request.as_bytes()).is_err() {
            transport_state = TransportState::WriteFailed;
            continue;
        }
        let read_timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(100));
        if read_timeout.is_zero() || stream.set_read_timeout(Some(read_timeout)).is_err() {
            transport_state = TransportState::ReadTimedOutOrFailed;
            continue;
        }
        let mut response = Vec::new();
        let mut chunk = [0_u8; 512];
        let mut response_failed = false;
        loop {
            if response.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
            if response.len() >= MAX_RESPONSE_BYTES {
                transport_state = TransportState::ResponseTooLarge;
                response_failed = true;
                break;
            }
            if Instant::now() >= deadline {
                transport_state = TransportState::ReadTimedOutOrFailed;
                response_failed = true;
                break;
            }
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    let remaining = MAX_RESPONSE_BYTES - response.len();
                    response.extend_from_slice(&chunk[..count.min(remaining)]);
                    if count > remaining {
                        transport_state = TransportState::ResponseTooLarge;
                        response_failed = true;
                        break;
                    }
                }
                Err(_) => {
                    transport_state = TransportState::ReadTimedOutOrFailed;
                    response_failed = true;
                    break;
                }
            }
        }
        response_bytes = response.len();
        last_status = response_status(&response);
        if !response_failed {
            transport_state = TransportState::Complete;
        }
        authorization_state = checkpoint_state(&checkpoint_path, b"authorized\n");
        if authorization_state == CheckpointState::Complete {
            return;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            thread::sleep(Duration::from_millis(10).min(remaining));
        }
    }
    listener_state = checkpoint_state(&listener_checkpoint_path, b"listener-bound\n");
    authorization_state = checkpoint_state(&checkpoint_path, b"authorized\n");
    panic!(
        "activation probe HTTP checkpoint not observed (listener={listener_state:?}, authorization={authorization_state:?}, transport={transport_state:?}, status={last_status:?}, response_bytes={response_bytes}, attempts={attempts}, elapsed_ms={})",
        started.elapsed().as_millis()
    );
}

#[test]
fn readiness_schema_context_requires_canonical_manifest_schema_and_presence_is_bound() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");

    let first_release = directory.path().join("release-one");
    let second_release = directory.path().join("release-two");
    fs::create_dir(&first_release).expect("first release");
    fs::create_dir(&second_release).expect("second release");
    let first_manifest_path = write_canonical_readiness_manifest(&first_release, &executable_path);
    let second_manifest_path =
        write_canonical_readiness_manifest(&second_release, &executable_path);
    let first_manifest =
        crate::manifest::load_manifest(&first_manifest_path).expect("first manifest");
    let verified = VerifiedSidecar {
        manifest: first_manifest,
        executable_path: executable_path.clone(),
    };
    let spec = SidecarLaunchSpec::new(
        executable_path.clone(),
        42123,
        "secret-token".into(),
        token_environment("secret-token"),
        Vec::new(),
    );
    let first = freeze_launch_command_from_environment_with_schema(
        &verified,
        &spec,
        &[],
        Some(&first_manifest_path),
    )
    .expect("first context");
    let second = freeze_launch_command_from_environment_with_schema(
        &verified,
        &spec,
        &[],
        Some(&second_manifest_path),
    )
    .expect("second context");
    assert_ne!(first.digest, second.digest);
    let first_root = FrozenActivationRoot {
        ordinal: 0,
        role: "capture".into(),
        root_generation: 1,
        reserved_listener_identity: "11".repeat(16),
        planned_staging_path: PathBuf::new(),
        command: first,
    };
    let second_root = FrozenActivationRoot {
        ordinal: 0,
        role: "capture".into(),
        root_generation: 1,
        reserved_listener_identity: "11".repeat(16),
        planned_staging_path: PathBuf::new(),
        command: second,
    };
    assert_ne!(
        activation_root_spec_digest("22".repeat(16).as_str(), &first_root),
        activation_root_spec_digest("22".repeat(16).as_str(), &second_root)
    );

    let mut foreign_manifest =
        crate::manifest::load_manifest(&first_manifest_path).expect("manifest");
    let foreign_schema = first_release.join(R3_SCHEMA_FILE_NAME);
    fs::write(&foreign_schema, b"foreign schema").expect("foreign schema");
    foreign_manifest.schema_sha256 = digest_bytes(b"foreign schema");
    fs::write(
        &first_manifest_path,
        serde_json::to_vec(&foreign_manifest).expect("foreign manifest JSON"),
    )
    .expect("foreign manifest");
    let foreign_verified = VerifiedSidecar {
        manifest: foreign_manifest,
        executable_path: executable_path.clone(),
    };
    assert!(freeze_launch_command_from_environment_with_schema(
        &foreign_verified,
        &spec,
        &[],
        Some(&first_manifest_path),
    )
    .is_err());
    assert!(freeze_launch_command_from_environment_with_schema(
        &verified,
        &spec,
        &[],
        Some(&first_manifest_path),
    )
    .is_err());

    let legacy = FrozenActivationDescriptor::from_activation_inputs(
        directory.path().to_path_buf(),
        "session-1".into(),
        4,
        vec![ActivationRootInput {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            verified,
            spec,
            readiness_manifest_path: None,
        }],
    )
    .expect("legacy descriptor");
    assert!(legacy.readiness_schema_context(0).is_none());
}

#[test]
fn activation_descriptor_attaches_schema_context_before_plan_identity_is_frozen() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let release_directory = directory.path().join("release");
    fs::create_dir(&release_directory).expect("release directory");
    let manifest_path = write_canonical_readiness_manifest(&release_directory, &executable_path);
    let manifest = crate::manifest::load_manifest(&manifest_path).expect("manifest");
    let descriptor = FrozenActivationDescriptor::from_activation_inputs(
        directory.path().to_path_buf(),
        "session-1".into(),
        4,
        vec![ActivationRootInput {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            verified: VerifiedSidecar {
                manifest,
                executable_path: executable_path.clone(),
            },
            spec: SidecarLaunchSpec::new(
                executable_path,
                42123,
                "secret-token".into(),
                token_environment("secret-token"),
                Vec::new(),
            ),
            readiness_manifest_path: Some(manifest_path),
        }],
    )
    .expect("schema-aware descriptor");

    assert!(descriptor.readiness_schema_context(0).is_some());
    let draft = descriptor.to_prepare_draft().expect("schema-aware draft");
    assert!(is_lower_sha256(&draft.roots[0].spec_digest));
}

#[test]
fn activation_descriptor_derives_root_identity_from_owned_commands_and_nonces() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let descriptor =
        activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
    let draft = descriptor.to_prepare_draft().expect("activation draft");

    assert_eq!(draft.group_generation, 4);
    assert_eq!(draft.roots.len(), 2);
    assert_ne!(draft.roots[0].spec_digest, draft.roots[1].spec_digest);
    assert_ne!(
        draft.roots[0].spec_digest,
        descriptor.roots[0].command.digest
    );
    assert_ne!(
        draft.roots[1].reserved_listener_identity,
        draft.roots[0].reserved_listener_identity
    );
    for (ordinal, root) in descriptor.roots.iter().enumerate() {
        let expected_path = planned_root_staging_path(
            directory.path(),
            &descriptor.group_staging_identity,
            ordinal as u32,
        )
        .expect("planned staging path");
        assert_eq!(root.planned_staging_path, expected_path);
        assert_eq!(
            command_environment(&root.command.command())
                .get("capture_run_staging_dir")
                .map(String::as_str),
            expected_path.to_str()
        );
    }
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("read directory")
            .count(),
        1
    );
}

#[test]
fn activation_descriptor_rejects_incomplete_duplicate_or_colliding_roots() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let mut descriptor =
        activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
    descriptor.roots[1].ordinal = 2;
    assert!(descriptor.validate().is_err());

    let mut descriptor =
        activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
    descriptor.roots[1].command.port = descriptor.roots[0].command.port;
    assert!(descriptor.validate().is_err());

    let mut descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
    descriptor.roots[0].role.clear();
    assert!(descriptor.validate().is_err());
}

#[test]
fn activation_descriptor_rejects_conflicting_or_inherited_reserved_staging_environment() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");

    let mut conflicting = ActivationRootInput {
        ordinal: 0,
        role: "capture".into(),
        root_generation: 1,
        verified: verified(executable_path.clone()),
        spec: SidecarLaunchSpec::new(
            executable_path.clone(),
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        ),
        readiness_manifest_path: None,
    };
    conflicting
        .spec
        .environment
        .push((RUN_STAGING_ENVIRONMENT_NAME.into(), "C:\\other-run".into()));
    assert!(FrozenActivationDescriptor::from_activation_inputs(
        directory.path().to_path_buf(),
        "session-1".into(),
        4,
        vec![conflicting],
    )
    .is_err());
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("producer root")
            .count(),
        1
    );

    let inherited = ActivationRootInput {
        ordinal: 0,
        role: "capture".into(),
        root_generation: 1,
        verified: verified(executable_path.clone()),
        spec: SidecarLaunchSpec::new(
            executable_path,
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            vec![RUN_STAGING_ENVIRONMENT_NAME.into()],
        ),
        readiness_manifest_path: None,
    };
    assert!(FrozenActivationDescriptor::from_activation_inputs(
        directory.path().to_path_buf(),
        "session-1".into(),
        4,
        vec![inherited],
    )
    .is_err());

    let duplicate = SidecarLaunchSpec::new(
        directory.path().join("capture-runtime.exe"),
        42123,
        "secret-token".into(),
        [
            token_environment("secret-token"),
            vec![
                (
                    RUN_STAGING_ENVIRONMENT_NAME.into(),
                    "C:\\planned-run".into(),
                ),
                ("capture_run_staging_dir".into(), "C:\\planned-run".into()),
            ],
        ]
        .concat(),
        Vec::new(),
    );
    assert!(bind_planned_staging_environment(duplicate, "C:\\planned-run").is_err());
}

#[test]
fn activation_descriptor_rejects_invalid_scope_before_freezing_commands() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let input = ActivationRootInput {
        ordinal: 0,
        role: "capture".into(),
        root_generation: 1,
        verified: verified(executable_path.clone()),
        spec: SidecarLaunchSpec::new(
            executable_path,
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        ),
        readiness_manifest_path: None,
    };

    assert!(FrozenActivationDescriptor::from_activation_inputs(
        PathBuf::from("relative-root"),
        "session-1".into(),
        4,
        vec![input],
    )
    .is_err());
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("producer root")
            .count(),
        1
    );
}

#[test]
fn activation_descriptor_binds_command_staging_and_listener_identity() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let mut descriptor =
        activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
    let baseline = descriptor.to_prepare_draft().expect("baseline draft");
    let original_command = &descriptor.roots[0].command;
    let changed_command = freeze_launch_command_from_environment(
        &verified(original_command.executable_path.clone()),
        &spec_from_frozen_command(original_command, original_command.port + 2),
        &[],
    )
    .expect("changed command");
    descriptor.roots[0].command = changed_command;
    let changed_command_draft = descriptor.to_prepare_draft().expect("command draft");
    assert_ne!(
        baseline.roots[0].spec_digest,
        changed_command_draft.roots[0].spec_digest
    );

    let mut changed_staging =
        activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
    let staging_baseline = changed_staging
        .to_prepare_draft()
        .expect("staging baseline draft");
    let listener_identities: Vec<_> = changed_staging
        .roots
        .iter()
        .map(|root| root.reserved_listener_identity.clone())
        .collect();
    changed_staging.group_staging_identity = "33".repeat(16);
    for (index, root) in changed_staging.roots.iter_mut().enumerate() {
        let staging_path = planned_root_staging_path(
            directory.path(),
            &changed_staging.group_staging_identity,
            index as u32,
        )
        .expect("changed staging path");
        let mut spec = spec_from_frozen_command(&root.command, root.command.port);
        let staging_value = staging_path
            .to_str()
            .expect("UTF-8 staging path")
            .to_owned();
        for (name, value) in &mut spec.environment {
            if name.eq_ignore_ascii_case(RUN_STAGING_ENVIRONMENT_NAME) {
                *value = staging_value.clone();
            }
        }
        root.command = freeze_launch_command_from_environment(
            &verified(root.command.executable_path.clone()),
            &spec,
            &[],
        )
        .expect("changed staging command");
        root.planned_staging_path = staging_path;
    }
    let changed_staging_draft = changed_staging.to_prepare_draft().expect("staging draft");
    assert_eq!(
        listener_identities,
        changed_staging
            .roots
            .iter()
            .map(|root| root.reserved_listener_identity.clone())
            .collect::<Vec<_>>()
    );
    assert_ne!(
        staging_baseline.roots[0].spec_digest,
        changed_staging_draft.roots[0].spec_digest
    );
}

#[cfg(windows)]
struct DescriptorSink {
    binding: Mutex<Option<CompleteGroupBinding>>,
    fail_persist: bool,
    persist_calls: AtomicUsize,
}

#[cfg(windows)]
impl ReconcileRefSink for DescriptorSink {
    fn persist(
        &self,
        _binding_attempt_id: &crate::prepare::BindingAttemptId,
        binding: &CompleteGroupBinding,
    ) -> Result<(), PersistError> {
        self.persist_calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.fail_persist {
            return Err(PersistError::Storage);
        }
        *self.binding.lock().unwrap() = Some(binding.clone());
        Ok(())
    }

    fn read_back(
        &self,
        _binding_attempt_id: &crate::prepare::BindingAttemptId,
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
        _binding_attempt_id: &crate::prepare::BindingAttemptId,
        _expected: &CompleteGroupBinding,
        read_back: &CompleteGroupBindingReceiptV1,
    ) -> Result<VerifiedGroupBinding, PersistError> {
        VerifiedGroupBinding::from_receipt(read_back.clone())
    }
}

#[cfg(windows)]
struct ReadyClock {
    values: Mutex<Vec<Result<String, crate::prepare::PrepareError>>>,
}

#[cfg(windows)]
impl ReadyClock {
    fn new(values: impl IntoIterator<Item = Result<String, crate::prepare::PrepareError>>) -> Self {
        Self {
            values: Mutex::new(values.into_iter().collect()),
        }
    }
}

#[cfg(windows)]
impl crate::prepare::PrepareClock for ReadyClock {
    fn now(&self) -> Result<String, crate::prepare::PrepareError> {
        let mut values = self.values.lock().unwrap();
        if values.is_empty() {
            Err(crate::prepare::PrepareError::JournalUnavailable)
        } else {
            values.remove(0)
        }
    }
}

#[cfg(windows)]
fn build_activation_plan_with_clock(
    descriptor: FrozenActivationDescriptor,
    values: impl IntoIterator<Item = Result<String, crate::prepare::PrepareError>>,
) -> crate::prepare::ImmutableGroupPlan {
    crate::prepare::build_immutable_group_plan_from_activation_with_clock(
        Arc::new(descriptor),
        Arc::new(ReadyClock::new(values)),
    )
    .expect("activation plan")
}

#[cfg(windows)]
#[test]
fn activation_descriptor_reaches_prepared_result_only_after_durable_binding() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let descriptor =
        activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    assert_eq!(plan.context.session_nonce, "session-1");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    assert!(prepared.context.activation_descriptor.is_some());
    assert_eq!(
        sink.persist_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    let validated = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    assert_eq!(validated.journal_plan, plan.value);
    assert_eq!(validated.expected.journal_revision, 1);
    assert_eq!(validated.descriptor.session_nonce(), "session-1");
}

#[cfg(windows)]
#[test]
fn public_builder_freezes_environment_before_ambient_mutation() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let release_directory = directory.path().join("release");
    fs::create_dir(&release_directory).expect("release directory");
    let source_executable = std::env::current_exe().expect("current executable");
    let executable_path = release_directory.join("capture-runtime.exe");
    fs::copy(&source_executable, &executable_path).expect("executable fixture");
    let manifest_path = write_canonical_readiness_manifest(&release_directory, &executable_path);

    let mut marker_digest = Sha256::new();
    marker_digest.update(directory.path().as_os_str().as_encoded_bytes());
    let marker_name = format!(
        "CAPTURE_PUBLIC_FROZEN_{}",
        &format!("{:x}", marker_digest.finalize())[..16]
    );
    std::env::set_var(&marker_name, "before");
    let token = "public-builder-token-0123456789abcdef".to_owned();
    let plan = build_immutable_group_plan(
        producer_root,
        7,
        vec![GroupRootPlanInput::new(
            "capture".into(),
            1,
            SidecarLaunchSpec::new(
                executable_path,
                43_127,
                token.clone(),
                vec![("CAPTURE_API_TOKEN".into(), token)],
                vec![marker_name.clone()],
            ),
            manifest_path,
        )],
    )
    .expect("public producer plan");

    std::env::set_var(&marker_name, "after");
    let descriptor = plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("public plan activation descriptor");
    let command = descriptor.checked_command(0).expect("frozen command");
    let environment = command_environment(&command);
    assert_eq!(
        environment.get(&marker_name.to_ascii_lowercase()),
        Some(&"before".to_owned())
    );
    assert_eq!(
        environment.get("capture_api_token"),
        Some(&"public-builder-token-0123456789abcdef".to_owned())
    );
    std::env::remove_var(marker_name);
}

#[cfg(windows)]
#[test]
fn activation_validation_rejects_stale_prepared_bound_snapshot() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let current = plan
        .context
        .store
        .read(&plan.value)
        .expect("prepared journal");
    {
        let outcome = plan.context.store.compare_and_swap_owned(
            &plan.value,
            &current,
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: crate::journal::JournalState::ReconcileRequired,
                timestamp: current.updated_at.clone(),
            },
        );
        assert_eq!(
            outcome.disposition(),
            crate::journal_store::CasDisposition::Committed
        );
        outcome.attempt().cloned().expect("state transition")
    };

    assert!(matches!(
        prepared.consume_for_activation_with_budget(&activation_budget_for_test()),
        Err(crate::prepare::PrepareError::JournalConflict)
    ));
}

#[cfg(windows)]
#[test]
fn activation_validation_rejects_descriptor_and_index_identity_tampering() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");

    let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
    let mut plan = build_activation_plan(descriptor).expect("activation plan");
    let context = Arc::get_mut(&mut plan.context).expect("unique plan context");
    let descriptor = Arc::get_mut(
        context
            .activation_descriptor
            .as_mut()
            .expect("activation descriptor"),
    )
    .expect("unique activation descriptor");
    descriptor.roots[0].role = "changed-role".into();
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    assert!(matches!(
        prepared.consume_for_activation_with_budget(&activation_budget_for_test()),
        Err(crate::prepare::PrepareError::InvalidPlan)
    ));

    let directory = tempfile::tempdir().expect("index directory");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42124]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let index_path = fs::read_dir(directory.path())
        .expect("producer root")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("runtime-ref-index-v1-"))
        })
        .expect("address index");
    let index_bytes = fs::read(&index_path).expect("index bytes");
    let mut index: serde_json::Value = serde_json::from_slice(&index_bytes).unwrap();
    index["groupRef"] = serde_json::json!("tampered");
    fs::write(&index_path, serde_json::to_vec(&index).unwrap()).expect("tampered index");

    assert!(matches!(
        prepared.consume_for_activation_with_budget(&activation_budget_for_test()),
        Err(crate::prepare::PrepareError::InvalidPlan)
    ));
}

#[cfg(windows)]
#[test]
fn activation_validation_rejects_missing_address_index() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42125]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let index_path = fs::read_dir(directory.path())
        .expect("producer root")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("runtime-ref-index-v1-"))
        })
        .expect("address index");
    fs::remove_file(index_path).expect("remove index");

    assert!(matches!(
        prepared.consume_for_activation_with_budget(&activation_budget_for_test()),
        Err(crate::prepare::PrepareError::JournalUnavailable)
    ));
}

#[cfg(windows)]
#[test]
fn activation_descriptor_sink_failure_acquires_no_runtime_resource() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: true,
        persist_calls: AtomicUsize::new(0),
    };
    assert!(matches!(
        crate::prepare::prepare_group(&plan, &sink),
        Err(crate::prepare::PrepareError::Binding(_))
    ));
    assert_eq!(
        sink.persist_calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );
}

#[cfg(windows)]
#[test]
fn activation_descriptor_acquires_real_windows_roots_suspended_before_cleanup() {
    for ports in [&[42130_u16][..], &[42131_u16, 42132_u16][..]] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), ports);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let mut owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("real executable roots should be acquired suspended");
        assert_eq!(owner.native_root_count_for_test(), Some(ports.len()));
        assert!(owner.native_is_suspended_for_test());

        let owner = cleanup_activation_for_test(owner);
        assert!(owner.native_cleanup_proven_for_test());
        assert!(group_path.exists());
    }
}

#[cfg(windows)]
#[test]
fn suspended_group_persists_complete_ready_observation_without_resuming() {
    for ports in [&[42146_u16][..], &[42147_u16, 42148_u16][..]] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), ports);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("suspended owner");
        let mut ready = owner
            .persist_ready_with_budget(&activation_budget_for_test())
            .expect("durable Ready observation");

        let journal = plan.context.store.read(&plan.value).expect("Ready journal");
        assert_eq!(journal.state, crate::journal::JournalState::Ready);
        assert_eq!(ready.ready_journal_for_test(), &journal);
        assert_eq!(ready.ready_journal_for_test().journal_revision, 2);
        assert_eq!(
            journal.job_binding.as_ref().map(|job| job.setup_state),
            Some(crate::journal::JobSetupState::Committed,)
        );
        let staging_binding = journal
            .staging_binding
            .as_ref()
            .expect("Ready staging binding");
        assert_eq!(staging_binding.run_nonce, "session-1");
        assert_eq!(staging_binding.scope, "run");
        assert_eq!(staging_binding.root_digest.len(), 64);
        assert_eq!(journal.roots.len(), ports.len());
        let crate::journal::JournalBinding::Bound { root_bindings, .. } = &journal.binding else {
            panic!("Ready journal binding");
        };
        assert_eq!(root_bindings.len(), ports.len());
        for (ordinal, ((root, binding), port)) in journal
            .roots
            .iter()
            .zip(root_bindings)
            .zip(ports)
            .enumerate()
        {
            assert_eq!(root.ordinal, ordinal as u32);
            assert_eq!(root.role, binding.role);
            assert_eq!(root.root_ref_digest, binding.root_ref_digest);
            assert_eq!(root.root_generation, binding.root_generation);
            assert_eq!(
                root.reserved_listener_identity,
                binding.reserved_listener_identity
            );
            assert_eq!(root.loopback_port, *port);
            assert_eq!(root.state, crate::journal::RootState::Suspended);
            assert!(root.live_listener_readiness.is_none());
            assert!(root.pid > 0);
            assert_eq!(root.creation_identity.value.len(), 16);
        }
        assert_eq!(ready.native_root_count_for_test(), Some(ports.len()));
        assert!(ready.native_is_suspended_for_test());

        let cleanup_failure = cleanup_activation_for_test(ready.into_suspended_owner());
        let owner = cleanup_failure;
        assert!(owner.native_cleanup_proven_for_test());
        assert!(owner.native_cleanup_proven_for_test());
        assert!(group_path.exists());
    }
}

#[cfg(windows)]
#[test]
fn launching_cas_precedes_resume_and_keeps_the_exact_journal_snapshot() {
    for ports in [&[42155_u16][..], &[42156_u16, 42157_u16][..]] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), ports);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("suspended owner");
        let ready = owner
            .persist_ready_with_budget(&activation_budget_for_test())
            .expect("durable Ready");

        let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching followed by native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        assert_eq!(journal.state, crate::journal::JournalState::Launching);
        assert_eq!(launching.launching_journal_for_test(), &journal);
        assert_eq!(journal.roots.len(), ports.len());
        assert!(journal
            .roots
            .iter()
            .all(|root| root.state == crate::journal::RootState::Suspended));

        let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
        assert!(cleanup.native_cleanup_proven_for_test());
    }
}

#[cfg(windows)]
#[test]
fn activation_probe_observes_durable_launching_before_each_real_root_runs() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, marker_paths) =
        activation_probe_test_descriptor(directory.path(), &[42165_u16, 42166_u16]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    assert!(marker_paths.iter().all(|path| !path.exists()));

    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("fixture roots should observe durable Launching"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    assert_eq!(journal.state, crate::journal::JournalState::Launching);
    assert_eq!(journal.journal_revision, 3);
    for (ordinal, marker_path) in marker_paths.iter().enumerate() {
        wait_for_activation_probe_marker(
            marker_path,
            ordinal,
            journal.roots[ordinal].pid,
            journal.journal_revision,
        );
    }

    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn activation_probe_http_readiness_and_native_listener_use_the_same_launched_roots() {
    for root_count in [1_usize, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(root_count);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let activation_descriptor = plan
            .context
            .activation_descriptor
            .as_ref()
            .expect("schema-aware activation descriptor")
            .clone();
        for ordinal in 0..root_count {
            assert!(
                activation_descriptor
                    .readiness_schema_context(ordinal)
                    .is_some(),
                "schema context must be frozen for root {ordinal}"
            );
            assert_eq!(
                command_environment(&activation_descriptor.roots[ordinal].command.command())
                    .get("capture_test_http_mode")
                    .map(String::as_str),
                Some("ready")
            );
        }
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("suspended owner");
        let ready = owner
            .persist_ready_with_budget(&activation_budget_for_test())
            .expect("durable Ready");
        assert!(marker_paths.iter().all(|path| !path.exists()));
        drop(reservations);

        let mut launching = match ready.launch_with_budget(&activation_budget_for_test()) {
            Ok(owner) => owner,
            Err(_) => panic!("fixture roots should launch"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        assert_eq!(journal.state, crate::journal::JournalState::Launching);
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                journal.roots[ordinal].pid,
                journal.journal_revision,
            );
        }
        for (ordinal, port) in ports.iter().copied().enumerate() {
            let root = &activation_descriptor.roots[ordinal];
            let schema = activation_descriptor
                .readiness_schema_context(ordinal)
                .expect("frozen readiness schema");
            assert_eq!(root.command.port, port);
            assert!(
                root.command.token == ACTIVATION_HTTP_TOKEN,
                "frozen readiness token binding mismatch"
            );
            wait_for_activation_probe_http_status(
                &marker_paths,
                port,
                Some("wrong-token"),
                &format!("{LOOPBACK_HOST}:{port}"),
                401,
                true,
            );
            wait_for_activation_probe_http_status(
                &marker_paths,
                port,
                None,
                &format!("{LOOPBACK_HOST}:{port}"),
                401,
                true,
            );
            wait_for_activation_probe_http_status(
                &marker_paths,
                port,
                Some(ACTIVATION_HTTP_TOKEN),
                "localhost",
                400,
                false,
            );
            wait_for_activation_probe_http_status(
                &marker_paths,
                port,
                Some(ACTIVATION_HTTP_TOKEN),
                &format!("{LOOPBACK_HOST}:{port}"),
                200,
                false,
            );
            let readiness = crate::health::probe_service_ready(
                port,
                root.command.token.as_str(),
                &root.command.manifest,
                schema.schema(),
                Instant::now() + Duration::from_secs(5),
                &AtomicBool::new(false),
            )
            .unwrap_or_else(|error| panic!("strict HTTP readiness probe failed: {error}"));
            match readiness {
                crate::health::StrictProbeResult::Ready(_) => {}
                crate::health::StrictProbeResult::NotReady => {
                    panic!("root {ordinal} did not report strict RuntimeReady")
                }
                crate::health::StrictProbeResult::Cancelled => {
                    panic!("root {ordinal} readiness probe was cancelled")
                }
            }
        }
        assert_eq!(
            launching
                .observe_native_listeners_for_test(
                    &ports,
                    Instant::now() + Duration::from_secs(5),
                    None,
                )
                .expect("direct-root listener observation"),
            root_count
        );

        let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
        assert!(cleanup.native_cleanup_proven_for_test());
    }
}

#[cfg(windows)]
#[test]
fn activation_probe_promotes_one_and_many_roots_only_after_durable_running_cas() {
    for root_count in [1_usize, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(root_count);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("suspended owner");
        let ready = owner
            .persist_ready_with_budget(&activation_budget_for_test())
            .expect("durable Ready");
        drop(reservations);

        let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let launching_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                launching_journal.roots[ordinal].pid,
                launching_journal.journal_revision,
            );
        }
        for port in ports.iter().copied() {
            wait_for_activation_probe_http_status(
                &marker_paths,
                port,
                Some(ACTIVATION_HTTP_TOKEN),
                &format!("{LOOPBACK_HOST}:{port}"),
                200,
                false,
            );
        }

        // Runtime activity may legitimately add files after resume.  The
        // Running admission validates ownership/identity, rather than
        // reusing the pre-native empty-scope cleanup proof.
        let activation_descriptor = plan
            .context
            .activation_descriptor
            .as_ref()
            .expect("activation descriptor")
            .clone();
        let group_staging_path = activation_descriptor.planned_group_staging_path();
        let root_staging_paths = activation_descriptor
            .planned_root_staging_paths()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        for (ordinal, root_staging_path) in root_staging_paths.iter().enumerate() {
            fs::write(
                root_staging_path.join(format!("runtime-{ordinal}.spool")),
                b"runtime activity",
            )
            .expect("post-resume runtime staging file");
        }

        let running = launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
            .unwrap_or_else(|_| panic!("roots should reach Running with an exact durable CAS"));
        let running_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        assert_eq!(running.running_journal_for_test(), &running_journal);
        assert_eq!(running_journal.state, crate::journal::JournalState::Running);
        assert_eq!(running_journal.journal_revision, 4);
        assert!(running_journal
            .roots
            .iter()
            .all(|root| root.state == crate::journal::RootState::Running));
        assert!(running_journal
            .roots
            .iter()
            .all(|root| root.live_listener_readiness.is_some()));
        assert_eq!(
            running_journal
                .roots
                .iter()
                .filter_map(|root| root.live_listener_readiness.as_ref())
                .collect::<HashSet<_>>()
                .len(),
            root_count
        );
        assert_eq!(running.native_root_count_for_test(), Some(root_count));

        let cleanup = cleanup_activation_for_test(running.into_suspended_owner());
        let retained = cleanup;
        assert!(retained.native_cleanup_proven_for_test());
        assert!(group_staging_path.is_dir());
        for (ordinal, root_staging_path) in root_staging_paths.iter().enumerate() {
            assert!(root_staging_path.is_dir());
            assert!(root_staging_path
                .join(format!("runtime-{ordinal}.spool"))
                .is_file());
        }
    }
}

#[cfg(windows)]
#[test]
fn running_close_persists_teardown_intent_for_one_and_many_roots() {
    for root_count in [1_usize, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(root_count);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("suspended owner");
        let ready = owner
            .persist_ready_with_budget(&activation_budget_for_test())
            .expect("durable Ready");
        drop(reservations);
        let launching = ready
            .launch_with_budget(&activation_budget_for_test())
            .unwrap_or_else(|_| panic!("durable Launching and native resume"));
        let launching_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                launching_journal.roots[ordinal].pid,
                launching_journal.journal_revision,
            );
        }
        for port in ports.iter().copied() {
            wait_for_activation_probe_http_status(
                &marker_paths,
                port,
                Some(ACTIVATION_HTTP_TOKEN),
                &format!("{LOOPBACK_HOST}:{port}"),
                200,
                false,
            );
        }
        let running = launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
            .unwrap_or_else(|_| panic!("roots should reach Running"));
        let running_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        assert_eq!(running_journal.state, crate::journal::JournalState::Running);
        assert_eq!(running.running_journal_for_test(), &running_journal);

        // Closing is teardown intent. It must not issue a listener-table
        // query or require the service to remain healthy before the
        // durable transition is recorded.
        let mut running = running;
        running.inject_listener_query_failure_for_test();
        let staging_marker = plan
            .context
            .activation_descriptor
            .as_ref()
            .expect("activation descriptor")
            .planned_group_staging_path()
            .join(".capture-run-staging-v1");
        fs::write(&staging_marker, b"foreign marker bytes").expect("test staging marker drift");
        let closing = running
            .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
            .unwrap_or_else(|_| {
                panic!("Running owner should enter Closing without a listener probe")
            });
        let closing_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Closing journal");
        assert_eq!(closing_journal.state, crate::journal::JournalState::Closing);
        assert_eq!(
            closing_journal.journal_revision,
            running_journal.journal_revision + 1
        );
        assert_eq!(closing.closing_journal_for_test(), &closing_journal);
        assert_eq!(closing.native_root_count_for_test(), Some(root_count));
        assert_eq!(
            closing_journal.schema_version,
            running_journal.schema_version
        );
        assert_eq!(closing_journal.producer, running_journal.producer);
        assert_eq!(closing_journal.session_nonce, running_journal.session_nonce);
        assert_eq!(closing_journal.plan_digest, running_journal.plan_digest);
        assert_eq!(closing_journal.created_at, running_journal.created_at);
        assert!(closing_journal.updated_at >= running_journal.updated_at);
        assert_eq!(closing_journal.attempt, running_journal.attempt);
        assert_eq!(
            closing_journal.recovery_epoch,
            running_journal.recovery_epoch
        );
        assert_eq!(closing_journal.binding, running_journal.binding);
        assert_eq!(closing_journal.job_binding, running_journal.job_binding);
        assert_eq!(
            closing_journal.staging_binding,
            running_journal.staging_binding
        );
        assert_eq!(closing_journal.proof, running_journal.proof);
        let mut expected_roots = running_journal.roots.clone();
        for root in &mut expected_roots {
            root.state = crate::journal::RootState::Closing;
        }
        assert_eq!(closing_journal.roots, expected_roots);
        assert!(closing_journal
            .roots
            .iter()
            .all(|root| root.live_listener_readiness.is_some()));
        drop(closing);
        assert!(staging_marker.is_file(), "Closing must not delete staging");
    }
}

#[cfg(windows)]
#[test]
fn running_close_cancellation_before_cas_retains_running_owner_without_mutation() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = ready
        .launch_with_budget(&activation_budget_for_test())
        .unwrap_or_else(|_| panic!("durable Launching and native resume"));
    let launching_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    for (ordinal, marker_path) in marker_paths.iter().enumerate() {
        wait_for_activation_probe_marker(
            marker_path,
            ordinal,
            launching_journal.roots[ordinal].pid,
            launching_journal.journal_revision,
        );
    }
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[0],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[0]),
        200,
        false,
    );
    let running = launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
        .unwrap_or_else(|_| panic!("root should reach Running"));
    let running_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Running journal");
    let cancellation = Arc::new(AtomicBool::new(true));
    let failure = match running.begin_closing_with_cancellation(
        Instant::now() + Duration::from_secs(5),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("pre-CAS cancellation must retain Running owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingTransitionFailureKind::Cancelled
    );
    assert_eq!(failure.candidate_disposition_for_test(), None);
    let running = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Running
    );
    assert_eq!(running.running_journal_for_test(), &running_journal);
    let current = plan
        .context
        .store
        .read(&plan.value)
        .expect("Running journal");
    {
        let outcome = plan.context.store.compare_and_swap_owned(
            &plan.value,
            &current,
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: crate::journal::JournalState::ReconcileRequired,
                timestamp: current.updated_at.clone(),
            },
        );
        assert_eq!(
            outcome.disposition(),
            crate::journal_store::CasDisposition::Committed
        );
        outcome.attempt().cloned().expect("test journal drift")
    };
    let stale_failure = match running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("stale full journal must block Closing admission"),
        Err(failure) => failure,
    };
    assert_eq!(
        stale_failure.kind_for_test(),
        crate::process::ClosingTransitionFailureKind::Conflict
    );
    let running = stale_failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::ReconcileRequired
    );
    let cleanup = cleanup_activation_for_test(running.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_close_succeeds_after_exact_retained_root_has_exited() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, mut running, running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    running
        .terminate_root_for_test(0)
        .expect("exact retained root handle can terminate the child");
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        .unwrap_or_else(|_| panic!("dead root must not block teardown intent"));
    let closing_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Closing journal");
    assert_eq!(closing_journal.state, crate::journal::JournalState::Closing);
    assert_eq!(
        closing_journal.journal_revision,
        running_journal.journal_revision + 1
    );
    assert!(closing_journal
        .roots
        .iter()
        .all(|root| root.state == crate::journal::RootState::Closing));
    assert_eq!(closing.native_root_count_for_test(), Some(1));
    let cleaned = closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| {
            panic!("dead root should still prove native cleanup and listener release")
        });
    assert!(cleaned.native_cleanup_proven_for_test());
    assert!(cleaned.listener_release_proven_for_test());
}

#[cfg(windows)]
#[test]
fn closing_native_cleanup_proves_listener_release_for_one_and_many_roots() {
    for root_count in [1_usize, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (plan, _marker_paths, running, running_journal) =
            running_http_owner_for_test(directory.path(), root_count);
        let closing = running
            .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
        let group_path = plan
            .context
            .activation_descriptor
            .as_ref()
            .expect("activation descriptor")
            .planned_group_staging_path();

        let cleaned = closing
            .cleanup_native_and_observe_listener_release(
                Instant::now() + Duration::from_secs(10),
                None,
            )
            .unwrap_or_else(|_| panic!("native cleanup and listener absence proof"));
        assert!(cleaned.native_cleanup_proven_for_test());
        assert!(cleaned.listener_release_proven_for_test());
        assert_eq!(cleaned.native_root_count_for_test(), Some(root_count));
        assert_eq!(cleaned.native_cleanup_attempts_for_test(), 1);
        assert!(group_path.is_dir(), "Closing cleanup must retain staging");
        let disk = plan
            .context
            .store
            .read(&plan.value)
            .expect("Closing journal");
        assert_eq!(&disk, cleaned.closing_journal_for_test());
        assert_eq!(disk.state, crate::journal::JournalState::Closing);
        assert_eq!(disk.journal_revision, running_journal.journal_revision + 1);
    }
}

#[cfg(windows)]
#[test]
fn closing_staging_release_removes_owned_runtime_subtree_for_one_and_many_roots() {
    for root_count in [1_usize, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (_plan, cleaned, group_path, root_paths) =
            closing_owner_with_staging_for_test(directory.path(), root_count);
        for (ordinal, root_path) in root_paths.iter().enumerate() {
            let nested = root_path.join("nested");
            fs::create_dir(&nested).expect("runtime nested directory");
            fs::write(
                root_path.join(format!("runtime-{ordinal}.spool")),
                b"runtime spool",
            )
            .expect("runtime spool");
            fs::write(nested.join("runtime-child.bin"), b"runtime child")
                .expect("runtime nested file");
        }

        let (released, observation) = cleaned
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|failure| {
                panic!(
                    "owned staging subtree should release: {}",
                    failure.detail_for_test()
                )
            });
        assert!(!group_path.exists());
        assert!(root_paths.iter().all(|path| !path.exists()));
        assert!(released.staging_release_proven_for_test());
        assert!(released.listener_release_proven_for_test());
        assert_eq!(released.native_cleanup_attempts_for_test(), 1);

        // A retry uses the retained release observation to verify absence
        // and ancestor identity; it does not recreate or delete again.
        let (replayed, replayed_observation) = released
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|failure| {
                panic!(
                    "released staging replay should verify absence: {}",
                    failure.detail_for_test()
                )
            });
        assert!(observation == replayed_observation);
        assert!(replayed.staging_release_proven_for_test());
        assert_eq!(replayed.native_cleanup_attempts_for_test(), 1);
        assert!(!group_path.exists());
    }
}

#[cfg(windows)]
#[test]
fn terminal_join_persists_exact_cleanup_proof_for_one_and_many_roots() {
    for root_count in [1_usize, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (plan, cleaned, group_path, root_paths) =
            closing_owner_with_staging_for_test(directory.path(), root_count);
        let (released, _staging_observation) = cleaned
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|failure| {
                panic!(
                    "staging release should precede terminal join: {}",
                    failure.detail_for_test()
                )
            });
        let closing = released.closing_journal_for_test().clone();
        let terminal = released
            .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|failure| {
                panic!(
                    "terminal join should persist exact proof: {}",
                    failure.detail_for_test()
                )
            });
        let terminal_journal = terminal.journal_for_test();
        assert_eq!(
            terminal_journal.state,
            crate::journal::JournalState::Terminal
        );
        assert_eq!(
            terminal_journal.journal_revision,
            closing.journal_revision + 1
        );
        assert_eq!(terminal_journal.attempt, closing.attempt);
        assert_eq!(terminal_journal.recovery_epoch, closing.recovery_epoch);
        assert_eq!(terminal_journal.schema_version, closing.schema_version);
        assert_eq!(terminal_journal.producer, closing.producer);
        assert_eq!(terminal_journal.session_nonce, closing.session_nonce);
        assert_eq!(terminal_journal.plan_digest, closing.plan_digest);
        assert_eq!(terminal_journal.binding, closing.binding);
        assert_eq!(terminal_journal.job_binding, closing.job_binding);
        assert_eq!(terminal_journal.staging_binding, closing.staging_binding);
        let mut expected_roots = closing.roots.clone();
        for root in &mut expected_roots {
            root.state = crate::journal::RootState::Terminal;
            root.live_listener_readiness = None;
        }
        assert_eq!(terminal_journal.roots, expected_roots);
        let proof = terminal_journal.proof.as_ref().expect("terminal proof");
        assert!(proof.root_reaped);
        assert!(proof.descendants_terminated);
        assert!(proof.listeners_released);
        assert!(proof.staging_released);
        assert_eq!(proof.proof_generation, terminal_journal.journal_revision);
        assert!(proof.unacquired_root_bindings.is_empty());

        let disk = plan
            .context
            .store
            .read(&plan.value)
            .expect("terminal journal");
        assert_eq!(&disk, terminal_journal);
        assert!(!group_path.exists());
        assert!(root_paths.iter().all(|path| !path.exists()));
    }
}

#[cfg(windows)]
#[test]
fn terminal_join_rechecks_released_scope_and_foreign_listener() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    fs::create_dir(&group_path).expect("foreign recreated group");
    let failure =
        match released.terminalize_after_release(Instant::now() + Duration::from_secs(10), None) {
            Ok(_) => panic!("recreated staging scope must block terminal proof"),
            Err(failure) => failure,
        };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Validation
    );
    assert!(group_path.exists());
    let _owner = failure.into_owner();
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("Closing journal");
    assert_eq!(disk.state, crate::journal::JournalState::Closing);
    fs::remove_dir(&group_path).expect("remove foreign group");

    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let port = plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("activation descriptor")
        .planned_root_port(0)
        .expect("planned port");
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    let foreign_listener = TcpListener::bind((LOOPBACK_HOST, port)).expect("foreign listener");
    let failure =
        match released.terminalize_after_release(Instant::now() + Duration::from_secs(10), None) {
            Ok(_) => panic!("foreign listener must block terminal proof"),
            Err(failure) => failure,
        };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Listener
    );
    assert!(TcpStream::connect((LOOPBACK_HOST, port)).is_ok());
    let owner = failure.into_owner();
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("Closing journal");
    assert_eq!(disk.state, crate::journal::JournalState::Closing);
    drop(foreign_listener);
    let terminal = owner
        .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "terminal join after foreign listener release: {}",
                failure.detail_for_test()
            )
        });
    assert_eq!(
        terminal.journal_for_test().state,
        crate::journal::JournalState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn terminal_join_cancellation_before_write_retries_same_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    let cancellation = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .cancel_before_terminal_replace_for_test(Arc::clone(&cancellation));
    let failure = match released.terminalize_after_release(
        Instant::now() + Duration::from_secs(10),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("pre-write cancellation must retain Closing owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Cancelled
    );
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
    cancellation.store(false, Ordering::Release);
    let terminal = failure
        .into_owner()
        .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!("same owner terminal retry: {}", failure.detail_for_test())
        });
    assert_eq!(
        terminal.journal_for_test().state,
        crate::journal::JournalState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn terminal_join_post_write_cancellation_withholds_authority() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    let cancellation = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .cancel_after_terminal_replace_for_test(Arc::clone(&cancellation));
    let failure = match released.terminalize_after_release(
        Instant::now() + Duration::from_secs(10),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("post-write cancellation must withhold terminal authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::CommittedAfterBudget
    );
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("terminal disk record");
    assert_eq!(disk.state, crate::journal::JournalState::Terminal);
    assert_eq!(
        disk.proof
            .as_ref()
            .expect("terminal disk proof")
            .proof_generation,
        disk.journal_revision
    );
    let _owner = failure.into_owner();
}

#[cfg(windows)]
#[test]
fn terminal_join_before_replace_failure_retains_owner_and_retries_without_cleanup() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, group_path, root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    let native_attempts = released.native_cleanup_attempts_for_test();
    plan.context.store.fail_next_before_replace_for_test();
    let failure =
        match released.terminalize_after_release(Instant::now() + Duration::from_secs(10), None) {
            Ok(_) => panic!("pre-replace failure must retain Closing owner"),
            Err(failure) => failure,
        };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Storage
    );
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
    let retained = failure.into_owner();
    assert_eq!(retained.native_cleanup_attempts_for_test(), native_attempts);
    assert!(retained.native_cleanup_proven_for_test());
    assert!(retained.staging_release_proven_for_test());
    assert!(!group_path.exists());
    assert!(root_paths.iter().all(|path| !path.exists()));
    let terminal = retained
        .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "retry after pre-replace failure: {}",
                failure.detail_for_test()
            )
        });
    assert_eq!(
        terminal.journal_for_test().state,
        crate::journal::JournalState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn terminal_join_post_replace_recheck_failure_retains_owner_and_rejects_replay() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    plan.context
        .store
        .fail_after_replace_and_durability_recheck();
    let failure =
        match released.terminalize_after_release(Instant::now() + Duration::from_secs(10), None) {
            Ok(_) => panic!("failed durability recheck must retain owner"),
            Err(failure) => failure,
        };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Storage
    );
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("terminal candidate");
    assert_eq!(disk.state, crate::journal::JournalState::Terminal);
    assert_eq!(
        disk.proof
            .as_ref()
            .expect("terminal proof")
            .proof_generation,
        disk.journal_revision
    );
    let replay = match failure
        .into_owner()
        .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("old Closing owner cannot replay a durable Terminal record"),
        Err(failure) => failure,
    };
    assert_eq!(
        replay.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Conflict
    );
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Terminal journal")
            .state,
        crate::journal::JournalState::Terminal
    );
    let _owner = replay.into_owner();
}

#[cfg(windows)]
#[test]
fn terminal_join_reestablish_success_returns_one_exact_terminal_candidate() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    plan.context.store.fail_next_after_replace_before_flush();
    let terminal = released
        .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "reestablished terminal candidate: {}",
                failure.detail_for_test()
            )
        });
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("Terminal journal");
    assert_eq!(&disk, terminal.journal_for_test());
    assert_eq!(disk.state, crate::journal::JournalState::Terminal);
}

#[cfg(windows)]
#[test]
fn terminal_join_rejects_same_snapshot_resource_drift_without_native_action() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let (released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    let expected = released.closing_journal_for_test().clone();
    let native_attempts = released.native_cleanup_attempts_for_test();
    let mut foreign = expected.clone();
    foreign.roots[0].live_listener_readiness =
        Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into());
    assert_eq!(foreign.cas_snapshot(), expected.cas_snapshot());
    plan.context.store.replace_journal_for_test(&foreign);
    let failure =
        match released.terminalize_after_release(Instant::now() + Duration::from_secs(10), None) {
            Ok(_) => panic!("same-snapshot resource drift must block terminal join"),
            Err(failure) => failure,
        };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Conflict
    );
    let retained = failure.into_owner();
    assert_eq!(retained.native_cleanup_attempts_for_test(), native_attempts);
    assert!(retained.native_cleanup_proven_for_test());
    assert!(retained.staging_release_proven_for_test());
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("foreign journal"),
        foreign
    );
}

#[cfg(windows)]
#[test]
fn terminal_join_rechecks_listener_after_clock_before_terminal_write() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, cleaned, _group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let port = plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("activation descriptor")
        .planned_root_port(0)
        .expect("planned root port");
    let (mut released, _) = cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| panic!("release staging: {}", failure.detail_for_test()));
    released.inject_terminal_listener_rebind_after_clock_for_test(port);
    let failure =
        match released.terminalize_after_release(Instant::now() + Duration::from_secs(10), None) {
            Ok(_) => panic!("late listener rebound must block terminal write"),
            Err(failure) => failure,
        };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::TerminalJoinFailureKind::Listener
    );
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
    let mut retained = failure.into_owner();
    assert!(TcpStream::connect((LOOPBACK_HOST, port)).is_ok());
    retained.release_terminal_foreign_listener_for_test();
    let terminal = retained
        .terminalize_after_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "terminal retry after listener release: {}",
                failure.detail_for_test()
            )
        });
    assert_eq!(
        terminal.journal_for_test().state,
        crate::journal::JournalState::Terminal
    );
}

#[cfg(windows)]
#[test]
fn closing_staging_release_rejects_foreign_top_entry_and_marker_replacement() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, cleaned, group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let marker_path = group_path.join(".capture-run-staging-v1");
    let marker_bytes = fs::read(&marker_path).expect("marker");
    let foreign = group_path.join("foreign-runtime-state");
    fs::write(&foreign, b"preserve").expect("foreign top entry");

    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("foreign top entry must block every deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    assert_eq!(fs::read(&foreign).expect("foreign retained"), b"preserve");
    let retained = failure.into_owner();
    fs::remove_file(&foreign).expect("remove foreign test entry");
    fs::write(&marker_path, b"foreign-marker").expect("replace marker");
    let marker_failure = match retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("marker replacement must block every deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        marker_failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(marker_failure
        .detail_for_test()
        .contains("OwnershipUnknown"));
    assert!(group_path.exists());
    let retained = marker_failure.into_owner();
    fs::write(&marker_path, marker_bytes).expect("restore marker");
    let outside_marker = directory.path().join("outside-marker-hardlink");
    fs::hard_link(&marker_path, &outside_marker).expect("marker hardlink");
    let hardlink_failure = match retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("hardlinked marker must block every deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        hardlink_failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    assert!(outside_marker.exists());
    let retained = hardlink_failure.into_owner();
    fs::remove_file(&outside_marker).expect("remove marker hardlink");
    let (released, _) = retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "release after restoring owned marker: {}",
                failure.detail_for_test()
            )
        });
    assert!(released.staging_release_proven_for_test());
    assert!(!group_path.exists());
}

#[cfg(windows)]
#[test]
fn closing_staging_release_keeps_released_scope_for_post_delete_listener_retry() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, mut cleaned, group_path, root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    fs::write(root_paths[0].join("runtime.spool"), b"runtime").expect("runtime staging file");
    cleaned.inject_listener_query_failure_after_staging_for_test();

    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("post-delete listener failure must retain the owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Listener
    );
    assert!(!failure.detail_for_test().is_empty());
    let retained = failure.into_owner();
    assert!(retained.staging_release_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert!(!group_path.exists());
    assert_eq!(retained.native_cleanup_attempts_for_test(), 1);

    let (released, _) = retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "released scope should permit listener retry: {}",
                failure.detail_for_test()
            )
        });
    assert!(released.listener_release_proven_for_test());
    assert_eq!(released.native_cleanup_attempts_for_test(), 1);
    assert!(!group_path.exists());
}

#[cfg(windows)]
#[test]
fn closing_staging_release_checks_budget_after_final_listener_proof() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, mut cleaned, group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    cleaned.inject_staging_release_cancel_before_authority_for_test();
    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("late cancellation must retain the Closing owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Cancelled
    );
    let retained = failure.into_owner();
    assert!(retained.staging_release_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert!(!group_path.exists());
    let (released, _) = retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "late-cancel retry should issue the retained release proof: {}",
                failure.detail_for_test()
            )
        });
    assert!(released.listener_release_proven_for_test());
    assert_eq!(released.native_cleanup_attempts_for_test(), 1);
}

#[cfg(windows)]
#[test]
fn closing_staging_release_rejects_nested_hardlink_and_preserves_outside_file() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, cleaned, group_path, root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let outside = directory.path().join("outside-runtime-state");
    fs::write(&outside, b"outside").expect("outside file");
    let inside = root_paths[0].join("runtime-hardlink.spool");
    fs::hard_link(&outside, &inside).expect("hardlink inside run scope");

    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("hardlinked runtime file must block deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    assert!(inside.exists());
    assert_eq!(fs::read(&outside).expect("outside preserved"), b"outside");
    let retained = failure.into_owner();
    fs::remove_file(&inside).expect("remove hardlink test entry");
    let (released, _) = retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "release after hardlink removed: {}",
                failure.detail_for_test()
            )
        });
    assert!(!group_path.exists());
    assert_eq!(fs::read(&outside).expect("outside preserved"), b"outside");
    drop(released);
}

#[cfg(windows)]
#[test]
fn closing_staging_release_rejects_nested_junction_before_any_delete() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, cleaned, group_path, root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let outside = directory.path().join("outside-junction");
    fs::create_dir(&outside).expect("outside junction target");
    fs::write(outside.join("preserve.bin"), b"outside").expect("outside payload");
    let junction = root_paths[0].join("foreign-junction");
    let status = std::process::Command::new("cmd.exe")
        .args([
            "/C",
            "mklink",
            "/J",
            junction.to_str().expect("junction path"),
            outside.to_str().expect("outside path"),
        ])
        .status()
        .expect("mklink junction command");
    assert!(status.success(), "junction creation must be available");

    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("nested junction must block every deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    assert!(junction.exists());
    assert_eq!(
        fs::read(outside.join("preserve.bin")).expect("outside preserved"),
        b"outside"
    );

    let retained = failure.into_owner();
    fs::remove_dir(&junction).expect("remove junction");
    let (released, _) = retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "release after junction removal: {}",
                failure.detail_for_test()
            )
        });
    assert!(!group_path.exists());
    assert_eq!(
        fs::read(outside.join("preserve.bin")).expect("outside preserved"),
        b"outside"
    );
    drop(released);
}

#[cfg(windows)]
#[test]
fn closing_staging_release_rejects_missing_or_replaced_root_before_deletion() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, cleaned, group_path, root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    let root_path = &root_paths[0];
    let moved = directory.path().join("moved-owned-root");
    fs::rename(root_path, &moved).expect("move owned root away");

    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("missing root must block staging deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(
        failure.detail_for_test().contains("OwnershipUnknown"),
        "unexpected missing-root failure: {}",
        failure.detail_for_test()
    );
    assert!(group_path.exists());
    assert!(moved.exists());
    let retained = failure.into_owner();
    fs::rename(&moved, root_path).expect("restore owned root");

    let moved = directory.path().join("replaced-owned-root");
    fs::rename(root_path, &moved).expect("move owned root away again");
    fs::create_dir(root_path).expect("foreign replacement root");
    let failure = match retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("replaced root must block staging deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    assert!(moved.exists());
    let retained = failure.into_owner();
    fs::remove_dir(root_path).expect("remove foreign root");
    fs::rename(&moved, root_path).expect("restore original root");
    let (released, _) = retained
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|failure| {
            panic!(
                "release after restoring root: {}",
                failure.detail_for_test()
            )
        });
    assert!(released.staging_release_proven_for_test());
    assert!(!group_path.exists());
}

#[cfg(windows)]
#[test]
fn closing_staging_release_retains_partial_delete_progress_for_fault_and_cancel_retry() {
    for cancel in [false, true] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (_plan, cleaned, group_path, root_paths) =
            closing_owner_with_staging_for_test(directory.path(), 1);
        let first = root_paths[0].join("a-runtime.spool");
        let second = root_paths[0].join("b-runtime.spool");
        fs::write(&first, b"first").expect("first runtime file");
        fs::write(&second, b"second").expect("second runtime file");
        if cancel {
            cleaned.inject_staging_release_cancel_after_delete_at_for_test(0);
        } else {
            cleaned.inject_staging_release_delete_failure_at_for_test(1);
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        let failure = match cleaned.release_staging_after_native_cleanup(
            Instant::now() + Duration::from_secs(10),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("partial release must retain owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            if cancel {
                crate::process::ClosingStagingReleaseFailureKind::Cancelled
            } else {
                crate::process::ClosingStagingReleaseFailureKind::Storage
            }
        );
        assert!(group_path.exists());
        assert!(!first.exists());
        assert!(second.exists());
        let retained = failure.into_owner();
        let (released, _) = retained
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|failure| {
                panic!("partial release retry: {}", failure.detail_for_test())
            });
        assert!(!group_path.exists());
        assert!(released.staging_release_proven_for_test());
        assert_eq!(released.native_cleanup_attempts_for_test(), 1);
    }
}

#[cfg(windows)]
#[test]
fn closing_staging_release_rejects_unconfirmed_move_and_preflight_bounds() {
    for target in ["root", "marker", "group"] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (_plan, cleaned, group_path, root_paths) =
            closing_owner_with_staging_for_test(directory.path(), 1);
        let marker_path = group_path.join(".capture-run-staging-v1");
        let move_target = directory.path().join(format!("moved-{target}"));
        let mutation = match target {
            "root" => 0,
            "marker" => 1,
            "group" => 2,
            _ => unreachable!(),
        };
        cleaned.inject_staging_release_delete_failure_at_for_test(mutation);
        let failure = match cleaned
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        {
            Ok(_) => panic!("injected pre-delete failure must retain the owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::ClosingStagingReleaseFailureKind::Storage
        );
        let retained = failure.into_owner();
        let moved_path = match target {
            "root" => &root_paths[0],
            "marker" => &marker_path,
            "group" => &group_path,
            _ => unreachable!(),
        };
        fs::rename(moved_path, &move_target).expect("move unconfirmed target away");
        let failure = match retained
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
        {
            Ok(_) => panic!("missing unconfirmed target must remain unknown"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::ClosingStagingReleaseFailureKind::Validation
        );
        assert!(
            move_target.exists(),
            "moved owned data must remain outside scope"
        );
        let retained = failure.into_owner();
        fs::rename(&move_target, moved_path).expect("restore owned target");
        let (released, _) = retained
            .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
            .unwrap_or_else(|failure| {
                panic!(
                    "release after restoring target: {}",
                    failure.detail_for_test()
                )
            });
        assert!(!group_path.exists());
        drop(released);
    }

    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, cleaned, group_path, root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    fs::create_dir(root_paths[0].join("bounded-depth")).expect("nested directory");
    cleaned.inject_staging_release_depth_limit_for_test(0);
    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("depth bound must fail before deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    let mut retained = failure.into_owner();
    let cancellation = Arc::new(AtomicBool::new(true));
    let failure = match retained.release_staging_after_native_cleanup(
        Instant::now() + Duration::from_secs(10),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("preflight cancellation must fail before deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Cancelled
    );
    assert!(group_path.exists());
    retained = failure.into_owner();
    drop(retained);

    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, cleaned, group_path, _root_paths) =
        closing_owner_with_staging_for_test(directory.path(), 1);
    cleaned.inject_staging_release_entry_limit_for_test(1);
    let failure = match cleaned
        .release_staging_after_native_cleanup(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("entry bound must fail before deletion"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingStagingReleaseFailureKind::Validation
    );
    assert!(group_path.exists());
    drop(failure.into_owner());
}

#[cfg(windows)]
#[test]
fn closing_listener_query_failure_retains_native_proof_for_retry() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    let mut closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    closing.inject_listener_query_failure_for_test();

    let failure = match closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("listener query failure must retain Closing owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Listener
    );
    assert!(failure
        .detail_for_test()
        .contains("listener release table query failure"));
    let retained = failure.into_owner();
    assert!(retained.native_cleanup_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert_eq!(retained.native_cleanup_attempts_for_test(), 1);

    let retried = retained
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("listener release retry"));
    assert!(retried.native_cleanup_proven_for_test());
    assert!(retried.listener_release_proven_for_test());
    assert_eq!(retried.native_cleanup_attempts_for_test(), 1);
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
}

#[cfg(windows)]
#[test]
fn closing_listener_release_rejects_rebound_reserved_port_and_reobserves_after_release() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    let port = closing.closing_journal_for_test().roots[0].loopback_port;
    let cleaned = closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("first listener-release observation"));
    assert!(cleaned.listener_release_proven_for_test());
    assert_eq!(cleaned.native_cleanup_attempts_for_test(), 1);

    let foreign = TcpListener::bind((LOOPBACK_HOST, port))
        .expect("foreign listener can rebind the released port");
    let failure = match cleaned
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("a rebound reserved port must clear release authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Listener
    );
    assert!(failure
        .detail_for_test()
        .contains("listener remained on reserved port"));
    let retained = failure.into_owner();
    assert!(retained.native_cleanup_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert_eq!(retained.native_cleanup_attempts_for_test(), 1);
    assert!(
        TcpStream::connect_timeout(
            &format!("{LOOPBACK_HOST}:{port}")
                .parse()
                .expect("foreign address"),
            Duration::from_secs(1),
        )
        .is_ok(),
        "cleanup must never touch a foreign listener"
    );
    drop(foreign);

    let retried = retained
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("release should reobserve after foreign listener exits"));
    assert!(retried.listener_release_proven_for_test());
    assert_eq!(retried.native_cleanup_attempts_for_test(), 1);
}

#[cfg(windows)]
#[test]
fn closing_native_cleanup_failure_retains_same_owner_for_retry() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 2);
    let mut closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    closing.inject_native_cleanup_failure_for_test();

    let failure = match closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("native cleanup failure must retain Closing owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Native
    );
    let retained = failure.into_owner();
    assert!(!retained.native_cleanup_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert_eq!(retained.native_root_count_for_test(), Some(2));
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
    let retried = retained
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("native cleanup retry"));
    assert!(retried.native_cleanup_proven_for_test());
    assert!(retried.listener_release_proven_for_test());
    assert_eq!(retried.native_cleanup_attempts_for_test(), 2);
}

#[cfg(windows)]
#[test]
fn closing_mid_cleanup_cancellation_retains_partial_owner_without_false_proof() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (_plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 2);
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    let mut closing = closing;
    closing.inject_cancellation_after_native_cleanup_root_for_test(0);
    let cancellation = Arc::new(AtomicBool::new(false));
    let failure = match closing.cleanup_native_and_observe_listener_release(
        Instant::now() + Duration::from_secs(10),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("cancellation after the first root must retain the owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Cancelled
    );
    assert!(failure.detail_for_test().contains("cancel"));
    let retained = failure.into_owner();
    assert!(cancellation.load(Ordering::Acquire));
    assert_eq!(retained.native_cleanup_attempts_for_test(), 1);
    assert!(!retained.native_cleanup_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert_eq!(retained.native_root_count_for_test(), Some(2));

    let retried = retained
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("partial cleanup owner must be retryable"));
    assert!(retried.native_cleanup_proven_for_test());
    assert!(retried.listener_release_proven_for_test());
    assert_eq!(retried.native_cleanup_attempts_for_test(), 2);
}

#[cfg(windows)]
#[test]
fn closing_cleanup_cancellation_before_native_cleanup_retains_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    let cancellation = Arc::new(AtomicBool::new(true));
    let failure = match closing.cleanup_native_and_observe_listener_release(
        Instant::now() + Duration::from_secs(10),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("pre-cancelled cleanup must retain Closing owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Cancelled
    );
    let retained = failure.into_owner();
    assert_eq!(retained.native_cleanup_attempts_for_test(), 0);
    assert!(!retained.native_cleanup_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
}

#[cfg(windows)]
#[test]
fn closing_cleanup_revalidates_address_index_before_native_termination() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    let index_path = fs::read_dir(directory.path())
        .expect("producer root")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("runtime-ref-index-v1-") && name.ends_with(".json")
                })
        })
        .expect("address index");
    fs::remove_file(index_path).expect("remove index before close cleanup");

    let failure = match closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("missing address index must stop native cleanup"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Validation
    );
    let retained = failure.into_owner();
    assert_eq!(retained.native_cleanup_attempts_for_test(), 0);
    assert!(!retained.native_cleanup_proven_for_test());
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Closing journal")
            .state,
        crate::journal::JournalState::Closing
    );
}

#[cfg(windows)]
#[test]
fn closing_cleanup_rejects_stale_journal_before_native_termination() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, running, _running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    let closing = running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(10), None)
        .unwrap_or_else(|_| panic!("Running owner should enter Closing"));
    let current = plan
        .context
        .store
        .read(&plan.value)
        .expect("Closing journal");
    {
        let outcome = plan.context.store.compare_and_swap_owned(
            &plan.value,
            &current,
            crate::journal_store::JournalStoreCommand::Transition {
                next_state: crate::journal::JournalState::ReconcileRequired,
                timestamp: current.updated_at.clone(),
            },
        );
        assert_eq!(
            outcome.disposition(),
            crate::journal_store::CasDisposition::Committed
        );
        outcome.attempt().cloned().expect("reconciliation drift")
    };

    let failure = match closing
        .cleanup_native_and_observe_listener_release(Instant::now() + Duration::from_secs(10), None)
    {
        Ok(_) => panic!("stale Closing owner must not terminate native roots"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingCleanupFailureKind::Validation
    );
    assert!(failure.detail_for_test().contains("admission"));
    let retained = failure.into_owner();
    assert_eq!(retained.native_cleanup_attempts_for_test(), 0);
    assert!(!retained.native_cleanup_proven_for_test());
    assert!(!retained.listener_release_proven_for_test());
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("drifted journal")
            .state,
        crate::journal::JournalState::ReconcileRequired
    );
}

#[cfg(windows)]
#[test]
fn running_close_ambiguous_replacement_keeps_owner_without_closing_authority() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = ready
        .launch_with_budget(&activation_budget_for_test())
        .unwrap_or_else(|_| panic!("durable Launching and native resume"));
    let launching_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        launching_journal.roots[0].pid,
        launching_journal.journal_revision,
    );
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[0],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[0]),
        200,
        false,
    );
    let running = launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
        .unwrap_or_else(|_| panic!("root should reach Running"));
    let running_journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Running journal");
    plan.context
        .store
        .fail_after_replace_and_durability_recheck();
    let failure = match running
        .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("ambiguous replacement must not issue Closing authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingTransitionFailureKind::Storage
    );
    assert!(failure.detail_for_test().contains("possibly Closing"));
    assert_eq!(
        failure.candidate_disposition_for_test(),
        Some(crate::journal_store::CasDisposition::AmbiguousWrite)
    );
    let owner = failure.into_owner();
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("candidate journal");
    assert_eq!(disk.state, crate::journal::JournalState::Closing);
    assert_eq!(disk.journal_revision, running_journal.journal_revision + 1);
    assert_eq!(owner.running_journal_for_test(), &running_journal);
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_close_cancellation_after_real_admission_contention_keeps_running_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (plan, _marker_paths, mut running, running_journal) =
        running_http_owner_for_test(directory.path(), 1);
    let (reached_sender, reached_receiver) = sync_channel(1);
    let (acquired_sender, acquired_receiver) = sync_channel(1);
    running.coordinate_closing_admission_for_test(reached_sender, acquired_receiver);
    let (release_sender, release_receiver) = sync_channel(1);
    let lock_store = Arc::clone(&plan.context.store);
    let holder = thread::spawn(move || {
        if reached_receiver
            .recv_timeout(Duration::from_secs(5))
            .is_err()
        {
            return;
        }
        let Ok(lock) = lock_store.lock_for_test() else {
            return;
        };
        let _ = acquired_sender.send(());
        let _ = release_receiver.recv_timeout(Duration::from_secs(5));
        drop(lock);
    });

    let contention = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .set_running_lock_contention_signal_for_test(Some(Arc::clone(&contention)));
    let cancellation = Arc::new(AtomicBool::new(false));
    let cancellation_watcher = Arc::clone(&cancellation);
    let contention_watcher = Arc::clone(&contention);
    let watcher = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !contention_watcher.load(Ordering::Acquire) {
            thread::yield_now();
        }
        // If the OS never reports the held-lock contention, still release
        // the admission attempt at the bounded rendezvous deadline so a
        // broken test hook cannot hang the suite.
        cancellation_watcher.store(true, Ordering::Release);
    });
    let failure = match running.begin_closing_with_cancellation(
        Instant::now() + Duration::from_secs(8),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("admission cancellation after lock contention must retain owner"),
        Err(failure) => failure,
    };
    plan.context
        .store
        .set_running_lock_contention_signal_for_test(None);
    let _ = release_sender.send(());
    holder.join().expect("lock holder must terminate bounded");
    watcher
        .join()
        .expect("contention watcher must terminate bounded");
    assert!(
        contention.load(Ordering::Acquire),
        "the close path must have reached a real failed lock attempt"
    );
    assert_eq!(
        failure.kind_for_test(),
        crate::process::ClosingTransitionFailureKind::Cancelled
    );
    let owner = failure.into_owner();
    assert_eq!(owner.running_journal_for_test(), &running_journal);
    let disk = plan
        .context
        .store
        .read(&plan.value)
        .expect("Running journal");
    assert_eq!(disk, running_journal);
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_close_cancellation_boundaries_keep_the_exact_owner_and_disk_state() {
    for boundary in ["before-replace", "after-replace", "after-readback"] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (plan, _marker_paths, running, running_journal) =
            running_http_owner_for_test(directory.path(), 1);
        let cancellation = Arc::new(AtomicBool::new(false));
        let store = &plan.context.store;
        match boundary {
            "before-replace" => {
                store.cancel_before_closing_replace_for_test(Arc::clone(&cancellation));
            }
            "after-replace" => {
                store.cancel_after_closing_replace_for_test(Arc::clone(&cancellation));
            }
            "after-readback" => {
                store.cancel_after_closing_readback_for_test(Arc::clone(&cancellation));
            }
            _ => unreachable!(),
        }
        let failure = match running.begin_closing_with_cancellation(
            Instant::now() + Duration::from_secs(5),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("{boundary} cancellation must retain Running owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::ClosingTransitionFailureKind::Cancelled
        );
        assert!(cancellation.load(Ordering::Acquire));
        if boundary == "after-readback" {
            assert!(
                failure
                    .detail_for_test()
                    .to_ascii_lowercase()
                    .contains("cancel"),
                "final egress guard must report the injected post-readback cancellation"
            );
        }
        let owner = failure.into_owner();
        let disk = plan
            .context
            .store
            .read(&plan.value)
            .expect("closing boundary journal");
        if boundary == "before-replace" {
            assert_eq!(disk, running_journal);
        } else {
            assert_eq!(disk.state, crate::journal::JournalState::Closing);
            assert_eq!(disk.journal_revision, running_journal.journal_revision + 1);
        }
        assert_eq!(owner.running_journal_for_test(), &running_journal);
        let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
        assert!(cleanup.native_cleanup_proven_for_test());
    }
}

#[cfg(windows)]
#[test]
fn activation_probe_readiness_failures_retain_launching_owner_without_running_authority() {
    for (http_mode, expected_status, expected_kind, expected_detail) in [
        (
            "status503",
            503_u16,
            crate::process::RunningPromotionFailureKind::NotReady,
            "did not report strict",
        ),
        (
            "partial",
            200_u16,
            crate::process::RunningPromotionFailureKind::Validation,
            "body length",
        ),
    ] {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) =
            activation_http_test_descriptor_with_mode(directory.path(), &ports, http_mode);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context");
        let owner = crate::process::acquire_suspended_for_activation_with_budget(
            activation,
            &activation_budget_for_test(),
        )
        .expect("suspended owner");
        let ready = owner
            .persist_ready_with_budget(&activation_budget_for_test())
            .expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_status(
            &marker_paths,
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            expected_status,
            false,
        );

        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(3), None)
        {
            Ok(_) => panic!("non-ready service must retain Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            expected_kind,
            "{}",
            failure.detail_for_test()
        );
        assert!(
            failure.detail_for_test().contains(expected_detail),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
        assert!(cleanup.native_cleanup_proven_for_test());
    }

    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) =
        activation_http_test_descriptor_with_mode(directory.path(), &ports, "silent");
    let plan = build_activation_plan(descriptor).expect("silent HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    wait_for_activation_probe_http_checkpoint(ports[0], &marker_paths[0]);
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(1), None)
    {
        Ok(_) => panic!("silent service must be bounded and retain owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::NotReady
    );
    assert!(failure.detail_for_test().contains("did not report strict"));
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn activation_probe_second_root_failure_retains_the_complete_native_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(2);
    drop(reservations);
    let modes = ["ready", "status503"];
    let (plan, marker_paths, launching) =
        launch_http_owner_with_modes_for_test(directory.path(), &ports, &modes);
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[0],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[0]),
        200,
        false,
    );
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[1],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[1]),
        503,
        false,
    );
    let group_staging_path = plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("activation descriptor")
        .planned_group_staging_path();
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("a second-root readiness failure must retain the Launching owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::NotReady
    );
    assert!(
        failure
            .detail_for_test()
            .contains("root 1 did not report strict"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(launching.native_root_count_for_test(), Some(2));
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    let retained = cleanup;
    assert!(retained.native_cleanup_proven_for_test());
    assert!(group_staging_path.is_dir());
    assert!(marker_paths.iter().all(|path| path.is_file()));
}

#[cfg(windows)]
#[test]
fn activation_probe_listener_checkpoint_allows_bounded_delayed_startup() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let started = Instant::now();
    let (plan, _marker_paths, launching) = launch_http_owner_with_modes_and_delay_for_test(
        directory.path(),
        &ports,
        &["ready"],
        Some(5_100),
    );
    assert!(
        started.elapsed() >= Duration::from_secs(5),
        "delayed fixture did not exercise the former five-second startup boundary"
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
    drop(plan);
}

#[cfg(windows)]
#[test]
fn activation_probe_requires_schema_context_and_cancellation_before_running() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = activation_probe_test_descriptor(directory.path(), &[42169]);
    let plan = build_activation_plan(descriptor).expect("marker-only activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(3), None)
    {
        Ok(_) => panic!("value-only descriptor cannot produce service readiness"),
        Err(failure) => failure,
    };
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());

    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) =
        activation_http_test_descriptor_with_mode(directory.path(), &ports, "silent");
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    wait_for_activation_probe_http_checkpoint(ports[0], &marker_paths[0]);
    let cancellation = Arc::new(AtomicBool::new(false));
    let cancellation_signal = Arc::clone(&cancellation);
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        cancellation_signal.store(true, std::sync::atomic::Ordering::Release);
    });
    let failure = match launching.promote_running_with_cancellation(
        Instant::now() + Duration::from_secs(15),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("cancelled promotion must retain Launching owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Cancelled,
        "{}",
        failure.detail_for_test()
    );
    assert!(failure.detail_for_test().contains("cancelled"));
    canceller.join().expect("cancellation thread");
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_promotion_rejects_native_or_staging_drift_and_ambiguous_cas() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let mut launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[0],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[0]),
        200,
        false,
    );
    launching.inject_listener_query_failure_for_test();
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("listener query failure must retain Launching owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Validation
    );
    assert!(
        failure
            .detail_for_test()
            .contains("Injected listener table query failure."),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());

    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    // The scope validator observes the actual planned marker through the
    // owner; a foreign marker mutation must stop before any Running CAS.
    let group_path = plan
        .context
        .activation_descriptor
        .as_ref()
        .expect("descriptor")
        .planned_group_staging_path();
    let marker_path = group_path.join(".capture-run-staging-v1");
    let marker = fs::read(&marker_path).expect("owned marker");
    fs::write(&marker_path, b"foreign running marker").expect("mutate marker");
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("staging drift must retain Launching owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Validation
    );
    assert!(
        failure
            .detail_for_test()
            .contains("staging marker identity changed"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    fs::write(&marker_path, marker).expect("restore marker");
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());

    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
    let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[0],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[0]),
        200,
        false,
    );
    plan.context
        .store
        .fail_after_replace_and_durability_recheck();
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("ambiguous Running CAS must retain Launching owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Storage
    );
    assert!(
        failure
            .detail_for_test()
            .contains("Running journal CAS failed"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Running
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_promotion_clock_failure_retains_launching_owner_without_running_authority() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
    let plan = build_activation_plan_with_clock(
        descriptor,
        [
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Err(crate::prepare::PrepareError::JournalUnavailable),
        ],
    );
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    drop(reservations);
    let launching = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(owner) => owner,
        Err(_) => panic!("durable Launching and native resume"),
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    wait_for_activation_probe_http_status(
        &marker_paths,
        ports[0],
        Some(ACTIVATION_HTTP_TOKEN),
        &format!("{LOOPBACK_HOST}:{}", ports[0]),
        200,
        false,
    );
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("clock failure must retain Launching owner"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Validation
    );
    assert!(
        failure.detail_for_test().contains("producer clock failed"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_admission_honors_deadline_and_cancellation_while_lock_is_held() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, mut launching) = launch_http_owner_for_test(directory.path(), &ports);
    let (reached_sender, reached_receiver) = sync_channel(1);
    let (acquired_sender, acquired_receiver) = sync_channel(1);
    launching.coordinate_running_admission_for_test(reached_sender, acquired_receiver);
    let contention = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .set_running_lock_deadline_after_contention_for_test(Arc::clone(&contention));
    let holder_active = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let (release_done_sender, release_done_receiver) = sync_channel(1);
    let contention_signal = Arc::clone(&contention);
    let holder_active_signal = Arc::clone(&holder_active);
    let release_signal = Arc::clone(&release);
    let lock_store = Arc::clone(&plan.context.store);
    let holder = std::thread::spawn(move || {
        if reached_receiver
            .recv_timeout(Duration::from_secs(5))
            .is_err()
        {
            let _ = release_done_sender.send(false);
            return;
        }
        let lock = match lock_store.lock_for_test() {
            Ok(lock) => lock,
            Err(_) => {
                let _ = release_done_sender.send(false);
                return;
            }
        };
        holder_active_signal.store(true, Ordering::Release);
        if acquired_sender.send(()).is_err() {
            drop(lock);
            holder_active_signal.store(false, Ordering::Release);
            let _ = release_done_sender.send(false);
            return;
        }
        let wait_deadline = Instant::now() + Duration::from_secs(5);
        while !contention_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
            thread::yield_now();
        }
        while !release_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
            thread::yield_now();
        }
        let released_by_test = release_signal.load(Ordering::Acquire);
        drop(lock);
        holder_active_signal.store(false, Ordering::Release);
        let _ = release_done_sender.send(released_by_test);
    });
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("expired admission must retain the Launching owner"),
        Err(failure) => failure,
    };
    let attempted = contention.load(Ordering::Acquire);
    let owner_was_held = holder_active.load(Ordering::Acquire);
    release.store(true, Ordering::Release);
    let released_by_test = release_done_receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("lock holder release rendezvous");
    holder.join().expect("lock holder cleanup");
    plan.context
        .store
        .set_running_lock_contention_signal_for_test(None);
    assert!(attempted, "admission never observed ERROR_LOCK_VIOLATION");
    assert!(owner_was_held, "admission contention lacked a live holder");
    assert!(
        !holder_active.load(Ordering::Acquire),
        "lock holder did not release"
    );
    assert!(
        released_by_test,
        "lock holder used its timeout fallback instead of the test release"
    );
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Deadline
    );
    assert!(
        failure.detail_for_test().contains("AdmissionDeadline"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());

    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, mut launching) = launch_http_owner_for_test(directory.path(), &ports);
    let cancellation = Arc::new(AtomicBool::new(false));
    let cancellation_signal = Arc::clone(&cancellation);
    let (reached_sender, reached_receiver) = sync_channel(1);
    let (acquired_sender, acquired_receiver) = sync_channel(1);
    launching.coordinate_running_admission_for_test(reached_sender, acquired_receiver);
    let contention = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .set_running_lock_contention_signal_for_test(Some(Arc::clone(&contention)));
    let holder_active = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let (release_done_sender, release_done_receiver) = sync_channel(1);
    let contention_signal = Arc::clone(&contention);
    let holder_active_signal = Arc::clone(&holder_active);
    let release_signal = Arc::clone(&release);
    let lock_store = Arc::clone(&plan.context.store);
    let cancel = std::thread::spawn(move || {
        if reached_receiver
            .recv_timeout(Duration::from_secs(5))
            .is_err()
        {
            let _ = release_done_sender.send(false);
            return;
        }
        let lock = match lock_store.lock_for_test() {
            Ok(lock) => lock,
            Err(_) => {
                let _ = release_done_sender.send(false);
                return;
            }
        };
        holder_active_signal.store(true, Ordering::Release);
        if acquired_sender.send(()).is_err() {
            drop(lock);
            holder_active_signal.store(false, Ordering::Release);
            let _ = release_done_sender.send(false);
            return;
        }
        let wait_deadline = Instant::now() + Duration::from_secs(5);
        while !contention_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
            thread::yield_now();
        }
        cancellation_signal.store(true, Ordering::Release);
        while !release_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
            thread::yield_now();
        }
        let released_by_test = release_signal.load(Ordering::Acquire);
        drop(lock);
        holder_active_signal.store(false, Ordering::Release);
        let _ = release_done_sender.send(released_by_test);
    });
    let failure = match launching.promote_running_with_cancellation(
        Instant::now() + Duration::from_secs(5),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("cancelled admission must retain the Launching owner"),
        Err(failure) => failure,
    };
    let attempted = contention.load(Ordering::Acquire);
    let owner_was_held = holder_active.load(Ordering::Acquire);
    release.store(true, Ordering::Release);
    let released_by_test = release_done_receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("cancellation holder release rendezvous");
    cancel.join().expect("cancellation holder cleanup");
    plan.context
        .store
        .set_running_lock_contention_signal_for_test(None);
    assert!(attempted, "admission never observed ERROR_LOCK_VIOLATION");
    assert!(owner_was_held, "admission contention lacked a live holder");
    assert!(
        !holder_active.load(Ordering::Acquire),
        "lock holder did not release"
    );
    assert!(
        released_by_test,
        "lock holder used its timeout fallback instead of the test release"
    );
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Cancelled
    );
    assert!(
        failure.detail_for_test().contains("AdmissionCancelled"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_post_cas_cancellation_keeps_owner_without_issuing_running_authority() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, launching) = launch_http_owner_for_test(directory.path(), &ports);
    let cancellation = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .cancel_after_running_replace_for_test(Arc::clone(&cancellation));
    let failure = match launching.promote_running_with_cancellation(
        Instant::now() + Duration::from_secs(5),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("post-CAS cancellation must not issue Running authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Cancelled,
        "{}",
        failure.detail_for_test()
    );
    assert!(failure
        .detail_for_test()
        .contains("completed after cancellation"));
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Running
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_pre_cas_cancellation_under_lock_keeps_launching_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, launching) = launch_http_owner_for_test(directory.path(), &ports);
    let cancellation = Arc::new(AtomicBool::new(false));
    plan.context
        .store
        .cancel_before_running_replace_for_test(Arc::clone(&cancellation));
    let failure = match launching.promote_running_with_cancellation(
        Instant::now() + Duration::from_secs(5),
        Some(Arc::clone(&cancellation)),
    ) {
        Ok(_) => panic!("pre-CAS cancellation must not issue Running authority"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Cancelled
    );
    assert!(failure.committed_candidate_for_test().is_none());
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_final_native_observation_change_retains_launching_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, mut launching) = launch_http_owner_for_test(directory.path(), &ports);
    launching.inject_listener_identity_mutation_after_first_for_test();
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("changed final listener observation must fail closed"),
        Err(failure) => failure,
    };
    assert!(
        failure
            .detail_for_test()
            .contains("native root binding changed"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_last_native_observation_change_retains_launching_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, mut launching) = launch_http_owner_for_test(directory.path(), &ports);
    launching.inject_listener_identity_mutation_at_last_observation_for_test();
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("the last native observation must guard the Running CAS"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Validation
    );
    assert!(
        failure
            .detail_for_test()
            .contains("native root binding changed during Running promotion"),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(launching.listener_observation_count_for_test(), 3);
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn running_final_root_exit_retains_launching_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (reservations, ports) = held_distinct_loopback_ports(1);
    drop(reservations);
    let (plan, _marker_paths, mut launching) = launch_http_owner_for_test(directory.path(), &ports);
    launching.inject_root_exit_after_first_for_test();
    let failure = match launching
        .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
    {
        Ok(_) => panic!("root exit during final observation must fail closed"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind_for_test(),
        crate::process::RunningPromotionFailureKind::Validation
    );
    assert!(
        failure
            .detail_for_test()
            .contains("Runtime root 0 was no longer live during listener observation."),
        "{}",
        failure.detail_for_test()
    );
    let launching = failure.into_owner();
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(launching.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn activation_probe_root_n_resume_failure_keeps_prior_marker_and_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, marker_paths) =
        activation_probe_test_descriptor(directory.path(), &[42167_u16, 42168_u16]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let mut ready = ready;
    ready.inject_resume_failure_at_for_test(1);

    let failure = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("root N resume failure"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Launching owner retained") {
        crate::process::ActivationLaunchOwner::Launching(owner) => owner,
        crate::process::ActivationLaunchOwner::Ready(_) => {
            panic!("root N resume failure occurs after durable Launching")
        }
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    assert_eq!(journal.state, crate::journal::JournalState::Launching);
    wait_for_activation_probe_marker(
        &marker_paths[0],
        0,
        journal.roots[0].pid,
        journal.journal_revision,
    );
    assert!(!marker_paths[1].exists(), "root N must remain suspended");
    assert_eq!(owner.native_root_count_for_test(), Some(2));
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn launching_cancellation_before_cas_retains_ready_owner_without_resume() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42158]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let cancellation = Arc::new(AtomicBool::new(true));

    let failure = match ready.launch_with_budget(&crate::journal_store::ActivationBudget::new(
        std::time::Instant::now() + std::time::Duration::from_secs(60),
        Arc::clone(&cancellation),
    )) {
        Ok(_) => panic!("pre-CAS cancellation"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Ready owner retained") {
        crate::process::ActivationLaunchOwner::Ready(owner) => owner,
        crate::process::ActivationLaunchOwner::Launching(_) => {
            panic!("pre-CAS cancellation cannot produce Launching ownership")
        }
    };
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Ready journal")
            .state,
        crate::journal::JournalState::Ready
    );
    let mut owner = owner;
    assert!(owner.native_is_suspended_for_test());
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
// Budgeted launch checks cancellation inside the Launching CAS step, before a
// LaunchingActivationOwner exists. The durable journal is already Launching, so the
// retained owner is the Ready one: still suspended, never resumed, and cleanable.
// (The deleted launch_with_cancellation path returned a Launching owner instead.)
fn launching_cancellation_after_cas_keeps_journal_launching_without_resume() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42159]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let cancellation = Arc::new(AtomicBool::new(false));
    crate::staging::cancel_after_launching_cas_for_test();

    let failure = match ready.launch_with_budget(&crate::journal_store::ActivationBudget::new(
        std::time::Instant::now() + std::time::Duration::from_secs(60),
        Arc::clone(&cancellation),
    )) {
        Ok(_) => panic!("post-CAS cancellation"),
        Err(failure) => failure,
    };
    let mut owner = match failure.into_owner().expect("owner retained") {
        crate::process::ActivationLaunchOwner::Ready(owner) => owner,
        crate::process::ActivationLaunchOwner::Launching(_) => {
            panic!("budgeted post-CAS cancellation fails before a Launching owner exists")
        }
    };
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("Launching journal");
    assert_eq!(journal.state, crate::journal::JournalState::Launching);
    assert!(
        owner.native_is_suspended_for_test(),
        "post-CAS cancellation must not resume the native group"
    );
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn launching_cancellation_before_root_n_retains_the_partial_native_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42161, 42162]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let cancellation = Arc::new(AtomicBool::new(false));
    crate::process::inject_cancellation_before_resume_root_for_test(1);

    let failure = match ready.launch_with_budget(&crate::journal_store::ActivationBudget::new(
        std::time::Instant::now() + std::time::Duration::from_secs(60),
        Arc::clone(&cancellation),
    )) {
        Ok(_) => panic!("mid-group cancellation"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Launching owner retained") {
        crate::process::ActivationLaunchOwner::Launching(owner) => owner,
        crate::process::ActivationLaunchOwner::Ready(_) => {
            panic!("mid-group cancellation occurs after the Launching CAS")
        }
    };
    assert_eq!(owner.native_root_count_for_test(), Some(2));
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Launching journal")
            .state,
        crate::journal::JournalState::Launching
    );
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn launching_durability_failure_never_upgrades_from_disk_to_resume() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42160]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    plan.context
        .store
        .fail_after_replace_and_durability_recheck();

    let failure = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("ambiguous Launching write must not resume"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Ready owner retained") {
        crate::process::ActivationLaunchOwner::Ready(owner) => owner,
        crate::process::ActivationLaunchOwner::Launching(_) => {
            panic!("ambiguous CAS cannot issue a Launching owner")
        }
    };
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("candidate journal")
            .state,
        crate::journal::JournalState::Launching
    );
    let mut owner = owner;
    assert!(owner.native_is_suspended_for_test());
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn launching_clock_failure_retains_ready_owner_and_journal() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42163]);
    let plan = build_activation_plan_with_clock(
        descriptor,
        [
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Err(crate::prepare::PrepareError::JournalUnavailable),
        ],
    );
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let failure = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("Launching clock failure"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Ready owner retained") {
        crate::process::ActivationLaunchOwner::Ready(owner) => owner,
        crate::process::ActivationLaunchOwner::Launching(_) => {
            panic!("clock failure precedes the Launching CAS")
        }
    };
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Ready journal")
            .state,
        crate::journal::JournalState::Ready
    );
    let mut owner = owner;
    assert!(owner.native_is_suspended_for_test());
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn launching_revalidation_rejects_staging_drift_before_cas() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42164]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let marker_path = group_path.join(".capture-run-staging-v1");
    let marker = fs::read(&marker_path).expect("owned marker");
    fs::write(&marker_path, b"foreign marker after Ready").expect("mutate marker");

    let failure = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("staging drift before Launching CAS"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Ready owner retained") {
        crate::process::ActivationLaunchOwner::Ready(owner) => owner,
        crate::process::ActivationLaunchOwner::Launching(_) => {
            panic!("staging drift must stop before Launching CAS")
        }
    };
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Ready journal")
            .state,
        crate::journal::JournalState::Ready
    );
    fs::write(&marker_path, marker).expect("restore marker");
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn launching_revalidation_rejects_native_identity_drift_before_cas() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42169]);
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let ready = owner
        .persist_ready_with_budget(&activation_budget_for_test())
        .expect("durable Ready");
    let mut ready = ready;
    ready.inject_native_membership_failure_for_test();

    let failure = match ready.launch_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("native membership drift before Launching CAS"),
        Err(failure) => failure,
    };
    let owner = match failure.into_owner().expect("Ready owner retained") {
        crate::process::ActivationLaunchOwner::Ready(owner) => owner,
        crate::process::ActivationLaunchOwner::Launching(_) => {
            panic!("native drift must stop before Launching CAS")
        }
    };
    assert_eq!(
        plan.context
            .store
            .read(&plan.value)
            .expect("Ready journal")
            .state,
        crate::journal::JournalState::Ready
    );
    let cleanup = cleanup_activation_for_test(owner.into_suspended_owner());
    assert!(cleanup.native_cleanup_proven_for_test());
}

#[cfg(windows)]
#[test]
fn ready_cas_durability_error_retains_suspended_owner_without_resume() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42149]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    plan.context
        .store
        .fail_after_replace_and_durability_recheck();

    let failure = match owner.persist_ready_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("durability failure must not issue Ready owner"),
        Err(failure) => failure,
    };
    let mut owner = failure.into_owner().expect("native owner retained");
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    assert!(owner.native_is_suspended_for_test());
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("candidate remains a valid journal");
    assert_eq!(journal.state, crate::journal::JournalState::Ready);

    let cleanup_failure = cleanup_activation_for_test(owner);
    let owner = cleanup_failure;
    assert!(owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());
}

#[cfg(windows)]
#[test]
fn ready_revalidation_rejects_index_mutation_after_native_acquisition() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42150]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");

    let index_path = fs::read_dir(directory.path())
        .expect("producer root")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("runtime-ref-index-v1-") && name.ends_with(".json")
                })
        })
        .expect("address index");
    fs::remove_file(index_path).expect("remove index after native acquisition");

    let failure = match owner.persist_ready_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("index mutation must block durable Ready"),
        Err(failure) => failure,
    };
    let mut owner = failure.into_owner().expect("owner retained");
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    assert!(owner.native_is_suspended_for_test());
    let journal = plan
        .context
        .store
        .read(&plan.value)
        .expect("prepared journal");
    assert_eq!(journal.state, crate::journal::JournalState::PreparedBound);
    assert!(group_path.exists());

    let owner = cleanup_activation_for_test(owner);
    assert!(owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());
}

#[cfg(windows)]
fn assert_ready_clock_failure(
    values: impl IntoIterator<Item = Result<String, crate::prepare::PrepareError>>,
) {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42151]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan_with_clock(descriptor, values);
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let failure = match owner.persist_ready_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("clock failure must block durable Ready"),
        Err(failure) => failure,
    };
    let mut owner = failure.into_owner().expect("owner retained");
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    assert!(owner.native_is_suspended_for_test());
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::PreparedBound
    );
    let owner = cleanup_activation_for_test(owner);
    assert!(owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());
}

#[cfg(windows)]
#[test]
fn ready_clock_failure_and_backward_time_retain_suspended_owner() {
    assert_ready_clock_failure([
        Ok("2026-01-01T00:00:01Z".into()),
        Ok("2026-01-01T00:00:01Z".into()),
        Ok("2026-01-01T00:00:02Z".into()),
        Err(crate::prepare::PrepareError::JournalUnavailable),
    ]);
    assert_ready_clock_failure([
        Ok("2026-01-01T00:00:01Z".into()),
        Ok("2026-01-01T00:00:01Z".into()),
        Ok("2026-01-01T00:00:02Z".into()),
        Ok("2026-01-01T00:00:01Z".into()),
    ]);
}

#[cfg(windows)]
#[test]
fn ready_revalidation_rejects_staging_drift_after_native_acquisition() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42152]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    let marker_path = group_path.join(".capture-run-staging-v1");
    let marker = fs::read(&marker_path).expect("owned marker");
    fs::write(&marker_path, b"foreign-marker-after-acquisition")
        .expect("mutate marker after acquisition");

    let failure = match owner.persist_ready_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("staging drift must block durable Ready"),
        Err(failure) => failure,
    };
    let mut owner = failure.into_owner().expect("owner retained");
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    assert!(owner.native_is_suspended_for_test());
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::PreparedBound
    );
    fs::write(&marker_path, marker).expect("restore owned marker");
    let owner = cleanup_activation_for_test(owner);
    assert!(owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());
}

#[cfg(windows)]
#[test]
fn ready_stale_cas_retains_suspended_owner_without_mutation() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42153]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    owner.inject_journal_drift_before_ready_for_test();

    let failure = match owner.persist_ready_with_budget(&activation_budget_for_test()) {
        Ok(_) => panic!("stale CAS must block durable Ready"),
        Err(failure) => failure,
    };
    let mut owner = failure.into_owner().expect("owner retained");
    assert_eq!(owner.native_root_count_for_test(), Some(1));
    assert!(owner.native_is_suspended_for_test());
    assert_eq!(
        plan.context.store.read(&plan.value).expect("journal").state,
        crate::journal::JournalState::ReconcileRequired
    );
    assert!(group_path.exists());
    let cleanup_failure = cleanup_activation_for_test(owner);
    let owner = cleanup_failure;
    assert!(owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());
}

#[cfg(windows)]
#[test]
fn native_cleanup_failure_keeps_staging_until_native_retry_succeeds() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42138, 42139]);
    let group_path = descriptor.planned_group_staging_path();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("validated activation context");
    let mut owner = crate::process::acquire_suspended_for_activation_with_budget(
        activation,
        &activation_budget_for_test(),
    )
    .expect("suspended owner");
    owner.inject_native_cleanup_failure_for_test();

    let cleanup_failure = cleanup_activation_for_test(owner);
    let owner = cleanup_failure;
    assert_eq!(owner.native_root_count_for_test(), Some(2));
    assert!(!owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());

    let owner = cleanup_activation_for_test(owner);
    assert!(owner.native_cleanup_proven_for_test());
    assert!(group_path.exists());
}

#[cfg(windows)]
#[test]
fn all_root_artifact_preflight_fails_before_staging_ownership() {
    let directory = tempfile::tempdir().expect("tempdir");
    let (descriptor, executable_path) =
        real_activation_test_descriptor(directory.path(), &[42133, 42134]);
    let group_path = descriptor.planned_group_staging_path();
    let shared_path = group_path
        .parent()
        .expect("shared staging parent")
        .to_path_buf();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    let mut bytes = fs::read(&executable_path).expect("fixture bytes");
    bytes[0] ^= 0xff;
    fs::write(&executable_path, bytes).expect("tamper fixture");
    let activation = prepared
        .consume_for_activation_with_budget(&activation_budget_for_test())
        .expect("journal binding remains valid");

    let failure = crate::staging::materialize(activation);
    assert!(matches!(
        failure,
        Err(crate::staging::StagingFailure::BeforeOwnership(
            crate::staging::StagingFailureKind::InvalidActivation
        ))
    ));
    assert!(!group_path.exists());
    assert!(!shared_path.exists());
}

#[cfg(windows)]
fn prepared_activation_for_staging(
    producer_root: &Path,
    executable_path: &Path,
    ports: &[u16],
) -> (
    crate::prepare::ValidatedActivationContext,
    PathBuf,
    Vec<PathBuf>,
) {
    let descriptor = activation_test_descriptor(producer_root, executable_path, ports);
    let group_path = descriptor.planned_group_staging_path();
    let root_paths = descriptor
        .planned_root_staging_paths()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    let plan = build_activation_plan(descriptor).expect("activation plan");
    let sink = DescriptorSink {
        binding: Mutex::new(None),
        fail_persist: false,
        persist_calls: AtomicUsize::new(0),
    };
    let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
    (
        prepared
            .consume_for_activation_with_budget(&activation_budget_for_test())
            .expect("validated activation context"),
        group_path,
        root_paths,
    )
}

#[cfg(windows)]
#[test]
fn staging_materialization_owns_marker_and_ordered_empty_roots() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let (activation, group_path, root_paths) =
        prepared_activation_for_staging(directory.path(), &executable_path, &[42123, 42124]);

    let owner = crate::staging::materialize(activation).expect("staging owner");
    assert!(group_path.is_dir());
    for (ordinal, path) in root_paths.iter().enumerate() {
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(format!("root-{ordinal:08}").as_str())
        );
        assert!(path.is_dir());
    }
    let marker_path = group_path.join(".capture-run-staging-v1");
    let marker = fs::read(&marker_path).expect("marker");
    assert!(marker.starts_with(b"{\"schemaVersion\":\"RunStagingMarkerV1\""));
    assert!(!marker
        .windows(b"secret-token".len())
        .any(|window| window == b"secret-token"));
    drop(owner);
    assert!(executable_path.exists());
    assert!(group_path.parent().expect("shared parent").exists());
}

#[cfg(windows)]
#[test]
fn staging_group_collision_is_rejected_before_owned_mutation() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let (activation, group_path, _) =
        prepared_activation_for_staging(directory.path(), &executable_path, &[42125]);
    fs::create_dir_all(&group_path).expect("foreign group");
    fs::write(group_path.join("foreign.txt"), b"keep").expect("foreign entry");

    assert!(matches!(
        crate::staging::materialize(activation),
        Err(crate::staging::StagingFailure::BeforeOwnership(_))
    ));
    assert_eq!(fs::read(group_path.join("foreign.txt")).unwrap(), b"keep");
}

#[cfg(windows)]
#[test]
fn staging_marker_flush_failure_retains_the_written_marker_owner() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let (activation, group_path, _) =
        prepared_activation_for_staging(directory.path(), &executable_path, &[42128]);
    crate::staging::fail_next_marker_flush_for_test();

    let owner = match crate::staging::materialize(activation) {
        Err(crate::staging::StagingFailure::Owned { owner, .. }) => owner,
        Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
            panic!("expected owned failure, got before ownership: {kind:?}")
        }
        Ok(_) => panic!("expected owned failure, got success"),
    };
    let marker_path = group_path.join(".capture-run-staging-v1");
    let marker = fs::read(&marker_path).expect("partial marker");
    fs::write(&marker_path, b"foreign-marker-bytes").expect("mutate marker");
    assert!(group_path.exists());
    fs::write(&marker_path, marker).expect("restore marker");
    drop(owner);
}

#[cfg(windows)]
#[test]
fn staging_marker_readback_failure_does_not_adopt_foreign_bytes() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let (activation, group_path, _) =
        prepared_activation_for_staging(directory.path(), &executable_path, &[42129]);
    crate::staging::fail_next_marker_readback_for_test();

    let owner = match crate::staging::materialize(activation) {
        Err(crate::staging::StagingFailure::Owned { owner, kind }) => {
            assert_eq!(kind, crate::staging::StagingFailureKind::MarkerReadBack);
            owner
        }
        Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
            panic!("expected owned failure, got before ownership: {kind:?}")
        }
        Ok(_) => panic!("expected failed marker read-back"),
    };
    let marker_path = group_path.join(".capture-run-staging-v1");
    assert_eq!(
        fs::read(&marker_path).expect("foreign marker"),
        b"foreign-marker-bytes"
    );
    assert!(group_path.exists());
    assert_eq!(
        fs::read(&marker_path).expect("foreign marker retained"),
        b"foreign-marker-bytes"
    );
    drop(owner);
}

#[cfg(windows)]
#[test]
fn staging_partial_marker_write_retains_only_confirmed_bytes() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let (activation, group_path, _) =
        prepared_activation_for_staging(directory.path(), &executable_path, &[42131]);
    crate::staging::fail_next_marker_partial_write_for_test();

    let owner = match crate::staging::materialize(activation) {
        Err(crate::staging::StagingFailure::Owned { owner, kind }) => {
            assert_eq!(kind, crate::staging::StagingFailureKind::Durability);
            owner
        }
        Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
            panic!("expected owned failure, got before ownership: {kind:?}")
        }
        Ok(_) => panic!("expected partial marker write failure"),
    };
    let marker_path = group_path.join(".capture-run-staging-v1");
    let confirmed_prefix = fs::read(&marker_path).expect("partial marker");
    assert!(!confirmed_prefix.is_empty());
    assert!(!confirmed_prefix
        .windows(b"foreign-marker-bytes".len())
        .any(|window| window == b"foreign-marker-bytes"));
    let mut foreign_marker = confirmed_prefix.clone();
    foreign_marker.extend_from_slice(b"foreign-marker-bytes");
    fs::write(&marker_path, foreign_marker).expect("mutate partial marker");
    assert!(group_path.exists());
    drop(owner);
}

#[cfg(windows)]
#[test]
fn staging_partial_root_failure_returns_an_owner_with_prior_roots() {
    let directory = tempfile::tempdir().expect("tempdir");
    let executable_path = directory.path().join("capture-runtime.exe");
    fs::write(&executable_path, b"runtime").expect("executable");
    let (activation, group_path, root_paths) =
        prepared_activation_for_staging(directory.path(), &executable_path, &[42129, 42130]);
    crate::staging::fail_next_root_mkdir_for_test(1);

    let owner = match crate::staging::materialize(activation) {
        Err(crate::staging::StagingFailure::Owned { owner, .. }) => owner,
        Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
            panic!("expected owned failure, got before ownership: {kind:?}")
        }
        Ok(_) => panic!("expected owned failure, got success"),
    };
    assert!(root_paths[0].is_dir());
    assert!(!root_paths[1].exists());
    assert!(group_path.is_dir());
    drop(owner);
}
