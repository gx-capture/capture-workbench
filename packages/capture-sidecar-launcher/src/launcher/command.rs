use std::{
    cmp::Ordering as CompareOrdering,
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use super::readiness::{
    append_readiness_context_identity, freeze_readiness_context, FrozenReadinessContext,
};
use super::spec::SidecarLaunchSpec;
use crate::{
    constants::LOOPBACK_HOST,
    manifest::{
        validate_manifest_contract, verify_artifact, ManifestExpectations, SidecarManifest,
        VerifiedSidecar,
    },
};

/// Frozen producer-owned command inputs. This foundation is intentionally not
/// wired into the legacy launch path until the activation owner can consume it.
pub(super) struct FrozenLaunchCommand {
    pub(super) executable_path: PathBuf,
    working_directory: PathBuf,
    pub(super) port: u16,
    pub(super) token: String,
    pub(super) environment: Vec<(OsString, OsString)>,
    pub(super) manifest: SidecarManifest,
    pub(super) readiness_schema: Option<FrozenReadinessContext>,
    pub(super) digest: String,
}

impl FrozenLaunchCommand {
    pub(super) fn command(&self) -> Command {
        let mut command = Command::new(&self.executable_path);
        command
            .env_clear()
            .arg("serve")
            .arg("--host")
            .arg(LOOPBACK_HOST)
            .arg("--port")
            .arg(self.port.to_string())
            .current_dir(&self.working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (name, value) in &self.environment {
            command.env(name, value);
        }
        command
    }

    /// Revalidates the frozen executable immediately before command creation.
    /// All launch values remain from this immutable snapshot; no ambient
    /// environment or mutable launch specification is consulted here.
    pub(super) fn checked_command(&self) -> Result<Command, String> {
        let canonical_path = fs::canonicalize(&self.executable_path)
            .map_err(|_| "Capture runtime frozen executable was unavailable.".to_string())?;
        if canonical_path != self.executable_path {
            return Err("Capture runtime frozen executable path changed.".into());
        }
        let executable_name = canonical_path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| "Capture runtime frozen executable name was invalid.".to_string())?;
        if executable_name != self.manifest.file_name {
            return Err("Capture runtime frozen executable name changed.".into());
        }
        verify_artifact(&canonical_path, &self.manifest).map_err(|_| {
            "Capture runtime frozen executable no longer matched its manifest.".to_string()
        })?;
        if let Some(readiness_schema) = &self.readiness_schema {
            readiness_schema.revalidate(&self.manifest)?;
        }
        Ok(self.command())
    }
}

#[cfg(test)]
pub(super) fn freeze_launch_command_from_environment(
    verified: &VerifiedSidecar,
    spec: &SidecarLaunchSpec,
    captured_environment: &[(OsString, OsString)],
) -> Result<FrozenLaunchCommand, String> {
    freeze_launch_command_from_environment_with_schema(verified, spec, captured_environment, None)
}

pub(super) fn freeze_launch_command_from_environment_with_schema(
    verified: &VerifiedSidecar,
    spec: &SidecarLaunchSpec,
    captured_environment: &[(OsString, OsString)],
    readiness_manifest_path: Option<&Path>,
) -> Result<FrozenLaunchCommand, String> {
    let executable_path = validate_frozen_launch_inputs(verified, spec)?;
    let environment = resolve_frozen_environment(captured_environment, spec)?;
    let working_directory = executable_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let readiness_schema = readiness_manifest_path
        .map(|path| freeze_readiness_context(path, &verified.manifest))
        .transpose()?;
    let digest = frozen_command_digest(
        &executable_path,
        &working_directory,
        spec.port,
        &spec.token,
        &environment,
        &verified.manifest,
        readiness_schema.as_ref(),
    );

    Ok(FrozenLaunchCommand {
        executable_path,
        working_directory,
        port: spec.port,
        token: spec.token.clone(),
        environment,
        manifest: verified.manifest.clone(),
        readiness_schema,
        digest,
    })
}

pub(super) fn validate_frozen_launch_inputs(
    verified: &VerifiedSidecar,
    spec: &SidecarLaunchSpec,
) -> Result<PathBuf, String> {
    let canonical_spec = fs::canonicalize(&spec.executable_path)
        .map_err(|_| "Capture runtime launch executable was unavailable.".to_string())?;
    let canonical_verified = fs::canonicalize(&verified.executable_path)
        .map_err(|_| "Capture runtime verified executable was unavailable.".to_string())?;
    if canonical_spec != canonical_verified {
        return Err("Capture runtime launch executable did not match its verified asset.".into());
    }
    if spec.port == 0 {
        return Err("Capture runtime launch port was invalid.".into());
    }
    if spec.token.is_empty()
        || spec
            .token
            .bytes()
            .any(|byte| byte == 0 || byte == b'\r' || byte == b'\n')
    {
        return Err("Capture runtime launch token was invalid.".into());
    }
    if canonical_verified
        .as_os_str()
        .as_encoded_bytes()
        .contains(&0)
    {
        return Err("Capture runtime launch executable path was invalid.".into());
    }

    let manifest = &verified.manifest;
    validate_manifest_contract(
        manifest,
        &ManifestExpectations {
            runtime_version: manifest.runtime_version.clone(),
            api_version: manifest.api_version.clone(),
            capture_document_schema_version: manifest.capture_document_schema_version.clone(),
            file_name: manifest.file_name.clone(),
            schema_file_name: manifest.schema_file_name.clone(),
        },
    )
    .map_err(|_| {
        "Capture runtime verified manifest failed launch binding validation.".to_string()
    })?;
    let executable_name = canonical_verified
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "Capture runtime launch executable name was invalid.".to_string())?;
    if executable_name != manifest.file_name {
        return Err("Capture runtime launch executable name did not match its manifest.".into());
    }
    verify_artifact(&canonical_verified, manifest).map_err(|_| {
        "Capture runtime verified executable no longer matched its manifest.".to_string()
    })?;
    Ok(canonical_verified)
}

