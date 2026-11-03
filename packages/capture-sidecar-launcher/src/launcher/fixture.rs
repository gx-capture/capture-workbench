use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use super::command::digest_bytes;
use crate::{
    health::{CANONICAL_CAPTURE_DOCUMENT_V2_SHA256, R3_SCHEMA_FILE_NAME},
    manifest::VerifiedSidecar,
};

pub(super) fn manifest() -> crate::SidecarManifest {
    crate::SidecarManifest {
        manifest_version: "1".into(),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
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

pub(super) fn verified(executable_path: PathBuf) -> VerifiedSidecar {
    VerifiedSidecar {
        manifest: manifest(),
        executable_path,
    }
}

pub(super) fn write_canonical_readiness_manifest(
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

pub(super) fn token_environment(token: &str) -> Vec<(String, String)> {
    vec![("CAPTURE_API_TOKEN".into(), token.into())]
}

pub(super) fn command_environment(command: &Command) -> BTreeMap<String, String> {
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
