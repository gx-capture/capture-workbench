use std::{
    cmp::Ordering as CompareOrdering,
    collections::{BTreeMap, BTreeSet, HashSet},
    ffi::{OsStr, OsString},
    fmt::Write as _,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use rand::{rngs::OsRng, RngCore};

use crate::{
    constants::{
        LOOPBACK_HOST, MAX_LAUNCH_ATTEMPTS, READY_POLL_INTERVAL, READY_TIMEOUT, RETRY_DELAY,
        RETRY_POLL_INTERVAL, TOTAL_LAUNCH_TIMEOUT,
    },
    health::{probe_ready_once, ProbeResult},
    manifest::{
        validate_manifest_contract, verify_artifact, ManifestExpectations, VerifiedSidecar,
    },
    process::OwnedRuntimeSession,
    SidecarConnection,
};

/// Reserves one ephemeral loopback port and releases the listener immediately.
pub fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A loopback runtime port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The reserved loopback port could not be read: {error}"))
}

/// Reserves an ephemeral loopback port not present in the supplied set.
pub fn reserve_distinct_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = reserve_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A fresh independent loopback port could not be reserved.".into())
}

/// Generates a fresh 256-bit bearer token encoded as lowercase hexadecimal.
pub fn generate_bearer_token() -> Result<String, String> {
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

/// Host-owned launch inputs. The launcher owns command isolation and process lifecycle;
/// the host supplies only its product-specific environment values.
pub struct SidecarLaunchSpec {
    pub executable_path: PathBuf,
    pub port: u16,
    pub token: String,
    pub environment: Vec<(String, String)>,
    pub inherited_environment_allowlist: Vec<String>,
}

impl SidecarLaunchSpec {
    /// Creates a launch specification for the runtime's standard `serve` entrypoint.
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

    pub(crate) fn command(&self) -> Command {
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

    pub(crate) fn base_url(&self) -> String {
        format!("http://{LOOPBACK_HOST}:{}", self.port)
    }
}

/// Frozen producer-owned command inputs. This foundation is intentionally not
/// wired into the legacy launch path until the activation owner can consume it.
#[allow(dead_code)]
struct FrozenLaunchCommand {
    executable_path: PathBuf,
    working_directory: PathBuf,
    port: u16,
    token: String,
    environment: Vec<(OsString, OsString)>,
    digest: String,
}

/// Producer-owned immutable inputs for the prepare/activation seam. The
/// nonce values identify planned bindings; they do not claim that a listener
/// or staging resource has already been acquired.
pub(crate) struct FrozenActivationDescriptor {
    group_generation: u64,
    group_staging_identity: String,
    roots: Vec<FrozenActivationRoot>,
}

pub(crate) struct FrozenActivationRoot {
    ordinal: u32,
    role: String,
    root_generation: u64,
    reserved_listener_identity: String,
    command: FrozenLaunchCommand,
}

impl FrozenActivationDescriptor {
    #[allow(dead_code)]
    fn from_frozen_commands(
        group_generation: u64,
        roots: Vec<(u32, String, u64, FrozenLaunchCommand)>,
    ) -> Result<Self, String> {
        let group_staging_identity = fresh_private_nonce()?;
        let roots = roots
            .into_iter()
            .map(|(ordinal, role, root_generation, command)| {
                Ok(FrozenActivationRoot {
                    ordinal,
                    role,
                    root_generation,
                    reserved_listener_identity: fresh_private_nonce()?,
                    command,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let descriptor = Self {
            group_generation,
            group_staging_identity,
            roots,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    fn validate(&self) -> Result<(), String> {
        if self.group_generation == 0 {
            return Err("Capture runtime activation generation was invalid.".into());
        }
        validate_private_nonce(&self.group_staging_identity)?;
        if self.roots.is_empty() {
            return Err("Capture runtime activation roots were incomplete.".into());
        }
        let mut ports = HashSet::with_capacity(self.roots.len());
        let mut listener_identities = HashSet::with_capacity(self.roots.len());
        for (index, root) in self.roots.iter().enumerate() {
            if root.ordinal != index as u32
                || root.root_generation == 0
                || root.role.is_empty()
                || root.role.len() > 256
                || root.command.port == 0
            {
                return Err("Capture runtime activation roots were invalid.".into());
            }
            if !ports.insert(root.command.port) {
                return Err("Capture runtime activation ports were not distinct.".into());
            }
            validate_private_nonce(&root.reserved_listener_identity)?;
            if !listener_identities.insert(&root.reserved_listener_identity) {
                return Err("Capture runtime listener identities were not distinct.".into());
            }
            if !is_lower_sha256(&root.command.digest) {
                return Err("Capture runtime frozen command identity was invalid.".into());
            }
        }
        Ok(())
    }

    pub(crate) fn to_prepare_draft(&self) -> Result<crate::prepare::PreparePlanDraft, String> {
        self.validate()?;
        Ok(crate::prepare::PreparePlanDraft {
            group_generation: self.group_generation,
            roots: self
                .roots
                .iter()
                .map(|root| crate::prepare::PrepareRootDraft {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_generation: root.root_generation,
                    spec_digest: activation_root_spec_digest(&self.group_staging_identity, root),
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                })
                .collect(),
        })
    }
}

/// Builds the prepare plan through the typed activation descriptor. The
/// value-only draft builder remains available for its existing foundation
/// fixtures and is not an activation input path.
#[allow(dead_code)]
fn build_activation_plan(
    descriptor: FrozenActivationDescriptor,
    producer_root: PathBuf,
    session_nonce: String,
) -> Result<crate::prepare::ImmutableGroupPlan, crate::prepare::PrepareError> {
    crate::prepare::build_immutable_group_plan_from_activation(
        std::sync::Arc::new(descriptor),
        producer_root,
        session_nonce,
    )
}

#[allow(dead_code)]
impl FrozenLaunchCommand {
    fn command(&self) -> Command {
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
}

/// Captures ambient environment values once and binds the resulting command
/// to the previously verified executable. The existing `VerifiedSidecar`
/// remains the provenance authority supplied by `verify_sidecar`; because its
/// fields are public, this helper reuses the artifact verifier but does not
/// claim to establish upstream manifest provenance from an arbitrary struct
/// literal.
#[allow(dead_code)]
fn freeze_launch_command(
    verified: &VerifiedSidecar,
    spec: &SidecarLaunchSpec,
) -> Result<FrozenLaunchCommand, String> {
    let captured_environment: Vec<_> = std::env::vars_os().collect();
    freeze_launch_command_from_environment(verified, spec, &captured_environment)
}

#[allow(dead_code)]
fn freeze_launch_command_from_environment(
    verified: &VerifiedSidecar,
    spec: &SidecarLaunchSpec,
    captured_environment: &[(OsString, OsString)],
) -> Result<FrozenLaunchCommand, String> {
    let executable_path = validate_frozen_launch_inputs(verified, spec)?;
    let environment = resolve_frozen_environment(captured_environment, spec)?;
    let working_directory = executable_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let digest = frozen_command_digest(
        &executable_path,
        &working_directory,
        spec.port,
        &spec.token,
        &environment,
        &verified.manifest,
    );

    Ok(FrozenLaunchCommand {
        executable_path,
        working_directory,
        port: spec.port,
        token: spec.token.clone(),
        environment,
        digest,
    })
}

#[allow(dead_code)]
fn validate_frozen_launch_inputs(
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

#[allow(dead_code)]
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
#[allow(dead_code)]
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

#[allow(dead_code)]
fn validate_environment_value(value: &OsStr) -> Result<(), String> {
    if value.as_encoded_bytes().contains(&0) {
        Err("Capture runtime launch environment value was invalid.".into())
    } else {
        Ok(())
    }
}

#[allow(dead_code)]
fn environment_key(name: &OsStr) -> Vec<u8> {
    name.as_encoded_bytes()
        .iter()
        .map(|byte| byte.to_ascii_lowercase())
        .collect()
}

#[allow(dead_code)]
fn compare_environment_pair(
    left: &(OsString, OsString),
    right: &(OsString, OsString),
) -> CompareOrdering {
    left.0
        .as_encoded_bytes()
        .cmp(right.0.as_encoded_bytes())
        .then(left.1.as_encoded_bytes().cmp(right.1.as_encoded_bytes()))
}

#[allow(dead_code)]
fn frozen_command_digest(
    executable_path: &Path,
    working_directory: &Path,
    port: u16,
    token: &str,
    environment: &[(OsString, OsString)],
    manifest: &crate::SidecarManifest,
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
    digest_bytes(&encoded)
}

#[allow(dead_code)]
fn append_bytes(output: &mut Vec<u8>, label: &[u8], value: &[u8]) {
    output.extend_from_slice(&(label.len() as u64).to_be_bytes());
    output.extend_from_slice(label);
    output.extend_from_slice(&(value.len() as u64).to_be_bytes());
    output.extend_from_slice(value);
}

#[allow(dead_code)]
fn digest_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[allow(dead_code)]
fn fresh_private_nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Capture runtime activation identity could not be generated.".to_string())?;
    let mut nonce = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut nonce, "{byte:02x}")
            .map_err(|_| "Capture runtime activation identity could not be encoded.".to_string())?;
    }
    Ok(nonce)
}

fn validate_private_nonce(value: &str) -> Result<(), String> {
    if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Capture runtime activation identity was invalid.".into())
    }
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn activation_root_spec_digest(
    group_staging_identity: &str,
    root: &FrozenActivationRoot,
) -> String {
    let mut encoded = Vec::new();
    encoded.extend_from_slice(b"capture-sidecar/activation-root-spec/v1\0");
    append_bytes(
        &mut encoded,
        b"command-digest",
        root.command.digest.as_bytes(),
    );
    append_bytes(
        &mut encoded,
        b"group-staging-identity",
        group_staging_identity.as_bytes(),
    );
    append_bytes(&mut encoded, b"ordinal", &root.ordinal.to_be_bytes());
    append_bytes(&mut encoded, b"role", root.role.as_bytes());
    append_bytes(
        &mut encoded,
        b"root-generation",
        &root.root_generation.to_be_bytes(),
    );
    append_bytes(
        &mut encoded,
        b"reserved-listener-identity",
        root.reserved_listener_identity.as_bytes(),
    );
    digest_bytes(&encoded)
}

/// Bounded launch timing and retry policy.
#[derive(Debug, Clone, Copy)]
pub struct LaunchOptions {
    pub ready_timeout: Duration,
    pub ready_poll_interval: Duration,
    pub max_attempts: usize,
    pub total_timeout: Duration,
    pub retry_delay: Duration,
    pub retry_poll_interval: Duration,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            ready_timeout: READY_TIMEOUT,
            ready_poll_interval: READY_POLL_INTERVAL,
            max_attempts: MAX_LAUNCH_ATTEMPTS,
            total_timeout: TOTAL_LAUNCH_TIMEOUT,
            retry_delay: RETRY_DELAY,
            retry_poll_interval: RETRY_POLL_INTERVAL,
        }
    }
}

/// A ready sidecar and its exact process-ownership handle.
pub struct LaunchedSidecar {
    pub process: OwnedRuntimeSession,
    pub connection: SidecarConnection,
}

/// Verifies, launches, probes, and retries one authenticated sidecar.
pub fn launch_sidecar(
    verified: &VerifiedSidecar,
    stopping: &AtomicBool,
    options: LaunchOptions,
    spec_factory: impl FnMut(usize, Duration) -> Result<SidecarLaunchSpec, String>,
) -> Result<LaunchedSidecar, String> {
    launch_sidecar_with_observer(verified, stopping, options, spec_factory, |_| Ok(()))
}

/// Launches a sidecar while handing every spawned attempt to the host before
/// readiness is probed. The observer normally stores a clone in the host's
/// authoritative ownership state; the launcher still uses its own token for
/// probing and retry cleanup.
pub fn launch_sidecar_with_observer(
    verified: &VerifiedSidecar,
    stopping: &AtomicBool,
    options: LaunchOptions,
    mut spec_factory: impl FnMut(usize, Duration) -> Result<SidecarLaunchSpec, String>,
    mut observe_spawn: impl FnMut(OwnedRuntimeSession) -> Result<(), String>,
) -> Result<LaunchedSidecar, String> {
    if options.max_attempts == 0 || options.total_timeout.is_zero() {
        return Err("Capture runtime launch policy did not allow an attempt.".into());
    }

    let started = Instant::now();
    let mut completed_attempts = 0;
    let mut last_failure = None;

    for attempt_number in 1..=options.max_attempts {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        let remaining = options.total_timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        completed_attempts = attempt_number;
        let spec = spec_factory(attempt_number, remaining)?;
        let mut command = spec.command();
        let mut process = match OwnedRuntimeSession::spawn(&mut command) {
            Ok(process) => process,
            Err(error) => return Err(error),
        };
        if let Err(error) = observe_spawn(process.clone()) {
            let cleanup = process.terminate().err();
            return Err(match cleanup {
                Some(cleanup) => {
                    format!("{error} The observed runtime attempt also failed cleanup: {cleanup}")
                }
                None => error,
            });
        }
        let timeout = options.ready_timeout.min(remaining);
        match wait_until_ready(
            &mut process,
            &spec,
            &verified.manifest,
            stopping,
            timeout,
            options.ready_poll_interval,
        ) {
            Ok(handshake) => {
                return Ok(LaunchedSidecar {
                    process,
                    connection: SidecarConnection {
                        base_url: spec.base_url(),
                        token: spec.token.clone(),
                        runtime_version: handshake.runtime_version,
                        api_version: handshake.api_version,
                        capture_document_schema_version: handshake.capture_document_schema_version,
                    },
                });
            }
            Err(error) => {
                process.terminate().map_err(|cleanup| cleanup.to_string())?;
                last_failure = Some(error);
            }
        }

        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        if attempt_number < options.max_attempts {
            let remaining = options.total_timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            wait_before_retry(
                stopping,
                options.retry_delay.min(remaining),
                options.retry_poll_interval,
            )?;
        }
    }

    let last_failure = last_failure.unwrap_or_else(|| {
        "Capture runtime did not become ready before the total launch timeout.".into()
    });
    Err(format!(
        "Capture runtime did not become ready after {completed_attempts} isolated launch attempt(s). Last failure: {last_failure}"
    ))
}

fn wait_until_ready(
    process: &mut OwnedRuntimeSession,
    spec: &SidecarLaunchSpec,
    manifest: &crate::SidecarManifest,
    stopping: &AtomicBool,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<crate::ReadyHandshake, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        if let Some(status) = process
            .try_wait()
            .map_err(|error| format!("Capture runtime status could not be read: {error}"))?
        {
            return Err(format!(
                "Capture runtime exited before readiness with status {status}."
            ));
        }
        match probe_ready_once(spec.port, &spec.token, manifest)? {
            ProbeResult::Ready(handshake) => return Ok(handshake),
            ProbeResult::NotReady => thread::sleep(poll_interval),
        }
    }
    Err("Capture runtime did not become ready before the timeout.".into())
}

fn wait_before_retry(
    stopping: &AtomicBool,
    delay: Duration,
    poll_interval: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < delay {
        if stopping.load(Ordering::Acquire) {
            return Err("Capture runtime launch was cancelled during shutdown.".into());
        }
        thread::sleep(poll_interval.min(delay.saturating_sub(started.elapsed())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::{BTreeMap, HashSet},
        ffi::OsString,
        fs,
        path::{Path, PathBuf},
        sync::{atomic::AtomicUsize, Mutex},
    };

    use crate::prepare::{
        CompleteGroupBinding, CompleteGroupBindingReceiptV1, PersistError, ReconcileRefSink,
        VerifiedGroupBinding,
    };

    fn manifest() -> crate::SidecarManifest {
        crate::SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: 7,
            sha256: "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23".into(),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        }
    }

    fn verified(executable_path: PathBuf) -> VerifiedSidecar {
        VerifiedSidecar {
            manifest: manifest(),
            executable_path,
        }
    }

    fn token_environment(token: &str) -> Vec<(String, String)> {
        vec![("CAPTURE_API_TOKEN".into(), token.into())]
    }

    fn frozen_test_command(executable_path: &Path, port: u16) -> FrozenLaunchCommand {
        freeze_launch_command_from_environment(
            &verified(executable_path.to_path_buf()),
            &SidecarLaunchSpec::new(
                executable_path.to_path_buf(),
                port,
                "secret-token".into(),
                token_environment("secret-token"),
                Vec::new(),
            ),
            &[],
        )
        .expect("frozen command")
    }

    fn activation_test_descriptor(
        executable_path: &Path,
        ports: &[u16],
    ) -> FrozenActivationDescriptor {
        FrozenActivationDescriptor::from_frozen_commands(
            4,
            ports
                .iter()
                .enumerate()
                .map(|(index, port)| {
                    (
                        index as u32,
                        if index == 0 {
                            "capture".into()
                        } else {
                            format!("worker-{index}")
                        },
                        index as u64 + 1,
                        frozen_test_command(executable_path, *port),
                    )
                })
                .collect(),
        )
        .expect("activation descriptor")
    }

    fn command_environment(command: &Command) -> BTreeMap<String, String> {
        command
            .get_envs()
            .filter_map(|(name, value)| {
                value.map(|value| {
                    (
                        name.to_string_lossy().to_ascii_lowercase(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect()
    }

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

    #[test]
    fn default_launch_policy_is_three_attempts_and_bounded() {
        let options = LaunchOptions::default();
        assert_eq!(options.max_attempts, 3);
        assert!(options.total_timeout >= options.ready_timeout);
    }

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

    #[test]
    fn activation_descriptor_derives_root_identity_from_owned_commands_and_nonces() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(&executable_path, &[42123, 42124]);
        let draft = descriptor.to_prepare_draft().expect("activation draft");

        assert_eq!(draft.group_generation, 4);
        assert_eq!(draft.roots.len(), 2);
        assert_ne!(draft.roots[0].spec_digest, draft.roots[1].spec_digest);
        assert_ne!(
            draft.roots[0].spec_digest,
            descriptor.roots[0].command.digest
        );
        assert_ne!(
            draft.roots[1].reserved_listener_identity,
            draft.roots[0].reserved_listener_identity
        );
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("read directory")
                .count(),
            1
        );
    }

    #[test]
    fn activation_descriptor_rejects_incomplete_duplicate_or_colliding_roots() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let first = frozen_test_command(&executable_path, 42123);
        let second = frozen_test_command(&executable_path, 42124);
        assert!(FrozenActivationDescriptor::from_frozen_commands(
            4,
            vec![
                (0, "capture".into(), 1, first),
                (2, "worker".into(), 2, second)
            ]
        )
        .is_err());

        let first = frozen_test_command(&executable_path, 42123);
        let second = frozen_test_command(&executable_path, 42123);
        assert!(FrozenActivationDescriptor::from_frozen_commands(
            4,
            vec![
                (0, "capture".into(), 1, first),
                (1, "worker".into(), 2, second)
            ]
        )
        .is_err());

        assert!(FrozenActivationDescriptor::from_frozen_commands(4, Vec::new()).is_err());
    }

    #[test]
    fn activation_descriptor_binds_command_staging_and_listener_identity() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let mut descriptor = activation_test_descriptor(&executable_path, &[42123, 42124]);
        let baseline = descriptor.to_prepare_draft().expect("baseline draft");
        let original_group_identity = descriptor.group_staging_identity.clone();
        let original_listener_identity = descriptor.roots[0].reserved_listener_identity.clone();

        descriptor.group_staging_identity = "11".repeat(16);
        let changed_staging = descriptor.to_prepare_draft().expect("staging draft");
        assert_ne!(
            baseline.roots[0].spec_digest,
            changed_staging.roots[0].spec_digest
        );

        descriptor.group_staging_identity = original_group_identity.clone();
        descriptor.roots[0].reserved_listener_identity = "22".repeat(16);
        let changed_listener = descriptor.to_prepare_draft().expect("listener draft");
        assert_ne!(
            baseline.roots[0].spec_digest,
            changed_listener.roots[0].spec_digest
        );

        let mut changed_command = activation_test_descriptor(&executable_path, &[42125, 42124]);
        changed_command.group_staging_identity = original_group_identity;
        changed_command.roots[0].reserved_listener_identity = original_listener_identity;
        changed_command.roots[1].reserved_listener_identity =
            descriptor.roots[1].reserved_listener_identity.clone();
        let changed_command_draft = changed_command
            .to_prepare_draft()
            .expect("changed command draft");
        assert_ne!(
            baseline.roots[0].spec_digest,
            changed_command_draft.roots[0].spec_digest
        );
    }

    #[cfg(windows)]
    struct DescriptorSink {
        binding: Mutex<Option<CompleteGroupBinding>>,
        fail_persist: bool,
        persist_calls: AtomicUsize,
    }

    #[cfg(windows)]
    impl ReconcileRefSink for DescriptorSink {
        fn persist(
            &self,
            _binding_attempt_id: &crate::prepare::BindingAttemptId,
            binding: &CompleteGroupBinding,
        ) -> Result<(), PersistError> {
            self.persist_calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if self.fail_persist {
                return Err(PersistError::Storage);
            }
            *self.binding.lock().unwrap() = Some(binding.clone());
            Ok(())
        }

        fn read_back(
            &self,
            _binding_attempt_id: &crate::prepare::BindingAttemptId,
        ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
            CompleteGroupBindingReceiptV1::from_binding(
                self.binding
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or(PersistError::Storage)?,
            )
        }

        fn verify(
            &self,
            _binding_attempt_id: &crate::prepare::BindingAttemptId,
            _expected: &CompleteGroupBinding,
            read_back: &CompleteGroupBindingReceiptV1,
        ) -> Result<VerifiedGroupBinding, PersistError> {
            VerifiedGroupBinding::from_receipt(read_back.clone())
        }
    }

    #[cfg(windows)]
    #[test]
    fn activation_descriptor_reaches_prepared_result_only_after_durable_binding() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(&executable_path, &[42123, 42124]);
        let plan = build_activation_plan(
            descriptor,
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        assert!(prepared.context.activation_descriptor.is_some());
        assert_eq!(
            sink.persist_calls
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn activation_descriptor_sink_failure_acquires_no_runtime_resource() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(&executable_path, &[42123]);
        let plan = build_activation_plan(
            descriptor,
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: true,
            persist_calls: AtomicUsize::new(0),
        };
        assert!(matches!(
            crate::prepare::prepare_group(&plan, &sink),
            Err(crate::prepare::PrepareError::Binding(_))
        ));
        assert_eq!(
            sink.persist_calls
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }
}
