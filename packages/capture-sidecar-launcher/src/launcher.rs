use std::{
    collections::HashSet,
    fmt::Write as _,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use rand::{rngs::OsRng, RngCore};

use crate::{
    constants::{
        LOOPBACK_HOST, MAX_LAUNCH_ATTEMPTS, READY_POLL_INTERVAL, READY_TIMEOUT, RETRY_DELAY,
        RETRY_POLL_INTERVAL, TOTAL_LAUNCH_TIMEOUT,
    },
    health::{probe_ready_once, ProbeResult},
    manifest::VerifiedSidecar,
    process::OwnedSidecarProcess,
    SidecarConnection,
};

/// Reserves one ephemeral loopback port and releases the listener immediately.
pub fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A loopback runtime port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The reserved loopback port could not be read: {error}"))
}

/// Reserves an ephemeral loopback port not present in the supplied set.
pub fn reserve_distinct_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = reserve_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A fresh independent loopback port could not be reserved.".into())
}

/// Generates a fresh 256-bit bearer token encoded as lowercase hexadecimal.
pub fn generate_bearer_token() -> Result<String, String> {
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

/// Host-owned launch inputs. The launcher owns command isolation and process lifecycle;
/// the host supplies only its product-specific environment values.
pub struct SidecarLaunchSpec {
    pub executable_path: PathBuf,
    pub port: u16,
    pub token: String,
    pub environment: Vec<(String, String)>,
    pub inherited_environment_allowlist: Vec<String>,
}

impl SidecarLaunchSpec {
    /// Creates a launch specification for the runtime's standard `serve` entrypoint.
    pub fn new(
        executable_path: PathBuf,
        port: u16,
        token: String,
        environment: Vec<(String, String)>,
        inherited_environment_allowlist: Vec<String>,
    ) -> Self {
        Self {
            executable_path,
            port,
            token,
            environment,
            inherited_environment_allowlist,
        }
    }

    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.executable_path);
        command
            .env_clear()
            .arg("serve")
            .arg("--host")
            .arg(LOOPBACK_HOST)
            .arg("--port")
            .arg(self.port.to_string())
            .current_dir(
                self.executable_path
                    .parent()
                    .unwrap_or_else(|| Path::new(".")),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        for (name, value) in std::env::vars_os() {
            if name.to_str().is_some_and(|name| {
                self.inherited_environment_allowlist
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(name))
            }) {
                command.env(name, value);
            }
        }
        for (name, value) in &self.environment {
            command.env(name, value);
        }
        command
    }

    pub(crate) fn base_url(&self) -> String {
        format!("http://{LOOPBACK_HOST}:{}", self.port)
    }
}

/// Bounded launch timing and retry policy.
#[derive(Debug, Clone, Copy)]
pub struct LaunchOptions {
    pub ready_timeout: Duration,
    pub ready_poll_interval: Duration,
    pub max_attempts: usize,
    pub total_timeout: Duration,
    pub retry_delay: Duration,
    pub retry_poll_interval: Duration,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            ready_timeout: READY_TIMEOUT,
            ready_poll_interval: READY_POLL_INTERVAL,
            max_attempts: MAX_LAUNCH_ATTEMPTS,
            total_timeout: TOTAL_LAUNCH_TIMEOUT,
            retry_delay: RETRY_DELAY,
            retry_poll_interval: RETRY_POLL_INTERVAL,
        }
    }
}

/// A ready sidecar and its exact process-ownership handle.
pub struct LaunchedSidecar {
    pub process: OwnedSidecarProcess,
    pub connection: SidecarConnection,
}

