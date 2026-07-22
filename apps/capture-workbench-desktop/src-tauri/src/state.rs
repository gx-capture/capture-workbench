use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use crate::{
    config::{BackendConfig, DesktopRuntimeStatus},
    launcher::{launch_runtime, LaunchedRuntime},
    process::{terminate_owned_process_tree, OwnedRuntimeProcess},
    resources::RuntimeAssets,
};

struct DesktopStateInner {
    data_dir: PathBuf,
    config: Mutex<Option<BackendConfig>>,
    status: Mutex<DesktopRuntimeStatus>,
    child: Mutex<Option<OwnedRuntimeProcess>>,
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
            let _ = terminate_owned_process_tree(launched.child);
            return;
        }

        let config = launched.config;
        let child = launched.child;
        let Ok(mut child_slot) = self.inner.child.lock() else {
            let _ = terminate_owned_process_tree(child);
            self.fail("Capture runtime process state is unavailable.");
            return;
        };
        let Ok(mut config_slot) = self.inner.config.lock() else {
            drop(child_slot);
            let _ = terminate_owned_process_tree(child);
            self.fail("Capture runtime connection state is unavailable.");
            return;
        };
        if self.inner.stopping.load(Ordering::Acquire) {
            drop(config_slot);
            drop(child_slot);
            let _ = terminate_owned_process_tree(child);
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
        if let Ok(mut config) = self.inner.config.lock() {
            *config = None;
        }
        if let Ok(mut child) = self.inner.child.lock() {
            if let Some(child) = child.take() {
                let _ = terminate_owned_process_tree(child);
            }
        }
        if let Ok(mut status) = self.inner.status.lock() {
            *status = DesktopRuntimeStatus::stopped();
        }
    }
}

impl Drop for DesktopStateInner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Ok(child) = self.child.get_mut() {
            if let Some(child) = child.take() {
                let _ = terminate_owned_process_tree(child);
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
}
