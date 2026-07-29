use std::fmt;

use serde::Serialize;

/// Memory-only connection information returned to the Angular desktop host.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

impl fmt::Debug for BackendConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackendConfig")
            .field("base_url", &self.base_url)
            .field("token", &"[REDACTED]")
            .field("runtime_version", &self.runtime_version)
            .field("api_version", &self.api_version)
            .field(
                "capture_document_schema_version",
                &self.capture_document_schema_version,
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub status: String,
    pub detail: String,
    pub base_url: Option<String>,
    pub runtime_version: Option<String>,
    pub api_version: Option<String>,
    pub capture_document_schema_version: Option<String>,
}

impl DesktopRuntimeStatus {
    pub(crate) fn starting() -> Self {
        Self {
            status: "starting".into(),
            detail: "Capture runtime is starting.".into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
        }
    }

    pub(crate) fn failed(detail: impl Into<String>) -> Self {
        Self {
            status: "failed".into(),
            detail: detail.into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
        }
    }

    pub(crate) fn ready(config: &BackendConfig) -> Self {
        Self {
            status: "ready".into(),
            detail: "Capture runtime is ready.".into(),
            base_url: Some(config.base_url.clone()),
            runtime_version: Some(config.runtime_version.clone()),
            api_version: Some(config.api_version.clone()),
            capture_document_schema_version: Some(config.capture_document_schema_version.clone()),
        }
    }

    pub(crate) fn stopped() -> Self {
        Self {
            status: "stopped".into(),
            detail: "Capture runtime was stopped by Capture Workbench.".into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
        }
    }
}
