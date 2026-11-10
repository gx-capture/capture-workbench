use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::constants::{EXPECTED_MANIFEST_VERSION, MAX_RUNTIME_ARTIFACT_BYTES};

/// The runtime manifest fields shared by desktop sidecar hosts.
///
/// JSON uses camelCase names and rejects unknown fields. Loading does not
/// hash the executable; [`verify_sidecar`] does that.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarManifest {
    /// Manifest contract version. The supported value is `"1"`.
    pub manifest_version: String,
    /// Runtime release the host expects to launch.
    pub runtime_version: String,
    /// HTTP API version the runtime reports when ready.
    pub api_version: String,
    /// Capture document schema version the runtime reports when ready.
    pub capture_document_schema_version: String,
    /// Operating system. The supported value is `"windows"`.
    pub platform: String,
    /// CPU architecture. The supported value is `"x86_64"`.
    pub arch: String,
    /// Executable file name only, with no directory separators.
    pub file_name: String,
    /// Executable length in bytes, from 1 through 536870912.
    pub bytes: u64,
    /// Lowercase SHA-256 hex digest of the executable bytes.
    pub sha256: String,
    /// Readiness schema file name only, with no directory separators.
    pub schema_file_name: String,
    /// Lowercase SHA-256 hex digest of the readiness schema bytes.
    pub schema_sha256: String,
}

/// Expected values supplied by the host product for one sidecar release.
///
/// [`validate_manifest_contract`] compares these strings for exact equality.
/// Platform, architecture, manifest version, digests, and byte length are
/// checked against fixed rules and are not fields of this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestExpectations {
    /// Expected `runtimeVersion`.
    pub runtime_version: String,
    /// Expected `apiVersion`.
    pub api_version: String,
    /// Expected `captureDocumentSchemaVersion`.
    pub capture_document_schema_version: String,
    /// Expected executable file name.
    pub file_name: String,
    /// Expected readiness schema file name.
    pub schema_file_name: String,
}

/// A manifest whose executable bytes matched `manifest.sha256`.
#[derive(Debug, Clone)]
pub struct VerifiedSidecar {
    /// Manifest that passed [`validate_manifest_contract`].
    pub manifest: SidecarManifest,
    /// Path whose regular-file length and SHA-256 matched `manifest`.
    pub executable_path: PathBuf,
}

/// Reads a sidecar manifest from `path` and parses it.
///
/// The file contents are not logged. This does not open the executable or
/// check digests.
///
/// # Errors
///
/// Returns `Err(String)` when the file cannot be read or the text is not the
/// manifest JSON object.
pub fn load_manifest(path: &Path) -> Result<SidecarManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Capture runtime manifest is unavailable at {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Capture runtime manifest is invalid JSON: {error}"))
}

/// Checks the manifest contract and the host's expected strings.
///
/// Requires manifest version `"1"`, platform `"windows"`, architecture
/// `"x86_64"`, plain file names, an executable length from 1 through
/// 536870912, and 64-character lowercase SHA-256 hex for the executable and
/// the schema. Does not read either file.
///
/// # Errors
///
/// Returns `Err(String)` when any required field disagrees or a digest or
/// file name is not in the form above.
pub fn validate_manifest_contract(
    manifest: &SidecarManifest,
    expected: &ManifestExpectations,
) -> Result<(), String> {
    expect_field(
        "manifestVersion",
        &manifest.manifest_version,
        EXPECTED_MANIFEST_VERSION,
    )?;
    expect_field(
        "runtimeVersion",
        &manifest.runtime_version,
        &expected.runtime_version,
    )?;
    expect_field("apiVersion", &manifest.api_version, &expected.api_version)?;
    expect_field(
        "captureDocumentSchemaVersion",
        &manifest.capture_document_schema_version,
        &expected.capture_document_schema_version,
    )?;
    expect_field("platform", &manifest.platform, "windows")?;
    expect_field("arch", &manifest.arch, "x86_64")?;
    expect_field("fileName", &manifest.file_name, &expected.file_name)?;
    expect_field(
        "schemaFileName",
        &manifest.schema_file_name,
        &expected.schema_file_name,
    )?;

    if !safe_file_name(&manifest.file_name) || !safe_file_name(&manifest.schema_file_name) {
        return Err("Capture runtime manifest file names must be plain file names.".into());
    }
    if !(1..=MAX_RUNTIME_ARTIFACT_BYTES).contains(&manifest.bytes) {
        return Err("Capture runtime executable bytes must be between 1 and 536870912.".into());
    }
    validate_sha256("sha256", &manifest.sha256)?;
    validate_sha256("schemaSha256", &manifest.schema_sha256)?;
    Ok(())
}

