use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use capture_sidecar_launcher::OwnedRuntimeSession;

use crate::{
    config::{BackendConfig, DesktopRuntimeStatus},
    launcher::{launch_runtime, LaunchedRuntime},
    resources::RuntimeAssets,
};

const RUNTIME_MONITOR_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeIdentity {
    generation: u64,
    pid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimePhase {
    Pending,
    Ready,
}

struct OwnedRuntime {
    identity: RuntimeIdentity,
    phase: RuntimePhase,
    session: OwnedRuntimeSession,
}

struct DesktopRuntimeState {
    generation: u64,
    config: Option<BackendConfig>,
    status: DesktopRuntimeStatus,
    active: Option<OwnedRuntime>,
    cleanup: Vec<OwnedRuntime>,
    #[cfg(test)]
    cleanup_failures: usize,
}

/// The desktop's single authoritative lifecycle state.
///
/// Configuration, status, generation, and every owned session are guarded by
/// one mutex. Lifecycle methods never acquire another state lock while this
/// mutex is held, and stale callbacks compare both generation and PID before
/// changing the active record.
struct DesktopStateInner {
    data_dir: PathBuf,
    runtime: Mutex<DesktopRuntimeState>,
    stopping: AtomicBool,
}

#[derive(Clone)]
pub struct DesktopState {
    inner: Arc<DesktopStateInner>,
}

impl DesktopState {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(DesktopStateInner {
                data_dir,
                runtime: Mutex::new(DesktopRuntimeState {
                    generation: 0,
                    config: None,
                    status: DesktopRuntimeStatus::starting(),
                    active: None,
                    cleanup: Vec::new(),
                    #[cfg(test)]
                    cleanup_failures: 0,
                }),
                stopping: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn start(&self, assets: RuntimeAssets) {
        let generation = match self.begin_launch() {
            Ok(generation) => generation,
            Err(error) => {
                self.fail(error);
                return;
            }
        };
        let state = self.clone();
        thread::spawn(move || {
            let runtime = state.inner.clone();
            let observer_state = state.clone();
            let result = launch_runtime(
                &assets,
                runtime.data_dir.clone(),
                &runtime.stopping,
                move |session| observer_state.register_pending(generation, session),
            );
            match result {
                Ok(launched) => state.accept_launched(generation, launched),
                Err(error) => state.fail_launch(generation, error),
            }
        });
    }

    fn begin_launch(&self) -> Result<u64, String> {
        if self.inner.stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        let mut runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| "Capture runtime lifecycle state is unavailable.".to_string())?;
        if !runtime.cleanup.is_empty() {
            return Err("Capture runtime already has cleanup pending.".into());
        }
        let next_generation = runtime
            .generation
            .checked_add(1)
            .ok_or_else(|| "Capture runtime launch generation exhausted.".to_string())?;
        if let Some(active) = runtime.active.take() {
            let identity = active.identity;
            if let Err(error) = Self::cleanup_session(&mut runtime, &active.session) {
                runtime.active = Some(active);
                Self::cleanup_failure_status(&mut runtime, identity, error.clone());
                return Err(error);
            }
        }
        runtime.generation = next_generation;
        runtime.config = None;
        runtime.status = DesktopRuntimeStatus::starting();
        Ok(runtime.generation)
    }

    pub(crate) fn fail(&self, detail: impl Into<String>) {
        if self.inner.stopping.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            if runtime.status.status == "failed-cleanup" {
                return;
            }
            runtime.config = None;
            runtime.status = DesktopRuntimeStatus::failed(detail);
        }
    }

    fn cleanup_session(
        _runtime: &mut DesktopRuntimeState,
        session: &OwnedRuntimeSession,
    ) -> Result<(), String> {
        #[cfg(test)]
        if _runtime.cleanup_failures > 0 {
            _runtime.cleanup_failures -= 1;
            return Err("Injected cleanup proof failure.".into());
        }
        session.terminate().map_err(|error| error.to_string())
    }

    /// A cleanup callback may change global status only while its exact
    /// generation/PID still owns the active session or a retained cleanup
    /// record.  A newer active identity therefore makes an older callback a
    /// no-op for global status, while its cleanup ownership remains queued.
    fn cleanup_failure_is_current(
        runtime: &DesktopRuntimeState,
        identity: RuntimeIdentity,
    ) -> bool {
        if let Some(active) = runtime.active.as_ref() {
            return runtime.generation == identity.generation && active.identity == identity;
        }
        runtime
            .cleanup
            .iter()
            .any(|owned| owned.identity == identity)
    }

    fn cleanup_failure_status(
        runtime: &mut DesktopRuntimeState,
        identity: RuntimeIdentity,
        detail: impl Into<String>,
    ) -> bool {
        if !Self::cleanup_failure_is_current(runtime, identity) {
            return false;
        }
        runtime.config = None;
        runtime.status = DesktopRuntimeStatus::failed_cleanup(format!(
            "Capture runtime cleanup failed; the owned process is retained for retry: {}",
            detail.into()
        ));
        true
    }

    #[cfg(test)]
    fn inject_cleanup_failure_for_test(&self) {
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            runtime.cleanup_failures += 1;
        }
    }

    fn register_pending(
        &self,
        generation: u64,
        session: OwnedRuntimeSession,
    ) -> Result<(), String> {
        let identity = RuntimeIdentity {
            generation,
            pid: session.id(),
        };
        let mut runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| "Capture runtime lifecycle state is unavailable.".to_string())?;
        if runtime.generation != generation {
            return Err("Capture runtime launch generation is stale.".into());
        }
        if !runtime.cleanup.is_empty() {
            return Err("A previous Capture runtime cleanup is still pending.".into());
        }
        if let Some(active) = runtime.active.take() {
            if active.phase == RuntimePhase::Ready {
                runtime.active = Some(active);
                return Err("Capture runtime already has a ready owned session.".into());
            }
            if let Err(error) = Self::cleanup_session(&mut runtime, &active.session) {
                runtime.active = Some(active);
                return Err(error);
            }
        }
        runtime.active = Some(OwnedRuntime {
            identity,
            phase: RuntimePhase::Pending,
            session,
        });
        runtime.config = None;
        runtime.status = DesktopRuntimeStatus::starting();
        Ok(())
    }

    fn accept_launched(&self, generation: u64, launched: LaunchedRuntime) {
        let identity = RuntimeIdentity {
            generation,
            pid: launched.child.id(),
        };
        let config = launched.config;
        let accepted = if let Ok(mut runtime) = self.inner.runtime.lock() {
            let matches = !self.inner.stopping.load(Ordering::Acquire)
                && runtime.generation == generation
                && runtime
                    .active
                    .as_ref()
                    .is_some_and(|active| active.identity == identity);
            if matches {
                if let Some(active) = runtime.active.as_mut() {
                    active.phase = RuntimePhase::Ready;
                }
                runtime.config = Some(config.clone());
                runtime.status = DesktopRuntimeStatus::ready(&config);
            }
            matches
        } else {
            false
        };

        if accepted {
            self.monitor_runtime(identity);
        } else {
            self.cleanup_unaccepted(OwnedRuntime {
                identity,
                phase: RuntimePhase::Pending,
                session: launched.child,
            });
        }
    }

    fn cleanup_unaccepted(&self, candidate: OwnedRuntime) {
        let identity = candidate.identity;
        let session = candidate.session.clone();
        let Ok(mut runtime) = self.inner.runtime.lock() else {
            let _ = session.terminate();
            return;
        };
        match Self::cleanup_session(&mut runtime, &session) {
            Ok(()) => {
                if runtime
                    .active
                    .as_ref()
                    .is_some_and(|active| active.identity == identity)
                {
                    runtime.active = None;
                    runtime.config = None;
                }
                if self.inner.stopping.load(Ordering::Acquire)
                    && runtime.active.is_none()
                    && runtime.cleanup.is_empty()
                {
                    runtime.status = DesktopRuntimeStatus::stopped();
                }
            }
            Err(error) => {
                if !runtime
                    .active
                    .as_ref()
                    .is_some_and(|active| active.identity == identity)
                {
                    runtime.cleanup.push(candidate);
                }
                Self::cleanup_failure_status(&mut runtime, identity, error);
            }
        }
    }

    fn fail_launch(&self, generation: u64, detail: String) {
        let Ok(mut runtime) = self.inner.runtime.lock() else {
            return;
        };
        if runtime.generation != generation {
            return;
        }
        if runtime
            .active
            .as_ref()
            .is_some_and(|active| active.identity.generation != generation)
        {
            return;
        }
        let active = runtime
            .active
            .as_ref()
            .filter(|active| active.identity.generation == generation)
            .map(|active| (active.identity, active.session.clone()));
        if let Some((identity, session)) = active {
            match Self::cleanup_session(&mut runtime, &session) {
                Ok(()) => {
                    runtime.active = None;
                    runtime.config = None;
                    if self.inner.stopping.load(Ordering::Acquire) {
                        if runtime.cleanup.is_empty() {
                            runtime.status = DesktopRuntimeStatus::stopped();
                        }
                    } else {
                        runtime.status = DesktopRuntimeStatus::failed(detail);
                    }
                }
                Err(error) => {
                    Self::cleanup_failure_status(&mut runtime, identity, error);
                }
            }
        } else if !self.inner.stopping.load(Ordering::Acquire) {
            runtime.config = None;
            runtime.status = DesktopRuntimeStatus::failed(detail);
        }
    }

    /// Poll the owned root after startup so an unexpected runtime exit closes
    /// the same Job Object before its sidecars/listeners can remain alive.
    fn monitor_runtime(&self, identity: RuntimeIdentity) {
        let state = self.clone();
        thread::spawn(move || loop {
            if state.inner.stopping.load(Ordering::Acquire) {
                break;
            }
            match state.poll_runtime_exit(identity) {
                Ok(false) => thread::sleep(RUNTIME_MONITOR_INTERVAL),
                Ok(true) => break,
                Err(error) => {
                    state.record_cleanup_failure(identity, error);
                    break;
                }
            }
        });
    }

    fn record_cleanup_failure(&self, identity: RuntimeIdentity, detail: impl Into<String>) {
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            Self::cleanup_failure_status(&mut runtime, identity, detail);
        }
    }

    fn poll_runtime_exit(&self, identity: RuntimeIdentity) -> Result<bool, String> {
        let mut runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| "Capture runtime lifecycle state is unavailable.".to_string())?;
        let Some(active) = runtime.active.as_ref() else {
            return Ok(true);
        };
        if active.identity != identity {
            return Ok(true);
        }
        let session = active.session.clone();
        match session.monitor_root_exit() {
            Ok(None) => Ok(false),
            Ok(Some(status)) => {
                runtime.active = None;
                runtime.config = None;
                runtime.status = DesktopRuntimeStatus::failed(format!(
                    "Capture runtime exited unexpectedly with status {status}."
                ));
                Ok(true)
            }
            Err(error) => {
                Self::cleanup_failure_status(
                    &mut runtime,
                    identity,
                    format!(
                        "Capture runtime exited, but owned descendant cleanup could not be proven: {error}"
                    ),
                );
                Ok(false)
            }
        }
    }

    pub(crate) fn backend_config(&self) -> Result<BackendConfig, String> {
        let runtime = self
            .inner
            .runtime
            .lock()
            .map_err(|_| "Capture runtime lifecycle state is unavailable.".to_string())?;
        if self.inner.stopping.load(Ordering::Acquire) {
            if runtime.status.status == "failed-cleanup" {
                return Err("Capture runtime cleanup is still pending.".into());
            }
            return Err("Capture runtime is stopped.".into());
        }
        if let Some(config) = runtime.config.clone() {
            return Ok(config);
        }
        Err(format!(
            "Capture runtime is not ready: {}",
            runtime.status.detail
        ))
    }

    pub(crate) fn status(&self) -> DesktopRuntimeStatus {
        self.inner
            .runtime
            .lock()
            .map(|runtime| runtime.status.clone())
            .unwrap_or_else(|_| {
                DesktopRuntimeStatus::failed("Capture runtime status is unavailable.")
            })
    }

    pub(crate) fn runtime_process_id(&self) -> Option<u32> {
        self.inner.runtime.lock().ok().and_then(|runtime| {
            runtime
                .active
                .as_ref()
                .map(|active| active.session.id())
                .or_else(|| runtime.cleanup.first().map(|owned| owned.session.id()))
        })
    }

    #[cfg(test)]
    fn active_identity(&self) -> Option<RuntimeIdentity> {
        self.inner
            .runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.active.as_ref().map(|active| active.identity))
    }

    #[cfg(test)]
    fn cleanup_identities(&self) -> Vec<RuntimeIdentity> {
        self.inner
            .runtime
            .lock()
            .map(|runtime| runtime.cleanup.iter().map(|owned| owned.identity).collect())
            .unwrap_or_default()
    }

    pub(crate) fn shutdown(&self) {
        self.inner.stopping.store(true, Ordering::Release);
        let Ok(mut runtime) = self.inner.runtime.lock() else {
            return;
        };
        runtime.config = None;
        let mut errors = Vec::new();

        if let Some(active) = runtime.active.as_ref() {
            let session = active.session.clone();
            if let Err(error) = Self::cleanup_session(&mut runtime, &session) {
                errors.push(error);
            } else {
                runtime.active = None;
            }
        }

        let pending = std::mem::take(&mut runtime.cleanup);
        let mut retained = Vec::new();
        for owned in pending {
            let session = owned.session.clone();
            if let Err(error) = Self::cleanup_session(&mut runtime, &session) {
                errors.push(error);
                retained.push(owned);
            }
        }
        runtime.cleanup = retained;

        if runtime.active.is_none() && runtime.cleanup.is_empty() {
            runtime.status = DesktopRuntimeStatus::stopped();
        } else {
            let detail = if errors.is_empty() {
                "An owned runtime session remains pending cleanup.".to_string()
            } else {
                errors.join("; ")
            };
            // Select the owner that still exists after this shutdown pass.  A
            // stale queued session may report a failure only after it is
            // retained; it can then mark the app as failed-cleanup because
            // there is no newer active identity left to protect.  When a
            // newer active session is retained, only that active identity can
            // mutate global status.
            let identity = runtime
                .active
                .as_ref()
                .map(|owned| owned.identity)
                .or_else(|| runtime.cleanup.first().map(|owned| owned.identity));
            if let Some(identity) = identity {
                Self::cleanup_failure_status(&mut runtime, identity, detail);
            }
        }
    }
}

