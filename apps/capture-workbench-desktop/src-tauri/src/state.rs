use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use capture_sidecar_launcher::OwnedSidecarProcess;

use crate::{
    config::{BackendConfig, DesktopRuntimeStatus},
    launcher::{launch_runtime, LaunchedRuntime},
    resources::RuntimeAssets,
};

#[derive(Default)]
struct StreamingRequestState {
    active: HashMap<String, Arc<AtomicBool>>,
    pending_cancellations: HashMap<String, bool>,
}

struct DesktopStateInner {
    data_dir: PathBuf,
    config: Mutex<Option<BackendConfig>>,
    status: Mutex<DesktopRuntimeStatus>,
    child: Mutex<Option<OwnedSidecarProcess>>,
    streaming_requests: Mutex<StreamingRequestState>,
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
                config: Mutex::new(None),
                status: Mutex::new(DesktopRuntimeStatus::starting()),
                child: Mutex::new(None),
                streaming_requests: Mutex::new(StreamingRequestState::default()),
                stopping: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn start(&self, assets: RuntimeAssets) {
        let state = self.clone();
        thread::spawn(move || {
            let result =
                launch_runtime(&assets, state.inner.data_dir.clone(), &state.inner.stopping);
            match result {
                Ok(launched) => state.accept_launched(launched),
                Err(error) => state.fail(error),
            }
        });
    }

