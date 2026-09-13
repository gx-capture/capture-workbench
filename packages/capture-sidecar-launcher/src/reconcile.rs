//! Producer-owned restart lookup foundation.
//!
//! This module deliberately stops at reading and validating the addressable
//! journal record. It does not observe native resources, mutate a journal, or
//! call the restart reconciliation transitions. Those operations require a
//! later producer-owned observer with explicit process and staging evidence.

#![allow(dead_code)]

use std::path::PathBuf;

use crate::{index::reopen_from_ref, prepare::ReconcileRef};

/// A sanitized reason for why a restarted record cannot yet be reported as a
/// completed terminal record. It intentionally contains no filesystem path,
/// native identifier, or storage diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartJournalReason {
    ActiveRecord,
    InvalidReference,
    RecordUnavailable,
    InvalidRecord,
}

/// Read-only semantic status from the producer restart lookup seam.
///
/// `TerminalRecord` reports only a previously committed, fully validated
/// terminal value. It is not a newly observed cleanup proof. Every other
/// status remains blocked until the later observe-only reconciliation seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartJournalStatus {
    TerminalRecord,
    ReconcileRequired { reason: RestartJournalReason },
}

/// The producer-owned context needed to resolve an opaque reference after a
/// restart. The constructor remains crate-private so a caller cannot select
/// an arbitrary root and turn it into cleanup authority.
pub(crate) struct ProducerJournalContext {
    producer_root: PathBuf,
}

impl ProducerJournalContext {
    pub(crate) fn from_configured_root(producer_root: PathBuf) -> Self {
        Self { producer_root }
    }
}

/// Read-only restart lookup. This is intentionally named as a lookup rather
/// than reconciliation: it performs no native/staging observation and no
/// journal CAS, so it cannot claim a completed reconciliation.
pub(crate) struct RestartJournalLookup {
    context: ProducerJournalContext,
}

impl RestartJournalLookup {
    pub(crate) fn new(context: ProducerJournalContext) -> Self {
        Self { context }
    }

    pub(crate) fn read_status(&self, reference: &ReconcileRef) -> RestartJournalStatus {
        let reopened = match reopen_from_ref(self.context.producer_root.clone(), reference.as_str())
        {
            Ok(reopened) => reopened,
            Err(error) => return Self::map_error(error),
        };

        // `reopen_from_ref` has already decoded and validated the complete
        // index, reconstructed the complete plan, and read the journal under
        // the store's lock. Keep this explicit guard at the semantic seam so
        // a future index implementation cannot turn an unvalidated terminal
        // value into a terminal result.
        if reopened
            .journal
            .validate_against_plan(&reopened.plan)
            .is_err()
        {
            return RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::InvalidRecord,
            };
        }