fn resolve_frozen_environment(
    captured_environment: &[(OsString, OsString)],
    spec: &SidecarLaunchSpec,
) -> Result<Vec<(OsString, OsString)>, String> {
    let mut allowlist = BTreeSet::new();
    for name in &spec.inherited_environment_allowlist {
        let name = OsString::from(name);
        validate_environment_name(&name)?;
        allowlist.insert(environment_key(&name));
    }

    let mut resolved = BTreeMap::new();
    for (name, value) in captured_environment {
        let key = environment_key(name);
        if allowlist.contains(&key) {
            validate_environment_name(name)?;
            validate_environment_value(value)?;
            let candidate = (name.clone(), value.clone());
            let replace = match resolved.get(&key) {
                None => true,
                Some(current) => {
                    compare_environment_pair(&candidate, current) == CompareOrdering::Less
                }
            };
            if replace {
                resolved.insert(key, candidate);
            }
        }
    }
    for (name, value) in &spec.environment {
        let name = OsString::from(name);
        let value = OsString::from(value);
        validate_environment_name(&name)?;
        validate_environment_value(&value)?;
        resolved.insert(environment_key(&name), (name, value));
    }

    let resolved: Vec<_> = resolved.into_values().collect();
    let token_name = OsString::from("CAPTURE_API_TOKEN");
    let token_value = OsString::from(&spec.token);
    if resolved
        .iter()
        .find(|(name, _)| environment_key(name) == environment_key(&token_name))
        .is_none_or(|(_, value)| value != &token_value)
    {
        return Err("Capture runtime launch token did not match its runtime environment.".into());
    }
    Ok(resolved)
}

/// The frozen boundary accepts the portable ASCII environment name grammar;
/// this is narrower than arbitrary Windows Unicode names so case identity is
/// deterministic without claiming a non-native case-folding implementation.
fn validate_environment_name(name: &OsStr) -> Result<(), String> {
    let bytes = name.as_encoded_bytes();
    let valid = !bytes.is_empty() && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_');
    let valid = valid
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_');
    if !valid {
        Err("Capture runtime launch environment name was invalid.".into())
    } else {
        Ok(())
    }
}

