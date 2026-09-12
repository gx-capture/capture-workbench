//! Producer-built prepare-only group seam.
//!
//! The opaque plan carries the concrete producer-owned journal store and
//! session identity in memory. Only its journal value is validated and passed
//! to the private journal codec; the context and the future native launch
//! inputs are never serialized.

#![allow(dead_code)]

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    index::{
        canonical_plan_digest, digest_opaque_ref, fresh_address_key, group_ref_for,
        persist_address_index, root_ref_for, AddressIndexError, ReconcileAddressIndexV1,
    },
    journal::{
        BoundRoot, CasSnapshot, JournalBinding, JournalError, JournalPlanValue, JournalState,
        RuntimeSessionJournalV1,
    },
    journal_store::{JournalStore, JournalStoreCommand, JournalStoreConfig, JournalStoreError},
};

const RECEIPT_DOMAIN: &[u8] = b"capture-runtime/group-binding-receipt/v1\0";

/// The producer-created plan is opaque until the later external construction
/// integration. Its private context is deliberately absent from the journal.
pub struct ImmutableGroupPlan {
    pub(crate) value: JournalPlanValue,
    pub(crate) context: Arc<PreparePlanContext>,
}

pub(crate) struct PreparePlanContext {
    pub(crate) store: Arc<JournalStore>,
    producer_root: PathBuf,
    pub(crate) session_nonce: String,
    group_ref: ReconcileRef,
    root_refs: Vec<ReconcileRef>,
    // This map is only an in-process convenience for the current opaque plan.
    // Durable restart addressing is supplied by the immutable ref index; the
    // journal remains the lifecycle authority.
    ref_addresses: HashMap<ReconcileRef, ReconcileRefAddress>,
    clock: Arc<dyn PrepareClock + Send + Sync>,
    pub(crate) activation_descriptor: Option<Arc<crate::launcher::FrozenActivationDescriptor>>,
}

/// The producer supplies semantic plan inputs; opaque references and all
/// reference-derived digests are finalized together by the producer builder.
/// A finalized `JournalPlanValue` is never silently rewritten.
pub(crate) struct PreparePlanDraft {
    pub(crate) group_generation: u64,
    pub(crate) roots: Vec<PrepareRootDraft>,
}

pub(crate) struct PrepareRootDraft {
    pub(crate) ordinal: u32,
    pub(crate) role: String,
    pub(crate) root_generation: u64,
    pub(crate) spec_digest: String,
    pub(crate) reserved_listener_identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReconcileRefKind {
    Group,
    Root { ordinal: u32 },
}

struct ReconcileRefAddress {
    store: Arc<JournalStore>,
    kind: ReconcileRefKind,
}

impl PreparePlanContext {
    fn address_of(&self, reference: &ReconcileRef) -> Option<&ReconcileRefAddress> {
        self.ref_addresses.get(reference)
    }

    /// Resolves a producer reference to the already-bound store and its
    /// group/root slot. The store owns the session/plan-derived journal
    /// address; the reference never becomes a user-controlled path.
    pub(crate) fn resolve_address(
        &self,
        reference: &ReconcileRef,
    ) -> Option<(Arc<JournalStore>, Option<u32>)> {
        let address = self.address_of(reference)?;
        let ordinal = match address.kind {
            ReconcileRefKind::Group => None,
            ReconcileRefKind::Root { ordinal } => Some(ordinal),
        };
        Some((Arc::clone(&address.store), ordinal))
    }

