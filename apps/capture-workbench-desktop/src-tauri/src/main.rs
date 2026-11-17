#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "dev-host")]
compile_error!("capture-workbench-desktop must not be built with `dev-host`.");

fn main() {
    capture_workbench_desktop::run();
}
