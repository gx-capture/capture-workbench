use std::{fs, io::Read, path::Path};

use crate::contracts::{RuntimeManifest, VerifiedRuntime};
use sha2::{Digest, Sha256};

use crate::constants::{
    EXPECTED_API_VERSION, EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION, EXPECTED_MANIFEST_VERSION,
    EXPECTED_RUNTIME_VERSION, MAX_RUNTIME_ARTIFACT_BYTES, RUNTIME_BINARY_TARGET_FILE,
    SCHEMA_FILE_NAME,
};

pub(crate) fn load_runtime_manifest(path: &Path) -> Result<RuntimeManifest, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Capture runtime manifest is unavailable: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Capture runtime manifest is invalid JSON: {error}"))
}

pub(crate) fn verify_runtime(
    manifest_path: &Path,
    executable_path: &Path,
) -> Result<VerifiedRuntime, String> {
    let manifest = load_runtime_manifest(manifest_path)?;
    validate_manifest_contract(&manifest)?;
    verify_artifact(executable_path, &manifest)?;
    Ok(VerifiedRuntime {
        manifest,
        executable_path: executable_path.to_path_buf(),
    })
}

pub(crate) fn validate_manifest_contract(manifest: &RuntimeManifest) -> Result<(), String> {
    expect_field(
        "manifestVersion",
        &manifest.manifest_version,
        EXPECTED_MANIFEST_VERSION,
    )?;
    expect_field(
        "runtimeVersion",
        &manifest.runtime_version,
        EXPECTED_RUNTIME_VERSION,
    )?;
    expect_field("apiVersion", &manifest.api_version, EXPECTED_API_VERSION)?;
    expect_field(
        "captureDocumentSchemaVersion",
        &manifest.capture_document_schema_version,
        EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION,
    )?;
    expect_field("platform", &manifest.platform, "windows")?;
    expect_field("arch", &manifest.arch, "x86_64")?;

    expect_field("fileName", &manifest.file_name, RUNTIME_BINARY_TARGET_FILE)?;
    expect_field(
        "schemaFileName",
        &manifest.schema_file_name,
        SCHEMA_FILE_NAME,
    )?;
    if manifest.bytes == 0 || manifest.bytes > MAX_RUNTIME_ARTIFACT_BYTES {
        return Err("Capture runtime manifest bytes must be from 1 through 536870912.".into());
    }
    if !lowercase_sha256(&manifest.sha256) {
        return Err(
            "Capture runtime manifest sha256 must contain 64 lowercase hexadecimal characters."
                .into(),
        );
    }
    if !lowercase_sha256(&manifest.schema_sha256) {
        return Err(
            "Capture runtime manifest schemaSha256 must contain 64 lowercase hexadecimal characters."
                .into(),
        );
    }
    Ok(())
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn expect_field(name: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime {name} is incompatible: expected {expected}, found {actual}."
        ))
    }
}

fn verify_artifact(path: &Path, manifest: &RuntimeManifest) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Capture runtime executable is unavailable: {error}"))?;
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

    let digest = sha256_file(path)?;
    if !digest.eq_ignore_ascii_case(&manifest.sha256) {
        return Err("Capture runtime SHA-256 mismatch.".into());
    }
    Ok(())
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

    fn valid_manifest(bytes: u64, sha256: &str) -> RuntimeManifest {
        RuntimeManifest {
            manifest_version: EXPECTED_MANIFEST_VERSION.into(),
            runtime_version: EXPECTED_RUNTIME_VERSION.into(),
            api_version: EXPECTED_API_VERSION.into(),
            capture_document_schema_version: EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: RUNTIME_BINARY_TARGET_FILE.into(),
            bytes,
            sha256: sha256.into(),
            schema_file_name: SCHEMA_FILE_NAME.into(),
            schema_sha256: "1".repeat(64),
        }
    }

    #[test]
    fn manifest_and_artifact_are_verified_together() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        let manifest_path = directory.path().join("capture-runtime-manifest.json");
        fs::File::create(&executable_path)
            .expect("runtime")
            .write_all(b"deterministic runtime")
            .expect("write");
        let manifest = valid_manifest(
            21,
            "a126a2a4d6c2bf30761eb62eadb5b26def2af216cd4608ed57585965beb4328f",
        );
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("write manifest");

        let verified = verify_runtime(&manifest_path, &executable_path).expect("verified");
        assert_eq!(verified.manifest, manifest);
    }

    #[test]
    fn modified_runtime_is_rejected() {
        let directory = tempfile::tempdir().expect("tempdir");
        let executable_path = directory.path().join("capture-runtime.exe");
        let manifest_path = directory.path().join("capture-runtime-manifest.json");
        fs::write(&executable_path, b"tampered").expect("runtime");
        let manifest = valid_manifest(
            8,
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("write manifest");

        assert_eq!(
            verify_runtime(&manifest_path, &executable_path).expect_err("mismatch"),
            "Capture runtime SHA-256 mismatch."
        );
    }

    #[test]
    fn wrong_schema_and_path_traversal_are_rejected() {
        let mut manifest = valid_manifest(
            1,
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        manifest.capture_document_schema_version = "2".into();
        assert!(validate_manifest_contract(&manifest)
            .expect_err("schema")
            .contains("captureDocumentSchemaVersion"));

        manifest.capture_document_schema_version = EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION.into();
        manifest.file_name = "../capture-runtime.exe".into();
        assert!(validate_manifest_contract(&manifest)
            .expect_err("path")
            .contains("fileName"));
    }
}
