use std::{
    cmp::Ordering as CompareOrdering,
    collections::{BTreeMap, BTreeSet, HashSet},
    ffi::{OsStr, OsString},
    fmt::Write as _,
    fs,
    io::Read,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[cfg(all(test, windows))]
use std::{io::Write, net::TcpStream};

use rand::{rngs::OsRng, RngCore};
use serde::de::{Error as DeError, IgnoredAny, MapAccess, Visitor};

use crate::{
    constants::{
        LOOPBACK_HOST, MAX_LAUNCH_ATTEMPTS, READY_POLL_INTERVAL, READY_TIMEOUT, RETRY_DELAY,
        RETRY_POLL_INTERVAL, TOTAL_LAUNCH_TIMEOUT,
    },
    health::{
        probe_ready_once, verify_readiness_schema, ProbeResult, VerifiedReadinessSchema,
        CANONICAL_CAPTURE_DOCUMENT_V2_SHA256, R3_SCHEMA_FILE_NAME,
    },
    manifest::{
        validate_manifest_contract, verify_artifact, ManifestExpectations, SidecarManifest,
        VerifiedSidecar,
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
    manifest: SidecarManifest,
    readiness_schema: Option<FrozenReadinessContext>,
    digest: String,
}

/// Producer-owned readiness evidence bound to one canonical manifest path.
/// The schema path is derived from that manifest's parent and is never guessed
/// from the executable location.  This type is crate-private so later service
/// promotion can revalidate it without making a forgeable public receipt.
pub(crate) struct FrozenReadinessContext {
    manifest_path: PathBuf,
    schema_path: PathBuf,
    schema: VerifiedReadinessSchema,
}

impl FrozenReadinessContext {
    #[allow(dead_code)]
    pub(crate) fn schema(&self) -> &VerifiedReadinessSchema {
        &self.schema
    }

    pub(crate) fn revalidate(&self, expected_manifest: &SidecarManifest) -> Result<(), String> {
        let manifest_path = canonical_regular_file(
            &self.manifest_path,
            "Capture runtime readiness manifest was unavailable.",
            "Capture runtime readiness manifest was not a regular file.",
        )?;
        if manifest_path != self.manifest_path {
            return Err("Capture runtime readiness manifest path changed.".into());
        }
        let actual_manifest = load_bounded_manifest(&manifest_path)
            .map_err(|_| "Capture runtime readiness manifest could not be reread.".to_string())?;
        if actual_manifest != *expected_manifest {
            return Err("Capture runtime readiness manifest changed.".into());
        }
        let schema_path = manifest_path
            .parent()
            .ok_or_else(|| "Capture runtime readiness manifest parent was invalid.".to_string())?
            .join(R3_SCHEMA_FILE_NAME);
        let schema_candidate = schema_path.clone();
        let schema_path = canonical_regular_file(
            &schema_path,
            "Capture runtime readiness schema was unavailable.",
            "Capture runtime readiness schema was not a regular file.",
        )?;
        if schema_path != schema_candidate || schema_path != self.schema_path {
            return Err("Capture runtime readiness schema path changed.".into());
        }
        let schema = verify_readiness_schema(&schema_path, &actual_manifest)?;
        if schema.sha256() != self.schema.sha256() {
            return Err("Capture runtime readiness schema bytes changed.".into());
        }
        Ok(())
    }
}

/// Producer-owned immutable inputs for the prepare/activation seam. The
/// nonce values identify planned bindings; they do not claim that a listener
/// or staging resource has already been acquired.
pub(crate) struct FrozenActivationDescriptor {
    producer_root: PathBuf,
    session_nonce: String,
    group_generation: u64,
    group_staging_identity: String,
    roots: Vec<FrozenActivationRoot>,
}

#[allow(dead_code)]
struct ActivationRootInput {
    ordinal: u32,
    role: String,
    root_generation: u64,
    verified: VerifiedSidecar,
    spec: SidecarLaunchSpec,
    readiness_manifest_path: Option<PathBuf>,
}

pub(crate) struct FrozenActivationRoot {
    ordinal: u32,
    role: String,
    root_generation: u64,
    reserved_listener_identity: String,
    planned_staging_path: PathBuf,
    command: FrozenLaunchCommand,
}

const RUN_STAGING_ENVIRONMENT_NAME: &str = "CAPTURE_RUN_STAGING_DIR";
const PRIVATE_RUN_STAGING_DIRECTORY: &str = "private-run-staging";

impl FrozenActivationDescriptor {
    #[allow(dead_code)]
    fn from_activation_inputs(
        producer_root: PathBuf,
        session_nonce: String,
        group_generation: u64,
        roots: Vec<ActivationRootInput>,
    ) -> Result<Self, String> {
        validate_activation_scope(&producer_root, &session_nonce)?;
        if group_generation == 0 {
            return Err("Capture runtime activation generation was invalid.".into());
        }
        validate_activation_root_inputs(&roots)?;
        let captured_environment: Vec<_> = std::env::vars_os().collect();
        let group_staging_identity = fresh_private_nonce()?;
        let roots = roots
            .into_iter()
            .map(|input| {
                freeze_activation_root(
                    &producer_root,
                    &group_staging_identity,
                    input,
                    &captured_environment,
                )
            })
            .collect::<Result<Vec<_>, String>>()?;
        let descriptor = Self {
            producer_root,
            session_nonce,
            group_generation,
            group_staging_identity,
            roots,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    fn validate(&self) -> Result<(), String> {
        validate_activation_scope(&self.producer_root, &self.session_nonce)?;
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
            let expected_staging_path = planned_root_staging_path(
                &self.producer_root,
                &self.group_staging_identity,
                root.ordinal,
            )?;
            if root.planned_staging_path != expected_staging_path
                || !frozen_command_has_staging_path(&root.command, &expected_staging_path)?
            {
                return Err("Capture runtime planned staging identity was invalid.".into());
            }
        }
        Ok(())
    }

    pub(crate) fn producer_root(&self) -> &Path {
        &self.producer_root
    }

    pub(crate) fn session_nonce(&self) -> &str {
        &self.session_nonce
    }

    pub(crate) fn group_staging_identity(&self) -> &str {
        &self.group_staging_identity
    }

    pub(crate) fn planned_group_staging_path(&self) -> PathBuf {
        self.producer_root
            .join(PRIVATE_RUN_STAGING_DIRECTORY)
            .join(&self.group_staging_identity)
    }

    pub(crate) fn planned_root_staging_paths(&self) -> impl Iterator<Item = &Path> {
        self.roots
            .iter()
            .map(|root| root.planned_staging_path.as_path())
    }

    pub(crate) fn planned_root_port(&self, ordinal: usize) -> Option<u16> {
        self.roots.get(ordinal).map(|root| root.command.port)
    }

    #[allow(dead_code)]
    pub(crate) fn readiness_schema_context(
        &self,
        ordinal: usize,
    ) -> Option<&FrozenReadinessContext> {
        self.roots
            .get(ordinal)
            .and_then(|root| root.command.readiness_schema.as_ref())
    }

    /// Return the producer-frozen inputs needed by the private strict service
    /// readiness adapter.  The manifest, schema receipt, token, and port all
    /// come from the same immutable command; callers cannot substitute a
    /// readiness value after the plan identity was derived.
    pub(crate) fn strict_readiness_inputs(
        &self,
        ordinal: usize,
    ) -> Result<(&str, &SidecarManifest, &FrozenReadinessContext, u16), String> {
        let root = self
            .roots
            .get(ordinal)
            .ok_or_else(|| "Capture runtime activation root was missing.".to_string())?;
        let schema = root.command.readiness_schema.as_ref().ok_or_else(|| {
            "Capture runtime activation root had no frozen readiness schema context.".to_string()
        })?;
        Ok((
            root.command.token.as_str(),
            &root.command.manifest,
            schema,
            root.command.port,
        ))
    }

    /// Revalidate and materialize every frozen command before a resource is
    /// acquired.  This remains crate-private so an activation caller cannot
    /// replace the producer-owned command source with arbitrary input.
    pub(crate) fn checked_commands(&self) -> Result<Vec<Command>, String> {
        self.validate()?;
        self.roots
            .iter()
            .map(|root| root.command.checked_command())
            .collect()
    }

    /// Revalidate one frozen command at the last pre-spawn boundary.
    pub(crate) fn checked_command(&self, ordinal: usize) -> Result<Command, String> {
        self.validate()?;
        self.roots
            .get(ordinal)
            .ok_or_else(|| "Capture runtime activation root was missing.".to_string())?
            .command
            .checked_command()
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

fn validate_activation_scope(producer_root: &Path, session_nonce: &str) -> Result<(), String> {
    crate::journal_store::JournalStoreConfig::new(
        producer_root.to_path_buf(),
        session_nonce.to_owned(),
        "0".repeat(64),
    )
    .map(|_| ())
    .map_err(|_| "Capture runtime activation producer context was invalid.".to_string())
}

#[allow(dead_code)]
fn validate_activation_root_inputs(roots: &[ActivationRootInput]) -> Result<(), String> {
    if roots.is_empty() {
        return Err("Capture runtime activation roots were incomplete.".into());
    }
    let mut ports = HashSet::with_capacity(roots.len());
    for (index, root) in roots.iter().enumerate() {
        if root.ordinal != index as u32
            || root.root_generation == 0
            || root.role.is_empty()
            || root.role.len() > 256
            || root.spec.port == 0
        {
            return Err("Capture runtime activation roots were invalid.".into());
        }
        if !ports.insert(root.spec.port) {
            return Err("Capture runtime activation ports were not distinct.".into());
        }
    }
    Ok(())
}

fn planned_root_staging_path(
    producer_root: &Path,
    group_staging_identity: &str,
    ordinal: u32,
) -> Result<PathBuf, String> {
    validate_private_nonce(group_staging_identity)?;
    Ok(producer_root
        .join(PRIVATE_RUN_STAGING_DIRECTORY)
        .join(group_staging_identity)
        .join(format!("root-{ordinal:08}")))
}

#[allow(dead_code)]
fn freeze_activation_root(
    producer_root: &Path,
    group_staging_identity: &str,
    input: ActivationRootInput,
    captured_environment: &[(OsString, OsString)],
) -> Result<FrozenActivationRoot, String> {
    let ActivationRootInput {
        ordinal,
        role,
        root_generation,
        verified,
        spec,
        readiness_manifest_path,
    } = input;
    let planned_staging_path =
        planned_root_staging_path(producer_root, group_staging_identity, ordinal)?;
    let staging_path = planned_staging_path
        .to_str()
        .ok_or_else(|| "Capture runtime planned staging path was invalid.".to_string())?;
    let spec = bind_planned_staging_environment(spec, staging_path)?;
    let command = freeze_launch_command_from_environment_with_schema(
        &verified,
        &spec,
        captured_environment,
        readiness_manifest_path.as_deref(),
    )?;
    Ok(FrozenActivationRoot {
        ordinal,
        role,
        root_generation,
        reserved_listener_identity: fresh_private_nonce()?,
        planned_staging_path,
        command,
    })
}

#[allow(dead_code)]
fn bind_planned_staging_environment(
    mut spec: SidecarLaunchSpec,
    expected_path: &str,
) -> Result<SidecarLaunchSpec, String> {
    if spec
        .inherited_environment_allowlist
        .iter()
        .any(|name| name.eq_ignore_ascii_case(RUN_STAGING_ENVIRONMENT_NAME))
    {
        return Err("Capture runtime planned staging environment was inherited.".into());
    }
    let mut found = false;
    for (name, value) in &spec.environment {
        if name.eq_ignore_ascii_case(RUN_STAGING_ENVIRONMENT_NAME) {
            if found || value != expected_path {
                return Err("Capture runtime planned staging environment conflicted.".into());
            }
            found = true;
        }
    }
    if !found {
        spec.environment.push((
            RUN_STAGING_ENVIRONMENT_NAME.to_owned(),
            expected_path.to_owned(),
        ));
    }
    Ok(spec)
}

fn frozen_command_has_staging_path(
    command: &FrozenLaunchCommand,
    expected_path: &Path,
) -> Result<bool, String> {
    let expected_path = expected_path
        .to_str()
        .ok_or_else(|| "Capture runtime planned staging path was invalid.".to_string())?;
    let staging_key = environment_key(OsStr::new(RUN_STAGING_ENVIRONMENT_NAME));
    let mut value = None;
    for (name, candidate) in &command.environment {
        if environment_key(name) == staging_key {
            if value.is_some() {
                return Ok(false);
            }
            value = Some(candidate);
        }
    }
    Ok(value.is_some_and(|candidate| candidate == OsStr::new(expected_path)))
}

/// Builds the prepare plan through the typed activation descriptor. The
/// value-only draft builder remains available for its existing foundation
/// fixtures and is not an activation input path.
#[allow(dead_code)]
fn build_activation_plan(
    descriptor: FrozenActivationDescriptor,
) -> Result<crate::prepare::ImmutableGroupPlan, crate::prepare::PrepareError> {
    crate::prepare::build_immutable_group_plan_from_activation(std::sync::Arc::new(descriptor))
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

    /// Revalidates the frozen executable immediately before command creation.
    /// All launch values remain from this immutable snapshot; no ambient
    /// environment or mutable launch specification is consulted here.
    #[allow(dead_code)]
    fn checked_command(&self) -> Result<Command, String> {
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

fn canonical_regular_file(
    path: &Path,
    unavailable: &str,
    nonregular: &str,
) -> Result<PathBuf, String> {
    validate_non_reparse_chain(path).map_err(|_| unavailable.to_string())?;
    let canonical = fs::canonicalize(path).map_err(|_| unavailable.to_string())?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|_| unavailable.to_string())?;
    if !metadata.is_file() {
        return Err(nonregular.to_string());
    }
    Ok(canonical)
}

const MAX_READINESS_MANIFEST_BYTES: u64 = 1024 * 1024;

fn load_bounded_manifest(path: &Path) -> Result<SidecarManifest, String> {
    validate_non_reparse_chain(path)
        .map_err(|_| "Capture runtime readiness manifest path was unsafe.".to_string())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Capture runtime readiness manifest was unavailable.".to_string())?;
    if !metadata.is_file() {
        return Err("Capture runtime readiness manifest was not a regular file.".into());
    }
    if metadata.len() > MAX_READINESS_MANIFEST_BYTES {
        return Err("Capture runtime readiness manifest exceeded the safety limit.".into());
    }
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| "Capture runtime readiness manifest was too large.".to_string())?;
    let file = fs::File::open(path)
        .map_err(|_| "Capture runtime readiness manifest could not be opened.".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(MAX_READINESS_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Capture runtime readiness manifest could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_READINESS_MANIFEST_BYTES {
        return Err("Capture runtime readiness manifest exceeded the safety limit.".into());
    }

    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    serde::de::Deserializer::deserialize_map(&mut deserializer, StrictManifestKeys)
        .map_err(|_| "Capture runtime readiness manifest had invalid JSON fields.".to_string())?;
    deserializer
        .end()
        .map_err(|_| "Capture runtime readiness manifest had trailing JSON.".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Capture runtime readiness manifest had invalid JSON.".to_string())
}

struct StrictManifestKeys;

impl<'de> Visitor<'de> for StrictManifestKeys {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a closed Capture Runtime manifest object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !matches!(
                key.as_str(),
                "manifestVersion"
                    | "runtimeVersion"
                    | "apiVersion"
                    | "captureDocumentSchemaVersion"
                    | "platform"
                    | "arch"
                    | "fileName"
                    | "bytes"
                    | "sha256"
                    | "schemaFileName"
                    | "schemaSha256"
            ) {
                return Err(A::Error::custom("unknown manifest field"));
            }
            if !seen.insert(key) {
                return Err(A::Error::custom("duplicate manifest field"));
            }
            map.next_value::<IgnoredAny>()?;
        }
        Ok(())
    }
}

fn validate_non_reparse_chain(path: &Path) -> Result<(), ()> {
    let mut current = path;
    loop {
        let metadata = fs::symlink_metadata(current).map_err(|_| ())?;
        if metadata_is_reparse(&metadata) {
            return Err(());
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;
        metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn freeze_readiness_context(
    manifest_path: &Path,
    frozen_manifest: &SidecarManifest,
) -> Result<FrozenReadinessContext, String> {
    let manifest_path = canonical_regular_file(
        manifest_path,
        "Capture runtime readiness manifest was unavailable.",
        "Capture runtime readiness manifest was not a regular file.",
    )?;
    let actual_manifest = load_bounded_manifest(&manifest_path)
        .map_err(|_| "Capture runtime readiness manifest could not be read.".to_string())?;
    if actual_manifest != *frozen_manifest {
        return Err("Capture runtime readiness manifest did not match the frozen asset.".into());
    }
    if actual_manifest.schema_sha256 != CANONICAL_CAPTURE_DOCUMENT_V2_SHA256 {
        return Err(
            "Capture runtime readiness schema was not the canonical release schema.".into(),
        );
    }
    let schema_path = manifest_path
        .parent()
        .ok_or_else(|| "Capture runtime readiness manifest parent was invalid.".to_string())?
        .join(R3_SCHEMA_FILE_NAME);
    let schema_candidate = schema_path.clone();
    let schema_path = canonical_regular_file(
        &schema_path,
        "Capture runtime readiness schema was unavailable.",
        "Capture runtime readiness schema was not a regular file.",
    )?;
    if schema_path != schema_candidate
        || schema_path.file_name().and_then(OsStr::to_str) != Some(R3_SCHEMA_FILE_NAME)
    {
        return Err("Capture runtime readiness schema file name was invalid.".into());
    }
    let schema = verify_readiness_schema(&schema_path, &actual_manifest)?;
    if schema.sha256() != CANONICAL_CAPTURE_DOCUMENT_V2_SHA256 {
        return Err("Capture runtime readiness schema bytes were not canonical.".into());
    }
    Ok(FrozenReadinessContext {
        manifest_path,
        schema_path,
        schema,
    })
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
    freeze_launch_command_from_environment_with_schema(verified, spec, captured_environment, None)
}

fn freeze_launch_command_from_environment_with_schema(
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
    append_readiness_context_identity(&mut encoded, root.command.readiness_schema.as_ref());
    digest_bytes(&encoded)
}

fn append_readiness_context_identity(
    encoded: &mut Vec<u8>,
    readiness_schema: Option<&FrozenReadinessContext>,
) {
    match readiness_schema {
        None => append_bytes(encoded, b"readiness-schema-context", b"absent"),
        Some(context) => {
            append_bytes(encoded, b"readiness-schema-context", b"present");
            append_bytes(
                encoded,
                b"readiness-manifest-path",
                context.manifest_path.as_os_str().as_encoded_bytes(),
            );
            append_bytes(
                encoded,
                b"readiness-schema-path",
                context.schema_path.as_os_str().as_encoded_bytes(),
            );
            append_bytes(
                encoded,
                b"readiness-schema-sha256",
                context.schema.sha256().as_bytes(),
            );
        }
    }
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
        sync::{
            atomic::{AtomicBool, AtomicUsize},
            mpsc::sync_channel,
            Arc, Mutex,
        },
    };

    use crate::prepare::{
        CompleteGroupBinding, CompleteGroupBindingReceiptV1, PersistError, ReconcileRefSink,
        VerifiedGroupBinding,
    };

    #[cfg(windows)]
    use sha2::{Digest, Sha256};

    #[cfg(windows)]
    const ACTIVATION_HTTP_TOKEN: &str = "fixture-bearer-token-0123456789abcdef";

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

    fn write_canonical_readiness_manifest(
        manifest_directory: &Path,
        executable_path: &Path,
    ) -> PathBuf {
        let schema_bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json"
        ));
        fs::write(manifest_directory.join(R3_SCHEMA_FILE_NAME), schema_bytes)
            .expect("canonical schema fixture");

        let executable_bytes = fs::read(executable_path).expect("executable fixture");
        let mut manifest = manifest();
        manifest.bytes = executable_bytes.len() as u64;
        manifest.sha256 = digest_bytes(&executable_bytes);
        manifest.schema_sha256 = CANONICAL_CAPTURE_DOCUMENT_V2_SHA256.into();
        let manifest_path = manifest_directory.join("capture-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest JSON"),
        )
        .expect("manifest fixture");
        manifest_path
    }

    fn token_environment(token: &str) -> Vec<(String, String)> {
        vec![("CAPTURE_API_TOKEN".into(), token.into())]
    }

    fn spec_from_frozen_command(command: &FrozenLaunchCommand, port: u16) -> SidecarLaunchSpec {
        SidecarLaunchSpec::new(
            command.executable_path.clone(),
            port,
            command.token.clone(),
            command
                .environment
                .iter()
                .map(|(name, value)| {
                    (
                        name.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            Vec::new(),
        )
    }

    fn activation_test_descriptor(
        producer_root: &Path,
        executable_path: &Path,
        ports: &[u16],
    ) -> FrozenActivationDescriptor {
        FrozenActivationDescriptor::from_activation_inputs(
            producer_root.to_path_buf(),
            "session-1".into(),
            4,
            ports
                .iter()
                .enumerate()
                .map(|(index, port)| ActivationRootInput {
                    ordinal: index as u32,
                    role: if index == 0 {
                        "capture".into()
                    } else {
                        format!("worker-{index}")
                    },
                    root_generation: index as u64 + 1,
                    verified: verified(executable_path.to_path_buf()),
                    spec: SidecarLaunchSpec::new(
                        executable_path.to_path_buf(),
                        *port,
                        "secret-token".into(),
                        token_environment("secret-token"),
                        Vec::new(),
                    ),
                    readiness_manifest_path: None,
                })
                .collect(),
        )
        .expect("activation descriptor")
    }

    #[cfg(windows)]
    fn real_activation_test_descriptor(
        producer_root: &Path,
        ports: &[u16],
    ) -> (FrozenActivationDescriptor, PathBuf) {
        let source = std::env::current_exe().expect("test executable");
        let executable_path = producer_root.join("capture-runtime.exe");
        fs::copy(&source, &executable_path).expect("copy executable fixture");
        let bytes = fs::read(&executable_path).expect("fixture bytes");
        let manifest = crate::SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        };
        let descriptor = FrozenActivationDescriptor::from_activation_inputs(
            producer_root.to_path_buf(),
            "session-1".into(),
            4,
            ports
                .iter()
                .enumerate()
                .map(|(index, port)| ActivationRootInput {
                    ordinal: index as u32,
                    role: if index == 0 {
                        "capture".into()
                    } else {
                        format!("worker-{index}")
                    },
                    root_generation: index as u64 + 1,
                    verified: VerifiedSidecar {
                        manifest: manifest.clone(),
                        executable_path: executable_path.clone(),
                    },
                    spec: SidecarLaunchSpec::new(
                        executable_path.clone(),
                        *port,
                        "secret-token".into(),
                        token_environment("secret-token"),
                        Vec::new(),
                    ),
                    readiness_manifest_path: None,
                })
                .collect(),
        )
        .expect("real activation descriptor");
        (descriptor, executable_path)
    }

    #[cfg(windows)]
    fn activation_probe_test_descriptor(
        producer_root: &Path,
        ports: &[u16],
    ) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("activation-probe")
            .join("target")
            .join("debug")
            .join("capture-activation-probe.exe");
        assert!(
            source.is_file(),
            "activation probe must be built by cargo-fixture-build: {}",
            source.display()
        );
        let executable_path = producer_root.join("capture-runtime.exe");
        fs::copy(&source, &executable_path).expect("copy activation probe fixture");
        let bytes = fs::read(&executable_path).expect("fixture bytes");
        let manifest = crate::SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        };
        let journal_path = producer_root
            .to_str()
            .expect("producer root is UTF-8")
            .to_owned();
        let marker_paths = ports
            .iter()
            .enumerate()
            .map(|(ordinal, _)| producer_root.join(format!("activation-probe-{ordinal}.marker")))
            .collect::<Vec<_>>();
        let descriptor = FrozenActivationDescriptor::from_activation_inputs(
            producer_root.to_path_buf(),
            "session-1".into(),
            4,
            ports
                .iter()
                .enumerate()
                .map(|(ordinal, port)| {
                    let marker_path = marker_paths[ordinal]
                        .to_str()
                        .expect("marker path is UTF-8")
                        .to_owned();
                    ActivationRootInput {
                        ordinal: ordinal as u32,
                        role: if ordinal == 0 {
                            "capture".into()
                        } else {
                            format!("worker-{ordinal}")
                        },
                        root_generation: ordinal as u64 + 1,
                        verified: VerifiedSidecar {
                            manifest: manifest.clone(),
                            executable_path: executable_path.clone(),
                        },
                        spec: SidecarLaunchSpec::new(
                            executable_path.clone(),
                            *port,
                            "secret-token".into(),
                            vec![
                                ("CAPTURE_API_TOKEN".into(), "secret-token".into()),
                                ("CAPTURE_TEST_JOURNAL_PATH".into(), journal_path.clone()),
                                ("CAPTURE_TEST_MARKER_PATH".into(), marker_path),
                                ("CAPTURE_TEST_SESSION_NONCE".into(), "session-1".into()),
                                ("CAPTURE_TEST_ROOT_ORDINAL".into(), ordinal.to_string()),
                            ],
                            Vec::new(),
                        ),
                        readiness_manifest_path: None,
                    }
                })
                .collect(),
        )
        .expect("activation probe descriptor");
        (descriptor, marker_paths)
    }

    #[cfg(windows)]
    static TEST_PORT_ALLOCATIONS: std::sync::OnceLock<Mutex<HashSet<u16>>> =
        std::sync::OnceLock::new();

    #[cfg(windows)]
    fn held_distinct_loopback_ports(count: usize) -> (Vec<TcpListener>, Vec<u16>) {
        assert!(count > 0);
        let mut reservations = Vec::with_capacity(count);
        let mut ports = HashSet::with_capacity(count);
        let allocated = TEST_PORT_ALLOCATIONS.get_or_init(|| Mutex::new(HashSet::new()));
        for _ in 0..128 {
            if reservations.len() == count {
                break;
            }
            let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("ephemeral port");
            let port = listener.local_addr().expect("ephemeral address").port();
            if allocated.lock().unwrap().insert(port) {
                ports.insert(port);
                reservations.push(listener);
            }
        }
        assert_eq!(reservations.len(), count, "distinct loopback ports");
        (reservations, ports.into_iter().collect())
    }

    #[cfg(windows)]
    fn activation_http_test_descriptor(
        producer_root: &Path,
        ports: &[u16],
    ) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
        activation_http_test_descriptor_with_mode(producer_root, ports, "ready")
    }

    #[cfg(windows)]
    fn activation_http_test_descriptor_with_mode(
        producer_root: &Path,
        ports: &[u16],
        http_mode: &str,
    ) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
        let modes = vec![http_mode; ports.len()];
        activation_http_test_descriptor_with_modes(producer_root, ports, &modes)
    }

    #[cfg(windows)]
    fn activation_http_test_descriptor_with_modes(
        producer_root: &Path,
        ports: &[u16],
        http_modes: &[&str],
    ) -> (FrozenActivationDescriptor, Vec<PathBuf>) {
        assert_eq!(ports.len(), http_modes.len());
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("activation-probe")
            .join("target")
            .join("debug")
            .join("capture-activation-probe.exe");
        assert!(
            source.is_file(),
            "activation probe must be built by cargo-fixture-build: {}",
            source.display()
        );
        let executable_path = producer_root.join("capture-runtime.exe");
        fs::copy(&source, &executable_path).expect("copy activation probe fixture");
        let release_directory = producer_root.join("release");
        fs::create_dir_all(&release_directory).expect("readiness release directory");
        let manifest_path =
            write_canonical_readiness_manifest(&release_directory, &executable_path);
        let manifest = crate::manifest::load_manifest(&manifest_path).expect("readiness manifest");
        let journal_path = producer_root
            .to_str()
            .expect("producer root is UTF-8")
            .to_owned();
        let marker_paths = ports
            .iter()
            .enumerate()
            .map(|(ordinal, _)| producer_root.join(format!("activation-http-{ordinal}.marker")))
            .collect::<Vec<_>>();
        let descriptor = FrozenActivationDescriptor::from_activation_inputs(
            producer_root.to_path_buf(),
            "session-1".into(),
            4,
            ports
                .iter()
                .enumerate()
                .map(|(ordinal, port)| {
                    let marker_path = marker_paths[ordinal]
                        .to_str()
                        .expect("marker path is UTF-8")
                        .to_owned();
                    ActivationRootInput {
                        ordinal: ordinal as u32,
                        role: if ordinal == 0 {
                            "capture".into()
                        } else {
                            format!("worker-{ordinal}")
                        },
                        root_generation: ordinal as u64 + 1,
                        verified: VerifiedSidecar {
                            manifest: manifest.clone(),
                            executable_path: executable_path.clone(),
                        },
                        spec: SidecarLaunchSpec::new(
                            executable_path.clone(),
                            *port,
                            ACTIVATION_HTTP_TOKEN.into(),
                            vec![
                                ("CAPTURE_API_TOKEN".into(), ACTIVATION_HTTP_TOKEN.into()),
                                ("CAPTURE_TEST_JOURNAL_PATH".into(), journal_path.clone()),
                                ("CAPTURE_TEST_MARKER_PATH".into(), marker_path),
                                (
                                    "CAPTURE_TEST_HTTP_CHECKPOINT_PATH".into(),
                                    producer_root
                                        .join(format!("activation-http-{ordinal}.checkpoint"))
                                        .to_str()
                                        .expect("HTTP checkpoint path is UTF-8")
                                        .to_owned(),
                                ),
                                ("CAPTURE_TEST_SESSION_NONCE".into(), "session-1".into()),
                                ("CAPTURE_TEST_ROOT_ORDINAL".into(), ordinal.to_string()),
                                ("CAPTURE_TEST_HTTP_MODE".into(), http_modes[ordinal].into()),
                            ],
                            vec!["SystemRoot".into()],
                        ),
                        readiness_manifest_path: Some(manifest_path.clone()),
                    }
                })
                .collect(),
        )
        .expect("HTTP activation probe descriptor");
        (descriptor, marker_paths)
    }

    #[cfg(windows)]
    fn launch_http_owner_for_test(
        producer_root: &Path,
        ports: &[u16],
    ) -> (
        crate::prepare::ImmutableGroupPlan,
        Vec<PathBuf>,
        crate::process::LaunchingActivationOwner,
    ) {
        let modes = vec!["ready"; ports.len()];
        launch_http_owner_with_modes_for_test(producer_root, ports, &modes)
    }

    #[cfg(windows)]
    fn launch_http_owner_with_modes_for_test(
        producer_root: &Path,
        ports: &[u16],
        http_modes: &[&str],
    ) -> (
        crate::prepare::ImmutableGroupPlan,
        Vec<PathBuf>,
        crate::process::LaunchingActivationOwner,
    ) {
        let (reservations, ports) = {
            let mut reservations = Vec::new();
            let mut distinct = HashSet::new();
            for port in ports {
                let listener =
                    TcpListener::bind((LOOPBACK_HOST, *port)).expect("test port reservation");
                distinct.insert(*port);
                reservations.push(listener);
            }
            assert_eq!(distinct.len(), ports.len());
            (reservations, ports.to_vec())
        };
        let (descriptor, marker_paths) =
            activation_http_test_descriptor_with_modes(producer_root, &ports, http_modes);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                journal.roots[ordinal].pid,
                journal.journal_revision,
            );
            wait_for_activation_probe_http_checkpoint(ports[ordinal], marker_path);
        }
        (plan, marker_paths, launching)
    }

    #[cfg(windows)]
    fn running_http_owner_for_test(
        producer_root: &Path,
        root_count: usize,
    ) -> (
        crate::prepare::ImmutableGroupPlan,
        Vec<PathBuf>,
        crate::process::RunningActivationOwner,
        crate::journal::RuntimeSessionJournalV1,
    ) {
        let (reservations, ports) = held_distinct_loopback_ports(root_count);
        let (descriptor, marker_paths) = activation_http_test_descriptor(producer_root, &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = ready
            .launch_with_cancellation(None)
            .unwrap_or_else(|_| panic!("durable Launching and native resume"));
        let launching_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                launching_journal.roots[ordinal].pid,
                launching_journal.journal_revision,
            );
            wait_for_activation_probe_http_checkpoint(ports[ordinal], marker_path);
        }
        for port in ports.iter().copied() {
            wait_for_activation_probe_http_status(
                port,
                Some(ACTIVATION_HTTP_TOKEN),
                &format!("{LOOPBACK_HOST}:{port}"),
                200,
                false,
            );
        }
        let running = launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
            .unwrap_or_else(|_| panic!("roots should reach Running"));
        let running_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        (plan, marker_paths, running, running_journal)
    }

    #[cfg(windows)]
    fn wait_for_activation_probe_marker(
        marker_path: &Path,
        ordinal: usize,
        expected_pid: u32,
        expected_revision: u64,
    ) {
        let expected = format!(
            "state=launching\nordinal={ordinal}\npid={expected_pid}\njournalRevision={expected_revision}\n"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut last_observation = None;
        while std::time::Instant::now() < deadline {
            match fs::read_to_string(marker_path) {
                Ok(marker) if marker == expected => return,
                Ok(marker) => last_observation = Some(format!("partial or mismatching {marker:?}")),
                Err(error) => last_observation = Some(format!("unreadable: {error}")),
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!(
            "fixture marker {} did not reach the exact expected four-line record; expected {:?}, last {}",
            marker_path.display(),
            expected,
            last_observation.unwrap_or_else(|| "absent".into())
        );
    }

    #[cfg(windows)]
    fn wait_for_activation_probe_http_status(
        port: u16,
        authorization: Option<&str>,
        host: &str,
        expected_status: u16,
        expect_bearer_challenge: bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let authorization = authorization
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "GET /v2/health/ready HTTP/1.1\r\nHost: {host}\r\n{authorization}Connection: close\r\n\r\n"
        );
        while Instant::now() < deadline {
            let Ok(mut stream) = TcpStream::connect_timeout(
                &format!("{LOOPBACK_HOST}:{port}")
                    .parse()
                    .expect("loopback address"),
                Duration::from_millis(250),
            ) else {
                thread::sleep(Duration::from_millis(10));
                continue;
            };
            stream
                .set_read_timeout(Some(Duration::from_millis(250)))
                .expect("HTTP test read timeout");
            if stream.write_all(request.as_bytes()).is_err() {
                continue;
            }
            let mut response = Vec::new();
            let mut chunk = [0_u8; 512];
            while !response.windows(4).any(|window| window == b"\r\n\r\n") {
                match std::io::Read::read(&mut stream, &mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => response.extend_from_slice(&chunk[..count]),
                }
                if response.len() > 4096 {
                    break;
                }
            }
            let status = response
                .split(|byte| *byte == b'\n')
                .next()
                .and_then(|line| std::str::from_utf8(line).ok())
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse::<u16>().ok());
            if status == Some(expected_status) {
                if expect_bearer_challenge
                    && !response
                        .windows(b"WWW-Authenticate: Bearer\r\n".len())
                        .any(|window| window == b"WWW-Authenticate: Bearer\r\n")
                {
                    panic!("activation probe omitted the Bearer challenge");
                }
                return;
            }
            panic!("activation probe returned an unexpected HTTP status");
        }
        panic!("activation probe HTTP server did not become reachable");
    }

    #[cfg(windows)]
    fn wait_for_activation_probe_http_checkpoint(port: u16, marker_path: &Path) {
        let checkpoint_path = marker_path.with_extension("checkpoint");
        let deadline = Instant::now() + Duration::from_secs(5);
        let request = format!(
            "GET /v2/health/ready HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {ACTIVATION_HTTP_TOKEN}\r\nConnection: close\r\n\r\n"
        );
        while Instant::now() < deadline {
            if !checkpoint_path.exists() {
                if let Ok(mut stream) = TcpStream::connect_timeout(
                    &format!("{LOOPBACK_HOST}:{port}")
                        .parse()
                        .expect("loopback address"),
                    Duration::from_millis(250),
                ) {
                    if stream.write_all(request.as_bytes()).is_ok() {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                        let mut response = Vec::new();
                        let _ = stream.read_to_end(&mut response);
                    }
                }
            }
            if fs::read(&checkpoint_path).ok().as_deref() == Some(b"authorized\n") {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "activation probe HTTP server did not confirm an authorized request checkpoint: {}",
            checkpoint_path.display()
        );
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
    fn readiness_schema_context_is_manifest_rooted_and_revalidated() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_directory = directory.path().join("runtime");
        let manifest_directory = directory.path().join("release");
        fs::create_dir(&executable_directory).expect("runtime directory");
        fs::create_dir(&manifest_directory).expect("release directory");
        let executable_path = executable_directory.join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let manifest_path =
            write_canonical_readiness_manifest(&manifest_directory, &executable_path);
        let verified_manifest = crate::manifest::load_manifest(&manifest_path).expect("manifest");
        let verified = VerifiedSidecar {
            manifest: verified_manifest,
            executable_path: executable_path.clone(),
        };
        let spec = SidecarLaunchSpec::new(
            executable_path.clone(),
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        );

        let frozen = freeze_launch_command_from_environment_with_schema(
            &verified,
            &spec,
            &[],
            Some(&manifest_path),
        )
        .expect("schema-rooted frozen command");
        let context = frozen.readiness_schema.as_ref().expect("readiness context");
        assert_eq!(
            context.manifest_path,
            fs::canonicalize(&manifest_path).expect("manifest path")
        );
        assert_eq!(
            context.schema_path,
            fs::canonicalize(manifest_directory.join(R3_SCHEMA_FILE_NAME)).expect("schema path")
        );
        assert_ne!(context.schema_path.parent(), executable_path.parent());
        assert_eq!(
            context.schema.sha256(),
            CANONICAL_CAPTURE_DOCUMENT_V2_SHA256
        );
        assert!(frozen.checked_command().is_ok());

        let canonical_schema =
            fs::read(manifest_directory.join(R3_SCHEMA_FILE_NAME)).expect("schema bytes");
        fs::write(
            manifest_directory.join(R3_SCHEMA_FILE_NAME),
            b"tampered schema",
        )
        .expect("tamper schema");
        assert!(frozen.checked_command().is_err());
        fs::write(
            manifest_directory.join(R3_SCHEMA_FILE_NAME),
            canonical_schema,
        )
        .expect("restore schema");
        assert!(frozen.checked_command().is_ok());

        let canonical_manifest = fs::read(&manifest_path).expect("manifest bytes");
        let mut oversized_manifest = canonical_manifest.clone();
        oversized_manifest.resize(MAX_READINESS_MANIFEST_BYTES as usize + 1, b' ');
        fs::write(&manifest_path, oversized_manifest).expect("oversized manifest");
        assert!(frozen.checked_command().is_err());
        fs::write(&manifest_path, &canonical_manifest).expect("restore manifest");
        assert!(frozen.checked_command().is_ok());

        for invalid_manifest in [
            br#"{"manifestVersion":"1","unknown":true}"#.as_slice(),
            br#"{"manifestVersion":"1","manifestVersion":"1"}"#.as_slice(),
        ] {
            fs::write(&manifest_path, invalid_manifest).expect("invalid manifest");
            assert!(frozen.checked_command().is_err());
            fs::write(&manifest_path, &canonical_manifest).expect("restore manifest");
        }

        let moved_manifest_path = manifest_directory.join("moved-manifest.json");
        fs::rename(&manifest_path, &moved_manifest_path).expect("move manifest");
        assert!(frozen.checked_command().is_err());
        fs::rename(&moved_manifest_path, &manifest_path).expect("restore manifest path");
        fs::create_dir(manifest_directory.join("invalid-manifest")).expect("manifest directory");
        let invalid_manifest_path = manifest_directory.join("invalid-manifest");
        assert!(freeze_launch_command_from_environment_with_schema(
            &verified,
            &spec,
            &[],
            Some(&invalid_manifest_path),
        )
        .is_err());

        let mut changed_manifest = verified.manifest.clone();
        changed_manifest.runtime_version = "0.4.3".into();
        fs::write(
            &manifest_path,
            serde_json::to_vec(&changed_manifest).expect("changed manifest JSON"),
        )
        .expect("tamper manifest");
        assert!(frozen.checked_command().is_err());
    }

    #[test]
    fn readiness_schema_context_requires_canonical_manifest_schema_and_presence_is_bound() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");

        let first_release = directory.path().join("release-one");
        let second_release = directory.path().join("release-two");
        fs::create_dir(&first_release).expect("first release");
        fs::create_dir(&second_release).expect("second release");
        let first_manifest_path =
            write_canonical_readiness_manifest(&first_release, &executable_path);
        let second_manifest_path =
            write_canonical_readiness_manifest(&second_release, &executable_path);
        let first_manifest =
            crate::manifest::load_manifest(&first_manifest_path).expect("first manifest");
        let verified = VerifiedSidecar {
            manifest: first_manifest,
            executable_path: executable_path.clone(),
        };
        let spec = SidecarLaunchSpec::new(
            executable_path.clone(),
            42123,
            "secret-token".into(),
            token_environment("secret-token"),
            Vec::new(),
        );
        let first = freeze_launch_command_from_environment_with_schema(
            &verified,
            &spec,
            &[],
            Some(&first_manifest_path),
        )
        .expect("first context");
        let second = freeze_launch_command_from_environment_with_schema(
            &verified,
            &spec,
            &[],
            Some(&second_manifest_path),
        )
        .expect("second context");
        assert_ne!(first.digest, second.digest);
        let first_root = FrozenActivationRoot {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            reserved_listener_identity: "11".repeat(16),
            planned_staging_path: PathBuf::new(),
            command: first,
        };
        let second_root = FrozenActivationRoot {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            reserved_listener_identity: "11".repeat(16),
            planned_staging_path: PathBuf::new(),
            command: second,
        };
        assert_ne!(
            activation_root_spec_digest("22".repeat(16).as_str(), &first_root),
            activation_root_spec_digest("22".repeat(16).as_str(), &second_root)
        );

        let mut foreign_manifest =
            crate::manifest::load_manifest(&first_manifest_path).expect("manifest");
        let foreign_schema = first_release.join(R3_SCHEMA_FILE_NAME);
        fs::write(&foreign_schema, b"foreign schema").expect("foreign schema");
        foreign_manifest.schema_sha256 = digest_bytes(b"foreign schema");
        fs::write(
            &first_manifest_path,
            serde_json::to_vec(&foreign_manifest).expect("foreign manifest JSON"),
        )
        .expect("foreign manifest");
        let foreign_verified = VerifiedSidecar {
            manifest: foreign_manifest,
            executable_path: executable_path.clone(),
        };
        assert!(freeze_launch_command_from_environment_with_schema(
            &foreign_verified,
            &spec,
            &[],
            Some(&first_manifest_path),
        )
        .is_err());
        assert!(freeze_launch_command_from_environment_with_schema(
            &verified,
            &spec,
            &[],
            Some(&first_manifest_path),
        )
        .is_err());

        let legacy = FrozenActivationDescriptor::from_activation_inputs(
            directory.path().to_path_buf(),
            "session-1".into(),
            4,
            vec![ActivationRootInput {
                ordinal: 0,
                role: "capture".into(),
                root_generation: 1,
                verified,
                spec,
                readiness_manifest_path: None,
            }],
        )
        .expect("legacy descriptor");
        assert!(legacy.readiness_schema_context(0).is_none());
    }

    #[test]
    fn activation_descriptor_attaches_schema_context_before_plan_identity_is_frozen() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let release_directory = directory.path().join("release");
        fs::create_dir(&release_directory).expect("release directory");
        let manifest_path =
            write_canonical_readiness_manifest(&release_directory, &executable_path);
        let manifest = crate::manifest::load_manifest(&manifest_path).expect("manifest");
        let descriptor = FrozenActivationDescriptor::from_activation_inputs(
            directory.path().to_path_buf(),
            "session-1".into(),
            4,
            vec![ActivationRootInput {
                ordinal: 0,
                role: "capture".into(),
                root_generation: 1,
                verified: VerifiedSidecar {
                    manifest,
                    executable_path: executable_path.clone(),
                },
                spec: SidecarLaunchSpec::new(
                    executable_path,
                    42123,
                    "secret-token".into(),
                    token_environment("secret-token"),
                    Vec::new(),
                ),
                readiness_manifest_path: Some(manifest_path),
            }],
        )
        .expect("schema-aware descriptor");

        assert!(descriptor.readiness_schema_context(0).is_some());
        let draft = descriptor.to_prepare_draft().expect("schema-aware draft");
        assert!(is_lower_sha256(&draft.roots[0].spec_digest));
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
        let descriptor =
            activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
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
        for (ordinal, root) in descriptor.roots.iter().enumerate() {
            let expected_path = planned_root_staging_path(
                directory.path(),
                &descriptor.group_staging_identity,
                ordinal as u32,
            )
            .expect("planned staging path");
            assert_eq!(root.planned_staging_path, expected_path);
            assert_eq!(
                command_environment(&root.command.command())
                    .get("capture_run_staging_dir")
                    .map(String::as_str),
                expected_path.to_str()
            );
        }
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
        let mut descriptor =
            activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
        descriptor.roots[1].ordinal = 2;
        assert!(descriptor.validate().is_err());

        let mut descriptor =
            activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
        descriptor.roots[1].command.port = descriptor.roots[0].command.port;
        assert!(descriptor.validate().is_err());

        let mut descriptor =
            activation_test_descriptor(directory.path(), &executable_path, &[42123]);
        descriptor.roots[0].role.clear();
        assert!(descriptor.validate().is_err());
    }

    #[test]
    fn activation_descriptor_rejects_conflicting_or_inherited_reserved_staging_environment() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");

        let mut conflicting = ActivationRootInput {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            verified: verified(executable_path.clone()),
            spec: SidecarLaunchSpec::new(
                executable_path.clone(),
                42123,
                "secret-token".into(),
                token_environment("secret-token"),
                Vec::new(),
            ),
            readiness_manifest_path: None,
        };
        conflicting
            .spec
            .environment
            .push((RUN_STAGING_ENVIRONMENT_NAME.into(), "C:\\other-run".into()));
        assert!(FrozenActivationDescriptor::from_activation_inputs(
            directory.path().to_path_buf(),
            "session-1".into(),
            4,
            vec![conflicting],
        )
        .is_err());
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("producer root")
                .count(),
            1
        );

        let inherited = ActivationRootInput {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            verified: verified(executable_path.clone()),
            spec: SidecarLaunchSpec::new(
                executable_path,
                42123,
                "secret-token".into(),
                token_environment("secret-token"),
                vec![RUN_STAGING_ENVIRONMENT_NAME.into()],
            ),
            readiness_manifest_path: None,
        };
        assert!(FrozenActivationDescriptor::from_activation_inputs(
            directory.path().to_path_buf(),
            "session-1".into(),
            4,
            vec![inherited],
        )
        .is_err());

        let duplicate = SidecarLaunchSpec::new(
            directory.path().join("capture-runtime.exe"),
            42123,
            "secret-token".into(),
            [
                token_environment("secret-token"),
                vec![
                    (
                        RUN_STAGING_ENVIRONMENT_NAME.into(),
                        "C:\\planned-run".into(),
                    ),
                    ("capture_run_staging_dir".into(), "C:\\planned-run".into()),
                ],
            ]
            .concat(),
            Vec::new(),
        );
        assert!(bind_planned_staging_environment(duplicate, "C:\\planned-run").is_err());
    }

    #[test]
    fn activation_descriptor_rejects_invalid_scope_before_freezing_commands() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let input = ActivationRootInput {
            ordinal: 0,
            role: "capture".into(),
            root_generation: 1,
            verified: verified(executable_path.clone()),
            spec: SidecarLaunchSpec::new(
                executable_path,
                42123,
                "secret-token".into(),
                token_environment("secret-token"),
                Vec::new(),
            ),
            readiness_manifest_path: None,
        };

        assert!(FrozenActivationDescriptor::from_activation_inputs(
            PathBuf::from("relative-root"),
            "session-1".into(),
            4,
            vec![input],
        )
        .is_err());
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("producer root")
                .count(),
            1
        );
    }

    #[test]
    fn activation_descriptor_binds_command_staging_and_listener_identity() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let mut descriptor =
            activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
        let baseline = descriptor.to_prepare_draft().expect("baseline draft");
        let original_command = &descriptor.roots[0].command;
        let changed_command = freeze_launch_command_from_environment(
            &verified(original_command.executable_path.clone()),
            &spec_from_frozen_command(original_command, original_command.port + 2),
            &[],
        )
        .expect("changed command");
        descriptor.roots[0].command = changed_command;
        let changed_command_draft = descriptor.to_prepare_draft().expect("command draft");
        assert_ne!(
            baseline.roots[0].spec_digest,
            changed_command_draft.roots[0].spec_digest
        );

        let mut changed_staging =
            activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
        let staging_baseline = changed_staging
            .to_prepare_draft()
            .expect("staging baseline draft");
        let listener_identities: Vec<_> = changed_staging
            .roots
            .iter()
            .map(|root| root.reserved_listener_identity.clone())
            .collect();
        changed_staging.group_staging_identity = "33".repeat(16);
        for (index, root) in changed_staging.roots.iter_mut().enumerate() {
            let staging_path = planned_root_staging_path(
                directory.path(),
                &changed_staging.group_staging_identity,
                index as u32,
            )
            .expect("changed staging path");
            let mut spec = spec_from_frozen_command(&root.command, root.command.port);
            let staging_value = staging_path
                .to_str()
                .expect("UTF-8 staging path")
                .to_owned();
            for (name, value) in &mut spec.environment {
                if name.eq_ignore_ascii_case(RUN_STAGING_ENVIRONMENT_NAME) {
                    *value = staging_value.clone();
                }
            }
            root.command = freeze_launch_command_from_environment(
                &verified(root.command.executable_path.clone()),
                &spec,
                &[],
            )
            .expect("changed staging command");
            root.planned_staging_path = staging_path;
        }
        let changed_staging_draft = changed_staging.to_prepare_draft().expect("staging draft");
        assert_eq!(
            listener_identities,
            changed_staging
                .roots
                .iter()
                .map(|root| root.reserved_listener_identity.clone())
                .collect::<Vec<_>>()
        );
        assert_ne!(
            staging_baseline.roots[0].spec_digest,
            changed_staging_draft.roots[0].spec_digest
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
    struct ReadyClock {
        values: Mutex<Vec<Result<String, crate::prepare::PrepareError>>>,
    }

    #[cfg(windows)]
    impl ReadyClock {
        fn new(
            values: impl IntoIterator<Item = Result<String, crate::prepare::PrepareError>>,
        ) -> Self {
            Self {
                values: Mutex::new(values.into_iter().collect()),
            }
        }
    }

    #[cfg(windows)]
    impl crate::prepare::PrepareClock for ReadyClock {
        fn now(&self) -> Result<String, crate::prepare::PrepareError> {
            let mut values = self.values.lock().unwrap();
            if values.is_empty() {
                Err(crate::prepare::PrepareError::JournalUnavailable)
            } else {
                values.remove(0)
            }
        }
    }

    #[cfg(windows)]
    fn build_activation_plan_with_clock(
        descriptor: FrozenActivationDescriptor,
        values: impl IntoIterator<Item = Result<String, crate::prepare::PrepareError>>,
    ) -> crate::prepare::ImmutableGroupPlan {
        crate::prepare::build_immutable_group_plan_from_activation_with_clock(
            Arc::new(descriptor),
            Arc::new(ReadyClock::new(values)),
        )
        .expect("activation plan")
    }

    #[cfg(windows)]
    #[test]
    fn activation_descriptor_reaches_prepared_result_only_after_durable_binding() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor =
            activation_test_descriptor(directory.path(), &executable_path, &[42123, 42124]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        assert_eq!(plan.context.session_nonce, "session-1");
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
        let validated = prepared
            .consume_for_activation()
            .expect("validated activation context");
        assert_eq!(validated.journal_plan, plan.value);
        assert_eq!(validated.expected.journal_revision, 1);
        assert_eq!(validated.descriptor.session_nonce(), "session-1");
    }

    #[cfg(windows)]
    #[test]
    fn activation_validation_rejects_stale_prepared_bound_snapshot() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let current = plan
            .context
            .store
            .read(&plan.value)
            .expect("prepared journal");
        plan.context
            .store
            .compare_and_swap(
                &plan.value,
                &current.cas_snapshot(),
                crate::journal_store::JournalStoreCommand::Transition {
                    next_state: crate::journal::JournalState::ReconcileRequired,
                    timestamp: current.updated_at.clone(),
                },
            )
            .expect("state transition");

        assert!(matches!(
            prepared.consume_for_activation(),
            Err(crate::prepare::PrepareError::JournalConflict)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn activation_validation_rejects_descriptor_and_index_identity_tampering() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");

        let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
        let mut plan = build_activation_plan(descriptor).expect("activation plan");
        let context = Arc::get_mut(&mut plan.context).expect("unique plan context");
        let descriptor = Arc::get_mut(
            context
                .activation_descriptor
                .as_mut()
                .expect("activation descriptor"),
        )
        .expect("unique activation descriptor");
        descriptor.roots[0].role = "changed-role".into();
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        assert!(matches!(
            prepared.consume_for_activation(),
            Err(crate::prepare::PrepareError::InvalidPlan)
        ));

        let directory = tempfile::tempdir().expect("index directory");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42124]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let index_path = fs::read_dir(directory.path())
            .expect("producer root")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("runtime-ref-index-v1-"))
            })
            .expect("address index");
        let index_bytes = fs::read(&index_path).expect("index bytes");
        let mut index: serde_json::Value = serde_json::from_slice(&index_bytes).unwrap();
        index["groupRef"] = serde_json::json!("tampered");
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).expect("tampered index");

        assert!(matches!(
            prepared.consume_for_activation(),
            Err(crate::prepare::PrepareError::InvalidPlan)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn activation_validation_rejects_missing_address_index() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42125]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let index_path = fs::read_dir(directory.path())
            .expect("producer root")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("runtime-ref-index-v1-"))
            })
            .expect("address index");
        fs::remove_file(index_path).expect("remove index");

        assert!(matches!(
            prepared.consume_for_activation(),
            Err(crate::prepare::PrepareError::JournalUnavailable)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn activation_descriptor_sink_failure_acquires_no_runtime_resource() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let descriptor = activation_test_descriptor(directory.path(), &executable_path, &[42123]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
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

    #[cfg(windows)]
    #[test]
    fn activation_descriptor_acquires_real_windows_roots_suspended_before_cleanup() {
        for ports in [&[42130_u16][..], &[42131_u16, 42132_u16][..]] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (descriptor, _) = real_activation_test_descriptor(directory.path(), ports);
            let group_path = descriptor.planned_group_staging_path();
            let plan = build_activation_plan(descriptor).expect("activation plan");
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let mut owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("real executable roots should be acquired suspended");
            assert_eq!(owner.native_root_count_for_test(), Some(ports.len()));
            assert!(owner.native_is_suspended_for_test());

            owner.cleanup().expect("native then empty staging cleanup");
            assert!(!group_path.exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn suspended_group_persists_complete_ready_observation_without_resuming() {
        for ports in [&[42146_u16][..], &[42147_u16, 42148_u16][..]] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (descriptor, _) = real_activation_test_descriptor(directory.path(), ports);
            let group_path = descriptor.planned_group_staging_path();
            let plan = build_activation_plan(descriptor).expect("activation plan");
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("suspended owner");
            let mut ready = owner.persist_ready().expect("durable Ready observation");

            let journal = plan.context.store.read(&plan.value).expect("Ready journal");
            assert_eq!(journal.state, crate::journal::JournalState::Ready);
            assert_eq!(ready.ready_journal_for_test(), &journal);
            assert_eq!(ready.ready_journal_for_test().journal_revision, 2);
            assert_eq!(
                journal.job_binding.as_ref().map(|job| job.setup_state),
                Some(crate::journal::JobSetupState::Committed,)
            );
            let staging_binding = journal
                .staging_binding
                .as_ref()
                .expect("Ready staging binding");
            assert_eq!(staging_binding.run_nonce, "session-1");
            assert_eq!(staging_binding.scope, "run");
            assert_eq!(staging_binding.root_digest.len(), 64);
            assert_eq!(journal.roots.len(), ports.len());
            let crate::journal::JournalBinding::Bound { root_bindings, .. } = &journal.binding
            else {
                panic!("Ready journal binding");
            };
            assert_eq!(root_bindings.len(), ports.len());
            for (ordinal, ((root, binding), port)) in journal
                .roots
                .iter()
                .zip(root_bindings)
                .zip(ports)
                .enumerate()
            {
                assert_eq!(root.ordinal, ordinal as u32);
                assert_eq!(root.role, binding.role);
                assert_eq!(root.root_ref_digest, binding.root_ref_digest);
                assert_eq!(root.root_generation, binding.root_generation);
                assert_eq!(
                    root.reserved_listener_identity,
                    binding.reserved_listener_identity
                );
                assert_eq!(root.loopback_port, *port);
                assert_eq!(root.state, crate::journal::RootState::Suspended);
                assert!(root.live_listener_readiness.is_none());
                assert!(root.pid > 0);
                assert_eq!(root.creation_identity.value.len(), 16);
            }
            assert_eq!(ready.native_root_count_for_test(), Some(ports.len()));
            assert!(ready.native_is_suspended_for_test());

            let cleanup_failure = ready
                .cleanup_without_terminal_proof()
                .expect_err("Ready cleanup must retain staging for reconciliation");
            let owner = cleanup_failure.into_owner();
            assert_eq!(owner.native_root_count_for_test(), None);
            assert!(owner.native_cleanup_proven_for_test());
            assert!(group_path.exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn launching_cas_precedes_resume_and_keeps_the_exact_journal_snapshot() {
        for ports in [&[42155_u16][..], &[42156_u16, 42157_u16][..]] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (descriptor, _) = real_activation_test_descriptor(directory.path(), ports);
            let plan = build_activation_plan(descriptor).expect("activation plan");
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("suspended owner");
            let ready = owner.persist_ready().expect("durable Ready");

            let launching = match ready.launch_with_cancellation(None) {
                Ok(owner) => owner,
                Err(_) => panic!("durable Launching followed by native resume"),
            };
            let journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Launching journal");
            assert_eq!(journal.state, crate::journal::JournalState::Launching);
            assert_eq!(launching.launching_journal_for_test(), &journal);
            assert_eq!(journal.roots.len(), ports.len());
            assert!(journal
                .roots
                .iter()
                .all(|root| root.state == crate::journal::RootState::Suspended));

            let cleanup = launching
                .cleanup_without_terminal_proof()
                .expect_err("Launching cleanup must retain staging for reconciliation");
            assert!(cleanup.into_owner().native_cleanup_proven_for_test());
        }
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_observes_durable_launching_before_each_real_root_runs() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, marker_paths) =
            activation_probe_test_descriptor(directory.path(), &[42165_u16, 42166_u16]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        assert!(marker_paths.iter().all(|path| !path.exists()));

        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("fixture roots should observe durable Launching"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        assert_eq!(journal.state, crate::journal::JournalState::Launching);
        assert_eq!(journal.journal_revision, 3);
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                journal.roots[ordinal].pid,
                journal.journal_revision,
            );
        }

        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_http_readiness_and_native_listener_use_the_same_launched_roots() {
        for root_count in [1_usize, 2] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (reservations, ports) = held_distinct_loopback_ports(root_count);
            let (descriptor, marker_paths) =
                activation_http_test_descriptor(directory.path(), &ports);
            let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
            let activation_descriptor = plan
                .context
                .activation_descriptor
                .as_ref()
                .expect("schema-aware activation descriptor")
                .clone();
            for ordinal in 0..root_count {
                assert!(
                    activation_descriptor
                        .readiness_schema_context(ordinal)
                        .is_some(),
                    "schema context must be frozen for root {ordinal}"
                );
                assert_eq!(
                    command_environment(&activation_descriptor.roots[ordinal].command.command())
                        .get("capture_test_http_mode")
                        .map(String::as_str),
                    Some("ready")
                );
            }
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("suspended owner");
            let ready = owner.persist_ready().expect("durable Ready");
            assert!(marker_paths.iter().all(|path| !path.exists()));
            drop(reservations);

            let mut launching = match ready.launch_with_cancellation(None) {
                Ok(owner) => owner,
                Err(_) => panic!("fixture roots should launch"),
            };
            let journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Launching journal");
            assert_eq!(journal.state, crate::journal::JournalState::Launching);
            for (ordinal, marker_path) in marker_paths.iter().enumerate() {
                wait_for_activation_probe_marker(
                    marker_path,
                    ordinal,
                    journal.roots[ordinal].pid,
                    journal.journal_revision,
                );
            }
            for (ordinal, port) in ports.iter().copied().enumerate() {
                let root = &activation_descriptor.roots[ordinal];
                let schema = activation_descriptor
                    .readiness_schema_context(ordinal)
                    .expect("frozen readiness schema");
                assert_eq!(root.command.port, port);
                assert!(
                    root.command.token == ACTIVATION_HTTP_TOKEN,
                    "frozen readiness token binding mismatch"
                );
                wait_for_activation_probe_http_status(
                    port,
                    Some("wrong-token"),
                    &format!("{LOOPBACK_HOST}:{port}"),
                    401,
                    true,
                );
                wait_for_activation_probe_http_status(
                    port,
                    None,
                    &format!("{LOOPBACK_HOST}:{port}"),
                    401,
                    true,
                );
                wait_for_activation_probe_http_status(
                    port,
                    Some(ACTIVATION_HTTP_TOKEN),
                    "localhost",
                    400,
                    false,
                );
                wait_for_activation_probe_http_status(
                    port,
                    Some(ACTIVATION_HTTP_TOKEN),
                    &format!("{LOOPBACK_HOST}:{port}"),
                    200,
                    false,
                );
                let readiness = crate::health::probe_service_ready(
                    port,
                    root.command.token.as_str(),
                    &root.command.manifest,
                    schema.schema(),
                    Instant::now() + Duration::from_secs(5),
                    &AtomicBool::new(false),
                )
                .unwrap_or_else(|error| panic!("strict HTTP readiness probe failed: {error}"));
                match readiness {
                    crate::health::StrictProbeResult::Ready(_) => {}
                    crate::health::StrictProbeResult::NotReady => {
                        panic!("root {ordinal} did not report strict RuntimeReady")
                    }
                    crate::health::StrictProbeResult::Cancelled => {
                        panic!("root {ordinal} readiness probe was cancelled")
                    }
                }
            }
            assert_eq!(
                launching
                    .observe_native_listeners_for_test(
                        &ports,
                        Instant::now() + Duration::from_secs(5),
                        None,
                    )
                    .expect("direct-root listener observation"),
                root_count
            );

            let cleanup = launching
                .cleanup_without_terminal_proof()
                .expect_err("Launching cleanup retains staging for reconciliation");
            assert!(cleanup.into_owner().native_cleanup_proven_for_test());
        }
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_promotes_one_and_many_roots_only_after_durable_running_cas() {
        for root_count in [1_usize, 2] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (reservations, ports) = held_distinct_loopback_ports(root_count);
            let (descriptor, marker_paths) =
                activation_http_test_descriptor(directory.path(), &ports);
            let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("suspended owner");
            let ready = owner.persist_ready().expect("durable Ready");
            drop(reservations);

            let launching = match ready.launch_with_cancellation(None) {
                Ok(owner) => owner,
                Err(_) => panic!("durable Launching and native resume"),
            };
            let launching_journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Launching journal");
            for (ordinal, marker_path) in marker_paths.iter().enumerate() {
                wait_for_activation_probe_marker(
                    marker_path,
                    ordinal,
                    launching_journal.roots[ordinal].pid,
                    launching_journal.journal_revision,
                );
            }
            for port in ports.iter().copied() {
                wait_for_activation_probe_http_status(
                    port,
                    Some(ACTIVATION_HTTP_TOKEN),
                    &format!("{LOOPBACK_HOST}:{port}"),
                    200,
                    false,
                );
            }

            // Runtime activity may legitimately add files after resume.  The
            // Running admission validates ownership/identity, rather than
            // reusing the pre-native empty-scope cleanup proof.
            let activation_descriptor = plan
                .context
                .activation_descriptor
                .as_ref()
                .expect("activation descriptor")
                .clone();
            let group_staging_path = activation_descriptor.planned_group_staging_path();
            let root_staging_paths = activation_descriptor
                .planned_root_staging_paths()
                .map(PathBuf::from)
                .collect::<Vec<_>>();
            for (ordinal, root_staging_path) in root_staging_paths.iter().enumerate() {
                fs::write(
                    root_staging_path.join(format!("runtime-{ordinal}.spool")),
                    b"runtime activity",
                )
                .expect("post-resume runtime staging file");
            }

            let running = launching
                .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
                .unwrap_or_else(|_| panic!("roots should reach Running with an exact durable CAS"));
            let running_journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Running journal");
            assert_eq!(running.running_journal_for_test(), &running_journal);
            assert_eq!(running_journal.state, crate::journal::JournalState::Running);
            assert_eq!(running_journal.journal_revision, 4);
            assert!(running_journal
                .roots
                .iter()
                .all(|root| root.state == crate::journal::RootState::Running));
            assert!(running_journal
                .roots
                .iter()
                .all(|root| root.live_listener_readiness.is_some()));
            assert_eq!(
                running_journal
                    .roots
                    .iter()
                    .filter_map(|root| root.live_listener_readiness.as_ref())
                    .collect::<HashSet<_>>()
                    .len(),
                root_count
            );
            assert_eq!(running.native_root_count_for_test(), Some(root_count));

            let cleanup = running
                .cleanup_without_terminal_proof()
                .expect_err("Running cleanup retains staging for reconciliation");
            let retained = cleanup.into_owner();
            assert!(retained.native_cleanup_proven_for_test());
            assert!(group_staging_path.is_dir());
            for (ordinal, root_staging_path) in root_staging_paths.iter().enumerate() {
                assert!(root_staging_path.is_dir());
                assert!(root_staging_path
                    .join(format!("runtime-{ordinal}.spool"))
                    .is_file());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn running_close_persists_teardown_intent_for_one_and_many_roots() {
        for root_count in [1_usize, 2] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (reservations, ports) = held_distinct_loopback_ports(root_count);
            let (descriptor, marker_paths) =
                activation_http_test_descriptor(directory.path(), &ports);
            let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("suspended owner");
            let ready = owner.persist_ready().expect("durable Ready");
            drop(reservations);
            let launching = ready
                .launch_with_cancellation(None)
                .unwrap_or_else(|_| panic!("durable Launching and native resume"));
            let launching_journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Launching journal");
            for (ordinal, marker_path) in marker_paths.iter().enumerate() {
                wait_for_activation_probe_marker(
                    marker_path,
                    ordinal,
                    launching_journal.roots[ordinal].pid,
                    launching_journal.journal_revision,
                );
            }
            for port in ports.iter().copied() {
                wait_for_activation_probe_http_status(
                    port,
                    Some(ACTIVATION_HTTP_TOKEN),
                    &format!("{LOOPBACK_HOST}:{port}"),
                    200,
                    false,
                );
            }
            let running = launching
                .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
                .unwrap_or_else(|_| panic!("roots should reach Running"));
            let running_journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Running journal");
            assert_eq!(running_journal.state, crate::journal::JournalState::Running);
            assert_eq!(running.running_journal_for_test(), &running_journal);

            // Closing is teardown intent. It must not issue a listener-table
            // query or require the service to remain healthy before the
            // durable transition is recorded.
            let mut running = running;
            running.inject_listener_query_failure_for_test();
            let staging_marker = plan
                .context
                .activation_descriptor
                .as_ref()
                .expect("activation descriptor")
                .planned_group_staging_path()
                .join(".capture-run-staging-v1");
            fs::write(&staging_marker, b"foreign marker bytes").expect("test staging marker drift");
            let closing = running
                .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
                .unwrap_or_else(|_| {
                    panic!("Running owner should enter Closing without a listener probe")
                });
            let closing_journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Closing journal");
            assert_eq!(closing_journal.state, crate::journal::JournalState::Closing);
            assert_eq!(
                closing_journal.journal_revision,
                running_journal.journal_revision + 1
            );
            assert_eq!(closing.closing_journal_for_test(), &closing_journal);
            assert_eq!(closing.native_root_count_for_test(), Some(root_count));
            assert_eq!(
                closing_journal.schema_version,
                running_journal.schema_version
            );
            assert_eq!(closing_journal.producer, running_journal.producer);
            assert_eq!(closing_journal.session_nonce, running_journal.session_nonce);
            assert_eq!(closing_journal.plan_digest, running_journal.plan_digest);
            assert_eq!(closing_journal.created_at, running_journal.created_at);
            assert!(closing_journal.updated_at >= running_journal.updated_at);
            assert_eq!(closing_journal.attempt, running_journal.attempt);
            assert_eq!(
                closing_journal.recovery_epoch,
                running_journal.recovery_epoch
            );
            assert_eq!(closing_journal.binding, running_journal.binding);
            assert_eq!(closing_journal.job_binding, running_journal.job_binding);
            assert_eq!(
                closing_journal.staging_binding,
                running_journal.staging_binding
            );
            assert_eq!(closing_journal.proof, running_journal.proof);
            let mut expected_roots = running_journal.roots.clone();
            for root in &mut expected_roots {
                root.state = crate::journal::RootState::Closing;
            }
            assert_eq!(closing_journal.roots, expected_roots);
            assert!(closing_journal
                .roots
                .iter()
                .all(|root| root.live_listener_readiness.is_some()));
            drop(closing);
            assert!(staging_marker.is_file(), "Closing must not delete staging");
        }
    }

    #[cfg(windows)]
    #[test]
    fn running_close_cancellation_before_cas_retains_running_owner_without_mutation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = ready
            .launch_with_cancellation(None)
            .unwrap_or_else(|_| panic!("durable Launching and native resume"));
        let launching_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        for (ordinal, marker_path) in marker_paths.iter().enumerate() {
            wait_for_activation_probe_marker(
                marker_path,
                ordinal,
                launching_journal.roots[ordinal].pid,
                launching_journal.journal_revision,
            );
        }
        wait_for_activation_probe_http_status(
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            200,
            false,
        );
        let running = launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
            .unwrap_or_else(|_| panic!("root should reach Running"));
        let running_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        let cancellation = Arc::new(AtomicBool::new(true));
        let failure = match running.begin_closing_with_cancellation(
            Instant::now() + Duration::from_secs(5),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("pre-CAS cancellation must retain Running owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::ClosingTransitionFailureKind::Cancelled
        );
        let running = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Running
        );
        assert_eq!(running.running_journal_for_test(), &running_journal);
        let current = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        plan.context
            .store
            .compare_and_swap(
                &plan.value,
                &current.cas_snapshot(),
                crate::journal_store::JournalStoreCommand::Transition {
                    next_state: crate::journal::JournalState::ReconcileRequired,
                    timestamp: current.updated_at.clone(),
                },
            )
            .expect("test journal drift");
        let stale_failure = match running
            .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("stale full journal must block Closing admission"),
            Err(failure) => failure,
        };
        assert_eq!(
            stale_failure.kind_for_test(),
            crate::process::ClosingTransitionFailureKind::Conflict
        );
        let running = stale_failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::ReconcileRequired
        );
        let cleanup = running
            .cleanup_without_terminal_proof()
            .expect_err("Running cleanup remains outside this slice");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_close_succeeds_after_exact_retained_root_has_exited() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (plan, _marker_paths, mut running, running_journal) =
            running_http_owner_for_test(directory.path(), 1);
        running
            .terminate_root_for_test(0)
            .expect("exact retained root handle can terminate the child");
        let closing = running
            .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
            .unwrap_or_else(|_| panic!("dead root must not block teardown intent"));
        let closing_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Closing journal");
        assert_eq!(closing_journal.state, crate::journal::JournalState::Closing);
        assert_eq!(
            closing_journal.journal_revision,
            running_journal.journal_revision + 1
        );
        assert!(closing_journal
            .roots
            .iter()
            .all(|root| root.state == crate::journal::RootState::Closing));
        assert_eq!(closing.native_root_count_for_test(), Some(1));
        drop(closing);
    }

    #[cfg(windows)]
    #[test]
    fn running_close_ambiguous_replacement_keeps_owner_without_closing_authority() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = ready
            .launch_with_cancellation(None)
            .unwrap_or_else(|_| panic!("durable Launching and native resume"));
        let launching_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            launching_journal.roots[0].pid,
            launching_journal.journal_revision,
        );
        wait_for_activation_probe_http_status(
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            200,
            false,
        );
        let running = launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(15), None)
            .unwrap_or_else(|_| panic!("root should reach Running"));
        let running_journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        plan.context
            .store
            .fail_after_replace_and_durability_recheck();
        let failure = match running
            .begin_closing_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("ambiguous replacement must not issue Closing authority"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::ClosingTransitionFailureKind::Storage
        );
        assert!(failure.detail_for_test().contains("possibly Closing"));
        let owner = failure.into_owner();
        let disk = plan
            .context
            .store
            .read(&plan.value)
            .expect("candidate journal");
        assert_eq!(disk.state, crate::journal::JournalState::Closing);
        assert_eq!(disk.journal_revision, running_journal.journal_revision + 1);
        assert_eq!(owner.running_journal_for_test(), &running_journal);
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("ambiguous Closing state retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_close_cancellation_after_real_admission_contention_keeps_running_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (plan, _marker_paths, mut running, running_journal) =
            running_http_owner_for_test(directory.path(), 1);
        let (reached_sender, reached_receiver) = sync_channel(1);
        let (acquired_sender, acquired_receiver) = sync_channel(1);
        running.coordinate_closing_admission_for_test(reached_sender, acquired_receiver);
        let (release_sender, release_receiver) = sync_channel(1);
        let lock_store = Arc::clone(&plan.context.store);
        let holder = thread::spawn(move || {
            if reached_receiver
                .recv_timeout(Duration::from_secs(5))
                .is_err()
            {
                return;
            }
            let Ok(lock) = lock_store.lock_for_test() else {
                return;
            };
            let _ = acquired_sender.send(());
            let _ = release_receiver.recv_timeout(Duration::from_secs(5));
            drop(lock);
        });

        let contention = Arc::new(AtomicBool::new(false));
        plan.context
            .store
            .set_running_lock_contention_signal_for_test(Some(Arc::clone(&contention)));
        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_watcher = Arc::clone(&cancellation);
        let contention_watcher = Arc::clone(&contention);
        let watcher = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && !contention_watcher.load(Ordering::Acquire) {
                thread::yield_now();
            }
            // If the OS never reports the held-lock contention, still release
            // the admission attempt at the bounded rendezvous deadline so a
            // broken test hook cannot hang the suite.
            cancellation_watcher.store(true, Ordering::Release);
        });
        let failure = match running.begin_closing_with_cancellation(
            Instant::now() + Duration::from_secs(8),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("admission cancellation after lock contention must retain owner"),
            Err(failure) => failure,
        };
        plan.context
            .store
            .set_running_lock_contention_signal_for_test(None);
        let _ = release_sender.send(());
        holder.join().expect("lock holder must terminate bounded");
        watcher
            .join()
            .expect("contention watcher must terminate bounded");
        assert!(
            contention.load(Ordering::Acquire),
            "the close path must have reached a real failed lock attempt"
        );
        assert_eq!(
            failure.kind_for_test(),
            crate::process::ClosingTransitionFailureKind::Cancelled
        );
        let owner = failure.into_owner();
        assert_eq!(owner.running_journal_for_test(), &running_journal);
        let disk = plan
            .context
            .store
            .read(&plan.value)
            .expect("Running journal");
        assert_eq!(disk, running_journal);
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("contention failure retains native/staging owner");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_close_cancellation_boundaries_keep_the_exact_owner_and_disk_state() {
        for boundary in ["before-replace", "after-replace", "after-readback"] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (plan, _marker_paths, running, running_journal) =
                running_http_owner_for_test(directory.path(), 1);
            let cancellation = Arc::new(AtomicBool::new(false));
            let store = &plan.context.store;
            match boundary {
                "before-replace" => {
                    store.cancel_before_closing_replace_for_test(Arc::clone(&cancellation));
                }
                "after-replace" => {
                    store.cancel_after_closing_replace_for_test(Arc::clone(&cancellation));
                }
                "after-readback" => {
                    store.cancel_after_closing_readback_for_test(Arc::clone(&cancellation));
                }
                _ => unreachable!(),
            }
            let failure = match running.begin_closing_with_cancellation(
                Instant::now() + Duration::from_secs(5),
                Some(Arc::clone(&cancellation)),
            ) {
                Ok(_) => panic!("{boundary} cancellation must retain Running owner"),
                Err(failure) => failure,
            };
            assert_eq!(
                failure.kind_for_test(),
                crate::process::ClosingTransitionFailureKind::Cancelled
            );
            assert!(cancellation.load(Ordering::Acquire));
            if boundary == "after-readback" {
                assert!(
                    failure
                        .detail_for_test()
                        .to_ascii_lowercase()
                        .contains("cancel"),
                    "final egress guard must report the injected post-readback cancellation"
                );
            }
            let owner = failure.into_owner();
            let disk = plan
                .context
                .store
                .read(&plan.value)
                .expect("closing boundary journal");
            if boundary == "before-replace" {
                assert_eq!(disk, running_journal);
            } else {
                assert_eq!(disk.state, crate::journal::JournalState::Closing);
                assert_eq!(disk.journal_revision, running_journal.journal_revision + 1);
            }
            assert_eq!(owner.running_journal_for_test(), &running_journal);
            let cleanup = owner
                .cleanup_without_terminal_proof()
                .expect_err("Closing failure retains native/staging owner");
            assert!(cleanup.into_owner().native_cleanup_proven_for_test());
        }
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_readiness_failures_retain_launching_owner_without_running_authority() {
        for (http_mode, expected_status, expected_kind, expected_detail) in [
            (
                "status503",
                503_u16,
                crate::process::RunningPromotionFailureKind::NotReady,
                "did not report strict",
            ),
            (
                "partial",
                200_u16,
                crate::process::RunningPromotionFailureKind::Validation,
                "body length",
            ),
        ] {
            let directory = tempfile::tempdir().expect("tempdir");
            let (reservations, ports) = held_distinct_loopback_ports(1);
            let (descriptor, marker_paths) =
                activation_http_test_descriptor_with_mode(directory.path(), &ports, http_mode);
            let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
            let sink = DescriptorSink {
                binding: Mutex::new(None),
                fail_persist: false,
                persist_calls: AtomicUsize::new(0),
            };
            let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
            let activation = prepared
                .consume_for_activation()
                .expect("validated activation context");
            let owner = crate::process::acquire_suspended_for_activation(activation)
                .expect("suspended owner");
            let ready = owner.persist_ready().expect("durable Ready");
            drop(reservations);
            let launching = match ready.launch_with_cancellation(None) {
                Ok(owner) => owner,
                Err(_) => panic!("durable Launching and native resume"),
            };
            let journal = plan
                .context
                .store
                .read(&plan.value)
                .expect("Launching journal");
            wait_for_activation_probe_marker(
                &marker_paths[0],
                0,
                journal.roots[0].pid,
                journal.journal_revision,
            );
            wait_for_activation_probe_http_status(
                ports[0],
                Some(ACTIVATION_HTTP_TOKEN),
                &format!("{LOOPBACK_HOST}:{}", ports[0]),
                expected_status,
                false,
            );

            let failure = match launching
                .promote_running_with_cancellation(Instant::now() + Duration::from_secs(3), None)
            {
                Ok(_) => panic!("non-ready service must retain Launching owner"),
                Err(failure) => failure,
            };
            assert_eq!(
                failure.kind_for_test(),
                expected_kind,
                "{}",
                failure.detail_for_test()
            );
            assert!(
                failure.detail_for_test().contains(expected_detail),
                "{}",
                failure.detail_for_test()
            );
            let launching = failure.into_owner();
            assert_eq!(
                plan.context.store.read(&plan.value).expect("journal").state,
                crate::journal::JournalState::Launching
            );
            let cleanup = launching
                .cleanup_without_terminal_proof()
                .expect_err("Launching cleanup retains staging for reconciliation");
            assert!(cleanup.into_owner().native_cleanup_proven_for_test());
        }

        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) =
            activation_http_test_descriptor_with_mode(directory.path(), &ports, "silent");
        let plan = build_activation_plan(descriptor).expect("silent HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_checkpoint(ports[0], &marker_paths[0]);
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(1), None)
        {
            Ok(_) => panic!("silent service must be bounded and retain owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::NotReady
        );
        assert!(failure.detail_for_test().contains("did not report strict"));
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_second_root_failure_retains_the_complete_native_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(2);
        drop(reservations);
        let modes = ["ready", "status503"];
        let (plan, marker_paths, launching) =
            launch_http_owner_with_modes_for_test(directory.path(), &ports, &modes);
        wait_for_activation_probe_http_status(
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            200,
            false,
        );
        wait_for_activation_probe_http_status(
            ports[1],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[1]),
            503,
            false,
        );
        let group_staging_path = plan
            .context
            .activation_descriptor
            .as_ref()
            .expect("activation descriptor")
            .planned_group_staging_path();
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("a second-root readiness failure must retain the Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::NotReady
        );
        assert!(
            failure
                .detail_for_test()
                .contains("root 1 did not report strict"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(launching.native_root_count_for_test(), Some(2));
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("partial readiness retains staging for reconciliation");
        let retained = cleanup.into_owner();
        assert!(retained.native_cleanup_proven_for_test());
        assert!(group_staging_path.is_dir());
        assert!(marker_paths.iter().all(|path| path.is_file()));
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_requires_schema_context_and_cancellation_before_running() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = activation_probe_test_descriptor(directory.path(), &[42169]);
        let plan = build_activation_plan(descriptor).expect("marker-only activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(3), None)
        {
            Ok(_) => panic!("value-only descriptor cannot produce service readiness"),
            Err(failure) => failure,
        };
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());

        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) =
            activation_http_test_descriptor_with_mode(directory.path(), &ports, "silent");
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_checkpoint(ports[0], &marker_paths[0]);
        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_signal = Arc::clone(&cancellation);
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancellation_signal.store(true, std::sync::atomic::Ordering::Release);
        });
        let failure = match launching.promote_running_with_cancellation(
            Instant::now() + Duration::from_secs(15),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("cancelled promotion must retain Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Cancelled,
            "{}",
            failure.detail_for_test()
        );
        assert!(failure.detail_for_test().contains("cancelled"));
        canceller.join().expect("cancellation thread");
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_promotion_rejects_native_or_staging_drift_and_ambiguous_cas() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let mut launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_status(
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            200,
            false,
        );
        launching.inject_listener_query_failure_for_test();
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("listener query failure must retain Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Validation
        );
        assert!(
            failure
                .detail_for_test()
                .contains("Injected listener table query failure."),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());

        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        // The scope validator observes the actual planned marker through the
        // owner; a foreign marker mutation must stop before any Running CAS.
        let group_path = plan
            .context
            .activation_descriptor
            .as_ref()
            .expect("descriptor")
            .planned_group_staging_path();
        let marker_path = group_path.join(".capture-run-staging-v1");
        let marker = fs::read(&marker_path).expect("owned marker");
        fs::write(&marker_path, b"foreign running marker").expect("mutate marker");
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("staging drift must retain Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Validation
        );
        assert!(
            failure
                .detail_for_test()
                .contains("staging marker identity changed"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        fs::write(&marker_path, marker).expect("restore marker");
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());

        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan(descriptor).expect("HTTP activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_status(
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            200,
            false,
        );
        plan.context
            .store
            .fail_after_replace_and_durability_recheck();
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("ambiguous Running CAS must retain Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Storage
        );
        assert!(
            failure
                .detail_for_test()
                .contains("Running journal CAS failed"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Running
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("ambiguous Running CAS retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_promotion_clock_failure_retains_launching_owner_without_running_authority() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        let (descriptor, marker_paths) = activation_http_test_descriptor(directory.path(), &ports);
        let plan = build_activation_plan_with_clock(
            descriptor,
            [
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Err(crate::prepare::PrepareError::JournalUnavailable),
            ],
        );
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        drop(reservations);
        let launching = match ready.launch_with_cancellation(None) {
            Ok(owner) => owner,
            Err(_) => panic!("durable Launching and native resume"),
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        wait_for_activation_probe_http_status(
            ports[0],
            Some(ACTIVATION_HTTP_TOKEN),
            &format!("{LOOPBACK_HOST}:{}", ports[0]),
            200,
            false,
        );
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("clock failure must retain Launching owner"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Validation
        );
        assert!(
            failure.detail_for_test().contains("producer clock failed"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_admission_honors_deadline_and_cancellation_while_lock_is_held() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, mut launching) =
            launch_http_owner_for_test(directory.path(), &ports);
        let (reached_sender, reached_receiver) = sync_channel(1);
        let (acquired_sender, acquired_receiver) = sync_channel(1);
        launching.coordinate_running_admission_for_test(reached_sender, acquired_receiver);
        let contention = Arc::new(AtomicBool::new(false));
        plan.context
            .store
            .set_running_lock_deadline_after_contention_for_test(Arc::clone(&contention));
        let holder_active = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let (release_done_sender, release_done_receiver) = sync_channel(1);
        let contention_signal = Arc::clone(&contention);
        let holder_active_signal = Arc::clone(&holder_active);
        let release_signal = Arc::clone(&release);
        let lock_store = Arc::clone(&plan.context.store);
        let holder = std::thread::spawn(move || {
            if reached_receiver
                .recv_timeout(Duration::from_secs(5))
                .is_err()
            {
                let _ = release_done_sender.send(false);
                return;
            }
            let lock = match lock_store.lock_for_test() {
                Ok(lock) => lock,
                Err(_) => {
                    let _ = release_done_sender.send(false);
                    return;
                }
            };
            holder_active_signal.store(true, Ordering::Release);
            if acquired_sender.send(()).is_err() {
                drop(lock);
                holder_active_signal.store(false, Ordering::Release);
                let _ = release_done_sender.send(false);
                return;
            }
            let wait_deadline = Instant::now() + Duration::from_secs(5);
            while !contention_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
                thread::yield_now();
            }
            while !release_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
                thread::yield_now();
            }
            let released_by_test = release_signal.load(Ordering::Acquire);
            drop(lock);
            holder_active_signal.store(false, Ordering::Release);
            let _ = release_done_sender.send(released_by_test);
        });
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("expired admission must retain the Launching owner"),
            Err(failure) => failure,
        };
        let attempted = contention.load(Ordering::Acquire);
        let owner_was_held = holder_active.load(Ordering::Acquire);
        release.store(true, Ordering::Release);
        let released_by_test = release_done_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("lock holder release rendezvous");
        holder.join().expect("lock holder cleanup");
        plan.context
            .store
            .set_running_lock_contention_signal_for_test(None);
        assert!(attempted, "admission never observed ERROR_LOCK_VIOLATION");
        assert!(owner_was_held, "admission contention lacked a live holder");
        assert!(
            !holder_active.load(Ordering::Acquire),
            "lock holder did not release"
        );
        assert!(
            released_by_test,
            "lock holder used its timeout fallback instead of the test release"
        );
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Deadline
        );
        assert!(
            failure.detail_for_test().contains("AdmissionDeadline"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());

        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, mut launching) =
            launch_http_owner_for_test(directory.path(), &ports);
        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_signal = Arc::clone(&cancellation);
        let (reached_sender, reached_receiver) = sync_channel(1);
        let (acquired_sender, acquired_receiver) = sync_channel(1);
        launching.coordinate_running_admission_for_test(reached_sender, acquired_receiver);
        let contention = Arc::new(AtomicBool::new(false));
        plan.context
            .store
            .set_running_lock_contention_signal_for_test(Some(Arc::clone(&contention)));
        let holder_active = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let (release_done_sender, release_done_receiver) = sync_channel(1);
        let contention_signal = Arc::clone(&contention);
        let holder_active_signal = Arc::clone(&holder_active);
        let release_signal = Arc::clone(&release);
        let lock_store = Arc::clone(&plan.context.store);
        let cancel = std::thread::spawn(move || {
            if reached_receiver
                .recv_timeout(Duration::from_secs(5))
                .is_err()
            {
                let _ = release_done_sender.send(false);
                return;
            }
            let lock = match lock_store.lock_for_test() {
                Ok(lock) => lock,
                Err(_) => {
                    let _ = release_done_sender.send(false);
                    return;
                }
            };
            holder_active_signal.store(true, Ordering::Release);
            if acquired_sender.send(()).is_err() {
                drop(lock);
                holder_active_signal.store(false, Ordering::Release);
                let _ = release_done_sender.send(false);
                return;
            }
            let wait_deadline = Instant::now() + Duration::from_secs(5);
            while !contention_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
                thread::yield_now();
            }
            cancellation_signal.store(true, Ordering::Release);
            while !release_signal.load(Ordering::Acquire) && Instant::now() < wait_deadline {
                thread::yield_now();
            }
            let released_by_test = release_signal.load(Ordering::Acquire);
            drop(lock);
            holder_active_signal.store(false, Ordering::Release);
            let _ = release_done_sender.send(released_by_test);
        });
        let failure = match launching.promote_running_with_cancellation(
            Instant::now() + Duration::from_secs(5),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("cancelled admission must retain the Launching owner"),
            Err(failure) => failure,
        };
        let attempted = contention.load(Ordering::Acquire);
        let owner_was_held = holder_active.load(Ordering::Acquire);
        release.store(true, Ordering::Release);
        let released_by_test = release_done_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("cancellation holder release rendezvous");
        cancel.join().expect("cancellation holder cleanup");
        plan.context
            .store
            .set_running_lock_contention_signal_for_test(None);
        assert!(attempted, "admission never observed ERROR_LOCK_VIOLATION");
        assert!(owner_was_held, "admission contention lacked a live holder");
        assert!(
            !holder_active.load(Ordering::Acquire),
            "lock holder did not release"
        );
        assert!(
            released_by_test,
            "lock holder used its timeout fallback instead of the test release"
        );
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Cancelled
        );
        assert!(
            failure.detail_for_test().contains("AdmissionCancelled"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_post_cas_cancellation_keeps_owner_without_issuing_running_authority() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, launching) = launch_http_owner_for_test(directory.path(), &ports);
        let cancellation = Arc::new(AtomicBool::new(false));
        plan.context
            .store
            .cancel_after_running_replace_for_test(Arc::clone(&cancellation));
        let failure = match launching.promote_running_with_cancellation(
            Instant::now() + Duration::from_secs(5),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("post-CAS cancellation must not issue Running authority"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Cancelled,
            "{}",
            failure.detail_for_test()
        );
        assert!(failure
            .detail_for_test()
            .contains("completed after cancellation"));
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Running
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("ambiguous post-CAS owner retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_pre_cas_cancellation_under_lock_keeps_launching_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, launching) = launch_http_owner_for_test(directory.path(), &ports);
        let cancellation = Arc::new(AtomicBool::new(false));
        plan.context
            .store
            .cancel_before_running_replace_for_test(Arc::clone(&cancellation));
        let failure = match launching.promote_running_with_cancellation(
            Instant::now() + Duration::from_secs(5),
            Some(Arc::clone(&cancellation)),
        ) {
            Ok(_) => panic!("pre-CAS cancellation must not issue Running authority"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Cancelled
        );
        assert!(
            failure.detail_for_test().contains("AdmissionCancelled"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("pre-CAS cancellation retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_final_native_observation_change_retains_launching_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, mut launching) =
            launch_http_owner_for_test(directory.path(), &ports);
        launching.inject_listener_identity_mutation_after_first_for_test();
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("changed final listener observation must fail closed"),
            Err(failure) => failure,
        };
        assert!(
            failure
                .detail_for_test()
                .contains("native root binding changed"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_last_native_observation_change_retains_launching_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, mut launching) =
            launch_http_owner_for_test(directory.path(), &ports);
        launching.inject_listener_identity_mutation_at_last_observation_for_test();
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("the last native observation must guard the Running CAS"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Validation
        );
        assert!(
            failure
                .detail_for_test()
                .contains("native root binding changed during Running promotion"),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(launching.listener_observation_count_for_test(), 3);
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("last observation failure retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn running_final_root_exit_retains_launching_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (reservations, ports) = held_distinct_loopback_ports(1);
        drop(reservations);
        let (plan, _marker_paths, mut launching) =
            launch_http_owner_for_test(directory.path(), &ports);
        launching.inject_root_exit_after_first_for_test();
        let failure = match launching
            .promote_running_with_cancellation(Instant::now() + Duration::from_secs(5), None)
        {
            Ok(_) => panic!("root exit during final observation must fail closed"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.kind_for_test(),
            crate::process::RunningPromotionFailureKind::Validation
        );
        assert!(
            failure
                .detail_for_test()
                .contains("Runtime root 0 was no longer live during listener observation."),
            "{}",
            failure.detail_for_test()
        );
        let launching = failure.into_owner();
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::Launching
        );
        let cleanup = launching
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn activation_probe_root_n_resume_failure_keeps_prior_marker_and_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, marker_paths) =
            activation_probe_test_descriptor(directory.path(), &[42167_u16, 42168_u16]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let mut ready = ready;
        ready.inject_resume_failure_at_for_test(1);

        let failure = match ready.launch_with_cancellation(None) {
            Ok(_) => panic!("root N resume failure"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Launching owner retained") {
            crate::process::ActivationLaunchOwner::Launching(owner) => owner,
            crate::process::ActivationLaunchOwner::Ready(_) => {
                panic!("root N resume failure occurs after durable Launching")
            }
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        assert_eq!(journal.state, crate::journal::JournalState::Launching);
        wait_for_activation_probe_marker(
            &marker_paths[0],
            0,
            journal.roots[0].pid,
            journal.journal_revision,
        );
        assert!(!marker_paths[1].exists(), "root N must remain suspended");
        assert_eq!(owner.native_root_count_for_test(), Some(2));
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("partial Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_cancellation_before_cas_retains_ready_owner_without_resume() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42158]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let cancellation = AtomicBool::new(true);

        let failure = match ready.launch_with_cancellation(Some(&cancellation)) {
            Ok(_) => panic!("pre-CAS cancellation"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Ready owner retained") {
            crate::process::ActivationLaunchOwner::Ready(owner) => owner,
            crate::process::ActivationLaunchOwner::Launching(_) => {
                panic!("pre-CAS cancellation cannot produce Launching ownership")
            }
        };
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("Ready journal")
                .state,
            crate::journal::JournalState::Ready
        );
        let mut owner = owner;
        assert!(owner.native_is_suspended_for_test());
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("Ready cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_cancellation_after_cas_retains_launching_owner_without_resume() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42159]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let cancellation = AtomicBool::new(false);
        crate::process::inject_cancellation_after_launching_cas_for_test();

        let failure = match ready.launch_with_cancellation(Some(&cancellation)) {
            Ok(_) => panic!("post-CAS cancellation"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Launching owner retained") {
            crate::process::ActivationLaunchOwner::Launching(owner) => owner,
            crate::process::ActivationLaunchOwner::Ready(_) => {
                panic!("post-CAS cancellation must retain the Launching snapshot")
            }
        };
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("Launching journal");
        assert_eq!(journal.state, crate::journal::JournalState::Launching);
        assert_eq!(owner.launching_journal_for_test(), &journal);
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_cancellation_before_root_n_retains_the_partial_native_owner() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42161, 42162]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let cancellation = AtomicBool::new(false);
        crate::process::inject_cancellation_before_resume_root_for_test(1);

        let failure = match ready.launch_with_cancellation(Some(&cancellation)) {
            Ok(_) => panic!("mid-group cancellation"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Launching owner retained") {
            crate::process::ActivationLaunchOwner::Launching(owner) => owner,
            crate::process::ActivationLaunchOwner::Ready(_) => {
                panic!("mid-group cancellation occurs after the Launching CAS")
            }
        };
        assert_eq!(owner.native_root_count_for_test(), Some(2));
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("Launching journal")
                .state,
            crate::journal::JournalState::Launching
        );
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("partial Launching cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_durability_failure_never_upgrades_from_disk_to_resume() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42160]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        plan.context
            .store
            .fail_after_replace_and_durability_recheck();

        let failure = match ready.launch_with_cancellation(None) {
            Ok(_) => panic!("ambiguous Launching write must not resume"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Ready owner retained") {
            crate::process::ActivationLaunchOwner::Ready(owner) => owner,
            crate::process::ActivationLaunchOwner::Launching(_) => {
                panic!("ambiguous CAS cannot issue a Launching owner")
            }
        };
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("candidate journal")
                .state,
            crate::journal::JournalState::Launching
        );
        let mut owner = owner;
        assert!(owner.native_is_suspended_for_test());
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("Ready cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_clock_failure_retains_ready_owner_and_journal() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42163]);
        let plan = build_activation_plan_with_clock(
            descriptor,
            [
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Ok("2026-01-01T00:00:01Z".into()),
                Err(crate::prepare::PrepareError::JournalUnavailable),
            ],
        );
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let failure = match ready.launch_with_cancellation(None) {
            Ok(_) => panic!("Launching clock failure"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Ready owner retained") {
            crate::process::ActivationLaunchOwner::Ready(owner) => owner,
            crate::process::ActivationLaunchOwner::Launching(_) => {
                panic!("clock failure precedes the Launching CAS")
            }
        };
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("Ready journal")
                .state,
            crate::journal::JournalState::Ready
        );
        let mut owner = owner;
        assert!(owner.native_is_suspended_for_test());
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("Ready cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_revalidation_rejects_staging_drift_before_cas() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42164]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let marker_path = group_path.join(".capture-run-staging-v1");
        let marker = fs::read(&marker_path).expect("owned marker");
        fs::write(&marker_path, b"foreign marker after Ready").expect("mutate marker");

        let failure = match ready.launch_with_cancellation(None) {
            Ok(_) => panic!("staging drift before Launching CAS"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Ready owner retained") {
            crate::process::ActivationLaunchOwner::Ready(owner) => owner,
            crate::process::ActivationLaunchOwner::Launching(_) => {
                panic!("staging drift must stop before Launching CAS")
            }
        };
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("Ready journal")
                .state,
            crate::journal::JournalState::Ready
        );
        fs::write(&marker_path, marker).expect("restore marker");
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("Ready cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn launching_revalidation_rejects_native_identity_drift_before_cas() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42169]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let ready = owner.persist_ready().expect("durable Ready");
        let mut ready = ready;
        ready.inject_native_membership_failure_for_test();

        let failure = match ready.launch_with_cancellation(None) {
            Ok(_) => panic!("native membership drift before Launching CAS"),
            Err(failure) => failure,
        };
        let owner = match failure.into_owner().expect("Ready owner retained") {
            crate::process::ActivationLaunchOwner::Ready(owner) => owner,
            crate::process::ActivationLaunchOwner::Launching(_) => {
                panic!("native drift must stop before Launching CAS")
            }
        };
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("Ready journal")
                .state,
            crate::journal::JournalState::Ready
        );
        let cleanup = owner
            .cleanup_without_terminal_proof()
            .expect_err("Ready cleanup retains staging for reconciliation");
        assert!(cleanup.into_owner().native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn ready_cas_durability_error_retains_suspended_owner_without_resume() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42149]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        plan.context
            .store
            .fail_after_replace_and_durability_recheck();

        let failure = match owner.persist_ready() {
            Ok(_) => panic!("durability failure must not issue Ready owner"),
            Err(failure) => failure,
        };
        let mut owner = failure.into_owner().expect("native owner retained");
        assert_eq!(owner.native_root_count_for_test(), Some(1));
        assert!(owner.native_is_suspended_for_test());
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("candidate remains a valid journal");
        assert_eq!(journal.state, crate::journal::JournalState::Ready);

        let cleanup_failure = owner
            .cleanup()
            .expect_err("ambiguous Ready write retains staging for reconciliation");
        let owner = cleanup_failure.into_owner();
        assert_eq!(owner.native_root_count_for_test(), None);
        assert!(group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn ready_cas_post_replace_readback_recovery_returns_exact_owner_snapshot() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42154]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        plan.context.store.fail_next_after_replace_before_flush();

        let mut ready = owner
            .persist_ready()
            .expect("exact Ready readback should recover post-replace failure");
        let journal = plan.context.store.read(&plan.value).expect("Ready journal");
        assert_eq!(journal.state, crate::journal::JournalState::Ready);
        assert_eq!(ready.ready_journal_for_test(), &journal);
        assert_eq!(ready.native_root_count_for_test(), Some(1));
        assert!(ready.native_is_suspended_for_test());
        let cleanup_failure = ready
            .cleanup_without_terminal_proof()
            .expect_err("Ready cleanup retains the staging owner");
        assert!(cleanup_failure
            .into_owner()
            .native_cleanup_proven_for_test());
    }

    #[cfg(windows)]
    #[test]
    fn ready_revalidation_rejects_index_mutation_after_native_acquisition() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42150]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");

        let index_path = fs::read_dir(directory.path())
            .expect("producer root")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("runtime-ref-index-v1-") && name.ends_with(".json")
                    })
            })
            .expect("address index");
        fs::remove_file(index_path).expect("remove index after native acquisition");

        let failure = match owner.persist_ready() {
            Ok(_) => panic!("index mutation must block durable Ready"),
            Err(failure) => failure,
        };
        let mut owner = failure.into_owner().expect("owner retained");
        assert_eq!(owner.native_root_count_for_test(), Some(1));
        assert!(owner.native_is_suspended_for_test());
        let journal = plan
            .context
            .store
            .read(&plan.value)
            .expect("prepared journal");
        assert_eq!(journal.state, crate::journal::JournalState::PreparedBound);
        assert!(group_path.exists());

        owner.cleanup().expect("cleanup retained owner");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    fn assert_ready_clock_failure(
        values: impl IntoIterator<Item = Result<String, crate::prepare::PrepareError>>,
    ) {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42151]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan_with_clock(descriptor, values);
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let failure = match owner.persist_ready() {
            Ok(_) => panic!("clock failure must block durable Ready"),
            Err(failure) => failure,
        };
        let mut owner = failure.into_owner().expect("owner retained");
        assert_eq!(owner.native_root_count_for_test(), Some(1));
        assert!(owner.native_is_suspended_for_test());
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::PreparedBound
        );
        owner.cleanup().expect("cleanup after clock failure");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn ready_clock_failure_and_backward_time_retain_suspended_owner() {
        assert_ready_clock_failure([
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:02Z".into()),
            Err(crate::prepare::PrepareError::JournalUnavailable),
        ]);
        assert_ready_clock_failure([
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:02Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
        ]);
    }

    #[cfg(windows)]
    #[test]
    fn ready_revalidation_rejects_staging_drift_after_native_acquisition() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42152]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        let marker_path = group_path.join(".capture-run-staging-v1");
        let marker = fs::read(&marker_path).expect("owned marker");
        fs::write(&marker_path, b"foreign-marker-after-acquisition")
            .expect("mutate marker after acquisition");

        let failure = match owner.persist_ready() {
            Ok(_) => panic!("staging drift must block durable Ready"),
            Err(failure) => failure,
        };
        let mut owner = failure.into_owner().expect("owner retained");
        assert_eq!(owner.native_root_count_for_test(), Some(1));
        assert!(owner.native_is_suspended_for_test());
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::PreparedBound
        );
        fs::write(&marker_path, marker).expect("restore owned marker");
        owner.cleanup().expect("cleanup after staging drift");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn ready_stale_cas_retains_suspended_owner_without_mutation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42153]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        owner.inject_journal_drift_before_ready_for_test();

        let failure = match owner.persist_ready() {
            Ok(_) => panic!("stale CAS must block durable Ready"),
            Err(failure) => failure,
        };
        let mut owner = failure.into_owner().expect("owner retained");
        assert_eq!(owner.native_root_count_for_test(), Some(1));
        assert!(owner.native_is_suspended_for_test());
        assert_eq!(
            plan.context.store.read(&plan.value).expect("journal").state,
            crate::journal::JournalState::ReconcileRequired
        );
        assert!(group_path.exists());
        let cleanup_failure = owner
            .cleanup()
            .expect_err("changed journal retains staging after native cleanup");
        let owner = cleanup_failure.into_owner();
        assert_eq!(owner.native_root_count_for_test(), None);
        assert!(group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn native_cleanup_failure_keeps_staging_until_native_retry_succeeds() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42138, 42139]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let mut owner =
            crate::process::acquire_suspended_for_activation(activation).expect("suspended owner");
        owner.inject_native_cleanup_failure_for_test();

        let cleanup_failure = owner
            .cleanup()
            .expect_err("native cleanup failure must retain both owners");
        let owner = cleanup_failure.into_owner();
        assert_eq!(owner.native_root_count_for_test(), Some(2));
        assert!(!owner.native_cleanup_proven_for_test());
        assert!(group_path.exists());

        owner.cleanup().expect("native retry then staging cleanup");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn all_root_artifact_preflight_fails_before_staging_ownership() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, executable_path) =
            real_activation_test_descriptor(directory.path(), &[42133, 42134]);
        let group_path = descriptor.planned_group_staging_path();
        let shared_path = group_path
            .parent()
            .expect("shared staging parent")
            .to_path_buf();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let mut bytes = fs::read(&executable_path).expect("fixture bytes");
        bytes[0] ^= 0xff;
        fs::write(&executable_path, bytes).expect("tamper fixture");
        let activation = prepared
            .consume_for_activation()
            .expect("journal binding remains valid");

        let failure = crate::staging::materialize(activation);
        assert!(matches!(
            failure,
            Err(crate::staging::StagingFailure::BeforeOwnership(
                crate::staging::StagingFailureKind::InvalidActivation
            ))
        ));
        assert!(!group_path.exists());
        assert!(!shared_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn post_staging_artifact_drift_keeps_staging_owner_without_a_job() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, executable_path) =
            real_activation_test_descriptor(directory.path(), &[42135, 42136]);
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let staging = crate::staging::materialize(activation).expect("staging owner");
        let mut bytes = fs::read(&executable_path).expect("fixture bytes");
        bytes[0] ^= 0xff;
        fs::write(&executable_path, bytes).expect("tamper fixture");

        let owner = match crate::process::acquire_suspended_from_staging(staging) {
            Ok(_) => panic!("artifact drift must stop before Job setup"),
            Err(failure) => failure
                .into_owner()
                .expect("staging owner after materialization"),
        };
        assert_eq!(owner.native_root_count_for_test(), None);
        owner
            .cleanup()
            .expect("unchanged prepared journal permits staging cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn partial_marker_owner_is_rejected_before_native_job_setup() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42141]);
        crate::staging::fail_next_marker_flush_for_test();

        let staging = match crate::staging::materialize(activation) {
            Err(crate::staging::StagingFailure::Owned { owner, .. }) => owner,
            _ => panic!("expected partial marker owner"),
        };
        let owner = match crate::process::acquire_suspended_from_staging(staging) {
            Ok(_) => panic!("partial marker scope must stop before Job setup"),
            Err(failure) => failure
                .into_owner()
                .expect("partial staging owner retained"),
        };
        assert_eq!(owner.native_root_count_for_test(), None);
        owner.cleanup().expect("partial marker owner cleanup");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn partial_root_owner_is_rejected_before_native_job_setup() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42142, 42143]);
        crate::staging::fail_next_root_mkdir_for_test(1);

        let staging = match crate::staging::materialize(activation) {
            Err(crate::staging::StagingFailure::Owned { owner, .. }) => owner,
            _ => panic!("expected partial root owner"),
        };
        let owner = match crate::process::acquire_suspended_from_staging(staging) {
            Ok(_) => panic!("partial root scope must stop before Job setup"),
            Err(failure) => failure
                .into_owner()
                .expect("partial staging owner retained"),
        };
        assert_eq!(owner.native_root_count_for_test(), None);
        owner.cleanup().expect("partial root owner cleanup");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn released_staging_owner_is_rejected_before_native_job_setup() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42144]);
        let mut staging = crate::staging::materialize(activation).expect("staging owner");
        staging
            .cleanup_pre_native()
            .expect("first cleanup releases staging owner");
        assert!(!group_path.exists());

        let owner = match crate::process::acquire_suspended_from_staging(staging) {
            Ok(_) => panic!("released scope must stop before Job setup"),
            Err(failure) => failure
                .into_owner()
                .expect("released staging owner retained"),
        };
        assert_eq!(owner.native_root_count_for_test(), None);
    }

    #[cfg(windows)]
    #[test]
    fn foreign_staging_scope_is_rejected_before_native_job_setup() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42145]);
        let staging = crate::staging::materialize(activation).expect("staging owner");
        let foreign = group_path.join("foreign.txt");
        fs::write(&foreign, b"preserve").expect("foreign entry");

        let owner = match crate::process::acquire_suspended_from_staging(staging) {
            Ok(_) => panic!("foreign scope must stop before Job setup"),
            Err(failure) => failure
                .into_owner()
                .expect("foreign staging owner retained"),
        };
        assert_eq!(owner.native_root_count_for_test(), None);
        assert_eq!(
            fs::read(&foreign).expect("foreign entry retained"),
            b"preserve"
        );
    }

    #[cfg(windows)]
    #[test]
    fn journal_drift_at_root_n_keeps_native_owner_and_runs_native_cleanup_first() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (descriptor, _) = real_activation_test_descriptor(directory.path(), &[42137, 42140]);
        let group_path = descriptor.planned_group_staging_path();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        let activation = prepared
            .consume_for_activation()
            .expect("validated activation context");
        let staging = crate::staging::materialize(activation).expect("staging owner");
        staging
            .inject_journal_drift_before_root_for_test(1)
            .expect("journal drift injection");

        let owner = match crate::process::acquire_suspended_from_staging(staging) {
            Ok(_) => panic!("changed journal must stop before root spawn"),
            Err(failure) => failure.into_owner().expect("owner after Job setup"),
        };
        assert_eq!(owner.native_root_count_for_test(), Some(1));
        let cleanup_failure = owner
            .cleanup()
            .expect_err("changed journal must retain staging after native cleanup");
        let owner = cleanup_failure.into_owner();
        assert_eq!(owner.native_root_count_for_test(), None);
        assert!(owner.native_cleanup_proven_for_test());
        assert!(group_path.exists());
    }

    #[cfg(windows)]
    fn prepared_activation_for_staging(
        producer_root: &Path,
        executable_path: &Path,
        ports: &[u16],
    ) -> (
        crate::prepare::ValidatedActivationContext,
        PathBuf,
        Vec<PathBuf>,
    ) {
        let descriptor = activation_test_descriptor(producer_root, executable_path, ports);
        let group_path = descriptor.planned_group_staging_path();
        let root_paths = descriptor
            .planned_root_staging_paths()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        let plan = build_activation_plan(descriptor).expect("activation plan");
        let sink = DescriptorSink {
            binding: Mutex::new(None),
            fail_persist: false,
            persist_calls: AtomicUsize::new(0),
        };
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared group");
        (
            prepared
                .consume_for_activation()
                .expect("validated activation context"),
            group_path,
            root_paths,
        )
    }

    #[cfg(windows)]
    #[test]
    fn staging_materialization_owns_marker_and_ordered_empty_roots() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, root_paths) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42123, 42124]);

        let mut owner = crate::staging::materialize(activation).expect("staging owner");
        assert!(group_path.is_dir());
        for (ordinal, path) in root_paths.iter().enumerate() {
            assert_eq!(
                path.file_name().and_then(|name| name.to_str()),
                Some(format!("root-{ordinal:08}").as_str())
            );
            assert!(path.is_dir());
        }
        let marker_path = group_path.join(".capture-run-staging-v1");
        let marker = fs::read(&marker_path).expect("marker");
        assert!(marker.starts_with(b"{\"schemaVersion\":\"RunStagingMarkerV1\""));
        assert!(!marker
            .windows(b"secret-token".len())
            .any(|window| window == b"secret-token"));
        owner.cleanup_pre_native().expect("empty scope cleanup");
        assert!(!group_path.exists());
        assert!(!root_paths[0].exists());
        assert!(executable_path.exists());
        assert!(group_path.parent().expect("shared parent").exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_group_collision_is_rejected_before_owned_mutation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42125]);
        fs::create_dir_all(&group_path).expect("foreign group");
        fs::write(group_path.join("foreign.txt"), b"keep").expect("foreign entry");

        assert!(matches!(
            crate::staging::materialize(activation),
            Err(crate::staging::StagingFailure::BeforeOwnership(_))
        ));
        assert_eq!(fs::read(group_path.join("foreign.txt")).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn staging_cleanup_preflights_foreign_entries_and_allows_retry() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42126]);
        let mut owner = crate::staging::materialize(activation).expect("staging owner");
        let foreign = group_path.join("runtime.crash");
        fs::write(&foreign, b"preserve").expect("foreign entry");

        assert!(matches!(
            owner.cleanup_pre_native(),
            Err(crate::staging::StagingCleanupError::ForeignEntry)
        ));
        assert_eq!(fs::read(&foreign).unwrap(), b"preserve");
        fs::remove_file(&foreign).expect("remove test entry");
        owner.cleanup_pre_native().expect("retry cleanup");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_cleanup_rejects_replaced_shared_ancestor_without_deleting() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42126]);
        let mut owner = crate::staging::materialize(activation).expect("staging owner");
        let shared_parent = group_path.parent().expect("shared parent").to_path_buf();
        let moved_parent = shared_parent.with_extension("moved");
        fs::rename(&shared_parent, &moved_parent).expect("move owned parent");
        fs::create_dir(&shared_parent).expect("foreign replacement");

        assert!(matches!(
            owner.cleanup_pre_native(),
            Err(crate::staging::StagingCleanupError::Reparse)
        ));
        assert!(moved_parent.join(group_path.file_name().unwrap()).exists());
        assert!(shared_parent.exists());
        fs::remove_dir(&shared_parent).expect("remove replacement");
        fs::rename(&moved_parent, &shared_parent).expect("restore owned parent");
        owner.cleanup_pre_native().expect("retry cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn staging_cleanup_rejects_directory_identity_replacement() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, root_paths) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42127]);
        let mut owner = crate::staging::materialize(activation).expect("staging owner");
        let original = root_paths[0].with_extension("original");
        fs::rename(&root_paths[0], &original).expect("move owned root");
        fs::create_dir(&root_paths[0]).expect("foreign replacement");

        assert!(matches!(
            owner.cleanup_pre_native(),
            Err(crate::staging::StagingCleanupError::IdentityChanged)
        ));
        assert!(root_paths[0].exists());
        fs::remove_dir(&root_paths[0]).expect("remove replacement");
        fs::rename(&original, &root_paths[0]).expect("restore owned root");
        owner.cleanup_pre_native().expect("retry cleanup");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_marker_flush_failure_returns_an_owner_that_can_retry_cleanup() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42128]);
        crate::staging::fail_next_marker_flush_for_test();

        let mut owner = match crate::staging::materialize(activation) {
            Err(crate::staging::StagingFailure::Owned { owner, .. }) => owner,
            Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
                panic!("expected owned failure, got before ownership: {kind:?}")
            }
            Ok(_) => panic!("expected owned failure, got success"),
        };
        let marker_path = group_path.join(".capture-run-staging-v1");
        let marker = fs::read(&marker_path).expect("partial marker");
        fs::write(&marker_path, b"foreign-marker-bytes").expect("mutate marker");
        assert!(matches!(
            owner.cleanup_pre_native(),
            Err(crate::staging::StagingCleanupError::ForeignEntry)
        ));
        assert!(group_path.exists());
        fs::write(&marker_path, marker).expect("restore marker");
        owner
            .cleanup_pre_native()
            .expect("cleanup after marker failure");
        assert!(!group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_marker_readback_failure_does_not_adopt_foreign_bytes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42129]);
        crate::staging::fail_next_marker_readback_for_test();

        let mut owner = match crate::staging::materialize(activation) {
            Err(crate::staging::StagingFailure::Owned { owner, kind }) => {
                assert_eq!(kind, crate::staging::StagingFailureKind::MarkerReadBack);
                owner
            }
            Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
                panic!("expected owned failure, got before ownership: {kind:?}")
            }
            Ok(_) => panic!("expected failed marker read-back"),
        };
        let marker_path = group_path.join(".capture-run-staging-v1");
        assert_eq!(
            fs::read(&marker_path).expect("foreign marker"),
            b"foreign-marker-bytes"
        );
        assert!(matches!(
            owner.cleanup_pre_native(),
            Err(crate::staging::StagingCleanupError::ForeignEntry)
        ));
        assert!(group_path.exists());
        assert_eq!(
            fs::read(&marker_path).expect("foreign marker retained"),
            b"foreign-marker-bytes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn staging_partial_marker_write_retains_only_confirmed_bytes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, _) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42131]);
        crate::staging::fail_next_marker_partial_write_for_test();

        let mut owner = match crate::staging::materialize(activation) {
            Err(crate::staging::StagingFailure::Owned { owner, kind }) => {
                assert_eq!(kind, crate::staging::StagingFailureKind::Durability);
                owner
            }
            Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
                panic!("expected owned failure, got before ownership: {kind:?}")
            }
            Ok(_) => panic!("expected partial marker write failure"),
        };
        let marker_path = group_path.join(".capture-run-staging-v1");
        let confirmed_prefix = fs::read(&marker_path).expect("partial marker");
        assert!(!confirmed_prefix.is_empty());
        assert!(!confirmed_prefix
            .windows(b"foreign-marker-bytes".len())
            .any(|window| window == b"foreign-marker-bytes"));
        let mut foreign_marker = confirmed_prefix.clone();
        foreign_marker.extend_from_slice(b"foreign-marker-bytes");
        fs::write(&marker_path, foreign_marker).expect("mutate partial marker");
        assert!(matches!(
            owner.cleanup_pre_native(),
            Err(crate::staging::StagingCleanupError::ForeignEntry)
        ));
        assert!(group_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_partial_root_failure_returns_an_owner_with_prior_roots() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        fs::write(&executable_path, b"runtime").expect("executable");
        let (activation, group_path, root_paths) =
            prepared_activation_for_staging(directory.path(), &executable_path, &[42129, 42130]);
        crate::staging::fail_next_root_mkdir_for_test(1);

        let mut owner = match crate::staging::materialize(activation) {
            Err(crate::staging::StagingFailure::Owned { owner, .. }) => owner,
            Err(crate::staging::StagingFailure::BeforeOwnership(kind)) => {
                panic!("expected owned failure, got before ownership: {kind:?}")
            }
            Ok(_) => panic!("expected owned failure, got success"),
        };
        assert!(root_paths[0].is_dir());
        assert!(!root_paths[1].exists());
        owner.cleanup_pre_native().expect("cleanup partial scope");
        assert!(!group_path.exists());
    }
}
