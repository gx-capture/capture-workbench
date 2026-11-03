use std::{fs, path::Path};

#[cfg(windows)]
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

#[cfg(test)]
use std::cell::Cell;

#[cfg(windows)]
use crate::journal_store::install_running_read_budget;

use crate::prepare::ValidatedActivationContext;

#[cfg(all(test, windows))]
use super::super::budget::{
    cancel_materialize_after_group_mkdir_for_test, cancel_materialize_after_marker_for_test,
};
use super::super::{
    budget::StagingBudget,
    failure::{StagingFailure, StagingFailureKind},
    identity::{
        capture_directory_identity, ensure_existing_directory, ensure_path_absent_and_safe,
        path_is_reparse, same_identity, validate_safe_chain,
    },
    marker::{
        create_marker, OwnedMarker, RunStagingMarkerRoot, RunStagingMarkerV1, MARKER_FILE_NAME,
        MARKER_PRODUCER, MARKER_SCHEMA_VERSION, MAX_MARKER_BYTES,
    },
    scope_digest::root_identity_digest,
};
use super::{
    journal::journal_is_exactly_prepared_with_budget, OwnedDirectory, RunStagingOwner,
    StagingScopeState,
};

#[cfg(all(test, windows))]
use super::BudgetActivationFixture;

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_ROOT_MKDIR: Cell<u32> = const { Cell::new(u32::MAX) };
}

/// Consume the validated activation handoff and materialize its producer-
/// planned, empty directory scope.  The journal snapshot is read while the
/// tree is still untouched, immediately before the first mkdir.
pub(crate) fn materialize(
    activation: ValidatedActivationContext,
) -> Result<RunStagingOwner, StagingFailure> {
    materialize_impl(activation, &StagingBudget::unbounded())
}

/// Budgeted pre-native materialization for the activation coordinator.  The
/// journal/index reads use the same scoped budget as the filesystem checks;
/// this function never acquires native resources or returns a success after
/// the deadline/cancellation boundary.
#[cfg(windows)]
pub(crate) fn materialize_with_budget(
    activation: ValidatedActivationContext,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
) -> Result<RunStagingOwner, StagingFailure> {
    let _read_budget = install_running_read_budget(deadline, Arc::clone(&cancellation));
    let budget = StagingBudget::bounded(deadline, cancellation);
    materialize_impl(activation, &budget)
}

