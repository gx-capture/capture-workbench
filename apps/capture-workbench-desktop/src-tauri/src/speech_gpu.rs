//! Whether speech recognition may use the GPU: a desktop setting, offered when
//! an NVIDIA CUDA driver is present. The runtime reads it when it is launched.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "speech-gpu-settings.json";
const LEGACY_SETTINGS_FILE: &str = "compute-settings.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechGpuSettings {
    pub(crate) prefer_gpu: bool,
}

impl Default for SpeechGpuSettings {
    fn default() -> Self {
        Self { prefer_gpu: true }
    }
}

impl SpeechGpuSettings {
    /// The saved setting, or the default when none is saved or it cannot be read.
    pub(crate) fn load(data_dir: &Path) -> Self {
        fs::read(settings_path(data_dir))
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    // Installed applications already have the settings under this file name.
                    fs::read(data_dir.join(LEGACY_SETTINGS_FILE))
                } else {
                    Err(error)
                }
            })
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub(crate) fn save(&self, data_dir: &Path) -> Result<(), String> {
        let path = settings_path(data_dir);
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("The speech GPU setting cannot be encoded: {error}"))?;
        fs::write(&temporary, bytes)
            .map_err(|error| format!("The speech GPU setting cannot be saved: {error}"))?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("The speech GPU setting cannot be saved: {error}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSpeechGpuStatus {
    pub cuda_available: bool,
    pub prefer_gpu: bool,
}

impl DesktopSpeechGpuStatus {
    pub(crate) fn read(data_dir: &Path) -> Self {
        Self {
            cuda_available: cuda_driver_present(),
            prefer_gpu: SpeechGpuSettings::load(data_dir).prefer_gpu,
        }
    }
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE)
}

/// An NVIDIA driver with CUDA installs `nvcuda.dll` in System32.
pub(crate) fn cuda_driver_present() -> bool {
    cuda_driver_present_in(std::env::var_os("SystemRoot").map(PathBuf::from))
}

fn cuda_driver_present_in(system_root: Option<PathBuf>) -> bool {
    cfg!(windows)
        && system_root.is_some_and(|root| root.join("System32").join("nvcuda.dll").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gpu_is_preferred_until_the_user_turns_it_off() {
        let directory = tempfile::tempdir().unwrap();
        assert!(SpeechGpuSettings::load(directory.path()).prefer_gpu);

        SpeechGpuSettings { prefer_gpu: false }
            .save(directory.path())
            .unwrap();
        assert!(!SpeechGpuSettings::load(directory.path()).prefer_gpu);

        fs::write(settings_path(directory.path()), b"{\"preferGpu\": \"no\"}").unwrap();
        assert!(SpeechGpuSettings::load(directory.path()).prefer_gpu);
    }

    #[test]
    fn reads_installed_settings_when_the_new_file_is_absent() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(LEGACY_SETTINGS_FILE),
            br#"{"preferGpu":false}"#,
        )
        .unwrap();

        assert!(!SpeechGpuSettings::load(directory.path()).prefer_gpu);
    }

    #[test]
    fn the_new_settings_file_takes_precedence() {
        let directory = tempfile::tempdir().unwrap();
        let legacy_path = directory.path().join(LEGACY_SETTINGS_FILE);
        let legacy_bytes = br#"{"preferGpu":true}"#;
        fs::write(&legacy_path, legacy_bytes).unwrap();

        SpeechGpuSettings { prefer_gpu: false }
            .save(directory.path())
            .unwrap();

        assert!(settings_path(directory.path()).is_file());
        assert!(!SpeechGpuSettings::load(directory.path()).prefer_gpu);
        assert_eq!(fs::read(legacy_path).unwrap().as_slice(), legacy_bytes);
    }

    #[test]
    fn saving_creates_only_the_new_settings_file() {
        let directory = tempfile::tempdir().unwrap();
        SpeechGpuSettings { prefer_gpu: false }
            .save(directory.path())
            .unwrap();

        assert!(settings_path(directory.path()).is_file());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_cuda_driver_is_found_in_system32() {
        let root = tempfile::tempdir().unwrap();
        assert!(!cuda_driver_present_in(Some(root.path().to_path_buf())));
        assert!(!cuda_driver_present_in(None));

        fs::create_dir_all(root.path().join("System32")).unwrap();
        fs::write(root.path().join("System32").join("nvcuda.dll"), b"").unwrap();
        assert_eq!(
            cuda_driver_present_in(Some(root.path().to_path_buf())),
            cfg!(windows)
        );
    }
}
