pub(crate) mod error;
pub(crate) mod native;
pub(crate) mod session;
pub(crate) mod sidecar_process;

#[cfg(test)]
mod tests;

pub use error::{SidecarCleanupError, SidecarCleanupErrorKind};
pub use session::{OwnedSidecarSession, SidecarTerminationProof};
pub use sidecar_process::OwnedSidecarProcess;
