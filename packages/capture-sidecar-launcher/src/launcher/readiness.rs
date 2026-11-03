use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::de::{Error as DeError, IgnoredAny, MapAccess, Visitor};

use super::command::append_bytes;
use crate::{
    health::{
        verify_readiness_schema, VerifiedReadinessSchema, CANONICAL_CAPTURE_DOCUMENT_V2_SHA256,
        R3_SCHEMA_FILE_NAME,
    },
    manifest::SidecarManifest,
};

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

pub(super) fn load_bounded_manifest(path: &Path) -> Result<SidecarManifest, String> {
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

pub(super) fn freeze_readiness_context(
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

pub(super) fn append_readiness_context_identity(
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::super::command::freeze_launch_command_from_environment_with_schema;
    use super::super::fixture::{token_environment, write_canonical_readiness_manifest};
    use super::super::spec::SidecarLaunchSpec;
    use super::MAX_READINESS_MANIFEST_BYTES;
    use crate::{
        health::{CANONICAL_CAPTURE_DOCUMENT_V2_SHA256, R3_SCHEMA_FILE_NAME},
        manifest::VerifiedSidecar,
    };

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
        changed_manifest.runtime_version = "99.0.0".into();
        fs::write(
            &manifest_path,
            serde_json::to_vec(&changed_manifest).expect("changed manifest JSON"),
        )
        .expect("tamper manifest");
        assert!(frozen.checked_command().is_err());
    }
}
