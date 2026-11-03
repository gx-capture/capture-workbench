use std::path::PathBuf;

#[cfg(windows)]
use std::{fs, path::Path, sync::atomic::AtomicBool, time::Instant};

use super::identity::FileIdentity;

#[cfg(windows)]
use super::{
    failure::StagingCleanupError,
    identity::{capture_any_identity, has_multiple_hard_links, metadata_is_reparse},
};

pub(super) const MAX_RELEASE_TREE_ENTRIES: usize = 8 * 1024;
pub(super) const MAX_RELEASE_TREE_DEPTH: usize = 32;

pub(super) struct ReleaseNode {
    pub(super) path: PathBuf,
    pub(super) parent: PathBuf,
    pub(super) parent_identity: FileIdentity,
    pub(super) identity: FileIdentity,
    pub(super) is_directory: bool,
}

#[cfg(windows)]
pub(super) fn check_staging_release_budget(
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<(), StagingCleanupError> {
    if cancellation.load(std::sync::atomic::Ordering::Acquire) {
        return Err(StagingCleanupError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(StagingCleanupError::Deadline);
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn read_release_entries(
    path: &Path,
    deadline: Instant,
    cancellation: &AtomicBool,
    remaining_entries: &mut usize,
) -> Result<Vec<fs::DirEntry>, StagingCleanupError> {
    check_staging_release_budget(deadline, cancellation)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| StagingCleanupError::ForeignEntry)? {
        check_staging_release_budget(deadline, cancellation)?;
        if *remaining_entries == 0 {
            return Err(StagingCleanupError::TraversalBound);
        }
        *remaining_entries -= 1;
        entries.push(entry.map_err(|_| StagingCleanupError::ForeignEntry)?);
    }
    Ok(entries)
}

#[cfg(windows)]
pub(super) fn collect_release_nodes(
    path: &Path,
    parent_identity: FileIdentity,
    depth: usize,
    depth_limit: usize,
    nodes: &mut Vec<ReleaseNode>,
    deadline: Instant,
    cancellation: &AtomicBool,
    remaining_entries: &mut usize,
) -> Result<(), StagingCleanupError> {
    check_staging_release_budget(deadline, cancellation)?;
    if depth > depth_limit {
        return Err(StagingCleanupError::TraversalBound);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| StagingCleanupError::ForeignEntry)?;
    if metadata_is_reparse(&metadata) {
        return Err(StagingCleanupError::Reparse);
    }
    let identity = capture_any_identity(path).map_err(|_| StagingCleanupError::IdentityChanged)?;
    check_staging_release_budget(deadline, cancellation)?;
    if metadata.is_dir() {
        let mut entries = read_release_entries(path, deadline, cancellation, remaining_entries)?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect_release_nodes(
                &entry.path(),
                identity,
                depth + 1,
                depth_limit,
                nodes,
                deadline,
                cancellation,
                remaining_entries,
            )?;
        }
        nodes.push(ReleaseNode {
            path: path.to_path_buf(),
            parent: path
                .parent()
                .ok_or(StagingCleanupError::IdentityChanged)?
                .to_path_buf(),
            parent_identity,
            identity,
            is_directory: true,
        });
    } else if metadata.is_file() {
        if has_multiple_hard_links(path, &metadata) {
            return Err(StagingCleanupError::HardLink);
        }
        nodes.push(ReleaseNode {
            path: path.to_path_buf(),
            parent: path
                .parent()
                .ok_or(StagingCleanupError::IdentityChanged)?
                .to_path_buf(),
            parent_identity,
            identity,
            is_directory: false,
        });
    } else {
        return Err(StagingCleanupError::ForeignEntry);
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn remove_release_node(node: &ReleaseNode) -> Result<(), StagingCleanupError> {
    if node.is_directory {
        fs::remove_dir(&node.path).map_err(|_| StagingCleanupError::DeleteFailed)
    } else {
        fs::remove_file(&node.path).map_err(|_| StagingCleanupError::DeleteFailed)
    }
}
