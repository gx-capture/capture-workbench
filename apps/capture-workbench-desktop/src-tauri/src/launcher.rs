use std::{
    collections::HashSet,
    fmt::Write as _,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use rand::{rngs::OsRng, RngCore};

use crate::{
    config::BackendConfig,
    constants::{
        DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_RETENTION_HOURS, LOOPBACK_HOST, WORKBENCH_OLLAMA_MODEL,
        WORKBENCH_OLLAMA_PROFILE,
    },
    health::{probe_ready_once, ProbeResult},
    manifest::{verify_runtime, RuntimeManifest, WindowsMlArtifactDescriptor},
    process::{terminate_owned_process_tree, OwnedRuntimeProcess},
    resources::RuntimeAssets,
};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_LAUNCH_ATTEMPTS: usize = 3;
const TOTAL_LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
const RETRY_POLL_INTERVAL: Duration = Duration::from_millis(25);
const RETRY_DELAY: Duration = Duration::from_millis(100);
const CHILD_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "APPDATA",
    "COMSPEC",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PROGRAMDATA",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
];

fn child_environment_name_is_allowed(name: &str) -> bool {
    CHILD_ENVIRONMENT_ALLOWLIST
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(name))
}

pub(crate) struct LaunchedRuntime {
    pub child: OwnedRuntimeProcess,
    pub config: BackendConfig,
}

enum LaunchAttemptError {
    Fatal(String),
    Retryable(String),
}

struct LaunchPolicy {
    runtime_port: u16,
    ollama_port: u16,
    token: String,
    data_dir: PathBuf,
}

impl LaunchPolicy {
    #[cfg(test)]
    fn deterministic(data_dir: PathBuf, runtime_port: u16, ollama_port: u16) -> Self {
        Self {
            runtime_port,
            ollama_port,
            token: "test-token".into(),
            data_dir,
        }
    }

    fn runtime_data_dir(&self) -> PathBuf {
        self.data_dir.join("runtime")
    }

    fn ollama_data_dir(&self) -> PathBuf {
        self.data_dir.join("ollama")
    }

    fn ollama_models_dir(&self) -> PathBuf {
        self.ollama_data_dir().join("models")
    }

    fn ollama_pid_file(&self) -> PathBuf {
        self.ollama_data_dir().join("ollama.pid")
    }

    fn base_url(&self) -> String {
        format!("http://{LOOPBACK_HOST}:{}", self.runtime_port)
    }

    fn environment(&self) -> Vec<(&'static str, String)> {
        let mut origins = vec!["http://tauri.localhost", "tauri://localhost"];
        if cfg!(debug_assertions) {
            origins.push("http://localhost:4200");
        }
        vec![
            ("CAPTURE_HOST", LOOPBACK_HOST.into()),
            ("CAPTURE_PORT", self.runtime_port.to_string()),
            ("CAPTURE_API_TOKEN", self.token.clone()),
            (
                "CAPTURE_ALLOWED_HOSTS",
                format!("{LOOPBACK_HOST}:{}", self.runtime_port),
            ),
            ("CAPTURE_ALLOWED_ORIGINS", origins.join(",")),
            ("CAPTURE_ENABLE_API_DOCS", "false".into()),
            (
                "CAPTURE_APP_DATA_DIR",
                self.runtime_data_dir().to_string_lossy().into_owned(),
            ),
            ("CAPTURE_STRUCTURING_PROVIDER", "ollama".into()),
            (
                "CAPTURE_RETENTION_HOURS",
                DEFAULT_RETENTION_HOURS.to_string(),
            ),
            (
                "CAPTURE_MAX_UPLOAD_BYTES",
                DEFAULT_MAX_UPLOAD_BYTES.to_string(),
            ),
            (
                "CAPTURE_OLLAMA_HOST",
                format!("http://{LOOPBACK_HOST}:{}", self.ollama_port),
            ),
            (
                "CAPTURE_OLLAMA_APP_DATA",
                self.ollama_data_dir().to_string_lossy().into_owned(),
            ),
            (
                "CAPTURE_OLLAMA_PID_FILE",
                self.ollama_pid_file().to_string_lossy().into_owned(),
            ),
            ("CAPTURE_OLLAMA_MODEL", WORKBENCH_OLLAMA_MODEL.into()),
            ("CAPTURE_OLLAMA_PROFILE_ID", WORKBENCH_OLLAMA_PROFILE.into()),
            (
                "OLLAMA_HOST",
                format!("{LOOPBACK_HOST}:{}", self.ollama_port),
            ),
            (
                "OLLAMA_MODELS",
                self.ollama_models_dir().to_string_lossy().into_owned(),
            ),
        ]
    }
}