fn materialize_impl(
    activation: ValidatedActivationContext,
    budget: &StagingBudget,
) -> Result<RunStagingOwner, StagingFailure> {
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    let producer_root_path = activation.descriptor.producer_root().to_path_buf();
    let expected_root_paths = activation
        .descriptor
        .planned_root_staging_paths()
        .collect::<Vec<_>>();
    if expected_root_paths.is_empty()
        || expected_root_paths.iter().any(|path| {
            path.parent().is_none() || path.file_name().is_none() || !path.is_absolute()
        })
    {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    let expected_root_paths = expected_root_paths
        .into_iter()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    let group_path = activation.descriptor.planned_group_staging_path();
    if expected_root_paths.first().and_then(|path| path.parent()) != Some(group_path.as_path()) {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    match journal_is_exactly_prepared_with_budget(&activation, budget) {
        Ok(true) => {}
        Ok(false) => {
            return Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::JournalChanged,
            ));
        }
        Err(kind) => return Err(StagingFailure::BeforeOwnership(kind)),
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    // Verify every executable before creating even the shared staging
    // directory.  A later per-root check rechecks the artifact before each
    // spawn; this does not eliminate path/content TOCTOU.
    if activation.descriptor.checked_commands().is_err() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::InvalidActivation,
        ));
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if validate_safe_chain(&producer_root_path).is_err() {
        return Err(StagingFailure::BeforeOwnership(StagingFailureKind::Reparse));
    }

    let shared_parent = group_path.parent().ok_or(StagingFailure::BeforeOwnership(
        StagingFailureKind::InvalidActivation,
    ))?;
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if ensure_existing_directory(shared_parent).is_err() {
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::BeforeOwnership(kind));
        }
        if let Err(error) = fs::create_dir(shared_parent) {
            if let Err(kind) = budget.check() {
                return Err(StagingFailure::BeforeOwnership(kind));
            }
            if error.kind() != std::io::ErrorKind::AlreadyExists
                || ensure_existing_directory(shared_parent).is_err()
            {
                return Err(StagingFailure::BeforeOwnership(
                    StagingFailureKind::SharedParent,
                ));
            }
        }
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if path_is_reparse(shared_parent).unwrap_or(true) {
        return Err(StagingFailure::BeforeOwnership(StagingFailureKind::Reparse));
    }
    let producer_root_identity = capture_directory_identity(&producer_root_path).ok();
    let shared_parent_identity = capture_directory_identity(shared_parent).ok();
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if producer_root_identity.is_none() || shared_parent_identity.is_none() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::RootIdentity,
        ));
    }

    if ensure_path_absent_and_safe(&group_path).is_err() {
        return Err(StagingFailure::BeforeOwnership(
            StagingFailureKind::GroupCollision,
        ));
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::BeforeOwnership(kind));
    }
    if let Err(error) = fs::create_dir(&group_path) {
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::BeforeOwnership(kind));
        }
        return Err(StagingFailure::BeforeOwnership(
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                StagingFailureKind::GroupCollision
            } else {
                StagingFailureKind::Durability
            },
        ));
    }
    let group_identity = capture_directory_identity(&group_path).ok();
    let mut owner = RunStagingOwner {
        activation,
        producer_root: OwnedDirectory {
            path: producer_root_path,
            identity: producer_root_identity,
        },
        shared_parent: OwnedDirectory {
            path: shared_parent.to_path_buf(),
            identity: shared_parent_identity,
        },
        group: OwnedDirectory {
            path: group_path.clone(),
            identity: group_identity,
        },
        marker: None,
        roots: Vec::new(),
        expected_root_paths,
        scope_state: StagingScopeState::Partial,
        released_roots: Vec::new(),
        marker_released: false,
        released_observation: None,
        #[cfg(test)]
        journal_drift_before_root: Cell::new(None),
        #[cfg(test)]
        journal_drift_before_ready: Cell::new(false),
        #[cfg(test)]
        release_delete_failure_at: Cell::new(None),
        #[cfg(test)]
        release_cancel_after_delete_at: Cell::new(None),
        #[cfg(test)]
        release_entry_limit: Cell::new(None),
        #[cfg(test)]
        release_depth_limit: Cell::new(None),
    };
    budget.cancel_after_group_mkdir_if_requested();
    if owner.group.identity.is_none() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::RootIdentity,
        });
    }
    if !owner.scope_chain_is_owned() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::Reparse,
        });
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }

    let marker_path = group_path.join(MARKER_FILE_NAME);
    if ensure_path_absent_and_safe(&marker_path).is_err() {
        return Err(StagingFailure::Owned {
            owner,
            kind: StagingFailureKind::MarkerCollision,
        });
    }
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }
    let marker_bytes = match marker_bytes(&owner) {
        Ok(bytes) => bytes,
        Err(kind) => {
            return Err(StagingFailure::Owned { owner, kind });
        }
    };
    let marker = match create_marker(&marker_path, &marker_bytes, budget) {
        Ok(marker) => marker,
        Err((kind, identity, bytes)) => {
            if identity.is_some() {
                owner.marker = Some(OwnedMarker {
                    path: marker_path,
                    identity,
                    bytes,
                });
            }
            return Err(StagingFailure::Owned { owner, kind });
        }
    };
    owner.marker = Some(marker);
    budget.cancel_after_marker_if_requested();
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }

    for (_ordinal, root_path) in owner.expected_root_paths.clone().into_iter().enumerate() {
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::Owned { owner, kind });
        }
        if validate_safe_chain(&group_path).is_err()
            || ensure_existing_directory(&group_path).is_err()
            || path_is_reparse(&group_path).unwrap_or(true)
            || !same_identity(&group_path, owner.group.identity)
        {
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::Reparse,
            });
        }
        if ensure_path_absent_and_safe(&root_path).is_err() {
            if let Err(kind) = budget.check() {
                return Err(StagingFailure::Owned { owner, kind });
            }
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::RootCollision,
            });
        }
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::Owned { owner, kind });
        }
        #[cfg(test)]
        if FAIL_NEXT_ROOT_MKDIR.with(|fault| {
            if fault.get() == _ordinal as u32 {
                fault.set(u32::MAX);
                true
            } else {
                false
            }
        }) {
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::Durability,
            });
        }
        if let Err(error) = fs::create_dir(&root_path) {
            if let Err(kind) = budget.check() {
                return Err(StagingFailure::Owned { owner, kind });
            }
            return Err(StagingFailure::Owned {
                owner,
                kind: if error.kind() == std::io::ErrorKind::AlreadyExists {
                    StagingFailureKind::RootCollision
                } else {
                    StagingFailureKind::Durability
                },
            });
        }
        let identity = capture_directory_identity(&root_path).ok();
        owner.roots.push(OwnedDirectory {
            path: root_path,
            identity,
        });
        owner.released_roots.push(false);
        if owner.roots.last().and_then(|root| root.identity).is_none() {
            return Err(StagingFailure::Owned {
                owner,
                kind: StagingFailureKind::RootIdentity,
            });
        }
        if let Err(kind) = budget.check() {
            return Err(StagingFailure::Owned { owner, kind });
        }
    }
    owner.scope_state = StagingScopeState::Complete;
    if let Err(kind) = budget.check() {
        return Err(StagingFailure::Owned { owner, kind });
    }
    Ok(owner)
}