/// Verifies, launches, probes, and retries one authenticated sidecar.
pub fn launch_sidecar(
    verified: &VerifiedSidecar,
    stopping: &AtomicBool,
    options: LaunchOptions,
    mut spec_factory: impl FnMut(usize, Duration) -> Result<SidecarLaunchSpec, String>,
) -> Result<LaunchedSidecar, String> {
    if options.max_attempts == 0 || options.total_timeout.is_zero() {
        return Err("Capture runtime launch policy did not allow an attempt.".into());
    }

    let started = Instant::now();
    let mut completed_attempts = 0;
    let mut last_failure = None;

    for attempt_number in 1..=options.max_attempts {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        let remaining = options.total_timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        completed_attempts = attempt_number;
        let spec = spec_factory(attempt_number, remaining)?;
        let mut command = spec.command();
        let mut process = match OwnedSidecarProcess::spawn(&mut command) {
            Ok(process) => process,
            Err(error) => return Err(error),
        };
        let timeout = options.ready_timeout.min(remaining);
        match wait_until_ready(
            &mut process,
            &spec,
            &verified.manifest,
            stopping,
            timeout,
            options.ready_poll_interval,
        ) {
            Ok(handshake) => {
                return Ok(LaunchedSidecar {
                    process,
                    connection: SidecarConnection {
                        base_url: spec.base_url(),
                        token: spec.token.clone(),
                        runtime_version: handshake.runtime_version,
                        api_version: handshake.api_version,
                        capture_document_schema_version: handshake.capture_document_schema_version,
                    },
                });
            }
            Err(error) => {
                process.terminate()?;
                last_failure = Some(error);
            }
        }

        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        if attempt_number < options.max_attempts {
            let remaining = options.total_timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            wait_before_retry(
                stopping,
                options.retry_delay.min(remaining),
                options.retry_poll_interval,
            )?;
        }
    }

    let last_failure = last_failure.unwrap_or_else(|| {
        "Capture runtime did not become ready before the total launch timeout.".into()
    });
    Err(format!(
        "Capture runtime did not become ready after {completed_attempts} isolated launch attempt(s). Last failure: {last_failure}"
    ))
}

fn wait_until_ready(
    process: &mut OwnedSidecarProcess,
    spec: &SidecarLaunchSpec,
    manifest: &crate::SidecarManifest,
    stopping: &AtomicBool,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<crate::ReadyHandshake, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        if let Some(status) = process
            .try_wait()
            .map_err(|error| format!("Capture runtime status could not be read: {error}"))?
        {
            return Err(format!(
                "Capture runtime exited before readiness with status {status}."
            ));
        }
        match probe_ready_once(spec.port, &spec.token, manifest)? {
            ProbeResult::Ready(handshake) => return Ok(handshake),
            ProbeResult::NotReady => thread::sleep(poll_interval),
        }
    }
    Err("Capture runtime did not become ready before the timeout.".into())
}

fn wait_before_retry(
    stopping: &AtomicBool,
    delay: Duration,
    poll_interval: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < delay {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        thread::sleep(poll_interval.min(delay.saturating_sub(started.elapsed())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, path::PathBuf};

    #[test]
    fn command_clears_ambient_environment_and_adds_host_values() {
        let spec = SidecarLaunchSpec::new(
            PathBuf::from("capture-runtime.exe"),
            42123,
            "secret-token".into(),
            vec![("CAPTURE_API_TOKEN".into(), "secret-token".into())],
            vec!["PATH".into()],
        );
        let command = spec.command();
        let values: HashSet<_> = command
            .get_envs()
            .filter_map(|(name, value)| {
                value.map(|value| {
                    (
                        name.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert!(values.contains(&("CAPTURE_API_TOKEN".into(), "secret-token".into())));
        assert!(!values.iter().any(
            |(name, value)| name.eq_ignore_ascii_case("CAPTURE_API_TOKEN") && value == "ambient"
        ));
    }

    #[test]
    fn default_launch_policy_is_three_attempts_and_bounded() {
        let options = LaunchOptions::default();
        assert_eq!(options.max_attempts, 3);
        assert!(options.total_timeout >= options.ready_timeout);
    }
}
