use std::{fs, io::Read, net::IpAddr, path::Path};

#[cfg(test)]
pub(crate) use crate::contracts::manifest::RuntimeRequirements;
use crate::contracts::{RuntimeManifest, VerifiedRuntime, WindowsMlArtifactDescriptor};
use sha2::{Digest, Sha256};

use crate::constants::{
    EXPECTED_API_VERSION, EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION, EXPECTED_MANIFEST_VERSION,
    EXPECTED_RUNTIME_VERSION, MAX_RUNTIME_ARTIFACT_BYTES, MAX_WINDOWSML_BUNDLE_BYTES,
    RUNTIME_BINARY_TARGET_FILE, SCHEMA_FILE_NAME,
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
    validate_windowsml_descriptor(&manifest.runtime_requirements.windowsml_ocr)?;
    Ok(())
}

fn validate_windowsml_descriptor(descriptor: &WindowsMlArtifactDescriptor) -> Result<(), String> {
    if descriptor.artifact_url.contains(['%', '\\'])
        || descriptor
            .artifact_url
            .chars()
            .any(|character| character.is_control())
    {
        return Err(
            "WindowsML artifactUrl must not contain escapes, backslashes, or controls.".into(),
        );
    }
    let Some(remainder) = descriptor.artifact_url.strip_prefix("https://") else {
        return Err("WindowsML artifactUrl must use public HTTPS.".into());
    };
    let Some((authority, path)) = remainder.split_once('/') else {
        return Err("WindowsML artifactUrl must end in an artifact path.".into());
    };
    if authority != authority.to_ascii_lowercase() {
        return Err("WindowsML artifactUrl hostname must be canonical lowercase DNS.".into());
    }
    if authority.is_empty()
        || authority.contains('@')
        || authority.contains(':')
        || descriptor.artifact_url.contains(['?', '#'])
        || authority.parse::<IpAddr>().is_ok()
        || authority == "localhost"
        || [".invalid", ".example", ".test", ".localhost"]
            .iter()
            .any(|suffix| authority.ends_with(suffix))
    {
        return Err(
            "WindowsML artifactUrl must be public HTTPS without credentials, query, or fragment."
                .into(),
        );
    }
    if !canonical_dns_name(authority)
        || path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || !plain_url_segment(segment))
    {
        return Err(
            "WindowsML artifactUrl must use canonical public DNS and plain path segments.".into(),
        );
    }
    if !safe_file_name(&descriptor.artifact_file_name)
        || !descriptor
            .artifact_file_name
            .to_ascii_lowercase()
            .ends_with(".zip")
        || !descriptor
            .artifact_file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || path.rsplit('/').next() != Some(descriptor.artifact_file_name.as_str())
    {
        return Err(
            "WindowsML artifactFileName must be the plain .zip name from artifactUrl.".into(),
        );
    }
    if descriptor.bytes == 0 || descriptor.bytes > MAX_WINDOWSML_BUNDLE_BYTES {
        return Err("WindowsML artifact bytes must be from 1 through 536870912.".into());
    }
    if !lowercase_sha256(&descriptor.sha256) {
        return Err(
            "WindowsML artifact sha256 must contain 64 lowercase hexadecimal characters.".into(),
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

fn canonical_dns_name(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        && value.rsplit_once('.').is_some_and(|(_, suffix)| {
            suffix.len() >= 2 && suffix.bytes().all(|byte| byte.is_ascii_lowercase())
        })
}

fn plain_url_segment(value: &str) -> bool {
    !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
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

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && Path::new(value)
            .file_name()
            .is_some_and(|name| name == value)
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
    use serde_json::Value;
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
            runtime_requirements: RuntimeRequirements {
                windowsml_ocr: WindowsMlArtifactDescriptor {
                    artifact_url: "https://downloads.example.org/capture-windowsml.zip".into(),
                    artifact_file_name: "capture-windowsml.zip".into(),
                    bytes: 123_456,
                    sha256: "a".repeat(64),
                },
            },
        }
    }

    fn materialize_corpus_case(case: &Value, base: &Value) -> Value {
        let mut manifest = case
            .get("manifest")
            .cloned()
            .unwrap_or_else(|| base.clone());
        if let Some(patch) = case.get("patch").and_then(Value::as_object) {
            manifest
                .as_object_mut()
                .expect("manifest")
                .extend(patch.clone());
        }
        if let Some(remove) = case.get("remove").and_then(Value::as_str) {
            manifest.as_object_mut().expect("manifest").remove(remove);
        }
        let requirements = manifest
            .get_mut("runtimeRequirements")
            .and_then(Value::as_object_mut)
            .expect("requirements");
        if let Some(patch) = case.get("requirementPatch").and_then(Value::as_object) {
            requirements.extend(patch.clone());
        }
        let descriptor = requirements
            .get_mut("windowsml-ocr")
            .and_then(Value::as_object_mut)
            .expect("descriptor");
        if let Some(patch) = case.get("descriptorPatch").and_then(Value::as_object) {
            descriptor.extend(patch.clone());
        }
        if let Some(remove) = case.get("descriptorRemove").and_then(Value::as_str) {
            descriptor.remove(remove);
        }
        manifest
    }

    #[test]
    fn shared_release_manifest_corpus_matches_rust_contract() {
        let corpus: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tools/release-manifest-corpus.json"
        )))
        .expect("corpus");
        let cases = corpus["cases"].as_array().expect("cases");
        let base = cases
            .iter()
            .find(|case| case["valid"] == Value::Bool(true))
            .and_then(|case| case.get("manifest"))
            .expect("base");
        for case in cases {
            let value = materialize_corpus_case(case, base);
            let result = serde_json::from_value::<RuntimeManifest>(value)
                .map_err(|error| error.to_string())
                .and_then(|manifest| validate_manifest_contract(&manifest));
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().expect("valid"),
                "{}",
                case["name"].as_str().expect("name")
            );
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

    #[test]
    fn windowsml_descriptor_rejects_secrets_and_non_lowercase_digests() {
        let mut manifest = valid_manifest(
            1,
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        manifest.runtime_requirements = RuntimeRequirements {
            windowsml_ocr: WindowsMlArtifactDescriptor {
                artifact_url: "https://downloads.example.org/capture-windowsml.zip?token=secret"
                    .into(),
                artifact_file_name: "capture-windowsml.zip".into(),
                bytes: 123_456,
                sha256: "a".repeat(64),
            },
        };
        assert!(validate_manifest_contract(&manifest)
            .expect_err("query")
            .contains("without credentials"));

        let descriptor = &mut manifest.runtime_requirements.windowsml_ocr;
        descriptor.artifact_url = "https://downloads.example.org/capture-windowsml.zip".into();
        descriptor.sha256 = "A".repeat(64);
        assert!(validate_manifest_contract(&manifest)
            .expect_err("uppercase")
            .contains("lowercase"));
    }
}
