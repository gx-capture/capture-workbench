//! Private pre-native run-staging owner.
//!
//! This module materializes only the producer-planned directory scope after
//! durable preparation.  It does not acquire a listener, process, model, or
//! other runtime resource.  The owner is deliberately move-only and is kept
//! in every error after the group directory is created so a later lifecycle
//! owner can retry cleanup without rediscovering paths.
//!
//! The filesystem checks and directory creation are deliberately sequential;
//! the live owner does not claim hostile concurrent path confinement.  File
//! contents are flushed and read back, and the private restart observer can
//! report an exact V2 scope observation, but neither path establishes native
//! cleanup or terminal proof.  A later activation owner must consume the live
//! value and perform the native cleanup proof before final journal
//! terminalization.

#![allow(dead_code)]

mod budget;
mod failure;
mod identity;
mod marker;
mod owner;
mod release_tree;
mod restart;
mod scope_digest;

pub(crate) use failure::{StagingCleanupError, StagingFailure, StagingFailureKind};
pub(crate) use owner::{materialize, RunStagingOwner, StagingReleasedObservation};

#[cfg(windows)]
pub(crate) use owner::materialize_with_budget;

#[cfg(windows)]
pub(crate) use restart::{
    observe_restart_staging, RestartStagingObservation, RestartStagingObservationReason,
};

#[cfg(test)]
pub(crate) use budget::{cancel_after_launching_cas_for_test, cancel_after_ready_cas_for_test};
#[cfg(test)]
pub(crate) use marker::{
    fail_next_marker_flush_for_test, fail_next_marker_partial_write_for_test,
    fail_next_marker_readback_for_test,
};
#[cfg(test)]
pub(crate) use owner::fail_next_root_mkdir_for_test;
