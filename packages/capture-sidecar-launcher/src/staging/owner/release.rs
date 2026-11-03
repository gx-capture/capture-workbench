#[cfg(windows)]
use std::{fs, sync::atomic::AtomicBool, time::Instant};

#[cfg(windows)]
use crate::journal::{JournalState, RuntimeSessionJournalV1};

#[cfg(windows)]
use super::super::{
    failure::StagingCleanupError,
    identity::{
        capture_any_identity, ensure_existing_directory, has_multiple_hard_links,
        is_empty_directory, metadata_is_reparse, path_exists, path_is_reparse, read_bounded,
        same_identity, validate_safe_chain,
    },
    marker::{OwnedMarker, MARKER_FILE_NAME},
    release_tree::{
        check_staging_release_budget, collect_release_nodes, read_release_entries,
        remove_release_node, ReleaseNode, MAX_RELEASE_TREE_DEPTH, MAX_RELEASE_TREE_ENTRIES,
    },
};
use super::{RunStagingOwner, StagingReleasedObservation, StagingScopeState};

#[cfg(windows)]
impl RunStagingOwner {
    /// Release the producer-owned run subtree after the exact native and
    /// listener proofs have already been established by the Closing owner.
    /// This method only performs filesystem teardown; the caller holds the
    /// Closing journal admission while it invokes this seam and observes the
    /// listener again afterwards.
    #[cfg(windows)]
    pub(crate) fn cleanup_after_closing(
        &mut self,
        expected: &RuntimeSessionJournalV1,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<StagingReleasedObservation, StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        expected
            .validate_against_plan(&self.activation.journal_plan)
            .map_err(|_| StagingCleanupError::JournalChanged)?;
        if expected.state != JournalState::Closing
            || expected.session_nonce != self.activation.descriptor.session_nonce()
            || expected.plan_digest != self.activation.journal_plan.plan_digest
        {
            return Err(StagingCleanupError::JournalChanged);
        }

        if self.scope_state == StagingScopeState::Released {
            let observation = self
                .released_observation
                .clone()
                .ok_or(StagingCleanupError::OwnershipUnknown)?;
            self.validate_released_scope()?;
            if !observation.matches_activation(&self.activation) {
                return Err(StagingCleanupError::IdentityChanged);
            }
            return Ok(observation);
        }

        if !path_exists(&self.group.path) {
            return Err(StagingCleanupError::OwnershipUnknown);
        }

        let trees = self.preflight_release_scope(deadline, cancellation)?;
        let mut mutation_index = 0_usize;
        for index in (0..self.expected_root_paths.len()).rev() {
            check_staging_release_budget(deadline, cancellation)?;
            if self.released_roots[index] {
                continue;
            }
            for node in &trees[index] {
                check_staging_release_budget(deadline, cancellation)?;
                self.validate_release_node(node, deadline, cancellation)?;
                self.before_release_delete(mutation_index)?;
                remove_release_node(node)?;
                // Only a successful remove establishes deletion progress.  A
                // failed or interrupted attempt must remain unknown on retry.
                self.after_release_delete(mutation_index, cancellation);
                mutation_index = mutation_index.saturating_add(1);
            }
            check_staging_release_budget(deadline, cancellation)?;
            self.validate_scope_chain()?;
            let root = &self.roots[index];
            if root.path != self.expected_root_paths[index]
                || !same_identity(&root.path, root.identity)
                || !ensure_existing_directory(&root.path).is_ok()
                || !is_empty_directory(&root.path)?
            {
                return Err(StagingCleanupError::IdentityChanged);
            }
            self.before_release_delete(mutation_index)?;
            match fs::remove_dir(&root.path) {
                Ok(()) => self.released_roots[index] = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(StagingCleanupError::OwnershipUnknown);
                }
                Err(_) => return Err(StagingCleanupError::DeleteFailed),
            }
            self.after_release_delete(mutation_index, cancellation);
            mutation_index = mutation_index.saturating_add(1);
        }

