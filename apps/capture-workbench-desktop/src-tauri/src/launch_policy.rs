use std::{collections::HashSet, path::PathBuf};

use capture_sidecar_launcher::{generate_bearer_token, pick_distinct_free_loopback_port};

use crate::{
    constants::{LOOPBACK_HOST, RUNTIME_MAX_UPLOAD_BYTES, RUNTIME_RETENTION_HOURS},
    speech_gpu::SpeechGpuSettings,
};

pub(crate) struct LaunchPolicy {
    pub(crate) runtime_port: u16,
    pub(crate) token: String,
    data_dir: PathBuf,
}

impl LaunchPolicy {
    pub(crate) fn runtime_data_dir(&self) -> PathBuf {
        self.data_dir.join("runtime")
    }

    pub(crate) fn ollama_data_dir(&self) -> PathBuf {
        self.data_dir.join("ollama")
    }

    pub(crate) fn ollama_models_dir(&self) -> PathBuf {
        self.ollama_data_dir().join("models")
    }

    pub(crate) fn ollama_pid_file(&self) -> PathBuf {
        self.ollama_data_dir().join("ollama.pid")
    }

    pub(crate) fn environment(&self) -> Vec<(&'static str, String)> {
        self.environment_with(|name| std::env::var(name).ok())
    }

    fn environment_with(
        &self,
        read_env: impl Fn(&str) -> Option<String>,
    ) -> Vec<(&'static str, String)> {
        let mut origins = vec!["http://tauri.localhost", "tauri://localhost"];
        if cfg!(debug_assertions) {
            origins.push("http://localhost:4200");
        }
        let speech_cpu_fallback = read_env("CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK")
            .as_deref()
            .map(str::trim)
            != Some("false");
        let mut environment = vec![
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
                "CAPTURE_SPEECH_PREFER_GPU",
                SpeechGpuSettings::load(&self.data_dir)
                    .prefer_gpu
                    .to_string(),
            ),
            (
                "CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK",
                speech_cpu_fallback.to_string(),
            ),
            (
                "CAPTURE_RETENTION_HOURS",
                RUNTIME_RETENTION_HOURS.to_string(),
            ),
            (
                "CAPTURE_MAX_UPLOAD_BYTES",
                RUNTIME_MAX_UPLOAD_BYTES.to_string(),
            ),
            (
                "CAPTURE_OLLAMA_APP_DATA",
                self.ollama_data_dir().to_string_lossy().into_owned(),
            ),
            (
                "CAPTURE_OLLAMA_PID_FILE",
                self.ollama_pid_file().to_string_lossy().into_owned(),
            ),
            (
                "OLLAMA_MODELS",
                self.ollama_models_dir().to_string_lossy().into_owned(),
            ),
        ];
        if let Some(cuda_path) = configured_cuda_path(read_env("CUDA_PATH")) {
            environment.push(("CUDA_PATH", cuda_path));
        }
        // These overrides exist only for verification, including in release builds.
        if let Some(mirror_url) = smoke_worker_mirror_url(
            read_env("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN"),
            read_env("CAPTURE_SMOKE_WORKER_MIRROR_URL"),
        ) {
            environment.push(("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN", "1".into()));
            environment.push(("CAPTURE_SMOKE_WORKER_MIRROR_URL", mirror_url));
        }
        if let Some(model_root) = local_ocr_model_override(
            read_env("CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN"),
            read_env("CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT"),
        ) {
            environment.push(("CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN", "1".into()));
            environment.push(("CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT", model_root));
        }
        #[cfg(feature = "acceptance-harness")]
        if std::env::var("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN")
            .ok()
            .as_deref()
            .map(str::trim)
            == Some("1")
        {
            environment.push(("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN", "1".into()));
            if let Some(root) =
                acceptance_ocr_execution_evidence_value("CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT")
            {
                environment.push(("CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT", root));
            }
            if let Some(runtime_sha256) =
                acceptance_ocr_execution_evidence_value("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256")
            {
                environment.push(("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256", runtime_sha256));
            }
        }
        environment
    }
}