struct LaunchPolicyFactory {
    data_dir: PathBuf,
    used_ports: HashSet<u16>,
    used_tokens: HashSet<String>,
}

impl LaunchPolicyFactory {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            used_ports: HashSet::new(),
            used_tokens: HashSet::new(),
        }
    }

    fn next(&mut self) -> Result<LaunchPolicy, String> {
        let runtime_port = reserve_distinct_loopback_port(&self.used_ports)?;
        let mut excluded_ports = self.used_ports.clone();
        excluded_ports.insert(runtime_port);
        let ollama_port = reserve_distinct_loopback_port(&excluded_ports)?;
        let token = self.next_token()?;

        self.used_ports.insert(runtime_port);
        self.used_ports.insert(ollama_port);
        self.used_tokens.insert(token.clone());
        Ok(LaunchPolicy {
            runtime_port,
            ollama_port,
            token,
            data_dir: self.data_dir.clone(),
        })
    }

    fn next_token(&self) -> Result<String, String> {
        for _ in 0..16 {
            let token = generate_bearer_token()?;
            if !self.used_tokens.contains(&token) {
                return Ok(token);
            }
        }
        Err("A fresh runtime bearer token could not be generated.".into())
    }
}

pub(crate) fn launch_runtime(
    assets: &RuntimeAssets,
    data_dir: PathBuf,
    stopping: &AtomicBool,
) -> Result<LaunchedRuntime, String> {
    // Integrity and contract verification are intentionally outside the retry
    // loop. A port race cannot change these assets, and hashing a large runtime
    // repeatedly would only extend startup without improving safety.
    let verified = verify_runtime(&assets.manifest_path, &assets.executable_path)?;
    let mut policy_factory = LaunchPolicyFactory::new(data_dir);
    run_bounded_launch_attempts(
        stopping,
        MAX_LAUNCH_ATTEMPTS,
        TOTAL_LAUNCH_TIMEOUT,
        |_, remaining| {
            // A new policy is generated for every attempt. Neither a port nor a
            // bearer token is reused after failed readiness.
            let policy = policy_factory.next().map_err(LaunchAttemptError::Fatal)?;
            prepare_isolated_directories(&policy).map_err(LaunchAttemptError::Fatal)?;

            let windowsml = &verified.manifest.runtime_requirements.windowsml_ocr;
            let mut command = runtime_command(&verified.executable_path, &policy, windowsml);
            let mut child =
                OwnedRuntimeProcess::spawn(&mut command).map_err(LaunchAttemptError::Fatal)?;

            let attempt_timeout = READY_TIMEOUT.min(remaining);
            let handshake = match wait_until_ready(
                &mut child,
                &policy,
                &verified.manifest,
                stopping,
                attempt_timeout,
            ) {
                Ok(handshake) => handshake,
                Err(error) => {
                    terminate_owned_process_tree(child).map_err(LaunchAttemptError::Fatal)?;
                    return Err(LaunchAttemptError::Retryable(error));
                }
            };

            Ok(LaunchedRuntime {
                child,
                config: BackendConfig {
                    base_url: policy.base_url(),
                    token: policy.token,
                    runtime_version: handshake.runtime_version,
                    api_version: handshake.api_version,
                    capture_document_schema_version: handshake.capture_document_schema_version,
                },
            })
        },
    )
}

fn run_bounded_launch_attempts<T>(
    stopping: &AtomicBool,
    max_attempts: usize,
    total_timeout: Duration,
    mut attempt: impl FnMut(usize, Duration) -> Result<T, LaunchAttemptError>,
) -> Result<T, String> {
    if max_attempts == 0 || total_timeout.is_zero() {
        return Err("Capture runtime launch policy did not allow an attempt.".into());
    }

    let started = Instant::now();
    let mut completed_attempts = 0;
    let mut last_failure = None;

    for attempt_number in 1..=max_attempts {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        let remaining = total_timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }

        completed_attempts = attempt_number;
        match attempt(attempt_number, remaining) {
            Ok(value) => return Ok(value),
            Err(LaunchAttemptError::Fatal(error)) => return Err(error),
            Err(LaunchAttemptError::Retryable(error)) => last_failure = Some(error),
        }

        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        if attempt_number < max_attempts {
            let remaining = total_timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            wait_before_retry(stopping, RETRY_DELAY.min(remaining))?;
        }
    }

    let last_failure = last_failure.unwrap_or_else(|| {
        "Capture runtime did not become ready before the total launch timeout.".into()
    });
    Err(format!(
        "Capture runtime did not become ready after {completed_attempts} isolated launch attempt(s). Last failure: {last_failure}"
    ))
}