impl Drop for DesktopStateInner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Ok(runtime) = self.runtime.get_mut() {
            if let Some(active) = runtime.active.as_ref() {
                let _ = active.session.terminate();
            }
            for owned in &runtime.cleanup {
                let _ = owned.session.terminate();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn test_launched_runtime() -> LaunchedRuntime {
        use std::process::{Command, Stdio};

        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        LaunchedRuntime {
            child: OwnedRuntimeSession::spawn(&mut command).expect("owned runtime"),
            config: BackendConfig {
                base_url: "http://127.0.0.1:49152".into(),
                token: "test-token".into(),
                runtime_version: "0.4.2".into(),
                api_version: "2.0".into(),
                capture_document_schema_version: "2".into(),
            },
        }
    }

    #[test]
    fn failure_status_never_contains_a_connection_token() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        state.fail("manifest mismatch");
        let status = serde_json::to_string(&state.status()).expect("status");
        assert!(status.contains("manifest mismatch"));
        assert!(!status.contains("token"));
        state.shutdown();
    }

    #[test]
    fn shutdown_is_idempotent_and_blocks_config_access() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        state.shutdown();
        state.shutdown();
        assert_eq!(state.status().status, "stopped");
        assert_eq!(
            state.backend_config().expect_err("stopped"),
            "Capture runtime is stopped."
        );
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_error_keeps_owned_session_and_does_not_mark_stopped() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let generation = state.begin_launch().expect("generation");
        let launched = test_launched_runtime();
        let identity = RuntimeIdentity {
            generation,
            pid: launched.child.id(),
        };
        state
            .register_pending(generation, launched.child.clone())
            .expect("pending");
        state.accept_launched(generation, launched);
        state.inject_cleanup_failure_for_test();

