use std::fmt;

use crate::journal_store::OwnedCasResult;

use super::owner::RunStagingOwner;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagingFailureKind {
    InvalidActivation,
    JournalChanged,
    SharedParent,
    GroupCollision,
    MarkerCollision,
    MarkerWrite,
    MarkerReadBack,
    RootCollision,
    RootIdentity,
    Reparse,
    Durability,
    Cancelled,
    Deadline,
}

/// A failure before group ownership exists is safe to return as a normal
/// error.  Once the group directory has been created, the error carries the
/// exact owner so callers cannot accidentally discard cleanup authority.
pub(crate) enum StagingFailure {
    // Dropping the consumed context here intentionally invalidates the
    // one-use activation handoff.  No group or native resource is owned on
    // this path, and no permit can be reissued from the rejected value.
    BeforeOwnership(StagingFailureKind),
    Owned {
        owner: RunStagingOwner,
        kind: StagingFailureKind,
    },
}

/// A private budgeted journal failure. The owned CAS result remains attached
/// so callers can distinguish a prewrite failure, ambiguous replacement, and
/// confirmed-late durable candidate without blessing a bare journal value.
#[derive(Debug)]
pub(crate) struct StagingBudgetFailure {
    kind: StagingFailureKind,
    pub(super) detail: String,
    cas_outcome: Option<OwnedCasResult>,
}

impl StagingBudgetFailure {
    pub(super) fn new(kind: StagingFailureKind, detail: String) -> Self {
        Self {
            kind,
            detail,
            cas_outcome: None,
        }
    }

    pub(super) fn with_cas_outcome(
        kind: StagingFailureKind,
        detail: String,
        cas_outcome: OwnedCasResult,
    ) -> Self {
        Self {
            kind,
            detail,
            cas_outcome: Some(cas_outcome),
        }
    }

    pub(crate) fn into_cas_parts(self) -> (StagingFailureKind, String, Option<OwnedCasResult>) {
        (self.kind, self.detail, self.cas_outcome)
    }
}

impl fmt::Debug for StagingFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BeforeOwnership(kind) => formatter
                .debug_tuple("BeforeOwnership")
                .field(kind)
                .finish(),
            Self::Owned { kind, .. } => formatter.debug_tuple("Owned").field(kind).finish(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagingCleanupError {
    Cancelled,
    Deadline,
    TraversalBound,
    JournalChanged,
    OwnershipUnknown,
    Reparse,
    IdentityChanged,
    ForeignEntry,
    HardLink,
    NonEmpty,
    DeleteFailed,
}

pub(super) fn staging_budget_error(kind: StagingFailureKind) -> String {
    match kind {
        StagingFailureKind::Cancelled => "Capture runtime staging operation was cancelled.".into(),
        StagingFailureKind::Deadline => {
            "Capture runtime staging operation exceeded its deadline.".into()
        }
        _ => "Capture runtime staging budget was invalid.".into(),
    }
}