fn validate_environment_value(value: &OsStr) -> Result<(), String> {
    if value.as_encoded_bytes().contains(&0) {
        Err("Capture runtime launch environment value was invalid.".into())
    } else {
        Ok(())
    }
}

pub(super) fn environment_key(name: &OsStr) -> Vec<u8> {
    name.as_encoded_bytes()
        .iter()
        .map(|byte| byte.to_ascii_lowercase())
        .collect()
}

fn compare_environment_pair(
    left: &(OsString, OsString),
    right: &(OsString, OsString),
) -> CompareOrdering {
    left.0
        .as_encoded_bytes()
        .cmp(right.0.as_encoded_bytes())
        .then(left.1.as_encoded_bytes().cmp(right.1.as_encoded_bytes()))
}

fn frozen_command_digest(
    executable_path: &Path,
    working_directory: &Path,
    port: u16,
    token: &str,
    environment: &[(OsString, OsString)],
    manifest: &crate::SidecarManifest,
    readiness_schema: Option<&FrozenReadinessContext>,
) -> String {
    let mut encoded = Vec::new();
    encoded.extend_from_slice(b"capture-sidecar/frozen-launch-command/v1\0");
    append_bytes(
        &mut encoded,
        b"executable",
        executable_path.as_os_str().as_encoded_bytes(),
    );
    append_bytes(
        &mut encoded,
        b"working-directory",
        working_directory.as_os_str().as_encoded_bytes(),
    );
    append_bytes(&mut encoded, b"arg-0", b"serve");
    append_bytes(&mut encoded, b"arg-1", b"--host");
    append_bytes(&mut encoded, b"arg-2", LOOPBACK_HOST.as_bytes());
    append_bytes(&mut encoded, b"arg-3", b"--port");
    append_bytes(&mut encoded, b"port", &port.to_be_bytes());
    append_bytes(&mut encoded, b"token", token.as_bytes());
    for (name, value) in environment {
        append_bytes(&mut encoded, b"environment-name", name.as_encoded_bytes());
        append_bytes(&mut encoded, b"environment-value", value.as_encoded_bytes());
    }
    for (name, value) in [
        (
            b"manifest-version".as_slice(),
            manifest.manifest_version.as_bytes(),
        ),
        (b"runtime-version", manifest.runtime_version.as_bytes()),
        (b"api-version", manifest.api_version.as_bytes()),
        (
            b"capture-document-schema-version",
            manifest.capture_document_schema_version.as_bytes(),
        ),
        (b"platform", manifest.platform.as_bytes()),
        (b"arch", manifest.arch.as_bytes()),
        (b"file-name", manifest.file_name.as_bytes()),
        (b"bytes", &manifest.bytes.to_be_bytes()),
        (b"sha256", manifest.sha256.as_bytes()),
        (b"schema-file-name", manifest.schema_file_name.as_bytes()),
        (b"schema-sha256", manifest.schema_sha256.as_bytes()),
    ] {
        append_bytes(&mut encoded, name, value);
    }
    append_readiness_context_identity(&mut encoded, readiness_schema);
    digest_bytes(&encoded)
}

pub(super) fn append_bytes(output: &mut Vec<u8>, label: &[u8], value: &[u8]) {
    output.extend_from_slice(&(label.len() as u64).to_be_bytes());
    output.extend_from_slice(label);
    output.extend_from_slice(&(value.len() as u64).to_be_bytes());
    output.extend_from_slice(value);
}