fn wait_before_retry(stopping: &AtomicBool, delay: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < delay {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        thread::sleep(RETRY_POLL_INTERVAL.min(delay.saturating_sub(started.elapsed())));
    }
    Ok(())
}

fn prepare_isolated_directories(policy: &LaunchPolicy) -> Result<(), String> {
    for path in [
        policy.runtime_data_dir(),
        policy.ollama_data_dir(),
        policy.ollama_models_dir(),
    ] {
        fs::create_dir_all(path).map_err(|error| {
            format!("Capture Workbench data directory could not be created: {error}")
        })?;
    }
    Ok(())
}

fn runtime_command(
    executable: &Path,
    policy: &LaunchPolicy,
    windowsml: &WindowsMlArtifactDescriptor,
) -> Command {
    let mut command = Command::new(executable);
    command
        .env_clear()
        .arg("serve")
        .arg("--host")
        .arg(LOOPBACK_HOST)
        .arg("--port")
        .arg(policy.runtime_port.to_string())
        .current_dir(executable.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    for (name, value) in std::env::vars_os() {
        if name.to_str().is_some_and(child_environment_name_is_allowed) {
            command.env(name, value);
        }
    }
    for (name, value) in policy.environment() {
        command.env(name, value);
    }
    command.env("CAPTURE_WINDOWSML_BUNDLE_URL", &windowsml.artifact_url);
    command.env(
        "CAPTURE_WINDOWSML_BUNDLE_BYTES",
        windowsml.bytes.to_string(),
    );
    command.env("CAPTURE_WINDOWSML_BUNDLE_SHA256", &windowsml.sha256);

    command
}

fn wait_until_ready(
    child: &mut OwnedRuntimeProcess,
    policy: &LaunchPolicy,
    manifest: &RuntimeManifest,
    stopping: &AtomicBool,
    timeout: Duration,
) -> Result<crate::health::ReadyHandshake, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Capture runtime status could not be read: {error}"))?
        {
            return Err(format!(
                "Capture runtime exited before readiness with status {status}."
            ));
        }
        match probe_ready_once(policy.runtime_port, &policy.token, manifest)? {
            ProbeResult::Ready(handshake) => return Ok(handshake),
            ProbeResult::NotReady => thread::sleep(READY_POLL_INTERVAL),
        }
    }
    Err("Capture runtime did not become ready before the timeout.".into())
}

fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A loopback runtime port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The reserved loopback port could not be read: {error}"))
}

fn reserve_distinct_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = reserve_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A fresh independent loopback port could not be reserved.".into())
}

