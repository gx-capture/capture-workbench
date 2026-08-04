use std::{fs, path::PathBuf, sync::atomic::AtomicBool};

use capture_sidecar_launcher::{
    launch_sidecar, verify_sidecar, LaunchOptions, ManifestExpectations, OwnedSidecarProcess,
    SidecarLaunchSpec,
};

use crate::{
    config::BackendConfig,
    constants::{
        CHILD_ENVIRONMENT_ALLOWLIST, EXPECTED_API_VERSION,
        EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION, EXPECTED_RUNTIME_VERSION,
        RUNTIME_BINARY_TARGET_FILE, SCHEMA_FILE_NAME,
    },
    launch_policy::{LaunchPolicy, LaunchPolicyFactory},
    resources::RuntimeAssets,
};

pub(crate) struct LaunchedRuntime {
    pub child: OwnedSidecarProcess,
    pub config: BackendConfig,
}

pub(crate) fn launch_runtime(
    assets: &RuntimeAssets,
    data_dir: PathBuf,
    stopping: &AtomicBool,
) -> Result<LaunchedRuntime, String> {
    let verified = verify_sidecar(
        &assets.manifest_path,
        &assets.executable_path,
        &ManifestExpectations {
            runtime_version: EXPECTED_RUNTIME_VERSION.into(),
            api_version: EXPECTED_API_VERSION.into(),
            capture_document_schema_version: EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
            file_name: RUNTIME_BINARY_TARGET_FILE.into(),
            schema_file_name: SCHEMA_FILE_NAME.into(),
        },
    )?;
    let mut policy_factory = LaunchPolicyFactory::new(data_dir);
    let launched = launch_sidecar(&verified, stopping, LaunchOptions::default(), |_, _| {
        let policy = policy_factory.next()?;
        prepare_isolated_directories(&policy)?;
        Ok(SidecarLaunchSpec::new(
            verified.executable_path.clone(),
            policy.runtime_port,
            policy.token.clone(),
            policy
                .environment()
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
            CHILD_ENVIRONMENT_ALLOWLIST
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        ))
    })?;

    Ok(LaunchedRuntime {
        child: launched.process,
        config: BackendConfig {
            base_url: launched.connection.base_url,
            token: launched.connection.token,
            runtime_version: launched.connection.runtime_version,
            api_version: launched.connection.api_version,
            capture_document_schema_version: launched.connection.capture_document_schema_version,
        },
    })
}

fn prepare_isolated_directories(policy: &LaunchPolicy) -> Result<(), String> {
    for path in [
        policy.runtime_data_dir(),
        policy.ollama_data_dir(),
        policy.ollama_models_dir(),
    ] {
        fs::create_dir_all(path).map_err(|error| {
            format!("Capture Workbench data directory could not be created: {error}")
        })?;
    }
    Ok(())
}
