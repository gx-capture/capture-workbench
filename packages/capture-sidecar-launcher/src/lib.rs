mod constants;
mod health;
mod launcher;
mod manifest;
mod process;

use std::fmt;

pub use health::{probe_ready_once, ProbeResult, ReadyHandshake};
pub use launcher::{
    generate_bearer_token, launch_sidecar, reserve_distinct_loopback_port, reserve_loopback_port,
    LaunchOptions, LaunchedSidecar, SidecarLaunchSpec,
};
pub use manifest::{
    load_manifest, validate_manifest_contract, verify_sidecar, ManifestExpectations,
    SidecarManifest, VerifiedSidecar,
};
pub use process::OwnedSidecarProcess;

/// A connection to a ready authenticated sidecar.
#[derive(Clone, PartialEq, Eq)]
pub struct SidecarConnection {
    /// Loopback base URL without a trailing slash.
    pub base_url: String,
    /// Bearer token required by the sidecar HTTP API.
    pub token: String,
    /// Runtime version returned by the readiness handshake.
    pub runtime_version: String,
    /// API version returned by the readiness handshake.
    pub api_version: String,
    /// Capture document schema version returned by the readiness handshake.
    pub capture_document_schema_version: String,
}

impl fmt::Debug for SidecarConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SidecarConnection")
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

#[cfg(test)]
mod tests {
    use super::SidecarConnection;

    #[test]
    fn connection_debug_redacts_the_bearer_token() {
        let connection = SidecarConnection {
            base_url: "http://127.0.0.1:49152".into(),
            token: "secret-sidecar-token".into(),
            runtime_version: "0.3.11".into(),
            api_version: "1.0".into(),
            capture_document_schema_version: "1".into(),
        };

        let output = format!("{connection:?}");
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("secret-sidecar-token"));
    }
}