/// Loads the manifest, checks its contract, and hashes the executable.
///
/// Reads `manifest_path` and then the bytes at `executable_path`. The
/// executable must be a regular file whose length equals `bytes` and whose
/// SHA-256 matches `sha256`. No process is started and nothing is written.
///
/// # Errors
///
/// Returns `Err(String)` when the manifest cannot be loaded or fails
/// [`validate_manifest_contract`], when the executable is missing or not a
/// regular file, when its length differs, or when its digest differs.
pub fn verify_sidecar(
    manifest_path: &Path,
    executable_path: &Path,
    expected: &ManifestExpectations,
) -> Result<VerifiedSidecar, String> {
    let manifest = load_manifest(manifest_path)?;
    validate_manifest_contract(&manifest, expected)?;
    verify_artifact(executable_path, &manifest)?;
    Ok(VerifiedSidecar {
        manifest,
        executable_path: executable_path.to_path_buf(),
    })
}

fn expect_field(name: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime {name} is incompatible with the verified manifest."
        ))
    }
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && Path::new(value)
            .file_name()
            .is_some_and(|name| name == value)
}

fn validate_sha256(name: &str, value: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime manifest {name} must contain 64 hexadecimal characters."
        ))
    }
}

pub(crate) fn verify_artifact(path: &Path, manifest: &SidecarManifest) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Capture runtime executable is unavailable at {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("Capture runtime executable is not a regular file.".into());
    }
    if metadata.len() != manifest.bytes {
        return Err(format!(
            "Capture runtime byte count mismatch: expected {}, found {}.",
            manifest.bytes,
            metadata.len()
        ));
    }
    if sha256_file(path)?.eq_ignore_ascii_case(&manifest.sha256) {
        Ok(())
    } else {
        Err("Capture runtime SHA-256 mismatch.".into())
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Capture runtime executable cannot be opened: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Capture runtime executable cannot be read: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn expected() -> ManifestExpectations {
        ManifestExpectations {
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            file_name: "capture-runtime.exe".into(),
            schema_file_name: "capture-document-v2.schema.json".into(),
        }
    }

    fn manifest(bytes: u64, sha256: &str) -> SidecarManifest {
        SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes,
            sha256: sha256.into(),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        }
    }

    #[test]
    fn verified_manifest_checks_artifact_bytes_and_hash() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable = directory.path().join("capture-runtime.exe");
        let manifest_path = directory.path().join("manifest.json");
        fs::File::create(&executable)
            .expect("executable")
            .write_all(b"runtime")
            .expect("write");
        let manifest = manifest(
            7,
            "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23",
        );
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("write manifest");

        verify_sidecar(&manifest_path, &executable, &expected()).expect("verified");

        let mut tampered_manifest = manifest;
        tampered_manifest.sha256 = "0".repeat(64);
        fs::write(
            &manifest_path,
            serde_json::to_vec(&tampered_manifest).expect("tampered manifest"),
        )
        .expect("write tampered manifest");
        assert!(verify_sidecar(&manifest_path, &executable, &expected()).is_err());
    }

    #[test]
    fn path_traversal_is_rejected_before_artifact_access() {
        let mut manifest = manifest(1, &"0".repeat(64));
        manifest.file_name = "../capture-runtime.exe".into();
        assert!(validate_manifest_contract(&manifest, &expected()).is_err());
    }
}
