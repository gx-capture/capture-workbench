//! Start and supervise a Capture runtime sidecar for a desktop host.
//!
//! A host verifies the sidecar manifest and executable with
//! [`load_manifest`], [`validate_manifest_contract`], and [`verify_sidecar`],
//! reserves a fresh loopback port with [`reserve_loopback_port`] or
//! [`reserve_distinct_loopback_port`], generates a fresh bearer token with
//! [`generate_bearer_token`], and launches one process with
//! [`launch_sidecar`] or [`launch_sidecar_with_observer`]. The launch makes up
//! to 3 attempts within 60 seconds by default ([`LaunchOptions`]) and returns
//! a [`LaunchedSidecar`] once the authenticated readiness probe accepts the
//! runtime. A host that runs its own process can use
//! [`OwnedRuntimeSession::spawn`] or [`OwnedSidecarProcess::spawn`] directly.
//!
//! On Windows every root is created suspended, assigned to a new
//! kill-on-close Job object, and resumed only after that assignment is
//! checked. When the host process exits for any reason, the system closes
//! the Job handle and stops the runtime and its descendants. A live host can
//! poll [`OwnedRuntimeSession::monitor_root_exit`] and stop the attempt with
//! [`OwnedRuntimeSession::terminate_and_prove`]. Nothing is written to disk:
//! the next launch uses a fresh port and token, and the runtime cleans its
//! own leftovers when it starts.
//!
//! A bearer token is kept in memory, sent on the loopback readiness request,
//! and copied into the child only when the host put it in the launch
//! environment. This crate does not write the token to a log or to disk.
//!
//! Runtime jobs are ephemeral. The host owns durable source and domain data.
//! Dropping the last [`OwnedRuntimeSession`] clone stops that launch attempt.

mod constants;
mod health;
mod launcher;
mod manifest;
mod process;

use std::fmt;

/// Loopback readiness probe.
pub use health::{probe_ready_once, ProbeResult, ReadyHandshake};
/// Single-process launch, loopback port reservation, and token generation.
pub use launcher::{
    generate_bearer_token, launch_sidecar, launch_sidecar_with_observer,
    reserve_distinct_loopback_port, reserve_loopback_port, LaunchOptions, LaunchedSidecar,
    SidecarLaunchSpec,
};
/// Manifest loading and executable digest verification.
pub use manifest::{
    load_manifest, validate_manifest_contract, verify_sidecar, ManifestExpectations,
    SidecarManifest, VerifiedSidecar,
};
/// Process ownership through a kill-on-close Windows Job object.
pub use process::{
    OwnedRuntimeSession, OwnedSidecarProcess, RuntimeCleanupError, RuntimeCleanupErrorKind,
    RuntimeTerminationProof,
};

/// A connection to a ready authenticated sidecar.
///
/// `Debug` prints `token` as `[REDACTED]`. Callers must not log or persist
/// the bearer token. This crate keeps it in memory and sends it on the
/// loopback readiness request.
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
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        };

        let output = format!("{connection:?}");
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("secret-sidecar-token"));
    }
}