    pub(crate) fn fail(&self, detail: impl Into<String>) {
        if self.inner.stopping.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut status) = self.inner.status.lock() {
            *status = DesktopRuntimeStatus::failed(detail);
        }
    }

    fn accept_launched(&self, launched: LaunchedRuntime) {
        if self.inner.stopping.load(Ordering::Acquire) {
            let _ = launched.child.terminate();
            return;
        }

        let config = launched.config;
        let child = launched.child;
        let Ok(mut child_slot) = self.inner.child.lock() else {
            let _ = child.terminate();
            self.fail("Capture runtime process state is unavailable.");
            return;
        };
        let Ok(mut config_slot) = self.inner.config.lock() else {
            drop(child_slot);
            let _ = child.terminate();
            self.fail("Capture runtime connection state is unavailable.");
            return;
        };
        if self.inner.stopping.load(Ordering::Acquire) {
            drop(config_slot);
            drop(child_slot);
            let _ = child.terminate();
            return;
        }

        *child_slot = Some(child);
        *config_slot = Some(config.clone());
        drop(config_slot);
        drop(child_slot);
        if let Ok(mut status) = self.inner.status.lock() {
            *status = DesktopRuntimeStatus::ready(&config);
        }
    }

    pub(crate) fn backend_config(&self) -> Result<BackendConfig, String> {
        if self.inner.stopping.load(Ordering::Acquire) {
            return Err("Capture runtime is stopped.".into());
        }
        if let Some(config) = self
            .inner
            .config
            .lock()
            .map_err(|_| "Capture runtime connection state is unavailable.".to_string())?
            .clone()
        {
            return Ok(config);
        }
        let status = self.status();
        Err(format!("Capture runtime is not ready: {}", status.detail))
    }

    pub(crate) fn status(&self) -> DesktopRuntimeStatus {
        self.inner
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| {
                DesktopRuntimeStatus::failed("Capture runtime status is unavailable.")
            })
    }

    pub(crate) fn shutdown(&self) {
        self.inner.stopping.store(true, Ordering::Release);
        if let Ok(mut requests) = self.inner.streaming_requests.lock() {
            for cancellation in requests.active.values() {
                cancellation.store(true, Ordering::Release);
            }
            requests.active.clear();
            requests.pending_cancellations.clear();
        }
        if let Ok(mut config) = self.inner.config.lock() {
            *config = None;
        }
        if let Ok(mut child) = self.inner.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.terminate();
            }
        }
        if let Ok(mut status) = self.inner.status.lock() {
            *status = DesktopRuntimeStatus::stopped();
        }
    }

    pub(crate) fn begin_streaming_request(
        &self,
        request_id: &str,
    ) -> Result<Arc<AtomicBool>, String> {
        if self.inner.stopping.load(Ordering::Acquire) {
            return Err("Capture runtime is stopped.".into());
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut requests = self
            .inner
            .streaming_requests
            .lock()
            .map_err(|_| "Capture runtime stream state is unavailable.".to_string())?;
        if requests.active.contains_key(request_id) {
            return Err("Capture Runtime SSE request is already active.".into());
        }
        let pending = requests
            .pending_cancellations
            .remove(request_id)
            .unwrap_or(false);
        cancellation.store(pending, Ordering::Release);
        requests
            .active
            .insert(request_id.to_string(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub(crate) fn cancel_streaming_request(&self, request_id: &str) {
        if let Ok(mut requests) = self.inner.streaming_requests.lock() {
            if let Some(cancellation) = requests.active.get(request_id) {
                cancellation.store(true, Ordering::Release);
            } else {
                requests
                    .pending_cancellations
                    .insert(request_id.to_string(), true);
            }
        }
    }

    pub(crate) fn finish_streaming_request(
        &self,
        request_id: &str,
        cancellation: &Arc<AtomicBool>,
    ) {
        if let Ok(mut requests) = self.inner.streaming_requests.lock() {
            if requests
                .active
                .get(request_id)
                .is_some_and(|active| Arc::ptr_eq(active, cancellation))
            {
                requests.active.remove(request_id);
            }
        }
    }
}

impl Drop for DesktopStateInner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Ok(requests) = self.streaming_requests.get_mut() {
            for cancellation in requests.active.values() {
                cancellation.store(true, Ordering::Release);
            }
            requests.active.clear();
            requests.pending_cancellations.clear();
        }
        if let Ok(child) = self.child.get_mut() {
            if let Some(child) = child.take() {
                let _ = child.terminate();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn streaming_request_cancellation_is_shared_with_the_native_reader() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let cancellation = state
            .begin_streaming_request("stream-request-1")
            .expect("register stream");
        assert!(!cancellation.load(Ordering::Acquire));
        state.cancel_streaming_request("stream-request-1");
        assert!(cancellation.load(Ordering::Acquire));
        state.finish_streaming_request("stream-request-1", &cancellation);
        assert!(state.begin_streaming_request("stream-request-1").is_ok());
        state.shutdown();
    }

    #[test]
    fn cancel_before_begin_returns_an_already_cancelled_stream() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        state.cancel_streaming_request("race-before-begin");

        let cancellation = state
            .begin_streaming_request("race-before-begin")
            .expect("register cancelled stream");
        assert!(cancellation.load(Ordering::Acquire));
        state.finish_streaming_request("race-before-begin", &cancellation);

        let reused = state
            .begin_streaming_request("race-before-begin")
            .expect("reuse request id");
        assert!(!reused.load(Ordering::Acquire));
        state.finish_streaming_request("race-before-begin", &reused);
        state.shutdown();
    }

    #[test]
    fn cancel_after_finish_is_preserved_for_a_reused_request_id() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let cancellation = state
            .begin_streaming_request("race-after-finish")
            .expect("register stream");
        state.finish_streaming_request("race-after-finish", &cancellation);

        state.cancel_streaming_request("race-after-finish");
        let reused = state
            .begin_streaming_request("race-after-finish")
            .expect("teardown cancellation is preserved");
        assert!(reused.load(Ordering::Acquire));
        state.finish_streaming_request("race-after-finish", &reused);
        state.shutdown();
    }

    #[test]
    fn shutdown_cancels_active_streams_and_clears_pending_cancellations() {
        let state = DesktopState::new(PathBuf::from("workbench-data"));
        let cancellation = state
            .begin_streaming_request("race-shutdown-active")
            .expect("register stream");
        state.cancel_streaming_request("race-shutdown-pending");

        state.shutdown();

        assert!(cancellation.load(Ordering::Acquire));
        assert_eq!(
            state
                .begin_streaming_request("race-shutdown-pending")
                .expect_err("stopped"),
            "Capture runtime is stopped."
        );
    }
}
