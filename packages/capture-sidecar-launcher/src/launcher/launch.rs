use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use super::spec::SidecarLaunchSpec;
use crate::{
    constants::{
        MAX_LAUNCH_ATTEMPTS, READY_POLL_INTERVAL, READY_TIMEOUT, RETRY_DELAY, RETRY_POLL_INTERVAL,
        TOTAL_LAUNCH_TIMEOUT,
    },
    health::{probe_ready_once, ProbeResult},
    manifest::VerifiedSidecar,
    process::OwnedRuntimeSession,
    SidecarConnection,
};

/// Bounds for one [`launch_sidecar`] call.
///
/// The `Default` implementation allows 3 attempts, waits up to 45 seconds for
/// each attempt to become ready, and stops the whole call after 60 seconds.
#[derive(Debug, Clone, Copy)]
pub struct LaunchOptions {
    /// How long one attempt waits for `/v2/health/ready`.
    pub ready_timeout: Duration,
    /// Pause between readiness probes while the process is still alive.
    pub ready_poll_interval: Duration,
    /// Maximum number of isolated processes. Zero rejects the call.
    pub max_attempts: usize,
    /// Budget for every attempt and the delays between them. Zero rejects the call.
    pub total_timeout: Duration,
    /// Pause after a failed attempt before the next spawn.
    pub retry_delay: Duration,
    /// How often that pause checks the stopping flag.
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

/// A ready sidecar and the ownership token for that process.
pub struct LaunchedSidecar {
    /// Ownership of the ready attempt. The last clone drops by stopping it.
    pub process: OwnedRuntimeSession,
    /// Loopback URL, bearer token, and versions from the ready handshake.
    pub connection: SidecarConnection,
}

/// Launches one verified sidecar and retries until it is ready or the policy ends.
///
/// Same process and cleanup behavior as [`launch_sidecar_with_observer`]. The
/// observer used here accepts every spawn.
///
/// # Errors
///
/// Returns `Err(String)` in the same cases as [`launch_sidecar_with_observer`].
pub fn launch_sidecar(
    verified: &VerifiedSidecar,
    stopping: &AtomicBool,
    options: LaunchOptions,
    spec_factory: impl FnMut(usize, Duration) -> Result<SidecarLaunchSpec, String>,
) -> Result<LaunchedSidecar, String> {
    launch_sidecar_with_observer(verified, stopping, options, spec_factory, |_| Ok(()))
}

/// Launches a sidecar and hands each spawned attempt to the host before probing.
///
/// `spec_factory` receives the attempt number, starting at 1, and the time
/// left in `options.total_timeout`. Each attempt spawns that command. On
/// Windows the child is created suspended, assigned to a kill-on-close job,
/// and resumed only after the assignment is checked. `observe_spawn` then
/// receives a clone of the ownership token. The launcher keeps its own clone,
/// probes readiness with the spec's bearer token, and does not log that token.
///
/// A failed probe or an early process exit stops that attempt before the next
/// one. `stopping` is checked before each attempt, during the ready wait, and
/// during the retry pause. An attempt that already returned ready is not
/// stopped because the flag later becomes true.
///
/// # Errors
///
/// Returns `Err(String)` when `max_attempts` or `total_timeout` is zero, when
/// `stopping` is set before a ready result, when `spec_factory` or spawn
/// fails, or when `observe_spawn` fails. An observer failure also stops that
/// attempt; if that cleanup fails, both messages are returned. When every
/// allowed attempt fails, the error includes the number of attempts and the
/// last probe or exit failure. Cleanup failure while retiring a not-ready
/// attempt is returned instead of the readiness failure.
pub fn launch_sidecar_with_observer(
    verified: &VerifiedSidecar,
    stopping: &AtomicBool,
    options: LaunchOptions,
    mut spec_factory: impl FnMut(usize, Duration) -> Result<SidecarLaunchSpec, String>,
    mut observe_spawn: impl FnMut(OwnedRuntimeSession) -> Result<(), String>,
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
        let mut process = OwnedRuntimeSession::spawn(&mut command)?;
        if let Err(error) = observe_spawn(process.clone()) {
            let cleanup = process.terminate().err();
            return Err(match cleanup {
                Some(cleanup) => {
                    format!("{error} The observed runtime attempt also failed cleanup: {cleanup}")
                }
                None => error,
            });
        }
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
                process.terminate().map_err(|cleanup| cleanup.to_string())?;
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
    process: &mut OwnedRuntimeSession,
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
    use super::LaunchOptions;

    #[test]
    fn default_launch_policy_is_three_attempts_and_bounded() {
        let options = LaunchOptions::default();
        assert_eq!(options.max_attempts, 3);
        assert!(options.total_timeout >= options.ready_timeout);
    }
}