        if matches!(
            reopened.journal.state,
            crate::journal::JournalState::Terminal
        ) {
            RestartJournalStatus::TerminalRecord
        } else {
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        }
    }

    fn map_error(error: crate::index::AddressIndexError) -> RestartJournalStatus {
        use crate::{index::AddressIndexError, journal_store::JournalStoreError};

        let reason = match error {
            AddressIndexError::InvalidReference => RestartJournalReason::InvalidReference,
            AddressIndexError::InvalidRecord | AddressIndexError::ReferenceMismatch => {
                RestartJournalReason::InvalidRecord
            }
            AddressIndexError::PlanMismatch => RestartJournalReason::InvalidRecord,
            AddressIndexError::Storage(
                JournalStoreError::NotFound
                | JournalStoreError::InvalidConfig
                | JournalStoreError::PathSecurity,
            ) => RestartJournalReason::RecordUnavailable,
            AddressIndexError::Storage(_) => RestartJournalReason::InvalidRecord,
        };
        RestartJournalStatus::ReconcileRequired { reason }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        sync::Mutex,
    };

    use tempfile::{tempdir, TempDir};

    use super::*;
    use crate::{
        index::{persist_address_index, ReconcileAddressIndexV1},
        journal::{JournalPlanValue, JournalState, RuntimeSessionJournalV1},
        journal_store::JournalStore,
        prepare::{build_immutable_group_plan, PreparePlanDraft, PrepareRootDraft},
        prepare::{
            BindingAttemptId, CompleteGroupBinding, CompleteGroupBindingReceiptV1, PersistError,
            ReconcileRefSink, VerifiedGroupBinding,
        },
    };

    const SPEC_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Default)]
    struct TestSink {
        binding: Mutex<Option<CompleteGroupBinding>>,
    }

    impl ReconcileRefSink for TestSink {
        fn persist(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            binding: &CompleteGroupBinding,
        ) -> Result<(), PersistError> {
            *self.binding.lock().expect("sink lock") =
                Some(CompleteGroupBinding::decode(&binding.encode()?)?);
            Ok(())
        }

        fn read_back(
            &self,
            _binding_attempt_id: &BindingAttemptId,
        ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
            CompleteGroupBindingReceiptV1::from_binding(
                self.binding
                    .lock()
                    .expect("sink lock")
                    .clone()
                    .ok_or(PersistError::Storage)?,
            )
        }

        fn verify(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            _expected: &CompleteGroupBinding,
            read_back: &CompleteGroupBindingReceiptV1,
        ) -> Result<VerifiedGroupBinding, PersistError> {
            VerifiedGroupBinding::from_receipt(read_back.clone())
        }
    }

    struct Fixture {
        directory: TempDir,
        group_ref: ReconcileRef,
        root_refs: Vec<ReconcileRef>,
        plan: JournalPlanValue,
        store: std::sync::Arc<JournalStore>,
    }

    fn fixture(root_count: usize) -> Fixture {
        let directory = tempdir().expect("fixture directory");
        let roots = (0..root_count)
            .map(|ordinal| PrepareRootDraft {
                ordinal: ordinal as u32,
                role: format!("root-{ordinal}"),
                root_generation: ordinal as u64 + 1,
                spec_digest: SPEC_DIGEST.into(),
                reserved_listener_identity: format!("listener-{ordinal}"),
            })
            .collect();
        let plan = build_immutable_group_plan(
            PreparePlanDraft {
                group_generation: 1,
                roots,
            },
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("immutable plan");
        let group_ref = plan.context.group_ref_for_test();
        let root_refs = plan.context.root_refs_for_test();
        let journal = RuntimeSessionJournalV1::planned(
            &plan.value,
            plan.context.session_nonce.clone(),
            "2026-01-01T00:00:00Z".into(),
        )
        .expect("planned journal");
        plan.context
            .store
            .create_initial(&plan.value, &journal)
            .expect("initial journal");
        let root_ref_values = root_refs
            .iter()
            .map(|root_ref| root_ref.as_str().to_owned())
            .collect::<Vec<_>>();
        let index = ReconcileAddressIndexV1::from_plan(
            &plan.value,
            plan.context.session_nonce.clone(),
            group_ref.as_str().into(),
            &root_ref_values,
        )
        .expect("address index");
        persist_address_index(&plan.context.store, &index).expect("persist index");

        Fixture {
            directory,
            group_ref,
            root_refs,
            plan: plan.value,
            store: plan.context.store.clone(),
        }
    }

    fn lookup(directory: &Path) -> RestartJournalLookup {
        RestartJournalLookup::new(ProducerJournalContext::from_configured_root(
            directory.to_path_buf(),
        ))
    }

    fn journal_path(directory: &Path) -> PathBuf {
        directory
            .read_dir()
            .expect("directory")
            .map(|entry| entry.expect("entry").path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("runtime-session-") && name.ends_with(".json")
                    })
            })
            .expect("journal path")
    }

    fn mutate_journal(directory: &Path, mutation: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let path = journal_path(directory);
        let original = fs::read(&path).expect("journal bytes");
        let mut value: serde_json::Value = serde_json::from_slice(&original).expect("journal json");
        mutation(&mut value);
        let bytes = serde_json::to_vec(&value).expect("journal bytes");
        fs::write(path, &bytes).expect("write journal fixture");
        bytes
    }

    #[test]
    fn lookup_reopens_from_new_context_without_the_plan_address_map() {
        let fixture = fixture(2);
        let first = lookup(fixture.directory.path());
        assert_eq!(
            first.read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
        drop(first);

        let second = lookup(fixture.directory.path());
        assert_eq!(
            second.read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
        for root_ref in &fixture.root_refs {
            assert_eq!(
                second.read_status(root_ref),
                RestartJournalStatus::ReconcileRequired {
                    reason: RestartJournalReason::ActiveRecord,
                }
            );
        }
    }

    #[test]
    fn lookup_can_run_in_a_fresh_process_without_native_or_journal_mutation() {
        let fixture = fixture(1);
        let child = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg("reconcile::tests::fresh_process_child_lookup")
            .arg("--nocapture")
            .env("CAPTURE_RECONCILE_TEST_ROOT", fixture.directory.path())
            .env("CAPTURE_RECONCILE_TEST_REF", fixture.group_ref.as_str())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("fresh lookup child");
        assert!(child.success());
        assert_eq!(
            lookup(fixture.directory.path()).read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
    }

    #[test]
    fn fresh_process_child_lookup() {
        let Ok(root) = std::env::var("CAPTURE_RECONCILE_TEST_ROOT") else {
            return;
        };
        let reference = std::env::var("CAPTURE_RECONCILE_TEST_REF").expect("opaque ref");
        let status = lookup(Path::new(&root)).read_status(&ReconcileRef::from_test(reference));
        assert_eq!(
            status,
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord,
            }
        );
    }

    #[test]
    fn terminal_record_is_reported_only_after_strict_plan_bound_validation() {
        let fixture = fixture(1);
        let valid_bytes = mutate_journal(fixture.directory.path(), |record| {
            record["state"] = serde_json::json!("terminal");
            record["journalRevision"] = serde_json::json!(1);
            record["updatedAt"] = serde_json::json!("2026-01-01T00:00:01Z");
            record["proof"] = serde_json::json!({
                "rootReaped": true,
                "descendantsTerminated": true,
                "listenersReleased": true,
                "stagingReleased": true,
                "proofGeneration": 1,
                "unacquiredRootBindings": [],
            });
        });
        assert_eq!(
            lookup(fixture.directory.path()).read_status(&fixture.group_ref),
            RestartJournalStatus::TerminalRecord
        );

        let invalid_bytes = mutate_journal(fixture.directory.path(), |record| {
            record["proof"]["rootReaped"] = serde_json::json!(false);
        });
        assert_eq!(
            lookup(fixture.directory.path()).read_status(&fixture.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::InvalidRecord,
            }
        );
        assert_ne!(invalid_bytes, valid_bytes);
        let path = journal_path(fixture.directory.path());
        assert_eq!(
            fs::read(path).expect("unchanged invalid record"),
            invalid_bytes
        );
    }

    #[test]
    fn unknown_foreign_and_torn_records_are_sanitized_and_untouched() {
        let primary = fixture(2);
        let foreign = fixture(1);
        assert_eq!(
            lookup(primary.directory.path()).read_status(&foreign.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::RecordUnavailable,
            }
        );
        assert_eq!(
            lookup(tempdir().expect("wrong root").path()).read_status(&primary.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::RecordUnavailable,
            }
        );

        let path = journal_path(primary.directory.path());
        let original = fs::read(&path).expect("journal");
        fs::write(&path, br#"{"schemaVersion":"RuntimeSessionJournalV1"}"#).expect("torn journal");
        assert_eq!(
            lookup(primary.directory.path()).read_status(&primary.group_ref),
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::InvalidRecord,
            }
        );
        assert_eq!(
            fs::read(&path).expect("torn bytes retained"),
            br#"{"schemaVersion":"RuntimeSessionJournalV1"}"#
        );
        fs::write(&path, original).expect("restore fixture");
    }

    #[test]
    fn prepared_state_is_never_reopened_as_an_activation_permit() {
        let directory = tempdir().expect("fixture directory");
        let plan = build_immutable_group_plan(
            PreparePlanDraft {
                group_generation: 1,
                roots: vec![PrepareRootDraft {
                    ordinal: 0,
                    role: "root-0".into(),
                    root_generation: 1,
                    spec_digest: SPEC_DIGEST.into(),
                    reserved_listener_identity: "listener-0".into(),
                }],
            },
            directory.path().to_path_buf(),
            "session-1".into(),
        )
        .expect("immutable plan");
        let group_ref = plan.context.group_ref_for_test();
        let sink = TestSink::default();
        let prepared = crate::prepare::prepare_group(&plan, &sink).expect("prepared value");
        drop(prepared);

        let status = lookup(directory.path()).read_status(&group_ref);
        assert!(matches!(
            status,
            RestartJournalStatus::ReconcileRequired {
                reason: RestartJournalReason::ActiveRecord
            }
        ));
        assert_eq!(plan.value.roots.len(), 1);
        assert_eq!(
            plan.context.store.read(&plan.value).unwrap().state,
            JournalState::PreparedBound
        );
    }
}