        check_staging_release_budget(deadline, cancellation)?;
        if !self.marker_released {
            let marker = self
                .marker
                .as_ref()
                .ok_or(StagingCleanupError::OwnershipUnknown)?;
            self.validate_release_marker(marker, deadline, cancellation)?;
            self.before_release_delete(mutation_index)?;
            match fs::remove_file(&marker.path) {
                Ok(()) => self.marker_released = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(StagingCleanupError::OwnershipUnknown);
                }
                Err(_) => return Err(StagingCleanupError::DeleteFailed),
            }
            self.after_release_delete(mutation_index, cancellation);
            mutation_index = mutation_index.saturating_add(1);
        }

        check_staging_release_budget(deadline, cancellation)?;
        self.validate_scope_chain()?;
        if !is_empty_directory(&self.group.path)? {
            return Err(StagingCleanupError::ForeignEntry);
        }
        self.before_release_delete(mutation_index)?;
        match fs::remove_dir(&self.group.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(StagingCleanupError::OwnershipUnknown);
            }
            Err(_) => return Err(StagingCleanupError::DeleteFailed),
        }
        // The group removal completed; all prior removal progress is already
        // recorded, so this is the first point at which the whole scope can
        // become a released observation.
        self.scope_state = StagingScopeState::Released;
        let observation = self.released_observation_for_activation();
        self.released_observation = Some(observation.clone());
        self.after_release_delete(mutation_index, cancellation);
        self.validate_released_scope()?;
        Ok(observation)
    }

    #[cfg(windows)]
    fn preflight_release_scope(
        &mut self,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<Vec<Vec<ReleaseNode>>, StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        if self.scope_state != StagingScopeState::Complete
            || self.marker.is_none()
            || self.roots.len() != self.expected_root_paths.len()
            || self.released_roots.len() != self.expected_root_paths.len()
        {
            return Err(StagingCleanupError::OwnershipUnknown);
        }
        self.validate_scope_chain()?;
        check_staging_release_budget(deadline, cancellation)?;
        let marker_path = self.group.path.join(MARKER_FILE_NAME);
        let marker = self.marker.as_ref().expect("marker checked above");
        if marker.path != marker_path {
            return Err(StagingCleanupError::IdentityChanged);
        }
        if self.marker_released {
            if path_exists(&marker.path) {
                return Err(StagingCleanupError::ForeignEntry);
            }
        } else if !path_exists(&marker.path) {
            return Err(StagingCleanupError::OwnershipUnknown);
        } else {
            self.validate_release_marker(marker, deadline, cancellation)
                .map_err(|error| match error {
                    StagingCleanupError::Cancelled | StagingCleanupError::Deadline => error,
                    _ => StagingCleanupError::OwnershipUnknown,
                })?;
        }

        let mut entry_budget = {
            #[cfg(test)]
            {
                self.release_entry_limit
                    .take()
                    .unwrap_or(MAX_RELEASE_TREE_ENTRIES)
            }
            #[cfg(not(test))]
            {
                MAX_RELEASE_TREE_ENTRIES
            }
        };
        let depth_limit = {
            #[cfg(test)]
            {
                self.release_depth_limit
                    .take()
                    .unwrap_or(MAX_RELEASE_TREE_DEPTH)
            }
            #[cfg(not(test))]
            {
                MAX_RELEASE_TREE_DEPTH
            }
        };
        let mut top_entries =
            read_release_entries(&self.group.path, deadline, cancellation, &mut entry_budget)?;
        top_entries.sort_by_key(|entry| entry.path());
        for entry in top_entries {
            check_staging_release_budget(deadline, cancellation)?;
            let path = entry.path();
            let allowed = path == marker_path
                || self
                    .expected_root_paths
                    .iter()
                    .any(|expected| *expected == path);
            if !allowed {
                return Err(StagingCleanupError::ForeignEntry);
            }
            if path_is_reparse(&path).unwrap_or(true) {
                return Err(StagingCleanupError::Reparse);
            }
        }

        let mut trees = Vec::with_capacity(self.expected_root_paths.len());
        for index in 0..self.expected_root_paths.len() {
            check_staging_release_budget(deadline, cancellation)?;
            let root_path = &self.expected_root_paths[index];
            if self.released_roots[index] {
                if path_exists(root_path) {
                    return Err(StagingCleanupError::ForeignEntry);
                }
                trees.push(Vec::new());
                continue;
            }
            let root = &self.roots[index];
            if root.path != *root_path {
                return Err(StagingCleanupError::IdentityChanged);
            }
            let metadata = match fs::symlink_metadata(root_path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(StagingCleanupError::OwnershipUnknown);
                }
                Err(_) => return Err(StagingCleanupError::IdentityChanged),
            };
            if !metadata.is_dir()
                || metadata_is_reparse(&metadata)
                || !same_identity(root_path, root.identity)
            {
                return Err(StagingCleanupError::IdentityChanged);
            }
            let root_identity = root.identity.ok_or(StagingCleanupError::IdentityChanged)?;
            let mut nodes = Vec::new();
            let mut entries =
                read_release_entries(root_path, deadline, cancellation, &mut entry_budget)?;
            entries.sort_by_key(|entry| entry.path());
            for entry in entries {
                collect_release_nodes(
                    &entry.path(),
                    root_identity,
                    1,
                    depth_limit,
                    &mut nodes,
                    deadline,
                    cancellation,
                    &mut entry_budget,
                )?;
            }
            trees.push(nodes);
        }
        Ok(trees)
    }

    #[cfg(windows)]
    fn validate_release_node(
        &self,
        node: &ReleaseNode,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        self.validate_scope_chain()?;
        check_staging_release_budget(deadline, cancellation)?;
        if !same_identity(&node.parent, Some(node.parent_identity))
            || path_is_reparse(&node.parent).unwrap_or(true)
        {
            return Err(StagingCleanupError::IdentityChanged);
        }
        check_staging_release_budget(deadline, cancellation)?;
        let metadata =
            fs::symlink_metadata(&node.path).map_err(|_| StagingCleanupError::DeleteFailed)?;
        if metadata_is_reparse(&metadata)
            || metadata.is_dir() != node.is_directory
            || metadata.is_file() == node.is_directory
            || capture_any_identity(&node.path).ok() != Some(node.identity)
        {
            return Err(StagingCleanupError::IdentityChanged);
        }
        if !node.is_directory && has_multiple_hard_links(&node.path, &metadata) {
            return Err(StagingCleanupError::HardLink);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn validate_release_marker(
        &self,
        marker: &OwnedMarker,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), StagingCleanupError> {
        check_staging_release_budget(deadline, cancellation)?;
        self.validate_scope_chain()?;
        check_staging_release_budget(deadline, cancellation)?;
        let metadata = fs::symlink_metadata(&marker.path)
            .map_err(|_| StagingCleanupError::OwnershipUnknown)?;
        if !metadata.is_file()
            || metadata_is_reparse(&metadata)
            || capture_any_identity(&marker.path).ok() != marker.identity
        {
            return Err(StagingCleanupError::ForeignEntry);
        }
        if has_multiple_hard_links(&marker.path, &metadata) {
            return Err(StagingCleanupError::HardLink);
        }
        check_staging_release_budget(deadline, cancellation)?;
        if read_bounded(&marker.path).map_err(|_| StagingCleanupError::ForeignEntry)?
            != marker.bytes
        {
            return Err(StagingCleanupError::ForeignEntry);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn before_release_delete(
        &self,
        #[cfg_attr(not(test), allow(unused))] mutation_index: usize,
    ) -> Result<(), StagingCleanupError> {
        #[cfg(test)]
        if self.release_delete_failure_at.get() == Some(mutation_index) {
            self.release_delete_failure_at.set(None);
            return Err(StagingCleanupError::DeleteFailed);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn after_release_delete(
        &self,
        #[cfg_attr(not(test), allow(unused))] mutation_index: usize,
        #[cfg_attr(not(test), allow(unused))] cancellation: &AtomicBool,
    ) {
        #[cfg(test)]
        if self.release_cancel_after_delete_at.get() == Some(mutation_index) {
            self.release_cancel_after_delete_at.set(None);
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        }
    }

    #[cfg(windows)]
    fn validate_released_scope(&self) -> Result<(), StagingCleanupError> {
        for directory in [&self.producer_root, &self.shared_parent] {
            if validate_safe_chain(&directory.path).is_err()
                || !same_identity(&directory.path, directory.identity)
                || path_is_reparse(&directory.path).unwrap_or(true)
            {
                return Err(StagingCleanupError::Reparse);
            }
        }
        if path_exists(&self.group.path)
            || self
                .expected_root_paths
                .iter()
                .any(|path| path_exists(path))
        {
            return Err(StagingCleanupError::ForeignEntry);
        }
        Ok(())
    }

    /// Validate the exact owner predicate needed by activation-failure
    /// reconcile. This accepts complete and partial materialization, but it
    /// never treats a missing, changed, or foreign path as retained staging.
    #[cfg(windows)]
    pub(crate) fn validate_reconcile_retained_scope(
        &self,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), String> {
        check_staging_release_budget(deadline, cancellation).map_err(|error| {
            format!("Capture runtime retained staging budget ended: {error:?}.")
        })?;
        if self.scope_state == StagingScopeState::Released {
            return Err("Capture runtime retained staging had already been released.".into());
        }
        self.validate_scope_chain()
            .map_err(|error| format!("Capture runtime retained staging changed: {error:?}."))?;
        if !path_exists(&self.group.path) {
            return Err("Capture runtime retained staging group was missing.".into());
        }
        if let Some(marker) = self.marker.as_ref() {
            self.validate_release_marker(marker, deadline, cancellation)
                .map_err(|error| {
                    format!("Capture runtime retained staging marker changed: {error:?}.")
                })?;
        } else if path_exists(&self.group.path.join(MARKER_FILE_NAME)) {
            return Err("Capture runtime retained staging marker ownership was unknown.".into());
        }
        for (index, root) in self.roots.iter().enumerate() {
            check_staging_release_budget(deadline, cancellation).map_err(|error| {
                format!("Capture runtime retained staging budget ended: {error:?}.")
            })?;
            let Some(expected_path) = self.expected_root_paths.get(index) else {
                return Err("Capture runtime retained staging root ordering was invalid.".into());
            };
            if self.released_roots.get(index).copied().unwrap_or(false) {
                if path_exists(expected_path) {
                    return Err("Capture runtime released staging root reappeared.".into());
                }
                continue;
            }
            if root.path != *expected_path
                || root.identity.is_none()
                || !path_exists(expected_path)
                || !same_identity(expected_path, root.identity)
                || path_is_reparse(expected_path).unwrap_or(true)
                || !ensure_existing_directory(expected_path).is_ok()
            {
                return Err("Capture runtime retained staging root identity changed.".into());
            }
        }
        let entries = fs::read_dir(&self.group.path)
            .map_err(|_| "Capture runtime retained staging group could not be read.")?;
        for entry in entries {
            let path = entry
                .map_err(|_| "Capture runtime retained staging group entry was unreadable.")?
                .path();
            let is_marker = path == self.group.path.join(MARKER_FILE_NAME);
            let known_root = self.expected_root_paths.iter().any(|root| root == &path);
            if !is_marker && !known_root {
                return Err("Capture runtime retained staging contained a foreign entry.".into());
            }
        }
        Ok(())
    }

    /// Recheck the already released scope before the terminal CAS.  This is
    /// observation only: terminalization never recreates or deletes staging.
    #[cfg(windows)]
    pub(crate) fn revalidate_released_scope_for_terminal(
        &self,
        expected: &StagingReleasedObservation,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<(), String> {
        check_staging_release_budget(deadline, cancellation).map_err(|error| {
            format!("Capture runtime released staging budget ended: {error:?}.")
        })?;
        if self.scope_state != StagingScopeState::Released
            || self.released_observation.as_ref() != Some(expected)
            || !expected.matches_activation(&self.activation)
        {
            return Err(
                "Capture runtime released staging observation was not the exact owner.".into(),
            );
        }
        self.validate_released_scope().map_err(|error| {
            format!("Capture runtime released staging scope changed: {error:?}.")
        })?;
        check_staging_release_budget(deadline, cancellation).map_err(|error| {
            format!("Capture runtime released staging budget ended: {error:?}.")
        })?;
        Ok(())
    }

    #[cfg(windows)]
    fn released_observation_for_activation(&self) -> StagingReleasedObservation {
        StagingReleasedObservation {
            session_nonce: self.activation.descriptor.session_nonce().to_owned(),
            plan_digest: self.activation.journal_plan.plan_digest.clone(),
            group_staging_identity: self
                .activation
                .descriptor
                .group_staging_identity()
                .to_owned(),
        }
    }
}

impl RunStagingOwner {
    #[cfg(test)]
    pub(crate) fn inject_release_delete_failure_at_for_test(&self, mutation: usize) {
        self.release_delete_failure_at.set(Some(mutation));
    }

    #[cfg(test)]
    pub(crate) fn inject_release_cancel_after_delete_at_for_test(&self, mutation: usize) {
        self.release_cancel_after_delete_at.set(Some(mutation));
    }

    #[cfg(test)]
    pub(crate) fn inject_release_entry_limit_for_test(&self, limit: usize) {
        self.release_entry_limit.set(Some(limit));
    }

    #[cfg(test)]
    pub(crate) fn inject_release_depth_limit_for_test(&self, limit: usize) {
        self.release_depth_limit.set(Some(limit));
    }
}
