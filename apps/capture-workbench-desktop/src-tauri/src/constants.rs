pub(crate) const RUNTIME_MANIFEST_FILE: &str = "capture-runtime-manifest.json";
pub(crate) const RUNTIME_BINARY_FILE: &str = "capture-runtime.exe";
pub(crate) const RUNTIME_BINARY_TARGET_FILE: &str = "capture-runtime-x86_64-pc-windows-msvc.exe";

pub(crate) const EXPECTED_MANIFEST_VERSION: &str = "1";
pub(crate) const EXPECTED_RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
pub(crate) const EXPECTED_API_VERSION: &str = "1.0";
pub(crate) const EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION: &str = "1";

pub(crate) const LOOPBACK_HOST: &str = "127.0.0.1";
pub(crate) const WORKBENCH_OLLAMA_MODEL: &str = "qwen3.5:4b";
pub(crate) const WORKBENCH_OLLAMA_PROFILE: &str = "capture-workbench-qwen3.5-4b-structure-v1";
pub(crate) const DEFAULT_RETENTION_HOURS: u64 = 24;
pub(crate) const DEFAULT_MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;