fn generate_bearer_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "A secure runtime bearer token could not be generated.".to_string())?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}")
            .map_err(|_| "A secure runtime bearer token could not be encoded.".to_string())?;
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn env_value(command: &Command, name: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(name))
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    }

    #[test]
    fn token_has_256_bits_encoded_without_url_punctuation() {
        let first = generate_bearer_token().expect("token");
        let second = generate_bearer_token().expect("token");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn loopback_ports_are_dynamic_and_independent() {
        let runtime_port = reserve_loopback_port().expect("runtime port");
        let ollama_port =
            reserve_distinct_loopback_port(&HashSet::from([runtime_port])).expect("ollama port");
        assert_ne!(runtime_port, ollama_port);
        assert!(TcpListener::bind((LOOPBACK_HOST, runtime_port)).is_ok());
        assert!(TcpListener::bind((LOOPBACK_HOST, ollama_port)).is_ok());
    }

    #[test]
    fn launch_policy_factory_never_reuses_attempt_ports_or_tokens() {
        let mut factory = LaunchPolicyFactory::new(PathBuf::from("workbench-data"));
        let policies: Vec<_> = (0..MAX_LAUNCH_ATTEMPTS)
            .map(|_| factory.next().expect("policy"))
            .collect();

        let ports: HashSet<_> = policies
            .iter()
            .flat_map(|policy| [policy.runtime_port, policy.ollama_port])
            .collect();
        let tokens: HashSet<_> = policies
            .iter()
            .map(|policy| policy.token.as_str())
            .collect();
        assert_eq!(ports.len(), MAX_LAUNCH_ATTEMPTS * 2);
        assert_eq!(tokens.len(), MAX_LAUNCH_ATTEMPTS);
    }

    #[test]
    fn retry_loop_is_bounded_and_reports_only_the_last_failure() {
        let stopping = AtomicBool::new(false);
        let mut attempts = Vec::new();
        let result = run_bounded_launch_attempts(
            &stopping,
            3,
            Duration::from_secs(2),
            |attempt_number, remaining| {
                attempts.push((attempt_number, remaining));
                Err::<(), _>(LaunchAttemptError::Retryable(format!(
                    "failure-{attempt_number}"
                )))
            },
        )
        .expect_err("bounded failure");

        assert_eq!(
            attempts
                .iter()
                .map(|(attempt, _)| *attempt)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert!(attempts.iter().all(|(_, remaining)| !remaining.is_zero()));
        assert!(result.contains("after 3 isolated launch attempt(s)"));
        assert!(result.contains("failure-3"));
        assert!(!result.contains("failure-1"));
        assert!(!result.contains("failure-2"));
    }

    #[test]
    fn shutdown_cancellation_prevents_another_attempt() {
        let stopping = AtomicBool::new(false);
        let mut attempts = 0;
        let result = run_bounded_launch_attempts(
            &stopping,
            MAX_LAUNCH_ATTEMPTS,
            Duration::from_secs(2),
            |_, _| {
                attempts += 1;
                stopping.store(true, Ordering::Release);
                Err::<(), _>(LaunchAttemptError::Retryable("port collision".into()))
            },
        )
        .expect_err("cancelled");

        assert_eq!(attempts, 1);
        assert_eq!(
            result,
            "Capture runtime launch was cancelled during shutdown."
        );
    }

    #[test]
    fn launch_environment_isolates_ollama_and_disables_docs() {
        let policy = LaunchPolicy::deterministic(PathBuf::from("workbench-data"), 41001, 41002);
        let windowsml = WindowsMlArtifactDescriptor {
            artifact_url: "https://downloads.example.org/capture-windowsml.zip".into(),
            artifact_file_name: "capture-windowsml.zip".into(),
            bytes: 123_456,
            sha256: "a".repeat(64),
        };
        let command = runtime_command(Path::new("capture-runtime.exe"), &policy, &windowsml);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(args, ["serve", "--host", "127.0.0.1", "--port", "41001"]);
        assert_eq!(
            env_value(&command, "CAPTURE_API_TOKEN").as_deref(),
            Some("test-token")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_ENABLE_API_DOCS").as_deref(),
            Some("false")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_STRUCTURING_PROVIDER").as_deref(),
            Some("ollama")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_OLLAMA_HOST").as_deref(),
            Some("http://127.0.0.1:41002")
        );
        assert_eq!(
            env_value(&command, "OLLAMA_HOST").as_deref(),
            Some("127.0.0.1:41002")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_OLLAMA_PROFILE_ID").as_deref(),
            Some(WORKBENCH_OLLAMA_PROFILE)
        );
        assert_eq!(
            env_value(&command, "CAPTURE_OLLAMA_MODEL").as_deref(),
            Some(WORKBENCH_OLLAMA_MODEL)
        );
        assert!(env_value(&command, "OLLAMA_MODELS")
            .expect("models")
            .contains("workbench-data"));
        assert_eq!(
            env_value(&command, "CAPTURE_ALLOWED_HOSTS").as_deref(),
            Some("127.0.0.1:41001")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_URL").as_deref(),
            Some("https://downloads.example.org/capture-windowsml.zip")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_BYTES").as_deref(),
            Some("123456")
        );
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_SHA256").as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );

        for poisoned in [
            "CERT_PREP_API_TOKEN",
            "LAW_PREP_API_TOKEN",
            "GITHUB_TOKEN",
            "HF_TOKEN",
            "CAPTURE_EXTRACTION_PROVIDER",
            "CAPTURE_WINDOWSML_MODEL_DIR",
        ] {
            assert!(!child_environment_name_is_allowed(poisoned));
            assert!(env_value(&command, poisoned).is_none());
        }
    }
}