fn marker_bytes(owner: &RunStagingOwner) -> Result<Vec<u8>, StagingFailureKind> {
    let descriptor = &owner.activation.descriptor;
    let roots = owner
        .activation
        .journal_plan
        .roots
        .iter()
        .map(|root| RunStagingMarkerRoot {
            ordinal: root.ordinal,
            root_identity_digest: root_identity_digest(
                descriptor.group_staging_identity(),
                root.ordinal,
                root,
            ),
        })
        .collect::<Vec<_>>();
    let marker = RunStagingMarkerV1 {
        schema_version: MARKER_SCHEMA_VERSION.into(),
        producer: MARKER_PRODUCER.into(),
        session_nonce: descriptor.session_nonce().into(),
        plan_digest: owner.activation.journal_plan.plan_digest.clone(),
        group_staging_identity: descriptor.group_staging_identity().into(),
        roots,
    };
    let encoded = serde_json::to_vec(&marker).map_err(|_| StagingFailureKind::MarkerWrite)?;
    if encoded.len() > MAX_MARKER_BYTES {
        return Err(StagingFailureKind::MarkerWrite);
    }
    Ok(encoded)
}

#[cfg(test)]
pub(crate) fn fail_next_root_mkdir_for_test(ordinal: u32) {
    FAIL_NEXT_ROOT_MKDIR.with(|fault| fault.set(ordinal));
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        sync::{atomic::AtomicBool, Arc},
        time::{Duration, Instant},
    };

    use super::*;

    #[cfg(windows)]
    #[test]
    fn budget_expiry_before_ownership_has_zero_private_group_effect() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() - Duration::from_millis(1),
            Arc::new(AtomicBool::new(false)),
        );

        assert!(matches!(
            result,
            Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::Deadline
            ))
        ));
        assert!(!group.exists(), "expired admission created a private group");
    }

    #[cfg(windows)]
    #[test]
    fn budget_cancellation_before_ownership_has_zero_private_group_effect() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(true)),
        );

        assert!(matches!(
            result,
            Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::Cancelled
            ))
        ));
        assert!(
            !group.exists(),
            "cancelled admission created a private group"
        );
    }

    #[cfg(windows)]
    #[test]
    fn budget_cancellation_after_group_mkdir_returns_the_owned_owner() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        cancel_materialize_after_group_mkdir_for_test();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        );

        match result {
            Err(StagingFailure::Owned { owner, kind }) => {
                assert_eq!(kind, StagingFailureKind::Cancelled);
                assert_eq!(owner.group.path, group);
                assert!(owner.group.path.is_dir());
                assert!(owner.marker.is_none());
                assert!(owner.roots.is_empty());
            }
            Err(StagingFailure::BeforeOwnership(kind)) => {
                panic!("cancellation happened before ownership: {kind:?}")
            }
            Ok(_) => panic!("cancellation was reported as success"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn budget_cancellation_after_marker_readback_returns_marker_owner() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        cancel_materialize_after_marker_for_test();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        );

        match result {
            Err(StagingFailure::Owned { owner, kind }) => {
                assert_eq!(kind, StagingFailureKind::Cancelled);
                let marker = owner.marker.as_ref().expect("retained marker owner");
                assert_eq!(owner.group.path, group);
                assert!(marker.path.is_file());
                assert!(owner.roots.is_empty());
            }
            Err(StagingFailure::BeforeOwnership(kind)) => {
                panic!("marker cancellation happened before ownership: {kind:?}")
            }
            Ok(_) => panic!("marker cancellation was reported as success"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn budgeted_materialization_reports_journal_lock_deadline_before_group_creation() {
        let fixture = BudgetActivationFixture::new();
        let group = fixture.group_path();
        let holder = fixture
            .activation
            .context
            .store
            .lock_for_test()
            .expect("journal lock holder");
        let started = Instant::now();
        let result = materialize_with_budget(
            fixture.activation,
            Instant::now() + Duration::from_millis(100),
            Arc::new(AtomicBool::new(false)),
        );
        let elapsed = started.elapsed();
        drop(holder);

        assert!(matches!(
            result,
            Err(StagingFailure::BeforeOwnership(
                StagingFailureKind::Deadline
            ))
        ));
        assert!(!group.exists(), "lock timeout created a private group");
        assert!(
            elapsed < Duration::from_secs(1),
            "budgeted lock read exceeded its bounded wait: {elapsed:?}"
        );
    }
}
