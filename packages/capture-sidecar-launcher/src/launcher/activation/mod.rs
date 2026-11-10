use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    fmt::Write as _,
    path::{Path, PathBuf},
    process::Command,
};

use rand::{rngs::OsRng, RngCore};

use super::command::{
    append_bytes, digest_bytes, environment_key,
    freeze_launch_command_from_environment_with_schema, validate_frozen_launch_inputs,
    FrozenLaunchCommand,
};
use super::readiness::{
    append_readiness_context_identity, load_bounded_manifest, FrozenReadinessContext,
};
use super::spec::SidecarLaunchSpec;
use crate::{
    health::R3_SCHEMA_FILE_NAME,
    manifest::{
        validate_manifest_contract, ManifestExpectations, SidecarManifest, VerifiedSidecar,
    },
};

/// Inputs for one ordered root in an immutable group plan.
///
/// Consumed by [`build_immutable_group_plan`]. There are no public accessors.
/// The executable, manifest path, environment, and bearer token are frozen
/// into the plan and are not returned on a lifecycle receipt. Constructing
/// this value does not read those paths.
pub struct GroupRootPlanInput {
    role: String,
    root_generation: u64,
    launch: SidecarLaunchSpec,
    manifest_path: PathBuf,
}

impl GroupRootPlanInput {
    /// Stores one root's role, generation, launch spec, and manifest path.
    ///
    /// The position of this value in the vector passed to
    /// [`build_immutable_group_plan`] is the root's ordinal. This function
    /// does not check the role, generation, port, token, or files.
    pub fn new(
        role: String,
        root_generation: u64,
        launch: SidecarLaunchSpec,
        manifest_path: PathBuf,
    ) -> Self {
        Self {
            role,
            root_generation,
            launch,
            manifest_path,
        }
    }
}

/// Verifies each root and builds an in-memory plan for [`crate::OwnedRuntimeSession::prepare_group`].
///
/// `roots` must be non-empty and `group_generation` must be non-zero. Vector
/// order is the root order. For every root this reads the manifest, checks
/// the executable's length and SHA-256, and checks the readiness schema file
/// beside the manifest against the manifest digest and the canonical schema
/// digest. Ports must be distinct and non-zero. The bearer token is kept in
/// the plan's private launch command. It is not placed in the returned plan's
/// public values, and this function does not write it.
///
/// `producer_root` must be an existing absolute directory and must not be a
/// reparse point. The call reads files and generates identifiers. It does not
/// create a staging directory, listener, process, journal file, or model
/// resource.
///
/// # Errors
///
/// Returns [`PrepareError::InvalidPlan`](crate::PrepareError::InvalidPlan)
/// when the generation, roots, manifest, executable digest, schema, ports, or
/// producer directory fail the checks above.
/// Returns [`PrepareError::ReferenceGeneration`](crate::PrepareError::ReferenceGeneration)
/// when the operating-system generator cannot supply a session or address
/// identifier.
/// Returns [`PrepareError::JournalUnavailable`](crate::PrepareError::JournalUnavailable)
/// when the journal store cannot be constructed, including on targets other
/// than Windows.
pub fn build_immutable_group_plan(
    producer_root: PathBuf,
    group_generation: u64,
    roots: Vec<GroupRootPlanInput>,
) -> Result<crate::prepare::ImmutableGroupPlan, crate::prepare::PrepareError> {
    if roots.is_empty() || group_generation == 0 {
        return Err(crate::prepare::PrepareError::InvalidPlan);
    }

    let session_nonce =
        fresh_private_nonce().map_err(|_| crate::prepare::PrepareError::ReferenceGeneration)?;
    let activation_roots = roots
        .into_iter()
        .enumerate()
        .map(|(ordinal, input)| public_activation_root(ordinal as u32, input))
        .collect::<Result<Vec<_>, _>>()?;
    let descriptor = FrozenActivationDescriptor::from_activation_inputs(
        producer_root,
        session_nonce,
        group_generation,
        activation_roots,
    )
    .map_err(|_| crate::prepare::PrepareError::InvalidPlan)?;
    build_activation_plan(descriptor)
}

fn public_activation_root(
    ordinal: u32,
    input: GroupRootPlanInput,
) -> Result<ActivationRootInput, crate::prepare::PrepareError> {
    let GroupRootPlanInput {
        role,
        root_generation,
        launch,
        manifest_path,
    } = input;
    let manifest = load_bounded_manifest(&manifest_path)
        .map_err(|_| crate::prepare::PrepareError::InvalidPlan)?;
    let file_name = launch
        .executable_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(crate::prepare::PrepareError::InvalidPlan)?;
    let expected = ManifestExpectations {
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        api_version: "2.0".into(),
        capture_document_schema_version: "2".into(),
        file_name: file_name.to_owned(),
        schema_file_name: R3_SCHEMA_FILE_NAME.into(),
    };
    validate_manifest_contract(&manifest, &expected)
        .map_err(|_| crate::prepare::PrepareError::InvalidPlan)?;
    let verified = VerifiedSidecar {
        manifest,
        executable_path: launch.executable_path.clone(),
    };
    validate_frozen_launch_inputs(&verified, &launch)
        .map_err(|_| crate::prepare::PrepareError::InvalidPlan)?;
    Ok(ActivationRootInput {
        ordinal,
        role,
        root_generation,
        verified,
        spec: launch,
        readiness_manifest_path: Some(manifest_path),
    })
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

struct ActivationRootInput {
    ordinal: u32,
    role: String,
    root_generation: u64,
    verified: VerifiedSidecar,
    spec: SidecarLaunchSpec,
    readiness_manifest_path: Option<PathBuf>,
}

struct FrozenActivationRoot {
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

    #[cfg(test)]
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
fn build_activation_plan(
    descriptor: FrozenActivationDescriptor,
) -> Result<crate::prepare::ImmutableGroupPlan, crate::prepare::PrepareError> {
    crate::prepare::build_immutable_group_plan_from_activation(std::sync::Arc::new(descriptor))
}

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

#[cfg(test)]
mod tests;
