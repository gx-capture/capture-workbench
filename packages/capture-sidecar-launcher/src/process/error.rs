use std::fmt;

/// Why one owned-process cleanup could not be proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCleanupErrorKind {
    /// The root process could not be killed from its launch handle.
    Termination,
    /// The root's exit could not be proven, or its liveness could not be read.
    Liveness,
    /// Waiting for the root to exit failed after termination was requested.
    Reap,
    /// A descendant in the ownership boundary was still present, or could not be queried.
    Descendants,
    /// The launch identity or the ownership lock could not be used.
    Ownership,
    /// Test-only failure injected before a real cleanup proof is attempted.
    #[cfg(test)]
    Injected,
}

/// Cleanup failure that keeps the process and job handle for another attempt.
///
/// The detail string describes the operating-system or ownership failure. It
/// does not include the bearer token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCleanupError {
    root_pid: u32,
    kind: RuntimeCleanupErrorKind,
    detail: String,
}

impl RuntimeCleanupError {
    pub(crate) fn new(
        root_pid: u32,
        kind: RuntimeCleanupErrorKind,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            root_pid,
            kind,
            detail: detail.into(),
        }
    }

    /// Returns the root process id captured for this cleanup attempt.
    ///
    /// Zero means the ownership lock failed before a root id was available.
    pub fn root_pid(&self) -> u32 {
        self.root_pid
    }

    /// Returns the cleanup failure category.
    pub fn kind(&self) -> RuntimeCleanupErrorKind {
        self.kind
    }

    /// Returns the cleanup diagnostic.
    ///
    /// The text can include an operating-system error. It does not include
    /// the bearer token.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for RuntimeCleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Owned runtime cleanup failed for root PID {} ({:?}): {}",
            self.root_pid, self.kind, self.detail
        )
    }
}

impl std::error::Error for RuntimeCleanupError {}
