use std::{collections::HashSet, fmt::Write as _, net::TcpListener, path::PathBuf};

use rand::{rngs::OsRng, RngCore};

use crate::constants::{
    CHILD_ENVIRONMENT_ALLOWLIST, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_RETENTION_HOURS, LOOPBACK_HOST,
    WORKBENCH_OLLAMA_MODEL, WORKBENCH_OLLAMA_PROFILE,
};

pub(crate) fn child_environment_name_is_allowed(name: &str) -> bool {
    CHILD_ENVIRONMENT_ALLOWLIST
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(name))
}

pub(crate) struct LaunchPolicy {
    pub(crate) runtime_port: u16,
    pub(crate) ollama_port: u16,
    pub(crate) token: String,
    data_dir: PathBuf,
}

impl LaunchPolicy {
    #[cfg(test)]
    pub(crate) fn deterministic(data_dir: PathBuf, runtime_port: u16, ollama_port: u16) -> Self {
        Self {
            runtime_port,
            ollama_port,
            token: "test-token".into(),
            data_dir,
        }
    }

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

    pub(crate) fn base_url(&self) -> String {
        format!("http://{LOOPBACK_HOST}:{}", self.runtime_port)
    }

    pub(crate) fn environment(&self) -> Vec<(&'static str, String)> {
        let mut origins = vec!["http://tauri.localhost", "tauri://localhost"];
        if cfg!(debug_assertions) {
            origins.push("http://localhost:4200");
        }
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
                "CAPTURE_RETENTION_HOURS",
                DEFAULT_RETENTION_HOURS.to_string(),
            ),
            (
                "CAPTURE_MAX_UPLOAD_BYTES",
                DEFAULT_MAX_UPLOAD_BYTES.to_string(),
            ),
            (
                "CAPTURE_OLLAMA_HOST",
                format!("http://{LOOPBACK_HOST}:{}", self.ollama_port),
            ),
            (
                "CAPTURE_OLLAMA_APP_DATA",
                self.ollama_data_dir().to_string_lossy().into_owned(),
            ),
            (
                "CAPTURE_OLLAMA_PID_FILE",
                self.ollama_pid_file().to_string_lossy().into_owned(),
            ),
            ("CAPTURE_OLLAMA_MODEL", WORKBENCH_OLLAMA_MODEL.into()),
            ("CAPTURE_OLLAMA_PROFILE_ID", WORKBENCH_OLLAMA_PROFILE.into()),
            (
                "OLLAMA_HOST",
                format!("{LOOPBACK_HOST}:{}", self.ollama_port),
            ),
            (
                "OLLAMA_MODELS",
                self.ollama_models_dir().to_string_lossy().into_owned(),
            ),
        ];
        if let Some(mirror_url) = smoke_worker_mirror_url(
            std::env::var("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN").ok(),
            std::env::var("CAPTURE_SMOKE_WORKER_MIRROR_URL").ok(),
        ) {
            environment.push(("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN", "1".into()));
            environment.push(("CAPTURE_SMOKE_WORKER_MIRROR_URL", mirror_url));
        }
        environment
    }
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
        let runtime_port = reserve_distinct_loopback_port(&self.used_ports)?;
        let mut excluded_ports = self.used_ports.clone();
        excluded_ports.insert(runtime_port);
        let ollama_port = reserve_distinct_loopback_port(&excluded_ports)?;
        let token = self.next_token()?;

        self.used_ports.insert(runtime_port);
        self.used_ports.insert(ollama_port);
        self.used_tokens.insert(token.clone());
        Ok(LaunchPolicy {
            runtime_port,
            ollama_port,
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

pub(crate) fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A loopback runtime port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The reserved loopback port could not be read: {error}"))
}

pub(crate) fn reserve_distinct_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = reserve_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A fresh independent loopback port could not be reserved.".into())
}

pub(crate) fn generate_bearer_token() -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::smoke_worker_mirror_url;

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
}