pub(super) fn digest_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, fs};

    use super::super::fixture::{command_environment, manifest, token_environment, verified};
    use super::super::spec::SidecarLaunchSpec;
    use super::{digest_bytes, freeze_launch_command_from_environment};
    use crate::manifest::VerifiedSidecar;

    #[test]
    fn frozen_command_captures_selected_environment_once() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let verified = verified(executable_path.clone());
        let spec = SidecarLaunchSpec::new(
            executable_path,
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            vec!["CAPTURE_MODE".into()],
        );
        let mut captured = vec![(OsString::from("CAPTURE_MODE"), OsString::from("before"))];
        let frozen = freeze_launch_command_from_environment(&verified, &spec, &captured)
            .expect("frozen command");
        let digest = frozen.digest.clone();
        captured[0].1 = OsString::from("after");

        let command = frozen.command();
        assert_eq!(
            command_environment(&command).get("capture_mode"),
            Some(&"before".into())
        );
        assert_eq!(frozen.digest, digest);
        let changed = freeze_launch_command_from_environment(&verified, &spec, &captured)
            .expect("changed frozen command");
        assert_ne!(frozen.digest, changed.digest);
    }

    #[test]
    fn checked_frozen_command_revalidates_path_and_artifact_before_creation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let verified = verified(executable_path.clone());
        let spec = SidecarLaunchSpec::new(
            executable_path.clone(),
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        );
        let frozen =
            freeze_launch_command_from_environment(&verified, &spec, &[]).expect("frozen command");

        assert!(frozen.checked_command().is_ok());
        fs::write(&executable_path, b"changed").expect("same-length replacement");
        assert!(frozen.checked_command().is_err());
        fs::write(&executable_path, b"runtime").expect("restore executable");
        assert!(frozen.checked_command().is_ok());

        let moved_path = directory.path().join("moved-runtime.exe");
        fs::rename(&executable_path, &moved_path).expect("move executable");
        fs::create_dir(&executable_path).expect("replace with directory");
        assert!(frozen.checked_command().is_err());
        fs::remove_dir(&executable_path).expect("remove replacement");
        fs::rename(&moved_path, &executable_path).expect("restore executable path");
        assert!(frozen.checked_command().is_ok());

        fs::remove_file(&executable_path).expect("delete executable");
        assert!(frozen.checked_command().is_err());
    }

    #[test]
    fn frozen_command_resolves_environment_case_collisions_deterministically() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let verified = verified(executable_path.clone());
        let spec = SidecarLaunchSpec::new(
            executable_path,
            42123,
            "secret-token".into(),
            vec![
                ("capture_mode".into(), "first".into()),
                ("CAPTURE_MODE".into(), "last".into()),
                ("CAPTURE_API_TOKEN".into(), "secret-token".into()),
            ],
            vec!["CAPTURE_MODE".into()],
        );
        let captured = vec![(OsString::from("Capture_Mode"), OsString::from("ambient"))];
        let first = freeze_launch_command_from_environment(&verified, &spec, &captured)
            .expect("first frozen command");
        let second = freeze_launch_command_from_environment(&verified, &spec, &captured)
            .expect("second frozen command");

        assert_eq!(first.digest, second.digest);
        assert_eq!(
            command_environment(&first.command()).get("capture_mode"),
            Some(&"last".into())
        );
    }

    #[test]
    fn frozen_digest_binds_port_token_environment_cwd_and_artifact_identity() {
        let directory = tempfile::tempdir().expect("tempdir");
        let first_path = directory.path().join("capture-runtime.exe");
        let second_directory = directory.path().join("alternate");
        fs::create_dir(&second_directory).expect("alternate directory");
        let second_path = second_directory.join("capture-runtime.exe");
        fs::write(&first_path, b"runtime").expect("first executable");
        fs::write(&second_path, b"runtime").expect("second executable");
        let captured = vec![(OsString::from("CAPTURE_MODE"), OsString::from("one"))];
        let base_spec = SidecarLaunchSpec::new(
            first_path.clone(),
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            vec!["CAPTURE_MODE".into()],
        );
        let base = freeze_launch_command_from_environment(
            &verified(first_path.clone()),
            &base_spec,
            &captured,
        )
        .expect("base frozen command");

        let mut port_spec = SidecarLaunchSpec::new(
            first_path.clone(),
            42124,
            "secret-token".into(),
            token_environment("secret-token"),
            vec!["CAPTURE_MODE".into()],
        );
        assert_ne!(
            base.digest,
            freeze_launch_command_from_environment(
                &verified(first_path.clone()),
                &port_spec,
                &captured,
            )
            .expect("port frozen command")
            .digest
        );
        port_spec.port = base_spec.port;
        port_spec.token = "another-token".into();
        port_spec.environment = token_environment("another-token");
        assert_ne!(
            base.digest,
            freeze_launch_command_from_environment(
                &verified(first_path.clone()),
                &port_spec,
                &captured,
            )
            .expect("token frozen command")
            .digest
        );

        let aliased_path = directory
            .path()
            .join("alternate")
            .join("..")
            .join("capture-runtime.exe");
        let aliased = freeze_launch_command_from_environment(
            &verified(first_path.clone()),
            &SidecarLaunchSpec::new(
                aliased_path,
                base_spec.port,
                base_spec.token.clone(),
                token_environment("secret-token"),
                vec!["CAPTURE_MODE".into()],
            ),
            &captured,
        )
        .expect("canonical aliased command");
        assert_eq!(
            aliased.executable_path,
            fs::canonicalize(&first_path).expect("canonical path")
        );
        assert_eq!(
            aliased.working_directory,
            fs::canonicalize(directory.path()).expect("canonical directory")
        );

        let changed_environment = vec![(OsString::from("CAPTURE_MODE"), OsString::from("two"))];
        assert_ne!(
            base.digest,
            freeze_launch_command_from_environment(
                &verified(first_path.clone()),
                &base_spec,
                &changed_environment,
            )
            .expect("environment frozen command")
            .digest
        );
        assert_ne!(
            base.digest,
            freeze_launch_command_from_environment(
                &verified(second_path.clone()),
                &SidecarLaunchSpec::new(
                    second_path,
                    base_spec.port,
                    base_spec.token.clone(),
                    token_environment("secret-token"),
                    vec!["CAPTURE_MODE".into()],
                ),
                &captured,
            )
            .expect("cwd frozen command")
            .digest
        );

        fs::write(&first_path, b"changed").expect("changed executable");
        let mut changed_manifest = manifest();
        changed_manifest.sha256 = digest_bytes(b"changed");
        let changed_verified = VerifiedSidecar {
            manifest: changed_manifest,
            executable_path: first_path.clone(),
        };
        assert_ne!(
            base.digest,
            freeze_launch_command_from_environment(&changed_verified, &base_spec, &captured)
                .expect("artifact frozen command")
                .digest
        );
    }

    #[test]
    fn frozen_command_rejects_unbound_or_invalid_sources() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let verified = verified(executable_path.clone());
        let captured = Vec::new();

        let mismatched = SidecarLaunchSpec::new(
            directory.path().join("other.exe"),
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        );
        assert!(freeze_launch_command_from_environment(&verified, &mismatched, &captured).is_err());

        for (port, token) in [(0, "secret-token"), (42123, "")] {
            let invalid = SidecarLaunchSpec::new(
                executable_path.clone(),
                port,
                token.into(),
                token_environment(token),
                Vec::new(),
            );
            assert!(
                freeze_launch_command_from_environment(&verified, &invalid, &captured).is_err()
            );
        }

        let invalid_environment = SidecarLaunchSpec::new(
            executable_path,
            42123,
            "secret-token".into(),
            [
                token_environment("secret-token"),
                vec![("BAD=NAME".into(), "value".into())],
            ]
            .concat(),
            Vec::new(),
        );
        assert!(
            freeze_launch_command_from_environment(&verified, &invalid_environment, &captured)
                .is_err()
        );
    }

    #[test]
    fn frozen_command_rejects_token_mismatch_and_selected_non_ascii_names() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let verified = verified(executable_path.clone());
        let captured = vec![(OsString::from("=C:"), OsString::from("pseudo"))];

        let mismatch = SidecarLaunchSpec::new(
            executable_path.clone(),
            42123,
            "different-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        );
        let error = match freeze_launch_command_from_environment(&verified, &mismatch, &captured) {
            Ok(_) => panic!("token mismatch must be rejected"),
            Err(error) => error,
        };
        assert!(!error.contains("secret-token"));

        let selected_pseudo = SidecarLaunchSpec::new(
            executable_path,
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            vec!["=C:".into()],
        );
        assert!(
            freeze_launch_command_from_environment(&verified, &selected_pseudo, &captured).is_err()
        );
    }
}