    fn addresses_are_complete(&self) -> bool {
        if self.ref_addresses.len() != self.root_refs.len() + 1 {
            return false;
        }
        let Some(group) = self.address_of(&self.group_ref) else {
            return false;
        };
        if group.kind != ReconcileRefKind::Group || !Arc::ptr_eq(&group.store, &self.store) {
            return false;
        }
        self.root_refs
            .iter()
            .enumerate()
            .all(|(ordinal, root_ref)| {
                let Some(address) = self.address_of(root_ref) else {
                    return false;
                };
                address.kind
                    == ReconcileRefKind::Root {
                        ordinal: ordinal as u32,
                    }
                    && Arc::ptr_eq(&address.store, &self.store)
            })
    }
}

trait PrepareClock {
    fn now(&self) -> Result<String, PrepareError>;
}

struct SystemPrepareClock;

impl PrepareClock for SystemPrepareClock {
    fn now(&self) -> Result<String, PrepareError> {
        system_timestamp()
    }
}

/// Builds the producer-only opaque plan. External plan construction is a
/// later integration slice; this private builder is the only foundation
/// constructor in the current crate.
pub(crate) fn build_immutable_group_plan(
    draft: PreparePlanDraft,
    producer_root: PathBuf,
    session_nonce: String,
) -> Result<ImmutableGroupPlan, PrepareError> {
    build_immutable_group_plan_with_clock(
        draft,
        producer_root,
        session_nonce,
        Arc::new(SystemPrepareClock),
    )
}

pub(crate) fn build_immutable_group_plan_from_activation(
    descriptor: Arc<crate::launcher::FrozenActivationDescriptor>,
) -> Result<ImmutableGroupPlan, PrepareError> {
    let draft = descriptor
        .to_prepare_draft()
        .map_err(|_| PrepareError::InvalidPlan)?;
    build_immutable_group_plan_with_clock_and_activation(
        draft,
        descriptor.producer_root().to_path_buf(),
        descriptor.session_nonce().to_owned(),
        Arc::new(SystemPrepareClock),
        Some(descriptor),
    )
}

fn build_immutable_group_plan_with_clock(
    draft: PreparePlanDraft,
    producer_root: PathBuf,
    session_nonce: String,
    clock: Arc<dyn PrepareClock + Send + Sync>,
) -> Result<ImmutableGroupPlan, PrepareError> {
    build_immutable_group_plan_with_clock_and_activation(
        draft,
        producer_root,
        session_nonce,
        clock,
        None,
    )
}

fn build_immutable_group_plan_with_clock_and_activation(
    draft: PreparePlanDraft,
    producer_root: PathBuf,
    session_nonce: String,
    clock: Arc<dyn PrepareClock + Send + Sync>,
    activation_descriptor: Option<Arc<crate::launcher::FrozenActivationDescriptor>>,
) -> Result<ImmutableGroupPlan, PrepareError> {
    validate_draft(&draft)?;
    let address_key = fresh_address_key().map_err(|_| PrepareError::ReferenceGeneration)?;
    let group_ref =
        ReconcileRef(group_ref_for(&address_key).map_err(|_| PrepareError::ReferenceGeneration)?);
    group_ref
        .validate()
        .map_err(|_| PrepareError::ReferenceGeneration)?;
    let root_refs = (0..draft.roots.len())
        .map(|ordinal| {
            Ok(ReconcileRef(
                root_ref_for(&address_key, ordinal as u32)
                    .map_err(|_| PrepareError::ReferenceGeneration)?,
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for root_ref in &root_refs {
        root_ref
            .validate()
            .map_err(|_| PrepareError::ReferenceGeneration)?;
    }
    let value = finalized_plan_value(&draft, &group_ref, &root_refs)?;
    let context_producer_root = producer_root.clone();
    let config = JournalStoreConfig::new(
        producer_root,
        session_nonce.clone(),
        value.plan_digest.clone(),
    )
    .map_err(map_store_error)?;
    let store = Arc::new(JournalStore::new(config).map_err(map_store_error)?);
    let mut ref_addresses = HashMap::with_capacity(root_refs.len() + 1);
    ref_addresses.insert(
        group_ref.clone(),
        ReconcileRefAddress {
            store: Arc::clone(&store),
            kind: ReconcileRefKind::Group,
        },
    );
    for (ordinal, root_ref) in root_refs.iter().enumerate() {
        if ref_addresses
            .insert(
                root_ref.clone(),
                ReconcileRefAddress {
                    store: Arc::clone(&store),
                    kind: ReconcileRefKind::Root {
                        ordinal: ordinal as u32,
                    },
                },
            )
            .is_some()
        {
            return Err(PrepareError::ReferenceGeneration);
        }
    }
    Ok(ImmutableGroupPlan {
        value,
        context: Arc::new(PreparePlanContext {
            store,
            producer_root: context_producer_root,
            session_nonce,
            group_ref,
            root_refs,
            ref_addresses,
            clock,
            activation_descriptor,
        }),
    })
}

fn validate_draft(draft: &PreparePlanDraft) -> Result<(), PrepareError> {
    if draft.group_generation == 0 || draft.roots.is_empty() {
        return Err(PrepareError::InvalidPlan);
    }
    for (index, root) in draft.roots.iter().enumerate() {
        if root.ordinal != index as u32
            || root.root_generation == 0
            || root.role.is_empty()
            || root.role.len() > 256
        {
            return Err(PrepareError::InvalidPlan);
        }
        validate_digest_value(&root.spec_digest)?;
        validate_opaque_value(&root.reserved_listener_identity)
            .map_err(|_| PrepareError::InvalidPlan)?;
    }
    Ok(())
}

fn finalized_plan_value(
    draft: &PreparePlanDraft,
    group_ref: &ReconcileRef,
    root_refs: &[ReconcileRef],
) -> Result<JournalPlanValue, PrepareError> {
    if root_refs.len() != draft.roots.len() {
        return Err(PrepareError::InvalidPlan);
    }
    let group_ref_digest = digest_ref(group_ref)?;
    let roots = draft
        .roots
        .iter()
        .zip(root_refs)
        .map(|(root, root_ref)| {
            Ok(crate::journal::PlannedRoot {
                ordinal: root.ordinal,
                role: root.role.clone(),
                root_ref_digest: digest_ref(root_ref)?,
                root_generation: root.root_generation,
                spec_digest: root.spec_digest.clone(),
                reserved_listener_identity: root.reserved_listener_identity.clone(),
            })
        })
        .collect::<Result<Vec<_>, PrepareError>>()?;
    let plan_digest = digest_plan(&group_ref_digest, draft.group_generation, &roots)?;
    let value = JournalPlanValue {
        plan_digest,
        group_ref_digest,
        group_generation: draft.group_generation,
        roots,
    };
    value.validate().map_err(|_| PrepareError::InvalidPlan)?;
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareError {
    InvalidPlan,
    InvalidTimestamp,
    InvalidBinding,
    ReferenceGeneration,
    JournalAlreadyExists,
    JournalConflict,
    JournalCorrupt,
    JournalTooLarge,
    JournalAmbiguous,
    JournalUnavailable,
    Binding(PersistError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistError {
    InvalidRecord,
    Storage,
    Rejected,
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRecord => "binding record was invalid",
            Self::Storage => "binding storage failed",
            Self::Rejected => "binding was rejected",
        })
    }
}

impl std::error::Error for PersistError {}

impl std::fmt::Display for PrepareError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Binding(error) => write!(formatter, "binding persistence failed: {error}"),
            other => formatter.write_str(match other {
                Self::InvalidPlan => "group plan was invalid",
                Self::InvalidTimestamp => "prepare timestamp was invalid",
                Self::InvalidBinding => "group binding was invalid",
                Self::ReferenceGeneration => "opaque reference generation failed",
                Self::JournalAlreadyExists => "group journal already exists",
                Self::JournalConflict => "group journal CAS conflicted",
                Self::JournalCorrupt => "group journal was corrupt",
                Self::JournalTooLarge => "group journal exceeded its size limit",
                Self::JournalAmbiguous => "group journal write outcome was ambiguous",
                Self::JournalUnavailable => "group journal was unavailable",
                Self::Binding(_) => unreachable!(),
            }),
        }
    }
}

impl std::error::Error for PrepareError {}

/// An opaque producer-issued reconciliation reference. It is not a journal
/// path and carries no native process identity; address resolution is only
/// through the producer-owned store context retained by the opaque plan.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ReconcileRef(String);

impl ReconcileRef {
    fn fresh() -> Result<Self, ()> {
        Ok(Self(random_hex(16)?))
    }

    fn validate(&self) -> Result<(), PersistError> {
        validate_opaque(&self.0).map_err(|_| PersistError::InvalidRecord)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A single producer-issued binding attempt. Sinks receive it by reference
/// and can read its opaque value, but cannot construct an arbitrary attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingAttemptId(String);

impl BindingAttemptId {
    fn fresh() -> Result<Self, PrepareError> {
        Ok(Self(
            random_hex(16).map_err(|_| PrepareError::ReferenceGeneration)?,
        ))
    }

    fn validate(&self) -> Result<(), PersistError> {
        validate_opaque(&self.0).map_err(|_| PersistError::InvalidRecord)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One complete immutable root binding. Read-only accessors and the enclosing
/// binding codec are the sink's persistence interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRefBinding {
    ordinal: u32,
    role: String,
    root_ref: ReconcileRef,
    root_ref_digest: String,
    root_generation: u64,
    spec_digest: String,
    reserved_listener_identity: String,
}

impl RootRefBinding {
    pub fn ordinal(&self) -> u32 {
        self.ordinal
    }

    pub fn role(&self) -> &str {
        &self.role
    }

    pub fn root_ref(&self) -> &ReconcileRef {
        &self.root_ref
    }

    pub fn root_ref_digest(&self) -> &str {
        &self.root_ref_digest
    }

    pub fn root_generation(&self) -> u64 {
        self.root_generation
    }

    pub fn spec_digest(&self) -> &str {
        &self.spec_digest
    }

    pub fn reserved_listener_identity(&self) -> &str {
        &self.reserved_listener_identity
    }
}

/// Complete group binding persisted by the injected sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteGroupBinding {
    binding_attempt_id: BindingAttemptId,
    group_ref: ReconcileRef,
    plan_digest: String,
    group_ref_digest: String,
    group_generation: u64,
    root_bindings: Vec<RootRefBinding>,
}

impl CompleteGroupBinding {
    pub fn binding_attempt_id(&self) -> &BindingAttemptId {
        &self.binding_attempt_id
    }

    pub fn group_ref(&self) -> &ReconcileRef {
        &self.group_ref
    }

    pub fn plan_digest(&self) -> &str {
        &self.plan_digest
    }

    pub fn group_ref_digest(&self) -> &str {
        &self.group_ref_digest
    }

    pub fn group_generation(&self) -> u64 {
        self.group_generation
    }

    pub fn root_bindings(&self) -> &[RootRefBinding] {
        &self.root_bindings
    }

    /// Encodes one closed canonical JSON record for sink persistence.
    pub fn encode(&self) -> Result<Vec<u8>, PersistError> {
        self.validate()?;
        serde_json::to_vec(&self.to_wire()).map_err(|_| PersistError::InvalidRecord)
    }

    /// Decodes and validates one closed canonical JSON record.
    pub fn decode(bytes: &[u8]) -> Result<Self, PersistError> {
        let wire: CompleteGroupBindingWire =
            serde_json::from_slice(bytes).map_err(|_| PersistError::InvalidRecord)?;
        let binding = Self::from_wire(wire)?;
        if binding.encode()?.as_slice() != bytes {
            return Err(PersistError::InvalidRecord);
        }
        Ok(binding)
    }

    fn from_plan(
        plan: &ImmutableGroupPlan,
        binding_attempt_id: BindingAttemptId,
    ) -> Result<Self, PrepareError> {
        if plan.context.root_refs.len() != plan.value.roots.len() {
            return Err(PrepareError::InvalidPlan);
        }
        Ok(Self {
            binding_attempt_id,
            group_ref: plan.context.group_ref.clone(),
            plan_digest: plan.value.plan_digest.clone(),
            group_ref_digest: plan.value.group_ref_digest.clone(),
            group_generation: plan.value.group_generation,
            root_bindings: plan
                .value
                .roots
                .iter()
                .zip(&plan.context.root_refs)
                .map(|(root, root_ref)| RootRefBinding {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref: root_ref.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    spec_digest: root.spec_digest.clone(),
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                })
                .collect(),
        })
    }

    fn to_journal_binding(&self, receipt_digest: &str) -> JournalBinding {
        JournalBinding::Bound {
            binding_attempt_id: self.binding_attempt_id.0.clone(),
            group_ref_digest: self.group_ref_digest.clone(),
            group_generation: self.group_generation,
            root_bindings: self
                .root_bindings
                .iter()
                .map(|root| BoundRoot {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    spec_digest: root.spec_digest.clone(),
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                })
                .collect(),
            activation_receipt_digest: receipt_digest.to_owned(),
        }
    }

    fn validate(&self) -> Result<(), PersistError> {
        self.binding_attempt_id.validate()?;
        self.group_ref.validate()?;
        validate_digest(&self.plan_digest)?;
        validate_digest(&self.group_ref_digest)?;
        if digest_utf8(self.group_ref.as_str()) != self.group_ref_digest {
            return Err(PersistError::InvalidRecord);
        }
        if self.group_generation == 0 || self.root_bindings.is_empty() {
            return Err(PersistError::InvalidRecord);
        }
        let mut root_refs = HashSet::with_capacity(self.root_bindings.len());
        let mut planned_roots = Vec::with_capacity(self.root_bindings.len());
        for (index, root) in self.root_bindings.iter().enumerate() {
            if root.ordinal != index as u32
                || root.root_generation == 0
                || root.role.is_empty()
                || root.role.len() > 256
            {
                return Err(PersistError::InvalidRecord);
            }
            root.root_ref.validate()?;
            if root.root_ref == self.group_ref || !root_refs.insert(&root.root_ref) {
                return Err(PersistError::InvalidRecord);
            }
            validate_digest(&root.root_ref_digest)?;
            if digest_utf8(root.root_ref.as_str()) != root.root_ref_digest {
                return Err(PersistError::InvalidRecord);
            }
            validate_digest(&root.spec_digest)?;
            validate_opaque_value(&root.reserved_listener_identity)?;
            planned_roots.push(crate::journal::PlannedRoot {
                ordinal: root.ordinal,
                role: root.role.clone(),
                root_ref_digest: root.root_ref_digest.clone(),
                root_generation: root.root_generation,
                spec_digest: root.spec_digest.clone(),
                reserved_listener_identity: root.reserved_listener_identity.clone(),
            });
        }
        let expected_plan_digest = canonical_plan_digest(
            &self.group_ref_digest,
            self.group_generation,
            &planned_roots,
        )
        .map_err(|_| PersistError::InvalidRecord)?;
        if expected_plan_digest != self.plan_digest {
            return Err(PersistError::InvalidRecord);
        }
        Ok(())
    }

    fn to_wire(&self) -> CompleteGroupBindingWire {
        CompleteGroupBindingWire {
            binding_attempt_id: self.binding_attempt_id.0.clone(),
            group_ref: self.group_ref.0.clone(),
            plan_digest: self.plan_digest.clone(),
            group_ref_digest: self.group_ref_digest.clone(),
            group_generation: self.group_generation,
            root_bindings: self
                .root_bindings
                .iter()
                .map(RootRefBinding::to_wire)
                .collect(),
        }
    }

    fn from_wire(wire: CompleteGroupBindingWire) -> Result<Self, PersistError> {
        let binding = Self {
            binding_attempt_id: BindingAttemptId(wire.binding_attempt_id),
            group_ref: ReconcileRef(wire.group_ref),
            plan_digest: wire.plan_digest,
            group_ref_digest: wire.group_ref_digest,
            group_generation: wire.group_generation,
            root_bindings: wire
                .root_bindings
                .into_iter()
                .map(RootRefBinding::from_wire)
                .collect::<Result<Vec<_>, _>>()?,
        };
        binding.validate()?;
        Ok(binding)
    }
}

impl RootRefBinding {
    fn to_wire(&self) -> RootRefBindingWire {
        RootRefBindingWire {
            ordinal: self.ordinal,
            role: self.role.clone(),
            root_ref: self.root_ref.0.clone(),
            root_ref_digest: self.root_ref_digest.clone(),
            root_generation: self.root_generation,
            spec_digest: self.spec_digest.clone(),
            reserved_listener_identity: self.reserved_listener_identity.clone(),
        }
    }

    fn from_wire(wire: RootRefBindingWire) -> Result<Self, PersistError> {
        Ok(Self {
            ordinal: wire.ordinal,
            role: wire.role,
            root_ref: ReconcileRef(wire.root_ref),
            root_ref_digest: wire.root_ref_digest,
            root_generation: wire.root_generation,
            spec_digest: wire.spec_digest,
            reserved_listener_identity: wire.reserved_listener_identity,
        })
    }
}

/// Closed receipt record returned by a sink after read-back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteGroupBindingReceiptV1 {
    binding_attempt_id: BindingAttemptId,
    binding: CompleteGroupBinding,
    receipt_digest: String,
}

impl CompleteGroupBindingReceiptV1 {
    pub fn from_binding(binding: CompleteGroupBinding) -> Result<Self, PersistError> {
        binding.validate()?;
        let receipt_digest = digest_bytes(RECEIPT_DOMAIN, &binding.encode()?);
        Ok(Self {
            binding_attempt_id: binding.binding_attempt_id.clone(),
            binding,
            receipt_digest,
        })
    }

    pub fn binding_attempt_id(&self) -> &BindingAttemptId {
        &self.binding_attempt_id
    }

    pub fn binding(&self) -> &CompleteGroupBinding {
        &self.binding
    }

    pub fn receipt_digest(&self) -> &str {
        &self.receipt_digest
    }

    pub fn encode(&self) -> Result<Vec<u8>, PersistError> {
        self.validate()?;
        serde_json::to_vec(&self.to_wire()).map_err(|_| PersistError::InvalidRecord)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PersistError> {
        let wire: CompleteGroupBindingReceiptWire =
            serde_json::from_slice(bytes).map_err(|_| PersistError::InvalidRecord)?;
        let receipt = Self::from_wire(wire)?;
        if receipt.encode()?.as_slice() != bytes {
            return Err(PersistError::InvalidRecord);
        }
        Ok(receipt)
    }

    fn validate(&self) -> Result<(), PersistError> {
        self.binding.validate()?;
        if self.binding_attempt_id != self.binding.binding_attempt_id {
            return Err(PersistError::InvalidRecord);
        }
        validate_digest(&self.receipt_digest)?;
        let expected = digest_bytes(RECEIPT_DOMAIN, &self.binding.encode()?);
        if expected != self.receipt_digest {
            return Err(PersistError::InvalidRecord);
        }
        Ok(())
    }

    fn to_wire(&self) -> CompleteGroupBindingReceiptWire {
        CompleteGroupBindingReceiptWire {
            binding_attempt_id: self.binding_attempt_id.0.clone(),
            binding: self.binding.to_wire(),
            receipt_digest: self.receipt_digest.clone(),
        }
    }

    fn from_wire(wire: CompleteGroupBindingReceiptWire) -> Result<Self, PersistError> {
        let receipt = Self {
            binding_attempt_id: BindingAttemptId(wire.binding_attempt_id),
            binding: CompleteGroupBinding::from_wire(wire.binding)?,
            receipt_digest: wire.receipt_digest,
        };
        receipt.validate()?;
        Ok(receipt)
    }
}

/// Shape-validated sink output. This wrapper is not authority: prepare still
/// independently compares the complete tuple and recomputes the digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedGroupBinding {
    receipt: CompleteGroupBindingReceiptV1,
}

impl VerifiedGroupBinding {
    pub fn from_receipt(receipt: CompleteGroupBindingReceiptV1) -> Result<Self, PersistError> {
        receipt.validate()?;
        Ok(Self { receipt })
    }

    pub fn receipt(&self) -> &CompleteGroupBindingReceiptV1 {
        &self.receipt
    }
}

/// The external sink persists only the complete binding and its closed
/// receipt. It never supplies the private activation permit.
pub trait ReconcileRefSink {
    fn persist(
        &self,
        binding_attempt_id: &BindingAttemptId,
        binding: &CompleteGroupBinding,
    ) -> Result<(), PersistError>;

    fn read_back(
        &self,
        binding_attempt_id: &BindingAttemptId,
    ) -> Result<CompleteGroupBindingReceiptV1, PersistError>;

    fn verify(
        &self,
        binding_attempt_id: &BindingAttemptId,
        expected: &CompleteGroupBinding,
        read_back: &CompleteGroupBindingReceiptV1,
    ) -> Result<VerifiedGroupBinding, PersistError>;
}

/// Opaque, move-only result of prepare. Its full journal value is retained so
/// activation can revalidate the exact immutable plan later.
pub struct PreparedGroup {
    pub(crate) journal_plan: JournalPlanValue,
    pub(crate) context: Arc<PreparePlanContext>,
    pub(crate) binding: JournalBinding,
    pub(crate) expected: CasSnapshot,
    pub(crate) verified: VerifiedGroupBinding,
    permit: ActivationPermitV1,
}

/// The private, move-only handoff between durable preparation and activation.
///
/// Construction consumes the preparation permit and revalidates every
/// immutable identity against the descriptor, address index, and current
/// journal snapshot.  It intentionally contains no native or filesystem
/// resource handles; those belong to the later activation owner.
pub(crate) struct ValidatedActivationContext {
    pub(crate) journal_plan: JournalPlanValue,
    pub(crate) context: Arc<PreparePlanContext>,
    pub(crate) binding: JournalBinding,
    pub(crate) expected: CasSnapshot,
    pub(crate) verified: VerifiedGroupBinding,
    pub(crate) descriptor: Arc<crate::launcher::FrozenActivationDescriptor>,
    permit: ActivationPermitV1,
}

impl ActivationPermitV1 {
    fn validate_against(
        &self,
        plan: &JournalPlanValue,
        binding: &JournalBinding,
        receipt: &CompleteGroupBindingReceiptV1,
    ) -> Result<(), PrepareError> {
        let JournalBinding::Bound {
            binding_attempt_id,
            group_ref_digest,
            group_generation,
            root_bindings,
            activation_receipt_digest,
        } = binding
        else {
            return Err(PrepareError::InvalidBinding);
        };

        let root_binding_digests = root_bindings
            .iter()
            .map(|root| root.root_ref_digest.clone())
            .collect::<Vec<_>>();

        if self.permit_version != 1
            || self.plan_digest != plan.plan_digest
            || self.binding_attempt_id.as_str() != binding_attempt_id
            || self.group_ref_digest != *group_ref_digest
            || self.group_generation != *group_generation
            || self.root_binding_digests != root_binding_digests
            || self.receipt_digest != *activation_receipt_digest
            || self.receipt_digest != receipt.receipt_digest()
            || receipt.binding_attempt_id() != &self.binding_attempt_id
        {
            return Err(PrepareError::InvalidBinding);
        }

        Ok(())
    }
}

impl PreparedGroup {
    /// Consume a prepared group only after revalidating its immutable
    /// activation identity and the exact durable prepared-bound snapshot.
    pub(crate) fn consume_for_activation(self) -> Result<ValidatedActivationContext, PrepareError> {
        let PreparedGroup {
            journal_plan,
            context,
            binding,
            expected,
            verified,
            permit,
        } = self;

        let descriptor = context
            .activation_descriptor
            .clone()
            .ok_or(PrepareError::InvalidPlan)?;

        if context.session_nonce != descriptor.session_nonce() {
            return Err(PrepareError::InvalidBinding);
        }
        if descriptor.producer_root() != context.producer_root.as_path() {
            return Err(PrepareError::InvalidBinding);
        }
        if !context.addresses_are_complete() {
            return Err(PrepareError::InvalidPlan);
        }

        let descriptor_draft = descriptor
            .to_prepare_draft()
            .map_err(|_| PrepareError::InvalidPlan)?;
        let descriptor_plan =
            finalized_plan_value(&descriptor_draft, &context.group_ref, &context.root_refs)?;
        if descriptor_plan != journal_plan {
            return Err(PrepareError::InvalidPlan);
        }

        verified
            .receipt()
            .validate()
            .map_err(|_| PrepareError::InvalidBinding)?;
        let plan_for_binding = ImmutableGroupPlan {
            value: journal_plan.clone(),
            context: Arc::clone(&context),
        };
        let expected_binding =
            CompleteGroupBinding::from_plan(&plan_for_binding, permit.binding_attempt_id.clone())?;
        if verified.receipt().binding() != &expected_binding {
            return Err(PrepareError::InvalidBinding);
        }
        if expected_binding.to_journal_binding(verified.receipt().receipt_digest()) != binding {
            return Err(PrepareError::InvalidBinding);
        }
        permit.validate_against(&journal_plan, &binding, verified.receipt())?;

        let reopened = crate::index::reopen_from_ref(
            descriptor.producer_root().to_path_buf(),
            context.group_ref.as_str(),
        )
        .map_err(map_address_index_error)?;

        if reopened.index.group_ref != context.group_ref.as_str()
            || reopened.index.session_nonce != descriptor.session_nonce()
            || reopened.plan != journal_plan
            || reopened.index.roots.len() != context.root_refs.len()
            || reopened
                .index
                .roots
                .iter()
                .zip(context.root_refs.iter())
                .any(|(indexed, expected)| indexed.root_ref != expected.as_str())
        {
            return Err(PrepareError::InvalidBinding);
        }

        if reopened.journal.state != JournalState::PreparedBound
            || reopened.journal.cas_snapshot() != expected
        {
            return Err(PrepareError::JournalConflict);
        }
        if reopened.journal.binding != binding
            || reopened.journal.session_nonce != descriptor.session_nonce()
            || reopened.journal.plan_digest != journal_plan.plan_digest
        {
            return Err(PrepareError::InvalidBinding);
        }

        Ok(ValidatedActivationContext {
            journal_plan,
            context,
            binding,
            expected,
            verified,
            descriptor,
            permit,
        })
    }
}

struct ActivationPermitV1 {
    permit_version: u8,
    plan_digest: String,
    binding_attempt_id: BindingAttemptId,
    group_ref_digest: String,
    group_generation: u64,
    root_binding_digests: Vec<String>,
    receipt_digest: String,
}

pub(crate) fn prepare_group(
    plan: &ImmutableGroupPlan,
    sink: &dyn ReconcileRefSink,
) -> Result<PreparedGroup, PrepareError> {
    plan.value
        .validate()
        .map_err(|_| PrepareError::InvalidPlan)?;
    if plan.context.root_refs.len() != plan.value.roots.len()
        || plan.context.session_nonce.is_empty()
    {
        return Err(PrepareError::InvalidPlan);
    }
    if !plan.context.addresses_are_complete() {
        return Err(PrepareError::InvalidPlan);
    }
    let timestamp = plan.context.clock.now()?;
    let initial = RuntimeSessionJournalV1::planned(
        &plan.value,
        plan.context.session_nonce.clone(),
        timestamp,
    )
    .map_err(map_plan_error)?;
    plan.context
        .store
        .create_initial(&plan.value, &initial)
        .map_err(map_store_error)?;

    let root_ref_values = plan
        .context
        .root_refs
        .iter()
        .map(|root_ref| root_ref.as_str().to_owned())
        .collect::<Vec<_>>();
    let address_index = ReconcileAddressIndexV1::from_plan(
        &plan.value,
        plan.context.session_nonce.clone(),
        plan.context.group_ref.as_str().to_owned(),
        &root_ref_values,
    )
    .map_err(map_address_index_error)?;
    persist_address_index(&plan.context.store, &address_index).map_err(map_address_index_error)?;

    let binding_attempt_id = BindingAttemptId::fresh()?;
    let expected_binding = CompleteGroupBinding::from_plan(plan, binding_attempt_id)?;
    sink.persist(expected_binding.binding_attempt_id(), &expected_binding)
        .map_err(PrepareError::Binding)?;
    let read_back = sink
        .read_back(expected_binding.binding_attempt_id())
        .map_err(PrepareError::Binding)?;
    let verified = sink
        .verify(
            expected_binding.binding_attempt_id(),
            &expected_binding,
            &read_back,
        )
        .map_err(PrepareError::Binding)?;
    verify_binding_independently(&expected_binding, &read_back, &verified)?;
    let receipt_digest = verified.receipt().receipt_digest().to_owned();
    let journal_binding = expected_binding.to_journal_binding(&receipt_digest);
    let cas = plan.context.store.compare_and_swap(
        &plan.value,
        &initial.cas_snapshot(),
        JournalStoreCommand::PrepareBound {
            binding: journal_binding.clone(),
            timestamp: plan.context.clock.now()?,
        },
    );
    let bound = cas.map_err(map_store_error)?;
    if bound.state != JournalState::PreparedBound || bound.binding != journal_binding {
        return Err(PrepareError::JournalAmbiguous);
    }
    let permit = ActivationPermitV1 {
        permit_version: 1,
        plan_digest: plan.value.plan_digest.clone(),
        binding_attempt_id: expected_binding.binding_attempt_id.clone(),
        group_ref_digest: expected_binding.group_ref_digest.clone(),
        group_generation: expected_binding.group_generation,
        root_binding_digests: expected_binding
            .root_bindings
            .iter()
            .map(|root| root.root_ref_digest.clone())
            .collect(),
        receipt_digest,
    };
    Ok(PreparedGroup {
        journal_plan: plan.value.clone(),
        context: Arc::clone(&plan.context),
        binding: journal_binding,
        expected: bound.cas_snapshot(),
        verified,
        permit,
    })
}

fn verify_binding_independently(
    expected: &CompleteGroupBinding,
    read_back: &CompleteGroupBindingReceiptV1,
    verified: &VerifiedGroupBinding,
) -> Result<(), PrepareError> {
    if read_back.binding_attempt_id() != expected.binding_attempt_id()
        || read_back.binding() != expected
        || verified.receipt() != read_back
    {
        return Err(PrepareError::InvalidBinding);
    }
    let encoded = read_back
        .binding()
        .encode()
        .map_err(|_| PrepareError::InvalidBinding)?;
    let expected_digest = digest_bytes(RECEIPT_DOMAIN, &encoded);
    if expected_digest != read_back.receipt_digest() {
        return Err(PrepareError::InvalidBinding);
    }
    Ok(())
}

fn map_store_error(error: JournalStoreError) -> PrepareError {
    match error {
        JournalStoreError::AlreadyExists => PrepareError::JournalAlreadyExists,
        JournalStoreError::Conflict => PrepareError::JournalConflict,
        JournalStoreError::CorruptJournal => PrepareError::JournalCorrupt,
        JournalStoreError::TooLarge => PrepareError::JournalTooLarge,
        JournalStoreError::Journal(JournalError::InvalidField("updatedAt")) => {
            PrepareError::InvalidTimestamp
        }
        JournalStoreError::Journal(_) => PrepareError::InvalidPlan,
        JournalStoreError::UnsupportedPlatform
        | JournalStoreError::InvalidConfig
        | JournalStoreError::PathSecurity
        | JournalStoreError::NotFound
        | JournalStoreError::Lock
        | JournalStoreError::LockTimeout
        | JournalStoreError::Io(_)
        | JournalStoreError::Durability(_)
        | JournalStoreError::AtomicReplace
        | JournalStoreError::Injected(_) => PrepareError::JournalUnavailable,
    }
}

fn map_address_index_error(error: AddressIndexError) -> PrepareError {
    match error {
        AddressIndexError::Storage(error) => map_store_error(error),
        AddressIndexError::InvalidReference
        | AddressIndexError::InvalidRecord
        | AddressIndexError::ReferenceMismatch
        | AddressIndexError::PlanMismatch => PrepareError::InvalidPlan,
    }
}

fn map_plan_error(error: JournalError) -> PrepareError {
    match error {
        JournalError::InvalidField("timestamp") => PrepareError::InvalidTimestamp,
        _ => PrepareError::InvalidPlan,
    }
}

fn random_hex(bytes: usize) -> Result<String, ()> {
    let mut value = vec![0_u8; bytes];
    OsRng.try_fill_bytes(&mut value).map_err(|_| ())?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn digest_bytes(domain: &[u8], bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
}

fn digest_ref(reference: &ReconcileRef) -> Result<String, PrepareError> {
    reference
        .validate()
        .map_err(|_| PrepareError::ReferenceGeneration)?;
    Ok(digest_utf8(reference.as_str()))
}

fn digest_utf8(value: &str) -> String {
    digest_opaque_ref(value)
}

fn digest_plan(
    group_ref_digest: &str,
    group_generation: u64,
    roots: &[crate::journal::PlannedRoot],
) -> Result<String, PrepareError> {
    canonical_plan_digest(group_ref_digest, group_generation, roots)
        .map_err(|_| PrepareError::InvalidPlan)
}

fn validate_digest_value(value: &str) -> Result<(), PrepareError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(PrepareError::InvalidPlan)
    }
}

fn validate_digest(value: &str) -> Result<(), PersistError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(PersistError::InvalidRecord)
    }
}