        state.shutdown();

        assert_eq!(state.status().status, "failed-cleanup");
        assert!(state.runtime_process_id().is_some());
        assert_eq!(state.active_identity(), Some(identity));
        assert!(state.cleanup_identities().is_empty());
        assert_eq!(
            state.backend_config().expect_err("cleanup pending"),
            "Capture runtime cleanup is still pending."
        );

        state.shutdown();

        assert_eq!(state.status().status, "stopped");
        assert!(state.runtime_process_id().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn launch_accepted_during_close_retains_failed_cleanup_for_retry() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let generation = state.begin_launch().expect("generation");
        state.shutdown();
        state.inject_cleanup_failure_for_test();

        let launched = test_launched_runtime();
        let identity = RuntimeIdentity {
            generation,
            pid: launched.child.id(),
        };
        state.accept_launched(generation, launched);

        assert_eq!(state.status().status, "failed-cleanup");
        assert!(state.runtime_process_id().is_some());
        assert_eq!(state.cleanup_identities(), vec![identity]);

        state.shutdown();

        assert_eq!(state.status().status, "stopped");
        assert!(state.runtime_process_id().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn stale_monitor_cannot_touch_a_new_generation_or_pid() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let first_generation = state.begin_launch().expect("first generation");
        let first = test_launched_runtime();
        state
            .register_pending(first_generation, first.child.clone())
            .expect("first pending");
        state.accept_launched(first_generation, first);
        let stale_identity = state.active_identity().expect("first identity");

        let second_generation = state.begin_launch().expect("second generation");
        let second = test_launched_runtime();
        state
            .register_pending(second_generation, second.child.clone())
            .expect("second pending");
        state.accept_launched(second_generation, second);

        state.fail_launch(first_generation, "stale launch failure".into());
        assert!(state
            .poll_runtime_exit(stale_identity)
            .expect("stale monitor"));
        assert_eq!(state.status().status, "ready");
        assert!(state.backend_config().is_ok());

        state.shutdown();
    }

    #[cfg(windows)]
    #[test]
    fn stale_candidate_cleanup_failure_cannot_clear_new_active_generation() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let first_generation = state.begin_launch().expect("first generation");
        let first = test_launched_runtime();
        let stale_session = first.child.clone();
        state
            .register_pending(first_generation, first.child.clone())
            .expect("first pending");
        state.accept_launched(first_generation, first);
        let stale_identity = state.active_identity().expect("first identity");

        let second_generation = state.begin_launch().expect("second generation");
        let second = test_launched_runtime();
        state
            .register_pending(second_generation, second.child.clone())
            .expect("second pending");
        let second_config = second.config.clone();
        state.accept_launched(second_generation, second);
        let current_identity = state.active_identity().expect("second identity");

        state.inject_cleanup_failure_for_test();
        state.cleanup_unaccepted(OwnedRuntime {
            identity: stale_identity,
            phase: RuntimePhase::Pending,
            session: stale_session,
        });

        assert_eq!(state.active_identity(), Some(current_identity));
        assert_eq!(state.status().status, "ready");
        assert_eq!(
            state.backend_config().expect("current config"),
            second_config
        );
        assert_eq!(state.cleanup_identities(), vec![stale_identity]);

        state.shutdown();
        assert_eq!(state.status().status, "stopped");
        assert!(state.runtime_process_id().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn stale_monitor_failure_cannot_clear_new_active_generation() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let first_generation = state.begin_launch().expect("first generation");
        let first = test_launched_runtime();
        state
            .register_pending(first_generation, first.child.clone())
            .expect("first pending");
        state.accept_launched(first_generation, first);
        let stale_identity = state.active_identity().expect("first identity");

        let second_generation = state.begin_launch().expect("second generation");
        let second = test_launched_runtime();
        state
            .register_pending(second_generation, second.child.clone())
            .expect("second pending");
        let second_config = second.config.clone();
        state.accept_launched(second_generation, second);
        let current_identity = state.active_identity().expect("second identity");

        state.record_cleanup_failure(stale_identity, "stale monitor cleanup failure");

        assert_eq!(state.active_identity(), Some(current_identity));
        assert_eq!(state.status().status, "ready");
        assert_eq!(
            state.backend_config().expect("current config"),
            second_config
        );
        assert!(state.cleanup_identities().is_empty());

        state.shutdown();
        assert_eq!(state.status().status, "stopped");
    }
}
