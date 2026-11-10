use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::constants::LOOPBACK_HOST;

/// Host-owned inputs for one sidecar process.
///
/// The launch command clears the child environment, then copies parent
/// variables whose names match `inherited_environment_allowlist` without
/// regard to case, then applies `environment`. It runs `serve --host
/// 127.0.0.1 --port <port>` with the executable's parent as the working
/// directory and with stdin, stdout, and stderr set to null. `token` is used
/// for the readiness probe and the returned connection. It is not copied into
/// the child environment unless the host also puts it in `environment`.
pub struct SidecarLaunchSpec {
    /// Sidecar executable to spawn.
    pub executable_path: PathBuf,
    /// Loopback port passed to `serve --port`.
    pub port: u16,
    /// Bearer token for the readiness probe. Not logged by this crate.
    pub token: String,
    /// Environment entries set after the allowlisted parent variables.
    pub environment: Vec<(String, String)>,
    /// Parent environment names the child may inherit.
    pub inherited_environment_allowlist: Vec<String>,
}

impl SidecarLaunchSpec {
    /// Stores one `serve` launch specification.
    ///
    /// Does not open the executable, bind `port`, or spawn a process.
    pub fn new(
        executable_path: PathBuf,
        port: u16,
        token: String,
        environment: Vec<(String, String)>,
        inherited_environment_allowlist: Vec<String>,
    ) -> Self {
        Self {
            executable_path,
            port,
            token,
            environment,
            inherited_environment_allowlist,
        }
    }

    pub(super) fn command(&self) -> Command {
        let mut command = Command::new(&self.executable_path);
        command
            .env_clear()
            .arg("serve")
            .arg("--host")
            .arg(LOOPBACK_HOST)
            .arg("--port")
            .arg(self.port.to_string())
            .current_dir(
                self.executable_path
                    .parent()
                    .unwrap_or_else(|| Path::new(".")),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        for (name, value) in std::env::vars_os() {
            if name.to_str().is_some_and(|name| {
                self.inherited_environment_allowlist
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(name))
            }) {
                command.env(name, value);
            }
        }
        for (name, value) in &self.environment {
            command.env(name, value);
        }
        command
    }

    pub(super) fn base_url(&self) -> String {
        format!("http://{LOOPBACK_HOST}:{}", self.port)
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, path::PathBuf};

    use super::SidecarLaunchSpec;

    #[test]
    fn command_clears_ambient_environment_and_adds_host_values() {
        let spec = SidecarLaunchSpec::new(
            PathBuf::from("capture-runtime.exe"),
            42123,
            "secret-token".into(),
            vec![("CAPTURE_API_TOKEN".into(), "secret-token".into())],
            vec!["PATH".into()],
        );
        let command = spec.command();
        let values: HashSet<_> = command
            .get_envs()
            .filter_map(|(name, value)| {
                value.map(|value| {
                    (
                        name.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert!(values.contains(&("CAPTURE_API_TOKEN".into(), "secret-token".into())));
        assert!(!values.iter().any(
            |(name, value)| name.eq_ignore_ascii_case("CAPTURE_API_TOKEN") && value == "ambient"
        ));
    }
}
