mod app_data;
mod cli;
mod dispatch;
mod server;
#[cfg(test)]
mod tests;

use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use crate::{library::LibraryStore, resources::RuntimeAssets, state::DesktopState};

use dispatch::HostContext;
use server::DevHostServer;

static CTRL_C_REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static DEV_HOST_STATE: std::sync::Mutex<Option<DesktopState>> = std::sync::Mutex::new(None);

struct ShutdownGuard<'a>(&'a DesktopState);

impl Drop for ShutdownGuard<'_> {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

#[cfg(windows)]
struct CtrlCHandlerGuard;

#[cfg(windows)]
fn dev_host_state_slot() -> std::sync::MutexGuard<'static, Option<DesktopState>> {
    DEV_HOST_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(windows)]
impl Drop for CtrlCHandlerGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        unsafe {
            SetConsoleCtrlHandler(Some(ctrl_c_handler), 0);
        }
        *dev_host_state_slot() = None;
    }
}

#[cfg(windows)]
unsafe extern "system" fn ctrl_c_handler(ctrl_type: u32) -> i32 {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT};
    if matches!(
        ctrl_type,
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT
    ) {
        let state = dev_host_state_slot().as_ref().cloned();
        if let Some(state) = state {
            state.shutdown();
        }
        CTRL_C_REQUESTED.store(true, Ordering::Release);
        1
    } else {
        0
    }
}

#[cfg(windows)]
fn install_ctrl_c_handler(state: &DesktopState) -> Option<CtrlCHandlerGuard> {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    CTRL_C_REQUESTED.store(false, Ordering::Release);
    *dev_host_state_slot() = Some(state.clone());
    if unsafe { SetConsoleCtrlHandler(Some(ctrl_c_handler), 1) } != 0 {
        Some(CtrlCHandlerGuard)
    } else {
        *dev_host_state_slot() = None;
        None
    }
}

pub fn run_cli() -> Result<(), String> {
    let config = cli::parse_args(std::env::args_os().skip(1))?;
    let token = cli::read_token_from_env()?;
    let data_dir = app_data::validate_app_data_dir(&config.app_data)?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Capture Workbench app data cannot be created: {error}"))?;

    let library = Arc::new(LibraryStore::open(&data_dir)?);
    let state = DesktopState::new(data_dir);
    let _shutdown_guard = ShutdownGuard(&state);

    let assets = RuntimeAssets {
        manifest_path: config.runtime_manifest,
        executable_path: config.runtime_executable,
    };
    state.start(assets.clone());

    let context = Arc::new(HostContext::new(state.clone(), library, Some(assets)));
    let server = DevHostServer::bind(config.port, token, context, Some(&CTRL_C_REQUESTED))?;
    let bound_port = server.port();

    #[cfg(windows)]
    let _ctrl_c = install_ctrl_c_handler(&state);

    {
        use std::io::Write;
        let line = serde_json::json!({ "port": bound_port });
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{line}")
            .and_then(|()| stdout.flush())
            .map_err(|error| format!("Dev host failed to write port line: {error}"))?;
    }

    server.run()
}