#[cfg(feature = "acceptance-harness")]
fn acceptance_ocr_execution_evidence_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn configured_cuda_path(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn smoke_worker_mirror_url(opt_in: Option<String>, raw_url: Option<String>) -> Option<String> {
    if opt_in.as_deref().map(str::trim) != Some("1") {
        return None;
    }
    let raw = raw_url?.trim().to_string();
    let port = raw
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)?;
    Some(format!("http://127.0.0.1:{port}"))
}

fn local_ocr_model_override(opt_in: Option<String>, root: Option<String>) -> Option<String> {
    if opt_in.as_deref().map(str::trim) != Some("1") {
        return None;
    }
    root.map(|value| value.trim().to_owned())
        .filter(|value| std::path::Path::new(value).is_absolute())
}

pub(crate) struct LaunchPolicyFactory {
    data_dir: PathBuf,
    used_ports: HashSet<u16>,
    used_tokens: HashSet<String>,
}

impl LaunchPolicyFactory {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            used_ports: HashSet::new(),
            used_tokens: HashSet::new(),
        }
    }

    pub(crate) fn next(&mut self) -> Result<LaunchPolicy, String> {
        let runtime_port = pick_distinct_free_loopback_port(&self.used_ports)?;
        let token = self.next_token()?;

        self.used_ports.insert(runtime_port);
        self.used_tokens.insert(token.clone());
        Ok(LaunchPolicy {
            runtime_port,
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        configured_cuda_path, local_ocr_model_override, smoke_worker_mirror_url, LaunchPolicy,
    };
    use crate::speech_gpu::SpeechGpuSettings;

    #[test]
    fn runtime_environment_explicitly_prefers_speech_gpu() {
        let environment = LaunchPolicy {
            runtime_port: 43123,
            token: "a".repeat(64),
            data_dir: PathBuf::from("C:\\capture-workbench"),
        }
        .environment();

        assert!(environment
            .iter()
            .any(|(name, value)| { *name == "CAPTURE_SPEECH_PREFER_GPU" && value == "true" }));
        assert!(environment
            .iter()
            .any(|(name, value)| { *name == "CAPTURE_MAX_UPLOAD_BYTES" && value == "2147483648" }));
    }

    #[test]
    fn the_runtime_uses_the_gpu_only_while_the_user_allows_it() {
        let directory = tempfile::tempdir().unwrap();
        SpeechGpuSettings { prefer_gpu: false }
            .save(directory.path())
            .unwrap();
        let environment = LaunchPolicy {
            runtime_port: 43123,
            token: "a".repeat(64),
            data_dir: directory.path().to_path_buf(),
        }
        .environment();

        assert!(environment
            .iter()
            .any(|(name, value)| { *name == "CAPTURE_SPEECH_PREFER_GPU" && value == "false" }));
    }

    #[test]
    fn runtime_environment_omits_ollama_host_and_keeps_isolated_ollama_paths() {
        let environment = LaunchPolicy {
            runtime_port: 43123,
            token: "a".repeat(64),
            data_dir: PathBuf::from("C:\\capture-workbench"),
        }
        .environment();

        assert!(!environment
            .iter()
            .any(|(name, _)| *name == "CAPTURE_OLLAMA_HOST" || *name == "OLLAMA_HOST"));
        for required in [
            "CAPTURE_OLLAMA_APP_DATA",
            "CAPTURE_OLLAMA_PID_FILE",
            "OLLAMA_MODELS",
        ] {
            assert!(environment.iter().any(|(name, _)| *name == required));
        }
    }

    #[test]
    fn configured_cuda_path_ignores_missing_or_blank_values() {
        assert_eq!(configured_cuda_path(None), None);
        assert_eq!(configured_cuda_path(Some("   ".into())), None);
        assert_eq!(
            configured_cuda_path(Some("  C:\\CUDA  ".into())),
            Some("C:\\CUDA".into())
        );
    }

    #[test]
    fn worker_mirror_and_speech_cpu_fallback_are_independent() {
        let directory = tempfile::tempdir().unwrap();
        let policy = LaunchPolicy {
            runtime_port: 43123,
            token: "a".repeat(64),
            data_dir: directory.path().to_path_buf(),
        };
        let environment = |mirror, fallback: Option<&str>| {
            policy.environment_with(|name| match name {
                "CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN" if mirror => Some("1".into()),
                "CAPTURE_SMOKE_WORKER_MIRROR_URL" => Some("http://127.0.0.1:43124".into()),
                "CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK" => fallback.map(str::to_owned),
                _ => None,
            })
        };
        let baseline = environment(false, None);
        let mut mirror_only = baseline.clone();
        mirror_only.push(("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN", "1".into()));
        mirror_only.push((
            "CAPTURE_SMOKE_WORKER_MIRROR_URL",
            "http://127.0.0.1:43124".into(),
        ));
        assert_eq!(environment(true, None), mirror_only);

        let disable_fallback = |mut values: Vec<(&'static str, String)>| {
            let (_, value) = values
                .iter_mut()
                .find(|(name, _)| *name == "CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK")
                .unwrap();
            assert_eq!(value.as_str(), "true");
            *value = "false".into();
            values
        };
        assert_eq!(
            environment(false, Some("false")),
            disable_fallback(baseline.clone())
        );
        assert_eq!(
            environment(true, Some("false")),
            disable_fallback(mirror_only.clone())
        );
        assert_eq!(environment(true, Some("true")), mirror_only);
        assert_eq!(environment(false, Some("invalid")), baseline);
    }

    #[test]
    fn reopened_legacy_settings_supply_the_speech_gpu_preference() {
        let directory = tempfile::tempdir().unwrap();
        let settings_path = directory.path().join("compute-settings.json");
        let settings_bytes = br#"{"preferGpu":false}"#;
        std::fs::write(&settings_path, settings_bytes).unwrap();

        for runtime_port in [43123, 43124] {
            let environment = LaunchPolicy {
                runtime_port,
                token: "a".repeat(64),
                data_dir: directory.path().to_path_buf(),
            }
            .environment_with(|_| None);
            assert!(environment
                .iter()
                .any(|(name, value)| *name == "CAPTURE_SPEECH_PREFER_GPU" && value == "false"));
        }

        assert_eq!(
            std::fs::read(settings_path).unwrap().as_slice(),
            settings_bytes
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn smoke_worker_mirror_requires_explicit_numeric_loopback_opt_in() {
        assert_eq!(
            smoke_worker_mirror_url(Some("1".into()), Some("http://127.0.0.1:43123".into())),
            Some("http://127.0.0.1:43123".into())
        );
        for value in [
            "http://localhost:43123",
            "https://127.0.0.1:43123",
            "http://127.0.0.1:43123/worker",
            "http://127.0.0.1:43123?x=1",
            "http://user:pass@127.0.0.1:43123",
        ] {
            assert_eq!(
                smoke_worker_mirror_url(Some("1".into()), Some(value.into())),
                None
            );
        }
        assert_eq!(
            smoke_worker_mirror_url(Some("0".into()), Some("http://127.0.0.1:43123".into())),
            None
        );
    }

    #[test]
    fn local_ocr_model_override_requires_explicit_opt_in_and_root() {
        let absolute_root = tempfile::tempdir().unwrap();
        let root = absolute_root.path().to_string_lossy().into_owned();
        assert_eq!(
            local_ocr_model_override(Some("1".into()), Some(root.clone())),
            Some(root)
        );
        assert_eq!(
            local_ocr_model_override(Some("1".into()), Some("relative-model".into())),
            None
        );
        assert_eq!(
            local_ocr_model_override(Some("0".into()), Some("C:\\probe-model".into())),
            None
        );
        assert_eq!(
            local_ocr_model_override(Some("1".into()), Some("   ".into())),
            None
        );
        assert_eq!(local_ocr_model_override(Some("1".into()), None), None);
    }
}