fn validate_opaque(value: &str) -> Result<(), ()> {
    validate_opaque_value(value).map_err(|_| ())
}

fn validate_opaque_value(value: &str) -> Result<(), PersistError> {
    if !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        Ok(())
    } else {
        Err(PersistError::InvalidRecord)
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn system_timestamp() -> Result<String, PrepareError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PrepareError::JournalUnavailable)?
        .as_secs();
    Ok(format_timestamp(seconds))
}

fn format_timestamp(seconds: u64) -> String {
    let days = seconds / 86_400;
    let day_seconds = seconds % 86_400;
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    let (year, month, day) = civil_date(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_date(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootRefBindingWire {
    ordinal: u32,
    role: String,
    root_ref: String,
    root_ref_digest: String,
    root_generation: u64,
    spec_digest: String,
    reserved_listener_identity: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteGroupBindingWire {
    binding_attempt_id: String,
    group_ref: String,
    plan_digest: String,
    group_ref_digest: String,
    group_generation: u64,
    root_bindings: Vec<RootRefBindingWire>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteGroupBindingReceiptWire {
    binding_attempt_id: String,
    binding: CompleteGroupBindingWire,
    receipt_digest: String,
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use tempfile::tempdir;

    use super::*;
    use crate::process::OwnedRuntimeSession;

    const ROOT_DIGEST: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const SPEC_DIGEST: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const ALT_DIGEST: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn draft() -> PreparePlanDraft {
        PreparePlanDraft {
            group_generation: 4,
            roots: vec![PrepareRootDraft {
                ordinal: 0,
                role: "capture".into(),
                root_generation: 1,
                spec_digest: SPEC_DIGEST.into(),
                reserved_listener_identity: "listener-0".into(),
            }],
        }
    }

    fn two_root_draft() -> PreparePlanDraft {
        let mut draft = draft();
        draft.roots.push(PrepareRootDraft {
            ordinal: 1,
            role: "worker".into(),
            root_generation: 2,
            spec_digest: ROOT_DIGEST.into(),
            reserved_listener_identity: "listener-1".into(),
        });
        draft
    }

    struct Sink {
        store: Arc<JournalStore>,
        plan: JournalPlanValue,
        binding: Mutex<Option<CompleteGroupBinding>>,
        fail: Option<&'static str>,
        mutate: Option<&'static str>,
        persist_calls: AtomicUsize,
    }

    struct SequenceClock {
        values: Mutex<Vec<Result<String, PrepareError>>>,
    }

    impl SequenceClock {
        fn new(values: impl IntoIterator<Item = Result<String, PrepareError>>) -> Self {
            Self {
                values: Mutex::new(values.into_iter().collect()),
            }
        }
    }

    impl PrepareClock for SequenceClock {
        fn now(&self) -> Result<String, PrepareError> {
            let mut values = self.values.lock().unwrap();
            if values.is_empty() {
                Err(PrepareError::JournalUnavailable)
            } else {
                values.remove(0)
            }
        }
    }

    impl Sink {
        fn new(plan: &ImmutableGroupPlan, fail: Option<&'static str>) -> Self {
            Self {
                store: Arc::clone(&plan.context.store),
                plan: plan.value.clone(),
                binding: Mutex::new(None),
                fail,
                mutate: None,
                persist_calls: AtomicUsize::new(0),
            }
        }

        fn mutating(plan: &ImmutableGroupPlan, mutation: &'static str) -> Self {
            let mut sink = Self::new(plan, None);
            sink.mutate = Some(mutation);
            sink
        }
    }

    impl ReconcileRefSink for Sink {
        fn persist(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            binding: &CompleteGroupBinding,
        ) -> Result<(), PersistError> {
            self.persist_calls.fetch_add(1, Ordering::Relaxed);
            assert_eq!(
                self.store
                    .read(&self.plan)
                    .expect("journal before sink")
                    .state,
                JournalState::PlannedUnbound
            );
            if self.fail == Some("persist") {
                return Err(PersistError::Storage);
            }
            let bytes = binding.encode()?;
            let decoded = CompleteGroupBinding::decode(&bytes)?;
            *self.binding.lock().unwrap() = Some(decoded);
            Ok(())
        }

        fn read_back(
            &self,
            _binding_attempt_id: &BindingAttemptId,
        ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
            if self.fail == Some("read_back") {
                return Err(PersistError::Storage);
            }
            let mut binding = self
                .binding
                .lock()
                .unwrap()
                .clone()
                .ok_or(PersistError::Storage)?;
            if let Some(mutation) = self.mutate {
                mutate_binding(&mut binding, mutation)?;
            }
            let mut receipt = CompleteGroupBindingReceiptV1::from_binding(binding)?;
            if self.mutate == Some("receipt_digest") {
                receipt.receipt_digest = ALT_DIGEST.into();
            }
            Ok(receipt)
        }

        fn verify(
            &self,
            _binding_attempt_id: &BindingAttemptId,
            _expected: &CompleteGroupBinding,
            read_back: &CompleteGroupBindingReceiptV1,
        ) -> Result<VerifiedGroupBinding, PersistError> {
            if self.fail == Some("verify") {
                return Err(PersistError::Rejected);
            }
            VerifiedGroupBinding::from_receipt(read_back.clone())
        }
    }

    fn plan(directory: &Path) -> ImmutableGroupPlan {
        plan_with_draft(directory, draft())
    }

    fn plan_with_draft(directory: &Path, draft: PreparePlanDraft) -> ImmutableGroupPlan {
        build_immutable_group_plan(draft, directory.to_path_buf(), "session-1".into())
            .expect("opaque plan")
    }

    fn plan_with_clock(
        directory: &Path,
        clock: Arc<dyn PrepareClock + Send + Sync>,
    ) -> ImmutableGroupPlan {
        build_immutable_group_plan_with_clock(
            draft(),
            directory.to_path_buf(),
            "session-1".into(),
            clock,
        )
        .expect("opaque plan")
    }

    fn mutate_binding(
        binding: &mut CompleteGroupBinding,
        mutation: &str,
    ) -> Result<(), PersistError> {
        match mutation {
            "attempt_id" => {
                binding.binding_attempt_id =
                    BindingAttemptId::fresh().map_err(|_| PersistError::InvalidRecord)?;
            }
            "group_ref" => {
                binding.group_ref =
                    ReconcileRef::fresh().map_err(|_| PersistError::InvalidRecord)?;
            }
            "plan_digest" => binding.plan_digest = ALT_DIGEST.into(),
            "group_ref_digest" => binding.group_ref_digest = ALT_DIGEST.into(),
            "group_generation" => binding.group_generation += 1,
            "root_role" => binding.root_bindings[0].role = "other".into(),
            "self_consistent_role" => {
                binding.root_bindings[0].role = "other".into();
                binding.plan_digest = rebased_binding_plan_digest(binding)?;
            }
            "root_ref" => {
                binding.root_bindings[0].root_ref =
                    ReconcileRef::fresh().map_err(|_| PersistError::InvalidRecord)?;
            }
            "root_ref_digest" => binding.root_bindings[0].root_ref_digest = ALT_DIGEST.into(),
            "root_generation" => binding.root_bindings[0].root_generation += 1,
            "spec_digest" => binding.root_bindings[0].spec_digest = ALT_DIGEST.into(),
            "self_consistent_spec_digest" => {
                binding.root_bindings[0].spec_digest = ALT_DIGEST.into();
                binding.plan_digest = rebased_binding_plan_digest(binding)?;
            }
            "listener" => {
                binding.root_bindings[0].reserved_listener_identity = "listener-other".into()
            }
            "reorder" => {
                binding.root_bindings.swap(0, 1);
                for (ordinal, root) in binding.root_bindings.iter_mut().enumerate() {
                    root.ordinal = ordinal as u32;
                }
            }
            "missing_root" => {
                binding.root_bindings.pop();
            }
            "extra_root" => {
                let mut extra = binding
                    .root_bindings
                    .last()
                    .cloned()
                    .ok_or(PersistError::InvalidRecord)?;
                extra.ordinal = binding.root_bindings.len() as u32;
                extra.root_ref = ReconcileRef::fresh().map_err(|_| PersistError::InvalidRecord)?;
                binding.root_bindings.push(extra);
            }
            "receipt_digest" => {}
            _ => return Err(PersistError::InvalidRecord),
        }
        Ok(())
    }

    fn rebased_binding_plan_digest(binding: &CompleteGroupBinding) -> Result<String, PersistError> {
        let roots = binding
            .root_bindings
            .iter()
            .map(|root| crate::journal::PlannedRoot {
                ordinal: root.ordinal,
                role: root.role.clone(),
                root_ref_digest: root.root_ref_digest.clone(),
                root_generation: root.root_generation,
                spec_digest: root.spec_digest.clone(),
                reserved_listener_identity: root.reserved_listener_identity.clone(),
            })
            .collect::<Vec<_>>();
        canonical_plan_digest(&binding.group_ref_digest, binding.group_generation, &roots)
            .map_err(|_| PersistError::InvalidRecord)
    }

    #[test]
    fn binding_and_receipt_codecs_round_trip_as_closed_records() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let binding =
            CompleteGroupBinding::from_plan(&plan, BindingAttemptId::fresh().expect("attempt"))
                .expect("binding");
        assert_eq!(
            digest_utf8(binding.group_ref.as_str()),
            binding.group_ref_digest
        );
        assert_eq!(binding.plan_digest, plan.value.plan_digest);
        assert_eq!(
            digest_plan(
                &plan.value.group_ref_digest,
                plan.value.group_generation,
                &plan.value.roots,
            )
            .expect("plan digest"),
            plan.value.plan_digest
        );
        for (root, expected) in binding.root_bindings.iter().zip(&plan.value.roots) {
            assert_eq!(digest_utf8(root.root_ref.as_str()), root.root_ref_digest);
            assert_eq!(root.root_ref_digest, expected.root_ref_digest);
        }
        let encoded = binding.encode().expect("binding encoding");
        assert_eq!(
            CompleteGroupBinding::decode(&encoded).expect("binding decode"),
            binding
        );
        for mutation in ["role", "spec_digest"] {
            let mut self_consistent = binding.clone();
            if mutation == "role" {
                self_consistent.root_bindings[0].role = "worker".into();
            } else {
                self_consistent.root_bindings[0].spec_digest = ALT_DIGEST.into();
            }
            self_consistent.plan_digest =
                rebased_binding_plan_digest(&self_consistent).expect("rebased digest");
            let self_consistent_bytes = self_consistent.encode().expect("codec self consistency");
            let decoded = CompleteGroupBinding::decode(&self_consistent_bytes)
                .expect("self-consistent binding decode");
            let receipt = CompleteGroupBindingReceiptV1::from_binding(decoded).unwrap();
            assert_eq!(
                CompleteGroupBindingReceiptV1::decode(&receipt.encode().unwrap()).unwrap(),
                receipt
            );
            assert_ne!(receipt.binding().plan_digest, plan.value.plan_digest);
        }
        let receipt = CompleteGroupBindingReceiptV1::from_binding(binding).expect("receipt");
        let encoded = receipt.encode().expect("receipt encoding");
        assert_eq!(
            CompleteGroupBindingReceiptV1::decode(&encoded).expect("receipt decode"),
            receipt
        );
        assert!(CompleteGroupBinding::decode(br#"{"groupRef":"x","unknown":1}"#).is_err());

        let two_root_directory = tempdir().expect("two root");
        let two_root_plan = plan_with_draft(two_root_directory.path(), two_root_draft());
        let mut duplicate = CompleteGroupBinding::from_plan(
            &two_root_plan,
            BindingAttemptId::fresh().expect("attempt"),
        )
        .expect("two root binding");
        duplicate.root_bindings[1].root_ref = duplicate.root_bindings[0].root_ref.clone();
        duplicate.root_bindings[1].root_ref_digest =
            duplicate.root_bindings[0].root_ref_digest.clone();
        assert_eq!(duplicate.encode(), Err(PersistError::InvalidRecord));
    }

    #[test]
    fn opaque_refs_resolve_only_through_the_producer_store_context() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        assert_eq!(
            plan.context.ref_addresses.len(),
            plan.context.root_refs.len() + 1
        );
        assert_eq!(
            plan.context
                .address_of(&plan.context.group_ref)
                .unwrap()
                .kind,
            ReconcileRefKind::Group
        );
        let (group_store, group_slot) = plan
            .context
            .resolve_address(&plan.context.group_ref)
            .expect("group address");
        assert!(Arc::ptr_eq(&group_store, &plan.context.store));
        assert_eq!(group_slot, None);
        for (ordinal, root_ref) in plan.context.root_refs.iter().enumerate() {
            assert_eq!(
                plan.context.address_of(root_ref).unwrap().kind,
                ReconcileRefKind::Root {
                    ordinal: ordinal as u32
                }
            );
            let (root_store, root_slot) = plan
                .context
                .resolve_address(root_ref)
                .expect("root address");
            assert!(Arc::ptr_eq(&root_store, &plan.context.store));
            assert_eq!(root_slot, Some(ordinal as u32));
        }
        assert!(plan
            .context
            .address_of(&ReconcileRef("unknown".into()))
            .is_none());
    }

    #[test]
    fn prepare_writes_unbound_before_sink_and_returns_one_bound_opaque_value() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let sink = Sink::new(&plan, None);
        let prepared = OwnedRuntimeSession::prepare_group(&plan, &sink).expect("prepare");
        assert_eq!(prepared.journal_plan, plan.value);
        assert_eq!(prepared.expected.journal_revision, 1);
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("bound journal")
                .state,
            JournalState::PreparedBound
        );
        let files = fs::read_dir(directory.path())
            .expect("producer root")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        assert!(files
            .iter()
            .all(|name| !name.to_string_lossy().contains("tmp-")));
        let address_key = crate::index::parse_address_ref(plan.context.group_ref.as_str())
            .expect("group address")
            .address_key;
        let index_path = directory
            .path()
            .join(format!("runtime-ref-index-v1-{address_key}.json"));
        assert!(index_path.is_file(), "prepare persisted the address index");
        let reopened = crate::index::reopen_from_ref(
            directory.path().to_path_buf(),
            plan.context.root_refs[0].as_str(),
        )
        .expect("restartable root reference");
        assert_eq!(reopened.plan, plan.value);
        assert_eq!(reopened.journal.state, JournalState::PreparedBound);
    }

    #[test]
    fn value_only_plan_is_rejected_before_activation_validation() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let sink = Sink::new(&plan, None);
        let prepared = OwnedRuntimeSession::prepare_group(&plan, &sink).expect("prepare");

        assert!(matches!(
            prepared.consume_for_activation(),
            Err(PrepareError::InvalidPlan)
        ));
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("prepared journal")
                .state,
            JournalState::PreparedBound
        );
    }

    #[test]
    fn foreign_index_collision_is_preserved_and_blocks_sink() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let sink = Sink::new(&plan, None);
        let address_key = crate::index::parse_address_ref(plan.context.group_ref.as_str())
            .expect("group address")
            .address_key;
        let index_path = directory
            .path()
            .join(format!("runtime-ref-index-v1-{address_key}.json"));
        let foreign = b"foreign-index-bytes";
        fs::write(&index_path, foreign).expect("foreign collision");

        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&plan, &sink),
            Err(PrepareError::InvalidPlan)
        ));
        assert_eq!(sink.persist_calls.load(Ordering::Relaxed), 0);
        assert_eq!(fs::read(&index_path).expect("collision remains"), foreign);
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("planned journal")
                .state,
            JournalState::PlannedUnbound
        );
    }

    #[test]
    fn auxiliary_post_replace_failure_is_reestablished_or_fails_closed() {
        let preflush_directory = tempdir().expect("preflush directory");
        let preflush_plan = plan(preflush_directory.path());
        let preflush_sink = Sink::new(&preflush_plan, None);
        preflush_plan
            .context
            .store
            .fail_next_auxiliary_before_flush();
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&preflush_plan, &preflush_sink),
            Err(PrepareError::JournalUnavailable)
        ));
        assert_eq!(preflush_sink.persist_calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            preflush_plan
                .context
                .store
                .read(&preflush_plan.value)
                .expect("planned journal")
                .state,
            JournalState::PlannedUnbound
        );

        let success_directory = tempdir().expect("success directory");
        let success_plan = plan(success_directory.path());
        let success_sink = Sink::new(&success_plan, None);
        success_plan
            .context
            .store
            .fail_next_auxiliary_after_replace_before_flush();
        OwnedRuntimeSession::prepare_group(&success_plan, &success_sink)
            .expect("exact index readback after post-replace failure");
        assert_eq!(success_sink.persist_calls.load(Ordering::Relaxed), 1);

        let failure_directory = tempdir().expect("failure directory");
        let failure_plan = plan(failure_directory.path());
        let failure_sink = Sink::new(&failure_plan, None);
        failure_plan
            .context
            .store
            .fail_auxiliary_after_replace_and_durability_recheck();
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&failure_plan, &failure_sink),
            Err(PrepareError::JournalUnavailable)
        ));
        assert_eq!(failure_sink.persist_calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            failure_plan
                .context
                .store
                .read(&failure_plan.value)
                .expect("planned journal")
                .state,
            JournalState::PlannedUnbound
        );
    }

    #[test]
    fn every_sink_failure_leaves_planned_unbound_without_native_acquisition() {
        for failure in ["persist", "read_back", "verify"] {
            let directory = tempdir().expect("tempdir");
            let plan = plan(directory.path());
            let sink = Sink::new(&plan, Some(failure));
            assert!(matches!(
                OwnedRuntimeSession::prepare_group(&plan, &sink),
                Err(PrepareError::Binding(_))
            ));
            assert_eq!(
                plan.context
                    .store
                    .read(&plan.value)
                    .expect("planned journal")
                    .state,
                JournalState::PlannedUnbound
            );
        }
    }

    #[test]
    fn duplicate_prepare_does_not_issue_a_second_sink_attempt_or_permit() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let sink = Sink::new(&plan, None);
        let _first = OwnedRuntimeSession::prepare_group(&plan, &sink).expect("first prepare");
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&plan, &sink),
            Err(PrepareError::JournalAlreadyExists)
        ));
        assert!(sink.binding.lock().unwrap().is_some());
        assert_eq!(sink.persist_calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn ambiguous_bound_write_is_resolved_by_exact_readback_without_replaying_sink() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let sink = Sink::new(&plan, None);
        plan.context.store.fail_next_after_replace_before_flush();
        let prepared = OwnedRuntimeSession::prepare_group(&plan, &sink).expect("readback commit");
        assert_eq!(prepared.expected.journal_revision, 1);
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("bound journal")
                .state,
            JournalState::PreparedBound
        );
    }

    #[test]
    fn failed_durability_recheck_does_not_issue_a_prepared_result() {
        let directory = tempdir().expect("tempdir");
        let plan = plan(directory.path());
        let sink = Sink::new(&plan, None);
        plan.context
            .store
            .fail_after_replace_and_durability_recheck();
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&plan, &sink),
            Err(PrepareError::JournalUnavailable)
        ));
        assert_eq!(sink.persist_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            plan.context
                .store
                .read(&plan.value)
                .expect("complete record")
                .state,
            JournalState::PreparedBound
        );
    }

    #[test]
    fn injected_clock_covers_equal_backward_and_error_timestamps() {
        let equal_directory = tempdir().expect("tempdir");
        let equal_clock = Arc::new(SequenceClock::new([
            Ok("2026-01-01T00:00:01Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
        ]));
        let equal_plan = plan_with_clock(&equal_directory.path(), equal_clock);
        let equal_sink = Sink::new(&equal_plan, None);
        let equal = OwnedRuntimeSession::prepare_group(&equal_plan, &equal_sink)
            .expect("equal timestamp is valid");
        let equal_journal = equal_plan
            .context
            .store
            .read(&equal_plan.value)
            .expect("equal journal");
        assert_eq!(equal_journal.created_at, equal_journal.updated_at);
        assert_eq!(equal.expected.journal_revision, 1);

        let backward_directory = tempdir().expect("tempdir");
        let backward_clock = Arc::new(SequenceClock::new([
            Ok("2026-01-01T00:00:02Z".into()),
            Ok("2026-01-01T00:00:01Z".into()),
        ]));
        let backward_plan = plan_with_clock(&backward_directory.path(), backward_clock);
        let backward_sink = Sink::new(&backward_plan, None);
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&backward_plan, &backward_sink),
            Err(PrepareError::InvalidTimestamp)
        ));
        assert_eq!(
            backward_plan
                .context
                .store
                .read(&backward_plan.value)
                .expect("planned journal")
                .state,
            JournalState::PlannedUnbound
        );

        let error_directory = tempdir().expect("tempdir");
        let error_clock = Arc::new(SequenceClock::new([Err(PrepareError::JournalUnavailable)]));
        let error_plan = plan_with_clock(&error_directory.path(), error_clock);
        let error_sink = Sink::new(&error_plan, None);
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&error_plan, &error_sink),
            Err(PrepareError::JournalUnavailable)
        ));
        assert_eq!(error_sink.persist_calls.load(Ordering::Relaxed), 0);
        assert_eq!(fs::read_dir(error_directory.path()).unwrap().count(), 0);

        let malformed_directory = tempdir().expect("tempdir");
        let malformed_clock = Arc::new(SequenceClock::new([Ok("not-a-timestamp".into())]));
        let malformed_plan = plan_with_clock(&malformed_directory.path(), malformed_clock);
        let malformed_sink = Sink::new(&malformed_plan, None);
        assert!(matches!(
            OwnedRuntimeSession::prepare_group(&malformed_plan, &malformed_sink),
            Err(PrepareError::InvalidTimestamp)
        ));
        assert_eq!(malformed_sink.persist_calls.load(Ordering::Relaxed), 0);
        assert_eq!(fs::read_dir(malformed_directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn system_timestamp_format_has_epoch_and_leap_day_coverage() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_timestamp(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn producer_rejects_each_independently_mutated_binding_tuple() {
        let mutations = [
            "attempt_id",
            "group_ref",
            "plan_digest",
            "group_ref_digest",
            "group_generation",
            "root_role",
            "self_consistent_role",
            "root_ref",
            "root_ref_digest",
            "root_generation",
            "spec_digest",
            "self_consistent_spec_digest",
            "listener",
            "receipt_digest",
        ];
        for mutation in mutations {
            let directory = tempdir().expect("tempdir");
            let plan = plan(directory.path());
            let sink = Sink::mutating(&plan, mutation);
            let result = OwnedRuntimeSession::prepare_group(&plan, &sink);
            if mutation.starts_with("self_consistent_") {
                assert!(matches!(result, Err(PrepareError::InvalidBinding)));
            } else {
                assert!(
                    matches!(
                        result,
                        Err(PrepareError::InvalidBinding) | Err(PrepareError::Binding(_))
                    ),
                    "mutation {mutation} unexpectedly accepted"
                );
            }
            assert_eq!(sink.persist_calls.load(Ordering::Relaxed), 1);
            assert_eq!(
                plan.context
                    .store
                    .read(&plan.value)
                    .expect("planned journal")
                    .state,
                JournalState::PlannedUnbound
            );
        }

        for mutation in ["reorder", "missing_root", "extra_root"] {
            let directory = tempdir().expect("tempdir");
            let plan = plan_with_draft(directory.path(), two_root_draft());
            let sink = Sink::mutating(&plan, mutation);
            assert!(
                matches!(
                    OwnedRuntimeSession::prepare_group(&plan, &sink),
                    Err(PrepareError::InvalidBinding) | Err(PrepareError::Binding(_))
                ),
                "mutation {mutation} unexpectedly accepted"
            );
            assert_eq!(sink.persist_calls.load(Ordering::Relaxed), 1);
            assert_eq!(
                plan.context
                    .store
                    .read(&plan.value)
                    .expect("planned journal")
                    .state,
                JournalState::PlannedUnbound
            );
        }
    }
}
