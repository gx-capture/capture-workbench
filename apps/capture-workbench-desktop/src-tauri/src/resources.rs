use std::path::PathBuf;

use capture_sidecar_launcher::{load_manifest, validate_manifest_contract, ManifestExpectations};
use tauri::{path::BaseDirectory, App, Manager, Runtime};

use crate::constants::{
    EXPECTED_API_VERSION, EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION, EXPECTED_MANIFEST_VERSION,
    EXPECTED_RUNTIME_VERSION, RUNTIME_BINARY_FILE, RUNTIME_BINARY_TARGET_FILE,
    RUNTIME_MANIFEST_FILE, SCHEMA_FILE_NAME,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeAssets {
    pub manifest_path: PathBuf,
    pub executable_path: PathBuf,
}

pub(crate) fn resolve_runtime_assets<R: Runtime>(app: &App<R>) -> Result<RuntimeAssets, String> {
    #[cfg(debug_assertions)]
    if let Some(assets) = debug_assets_override()? {
        return Ok(assets);
    }

    let manifest_path = first_file(manifest_candidates(app))
        .ok_or_else(|| "Bundled Capture runtime manifest was not found.".to_string())?;
    let manifest = load_manifest(&manifest_path)?;
    if manifest.manifest_version != EXPECTED_MANIFEST_VERSION {
        return Err("Bundled Capture runtime manifest version is incompatible.".into());
    }
    validate_manifest_contract(
        &manifest,
        &ManifestExpectations {
            runtime_version: EXPECTED_RUNTIME_VERSION.into(),
            api_version: EXPECTED_API_VERSION.into(),
            capture_document_schema_version: EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
            file_name: RUNTIME_BINARY_TARGET_FILE.into(),
            schema_file_name: SCHEMA_FILE_NAME.into(),
        },
    )?;

    let executable_path = first_file(executable_candidates(app, &manifest.file_name))
        .ok_or_else(|| "Bundled Capture runtime executable was not found.".to_string())?;

    Ok(RuntimeAssets {
        manifest_path,
        executable_path,
    })
}

fn manifest_candidates<R: Runtime>(app: &App<R>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for relative in [
        RUNTIME_MANIFEST_FILE.to_string(),
        format!("resources/{RUNTIME_MANIFEST_FILE}"),
    ] {
        if let Ok(path) = app.path().resolve(relative, BaseDirectory::Resource) {
            candidates.push(path);
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(RUNTIME_MANIFEST_FILE),
        );
    }
    candidates
}

fn executable_candidates<R: Runtime>(app: &App<R>, manifest_file_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for relative in [
        manifest_file_name.to_string(),
        format!("resources/{manifest_file_name}"),
        RUNTIME_BINARY_FILE.to_string(),
        format!("binaries/{RUNTIME_BINARY_TARGET_FILE}"),
        format!("resources/{RUNTIME_BINARY_TARGET_FILE}"),
        RUNTIME_BINARY_TARGET_FILE.to_string(),
    ] {
        if let Ok(path) = app.path().resolve(relative, BaseDirectory::Resource) {
            candidates.push(path);
        }
    }
    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(directory) = current_executable.parent() {
            candidates.push(directory.join(manifest_file_name));
            candidates.push(directory.join(RUNTIME_BINARY_FILE));
            candidates.push(directory.join("resources").join(manifest_file_name));
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(RUNTIME_BINARY_TARGET_FILE),
        );
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(manifest_file_name),
        );
    }
    candidates
}

fn first_file(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(debug_assertions)]
fn debug_assets_override() -> Result<Option<RuntimeAssets>, String> {
    let manifest = trimmed_env("CAPTURE_WORKBENCH_RUNTIME_MANIFEST");
    let executable = trimmed_env("CAPTURE_WORKBENCH_RUNTIME_EXECUTABLE");
    match (manifest, executable) {
        (None, None) => Ok(None),
        (Some(manifest_path), Some(executable_path)) => Ok(Some(RuntimeAssets {
            manifest_path: PathBuf::from(manifest_path),
            executable_path: PathBuf::from(executable_path),
        })),
        _ => Err("Debug runtime override requires both manifest and executable paths.".into()),
    }
}

#[cfg(debug_assertions)]
fn trimmed_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_target_name_is_windows_x64_only() {
        assert_eq!(
            RUNTIME_BINARY_TARGET_FILE,
            "capture-runtime-x86_64-pc-windows-msvc.exe"
        );
    }

    #[test]
    fn first_file_does_not_accept_directories() {
        let directory = tempfile::tempdir().expect("tempdir");
        let file = directory.path().join("runtime.exe");
        std::fs::write(&file, b"runtime").expect("file");
        assert_eq!(
            first_file(vec![directory.path().to_path_buf(), file.clone()]),
            Some(file)
        );
    }
}
