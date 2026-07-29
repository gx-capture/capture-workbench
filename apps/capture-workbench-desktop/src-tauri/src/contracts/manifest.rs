use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeManifest {
    pub manifest_version: String,
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
    pub platform: String,
    pub arch: String,
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
    pub schema_file_name: String,
    pub schema_sha256: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedRuntime {
    pub manifest: RuntimeManifest,
    pub executable_path: PathBuf,
}
