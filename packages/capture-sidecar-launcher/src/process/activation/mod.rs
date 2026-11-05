pub(crate) mod closing;
pub(crate) mod failure;
pub(crate) mod group;
pub(crate) mod launching;
pub(crate) mod reconcile;
pub(crate) mod running;
pub(crate) mod suspended;

pub(crate) use closing::*;
pub(crate) use failure::*;
pub(crate) use group::*;
pub(crate) use launching::*;
pub(crate) use reconcile::*;
pub(crate) use running::*;
pub(crate) use suspended::*;

#[cfg(windows)]
pub(crate) const GROUP_CLEANUP_BUDGET_MS: u32 = 5_000;

#[cfg(windows)]
pub(crate) const DROP_CLEANUP_WAIT_MS: u32 = 250;

#[cfg(windows)]
pub(crate) const NATIVE_NONCE_BYTES: usize = 16;

#[cfg(windows)]
pub(crate) type NativeNonce = [u8; NATIVE_NONCE_BYTES];

#[cfg(windows)]
pub(crate) const NATIVE_NONCE_ATTEMPTS: usize = 32;

#[cfg(windows)]
pub(crate) fn cancellation_requested(cancellation: Option<&AtomicBool>) -> bool {
    cancellation.is_some_and(|flag| flag.load(Ordering::Acquire))
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use crate::{
    journal_store::{ActivationBudget, CasDisposition, JournalStoreError},
    prepare::{PreparedGroup, ValidatedActivationContext},
    staging::{RunStagingOwner, StagingFailure},
};

#[cfg(all(test, windows))]
use crate::process::fixture::{
    acquire_http_fixture_permit, acquire_http_fixture_permit_with_budget, HttpFixturePermit,
    SCHEDULED_FIXTURES,
};

#[cfg(windows)]
/// Private producer activation coordinator. Every failed owned phase closes
/// the whole native Job and attempts the exact ReconcileRequired CAS under
/// the same absolute budget; callers never receive a partial Launching value.
pub(crate) fn activate_for_launch_with_budget(
    prepared: PreparedGroup,
    budget: &ActivationBudget,
) -> Result<LaunchingActivationOwner, PrivateActivationFailure> {
    if let Err(error) = budget.check() {
        let kind = match error {
            JournalStoreError::AdmissionCancelled => PrivateActivationFailureKind::Cancellation,
            JournalStoreError::AdmissionDeadline => PrivateActivationFailureKind::Deadline,
            _ => PrivateActivationFailureKind::Preparation,
        };
        return Err(PrivateActivationFailure {
            kind,
            #[cfg(test)]
            detail: activation_budget_error_detail(error),
            owner: None,
            committed_candidate: None,
        });
    }
    let activation = match prepared.consume_for_activation_with_budget(budget) {
        Ok(activation) => activation,
        Err(error) => {
            #[cfg_attr(not(test), allow(unused_variables))]
            let (kind, detail) = match budget.check() {
                Err(budget_error @ JournalStoreError::AdmissionCancelled)
                | Err(budget_error @ JournalStoreError::AdmissionDeadline) => {
                    let kind = match &budget_error {
                        JournalStoreError::AdmissionCancelled => {
                            PrivateActivationFailureKind::Cancellation
                        }
                        JournalStoreError::AdmissionDeadline => {
                            PrivateActivationFailureKind::Deadline
                        }
                        _ => unreachable!(),
                    };
                    (kind, activation_budget_error_detail(budget_error))
                }
                _ => (
                    PrivateActivationFailureKind::Preparation,
                    format!("Capture runtime activation preparation failed: {error:?}."),
                ),
            };
            return Err(PrivateActivationFailure {
                kind,
                #[cfg(test)]
                detail,
                owner: None,
                committed_candidate: None,
            });
        }
    };
    let suspended = match acquire_suspended_for_activation_with_budget(activation, budget) {
        Ok(owner) => owner,
        Err(failure) => return Err(private_failure_from_suspended_failure(failure, budget)),
    };
    let ready = match suspended.persist_ready_with_budget(budget) {
        Ok(owner) => owner,
        Err(failure) => return Err(private_failure_from_suspended_failure(failure, budget)),
    };
    match ready.launch_with_budget(budget) {
        Ok(owner) => Ok(owner),
        Err(failure) => Err(private_failure_from_launch_failure(failure, budget)),
    }
}

/// Consume one prepared group through the producer-owned activation and
/// Running-promotion phases.  The coordinator creates one absolute deadline
/// and one cancellation source for the whole handoff; no public activation
/// authority or timeout parameter is exposed at this seam.
#[cfg(windows)]
pub(crate) fn activate_prepared_group(
    prepared: PreparedGroup,
) -> Result<RunningActivationOwner, PrivateActivationFailure> {
    let cancellation = prepared.cancellation_arc();
    let budget = ActivationBudget::new(
        std::time::Instant::now() + std::time::Duration::from_secs(60),
        cancellation,
    );
    activate_prepared_group_with_budget(prepared, &budget)
}

/// Testable producer-private coordinator seam.  The caller supplies an
/// already-created budget so tests can force cancellation or expiry without
/// adding another clock read or a public timeout configuration.
#[cfg(windows)]
pub(crate) fn activate_prepared_group_with_budget(
    prepared: PreparedGroup,
    budget: &ActivationBudget,
) -> Result<RunningActivationOwner, PrivateActivationFailure> {
    let prepared_cancellation = prepared.cancellation_arc();
    let budget_cancellation = budget.cancellation_arc();
    if !Arc::ptr_eq(&prepared_cancellation, &budget_cancellation) {
        return Err(PrivateActivationFailure {
            kind: PrivateActivationFailureKind::Preparation,
            #[cfg(test)]
            detail:
                "Capture runtime activation budget did not carry the prepared cancellation source."
                    .into(),
            owner: None,
            committed_candidate: None,
        });
    }
    let launching = activate_for_launch_with_budget(prepared, budget)?;
    match launching
        .promote_running_with_cancellation(budget.deadline(), Some(budget.cancellation_arc()))
    {
        Ok(running) => Ok(running),
        Err(failure) => Err(private_failure_from_running_promotion_failure(
            failure, budget,
        )),
    }
}

#[cfg(all(test, windows))]
pub(crate) fn cleanup_activation_for_test(
    owner: SuspendedActivationOwner,
) -> SuspendedActivationOwner {
    match owner.cleanup_and_reconcile(&crate::journal_store::activation_budget_for_test()) {
        Ok(reconciled) => reconciled.owner,
        Err(failure) => failure.owner,
    }
}

#[cfg(windows)]
/// Budget-aware private native handoff.  The activation context is consumed
/// exactly once and all partial native owners remain attached to the staging
/// owner on failure.
pub(crate) fn acquire_suspended_for_activation_with_budget(
    activation: ValidatedActivationContext,
    budget: &ActivationBudget,
) -> Result<SuspendedActivationOwner, SuspendedActivationFailure> {
    acquire_suspended_for_activation_inner(activation, Some(budget))
}

#[cfg(windows)]
pub(crate) fn acquire_suspended_for_activation_inner(
    activation: ValidatedActivationContext,
    budget: Option<&ActivationBudget>,
) -> Result<SuspendedActivationOwner, SuspendedActivationFailure> {
    if let Some(budget) = budget {
        if let Err(error) = budget.check() {
            return Err(SuspendedActivationFailure {
                kind: activation_failure_kind_for_budget(&error),
                detail: activation_budget_error_detail(error),
                owner: None,
            });
        }
    }
    let _read_budget = budget.map(ActivationBudget::install_read_scope);
    let failure_context = Some(ActivationFailureJournalContext {
        store: Arc::clone(&activation.context.store),
        plan: activation.journal_plan.clone(),
        predecessor: activation.expected_journal.clone(),
        candidate: activation.expected_journal.clone(),
        disposition: CasDisposition::Prewrite,
    });
    #[cfg(all(test, windows))]
    let http_fixture_permit = if activation.descriptor.readiness_schema_context(0).is_some() {
        let scheduled = SCHEDULED_FIXTURES.with(|pending| {
            pending
                .borrow_mut()
                .remove(&(Arc::as_ptr(&activation.context.store) as usize))
        });
        let permit = match (scheduled, budget) {
            (Some(permit), _) => Ok(permit),
            (None, Some(budget)) => acquire_http_fixture_permit_with_budget(budget),
            (None, None) => acquire_http_fixture_permit(),
        };
        match permit {
            Ok(permit) => Some(permit),
            Err(error) => {
                let (kind, detail) = match budget.and_then(|budget| budget.check().err()) {
                    Some(JournalStoreError::AdmissionCancelled) => (
                        SuspendedActivationFailureKind::Cancellation,
                        activation_budget_error_detail(JournalStoreError::AdmissionCancelled),
                    ),
                    Some(JournalStoreError::AdmissionDeadline) => (
                        SuspendedActivationFailureKind::Deadline,
                        activation_budget_error_detail(JournalStoreError::AdmissionDeadline),
                    ),
                    _ => (
                        SuspendedActivationFailureKind::Staging,
                        format!(
                            "Capture runtime HTTP fixture concurrency permit was unavailable: {error:?}."
                        ),
                    ),
                };
                return Err(SuspendedActivationFailure {
                    kind,
                    detail,
                    owner: None,
                });
            }
        }
    } else {
        None
    };
    let staging_result = match budget {
        Some(budget) => crate::staging::materialize_with_budget(
            activation,
            budget.deadline(),
            budget.cancellation_arc(),
        ),
        None => crate::staging::materialize(activation),
    };
    let staging = match staging_result {
        Ok(owner) => owner,
        Err(StagingFailure::BeforeOwnership(kind)) => {
            return Err(SuspendedActivationFailure {
                kind: activation_failure_kind_for_staging_kind(kind),
                detail: format!("Capture runtime staging acquisition stopped: {kind:?}."),
                owner: None,
            });
        }
        Err(StagingFailure::Owned { owner, kind }) => {
            #[allow(unused_mut)]
            let mut owner = SuspendedActivationOwner {
                staging: owner,
                native: None,
                native_cleanup_proven: true,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            };
            return Err(SuspendedActivationFailure {
                kind: activation_failure_kind_for_staging_kind(kind),
                detail: format!("Capture runtime staging acquisition stopped: {kind:?}."),
                owner: Some(owner),
            });
        }
    };

    if let Some(budget) = budget {
        if let Err(error) = budget.check() {
            #[allow(unused_mut)]
            let mut owner = SuspendedActivationOwner {
                staging,
                native: None,
                native_cleanup_proven: true,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            };
            return Err(SuspendedActivationFailure {
                kind: activation_failure_kind_for_budget(&error),
                detail: activation_budget_error_detail(error),
                owner: Some(owner),
            });
        }
    }

    #[cfg(all(test, windows))]
    return acquire_suspended_from_staging_with_permit(
        staging,
        http_fixture_permit,
        failure_context,
        budget,
    );
    #[cfg(not(all(test, windows)))]
    acquire_suspended_from_staging_with_permit(staging, failure_context, budget)
}

#[cfg(windows)]
pub(crate) fn acquire_suspended_from_staging_with_permit(
    staging: RunStagingOwner,
    #[cfg(all(test, windows))] http_fixture_permit: Option<HttpFixturePermit>,
    failure_context: Option<ActivationFailureJournalContext>,
    budget: Option<&ActivationBudget>,
) -> Result<SuspendedActivationOwner, SuspendedActivationFailure> {
    if let Some(budget) = budget {
        if let Err(error) = budget.check() {
            #[allow(unused_mut)]
            let mut owner = SuspendedActivationOwner {
                staging,
                native: None,
                native_cleanup_proven: true,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            };
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Native(GroupNativeFailureKind::Setup),
                detail: activation_budget_error_detail(error),
                owner: Some(owner),
            });
        }
    }
    // Recheck the interval between staging materialization and Job creation.
    let mut commands = match staging.checked_commands() {
        Ok(commands) => commands,
        Err(_detail) => {
            #[allow(unused_mut)]
            let mut owner = SuspendedActivationOwner {
                staging,
                native: None,
                native_cleanup_proven: true,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            };
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Staging,
                detail: "Capture runtime frozen command revalidation failed before Job setup."
                    .into(),
                owner: Some(owner),
            });
        }
    };

    let native_result = match budget {
        Some(budget) => {
            SuspendedGroup::spawn_with_budget(&mut commands, budget, |ordinal, command| {
                staging.check_before_root_spawn(ordinal, command)
            })
        }
        None => SuspendedGroup::spawn_with_prespawn_check(&mut commands, |ordinal, command| {
            staging.check_before_root_spawn(ordinal, command)
        }),
    };
    let native = match native_result {
        Ok(native) => native,
        Err(failure) => {
            let native = failure.owner;
            #[allow(unused_mut)]
            let mut owner = SuspendedActivationOwner {
                staging,
                native_cleanup_proven: native.is_none(),
                native,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            };
            return Err(SuspendedActivationFailure {
                kind: SuspendedActivationFailureKind::Native(failure.kind),
                detail: failure.detail,
                owner: Some(owner),
            });
        }
    };

    let mut native = native;
    if let Err(detail) = native.binding_snapshot() {
        return Err(SuspendedActivationFailure {
            kind: SuspendedActivationFailureKind::Native(GroupNativeFailureKind::Membership),
            detail,
            owner: Some(SuspendedActivationOwner {
                staging,
                native: Some(native),
                native_cleanup_proven: false,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            }),
        });
    }
    if !staging.journal_is_still_prepared() {
        return Err(SuspendedActivationFailure {
            kind: SuspendedActivationFailureKind::Native(GroupNativeFailureKind::Membership),
            detail: "Capture runtime prepared binding changed after suspended acquisition.".into(),
            owner: Some(SuspendedActivationOwner {
                staging,
                native: Some(native),
                native_cleanup_proven: false,
                failure_context: failure_context.clone(),
                #[cfg(all(test, windows))]
                _http_fixture_permit: http_fixture_permit,
            }),
        });
    }

    Ok(SuspendedActivationOwner {
        staging,
        native: Some(native),
        native_cleanup_proven: false,
        failure_context,
        #[cfg(all(test, windows))]
        _http_fixture_permit: http_fixture_permit,
    })
}
