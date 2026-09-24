//! Private durable address index for producer-issued reconciliation refs.
//!
//! The index is an addressability record, not a lifecycle authority.  The
//! journal remains authoritative for state and binding transitions; every
//! reopened index is cross-validated against the complete immutable plan and
//! the journal before it is usable.

#![allow(dead_code)]

use std::path::PathBuf;

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    journal::{
        JournalBinding, JournalPlanValue, JournalState, PlannedRoot, RuntimeSessionJournalV1,
    },
    journal_store::{JournalStore, JournalStoreConfig, JournalStoreError},
};

const ADDRESS_KEY_HEX_LENGTH: usize = 64;
const GROUP_REF_PREFIX: &str = "r1g_";
const ROOT_REF_PREFIX: &str = "r1r_";
const INDEX_SCHEMA_VERSION: &str = "ReconcileAddressIndexV1";
const PRODUCER: &str = "capture-runtime";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AddressIndexError {
    InvalidReference,
    InvalidRecord,
    ReferenceMismatch,
    PlanMismatch,
    Storage(JournalStoreError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddressRefKind {
    Group,
    Root { ordinal: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedAddressRef {
    pub(crate) address_key: String,
    pub(crate) kind: AddressRefKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReconcileAddressIndexV1 {
    pub(crate) address_key: String,
    pub(crate) session_nonce: String,
    pub(crate) plan_digest: String,
    pub(crate) group_ref: String,
    pub(crate) group_ref_digest: String,
    pub(crate) group_generation: u64,
    pub(crate) roots: Vec<IndexedRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IndexedRoot {
    pub(crate) ordinal: u32,
    pub(crate) role: String,
    pub(crate) root_ref: String,
    pub(crate) root_ref_digest: String,
    pub(crate) root_generation: u64,
    pub(crate) spec_digest: String,
    pub(crate) reserved_listener_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReopenedAddress {
    pub(crate) index: ReconcileAddressIndexV1,
    pub(crate) plan: JournalPlanValue,
    pub(crate) journal: RuntimeSessionJournalV1,
    pub(crate) kind: AddressRefKind,
}

pub(crate) fn fresh_address_key() -> Result<String, ()> {
    let mut bytes = [0_u8; ADDRESS_KEY_HEX_LENGTH / 2];
    OsRng.try_fill_bytes(&mut bytes).map_err(|_| ())?;
    Ok(hex_lower(&bytes))
}

pub(crate) fn group_ref_for(address_key: &str) -> Result<String, ()> {
    validate_address_key(address_key).map_err(|_| ())?;
    Ok(format!("{GROUP_REF_PREFIX}{address_key}"))
}

pub(crate) fn root_ref_for(address_key: &str, ordinal: u32) -> Result<String, ()> {
    validate_address_key(address_key).map_err(|_| ())?;
    Ok(format!("{ROOT_REF_PREFIX}{address_key}_{ordinal}"))
}

pub(crate) fn parse_address_ref(value: &str) -> Result<ParsedAddressRef, AddressIndexError> {
    if let Some(address_key) = value.strip_prefix(GROUP_REF_PREFIX) {
        if validate_address_key(address_key).is_ok() {
            return Ok(ParsedAddressRef {
                address_key: address_key.to_owned(),
                kind: AddressRefKind::Group,
            });
        }
    }
    if let Some(suffix) = value.strip_prefix(ROOT_REF_PREFIX) {
        let Some((address_key, ordinal_text)) = suffix.rsplit_once('_') else {
            return Err(AddressIndexError::InvalidReference);
        };
        if validate_address_key(address_key).is_err()
            || ordinal_text.is_empty()
            || !ordinal_text.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(AddressIndexError::InvalidReference);
        }
        let ordinal = ordinal_text
            .parse::<u32>()
            .map_err(|_| AddressIndexError::InvalidReference)?;
        if ordinal.to_string() != ordinal_text {
            return Err(AddressIndexError::InvalidReference);
        }
        return Ok(ParsedAddressRef {
            address_key: address_key.to_owned(),
            kind: AddressRefKind::Root { ordinal },
        });
    }
    Err(AddressIndexError::InvalidReference)
}

pub(crate) fn canonical_plan_digest(
    group_ref_digest: &str,
    group_generation: u64,
    roots: &[PlannedRoot],
) -> Result<String, ()> {
    let wire = PlanDigestWire {
        group_ref_digest,
        group_generation,
        roots,
    };
    let encoded = serde_json::to_vec(&wire).map_err(|_| ())?;
    // Keep the established plan digest wire and hash semantics while moving
    // the one canonical implementation into the index owner.
    Ok(digest_bytes(&[], &encoded))
}

pub(crate) fn digest_opaque_ref(value: &str) -> String {
    digest_bytes(&[], value.as_bytes())
}

impl ReconcileAddressIndexV1 {
    pub(crate) fn from_plan(
        plan: &JournalPlanValue,
        session_nonce: String,
        group_ref: String,
        root_refs: &[String],
    ) -> Result<Self, AddressIndexError> {
        let parsed_group = parse_address_ref(&group_ref)?;
        if !matches!(parsed_group.kind, AddressRefKind::Group)
            || root_refs.len() != plan.roots.len()
        {
            return Err(AddressIndexError::ReferenceMismatch);
        }
        let roots = plan
            .roots
            .iter()
            .zip(root_refs)
            .map(|(root, root_ref)| {
                let parsed_root = parse_address_ref(root_ref)?;
                if parsed_root.address_key != parsed_group.address_key
                    || parsed_root.kind
                        != (AddressRefKind::Root {
                            ordinal: root.ordinal,
                        })
                {
                    return Err(AddressIndexError::ReferenceMismatch);
                }
                Ok(IndexedRoot {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref: root_ref.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    spec_digest: root.spec_digest.clone(),
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                })
            })
            .collect::<Result<Vec<_>, AddressIndexError>>()?;
        let index = Self {
            address_key: parsed_group.address_key,
            session_nonce,
            plan_digest: plan.plan_digest.clone(),
            group_ref,
            group_ref_digest: plan.group_ref_digest.clone(),
            group_generation: plan.group_generation,
            roots,
        };
        index.validate_against_plan(plan)?;
        Ok(index)
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, AddressIndexError> {
        self.validate()?;
        serde_json::to_vec(&self.to_wire()).map_err(|_| AddressIndexError::InvalidRecord)
    }

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, AddressIndexError> {
        let wire: AddressIndexWire =
            serde_json::from_slice(bytes).map_err(|_| AddressIndexError::InvalidRecord)?;
        let index = Self::from_wire(wire)?;
        if index.encode()?.as_slice() != bytes {
            return Err(AddressIndexError::InvalidRecord);
        }
        Ok(index)
    }

    pub(crate) fn validate_against_plan(
        &self,
        plan: &JournalPlanValue,
    ) -> Result<(), AddressIndexError> {
        self.validate()?;
        if self.plan_digest != plan.plan_digest
            || self.group_ref_digest != plan.group_ref_digest
            || self.group_generation != plan.group_generation
            || self.roots.len() != plan.roots.len()
        {
            return Err(AddressIndexError::PlanMismatch);
        }
        for (actual, expected) in self.roots.iter().zip(&plan.roots) {
            if actual.ordinal != expected.ordinal
                || actual.role != expected.role
                || actual.root_ref_digest != expected.root_ref_digest
                || actual.root_generation != expected.root_generation
                || actual.spec_digest != expected.spec_digest
                || actual.reserved_listener_identity != expected.reserved_listener_identity
            {
                return Err(AddressIndexError::ReferenceMismatch);
            }
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), AddressIndexError> {
        validate_address_key(&self.address_key).map_err(|_| AddressIndexError::InvalidRecord)?;
        validate_opaque(&self.session_nonce)?;
        validate_digest(&self.plan_digest)?;
        validate_digest(&self.group_ref_digest)?;
        if self.group_generation == 0 || self.roots.is_empty() {
            return Err(AddressIndexError::InvalidRecord);
        }
        let parsed_group = parse_address_ref(&self.group_ref)?;
        if parsed_group.address_key != self.address_key
            || !matches!(parsed_group.kind, AddressRefKind::Group)
            || digest_opaque_ref(&self.group_ref) != self.group_ref_digest
        {
            return Err(AddressIndexError::ReferenceMismatch);
        }
        let mut planned_roots = Vec::with_capacity(self.roots.len());
        let mut seen = std::collections::HashSet::with_capacity(self.roots.len());
        for (ordinal, root) in self.roots.iter().enumerate() {
            if root.ordinal != ordinal as u32
                || root.root_generation == 0
                || root.role.is_empty()
                || root.role.len() > 256
            {
                return Err(AddressIndexError::InvalidRecord);
            }
            validate_digest(&root.root_ref_digest)?;
            let parsed_root = parse_address_ref(&root.root_ref)?;
            if parsed_root.address_key != self.address_key
                || parsed_root.kind
                    != (AddressRefKind::Root {
                        ordinal: root.ordinal,
                    })
                || digest_opaque_ref(&root.root_ref) != root.root_ref_digest
                || !seen.insert(root.root_ref.as_str())
            {
                return Err(AddressIndexError::ReferenceMismatch);
            }
            validate_digest(&root.spec_digest)?;
            validate_opaque(&root.root_ref)?;
            validate_opaque(&root.reserved_listener_identity)?;
            planned_roots.push(PlannedRoot {
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
        .map_err(|_| AddressIndexError::InvalidRecord)?;
        if expected_plan_digest != self.plan_digest {
            return Err(AddressIndexError::InvalidRecord);
        }
        Ok(())
    }

    fn to_wire(&self) -> AddressIndexWire {
        AddressIndexWire {
            schema_version: INDEX_SCHEMA_VERSION.to_owned(),
            producer: PRODUCER.to_owned(),
            address_key: self.address_key.clone(),
            session_nonce: self.session_nonce.clone(),
            plan_digest: self.plan_digest.clone(),
            group_ref: self.group_ref.clone(),
            group_ref_digest: self.group_ref_digest.clone(),
            group_generation: self.group_generation,
            roots: self.roots.iter().map(IndexedRoot::to_wire).collect(),
        }
    }

    fn from_wire(wire: AddressIndexWire) -> Result<Self, AddressIndexError> {
        if wire.schema_version != INDEX_SCHEMA_VERSION || wire.producer != PRODUCER {
            return Err(AddressIndexError::InvalidRecord);
        }
        Ok(Self {
            address_key: wire.address_key,
            session_nonce: wire.session_nonce,
            plan_digest: wire.plan_digest,
            group_ref: wire.group_ref,
            group_ref_digest: wire.group_ref_digest,
            group_generation: wire.group_generation,
            roots: wire.roots.into_iter().map(IndexedRoot::from_wire).collect(),
        })
    }
}

impl IndexedRoot {
    fn to_wire(&self) -> IndexedRootWire {
        IndexedRootWire {
            ordinal: self.ordinal,
            role: self.role.clone(),
            root_ref: self.root_ref.clone(),
            root_ref_digest: self.root_ref_digest.clone(),
            root_generation: self.root_generation,
            spec_digest: self.spec_digest.clone(),
            reserved_listener_identity: self.reserved_listener_identity.clone(),
        }
    }

    fn from_wire(wire: IndexedRootWire) -> Self {
        Self {
            ordinal: wire.ordinal,
            role: wire.role,
            root_ref: wire.root_ref,
            root_ref_digest: wire.root_ref_digest,
            root_generation: wire.root_generation,
            spec_digest: wire.spec_digest,
            reserved_listener_identity: wire.reserved_listener_identity,
        }
    }
}

pub(crate) fn persist_address_index(
    store: &JournalStore,
    index: &ReconcileAddressIndexV1,
) -> Result<ReconcileAddressIndexV1, AddressIndexError> {
    let encoded = index.encode()?;
    let persisted = store
        .create_or_read_immutable_auxiliary(&index.address_key, &encoded)
        .map_err(AddressIndexError::Storage)?;
    let decoded = ReconcileAddressIndexV1::decode(&persisted)?;
    if decoded != *index {
        return Err(AddressIndexError::ReferenceMismatch);
    }
    Ok(decoded)
}

pub(crate) fn reopen_from_ref(
    producer_root: PathBuf,
    reference: &str,
) -> Result<ReopenedAddress, AddressIndexError> {
    let parsed = parse_address_ref(reference)?;
    let encoded = JournalStore::read_immutable_auxiliary(&producer_root, &parsed.address_key)
        .map_err(AddressIndexError::Storage)?;
    let index = ReconcileAddressIndexV1::decode(&encoded)?;
    let plan = plan_from_index(&index)?;
    index.validate_against_plan(&plan)?;
    let config = JournalStoreConfig::new(
        producer_root,
        index.session_nonce.clone(),
        index.plan_digest.clone(),
    )
    .map_err(AddressIndexError::Storage)?;
    let store = JournalStore::new(config).map_err(AddressIndexError::Storage)?;
    let journal = store.read(&plan).map_err(AddressIndexError::Storage)?;
    validate_journal_against_index(&journal, &index)?;
    let expected_ref = match parsed.kind {
        AddressRefKind::Group => &index.group_ref,
        AddressRefKind::Root { ordinal } => index
            .roots
            .get(ordinal as usize)
            .ok_or(AddressIndexError::ReferenceMismatch)
            .map(|root| &root.root_ref)?,
    };
    if expected_ref != reference {
        return Err(AddressIndexError::ReferenceMismatch);
    }
    Ok(ReopenedAddress {
        index,
        plan,
        journal,
        kind: parsed.kind,
    })
}

fn plan_from_index(index: &ReconcileAddressIndexV1) -> Result<JournalPlanValue, AddressIndexError> {
    let plan = JournalPlanValue {
        plan_digest: index.plan_digest.clone(),
        group_ref_digest: index.group_ref_digest.clone(),
        group_generation: index.group_generation,
        roots: index
            .roots
            .iter()
            .map(|root| PlannedRoot {
                ordinal: root.ordinal,
                role: root.role.clone(),
                root_ref_digest: root.root_ref_digest.clone(),
                root_generation: root.root_generation,
                spec_digest: root.spec_digest.clone(),
                reserved_listener_identity: root.reserved_listener_identity.clone(),
            })
            .collect(),
    };
    plan.validate()
        .map_err(|_| AddressIndexError::PlanMismatch)?;
    Ok(plan)
}

fn validate_journal_against_index(
    journal: &RuntimeSessionJournalV1,
    index: &ReconcileAddressIndexV1,
) -> Result<(), AddressIndexError> {
    if journal.session_nonce != index.session_nonce || journal.plan_digest != index.plan_digest {
        return Err(AddressIndexError::PlanMismatch);
    }
    if journal.state == JournalState::PlannedUnbound
        && !matches!(journal.binding, JournalBinding::Unbound {})
    {
        return Err(AddressIndexError::ReferenceMismatch);
    }
    if let JournalBinding::Bound {
        group_ref_digest,
        group_generation,
        root_bindings,
        ..
    } = &journal.binding
    {
        if group_ref_digest != &index.group_ref_digest
            || *group_generation != index.group_generation
            || root_bindings.len() != index.roots.len()
        {
            return Err(AddressIndexError::ReferenceMismatch);
        }
        for (actual, expected) in root_bindings.iter().zip(&index.roots) {
            if actual.ordinal != expected.ordinal
                || actual.role != expected.role
                || actual.root_ref_digest != expected.root_ref_digest
                || actual.root_generation != expected.root_generation
                || actual.spec_digest != expected.spec_digest
                || actual.reserved_listener_identity != expected.reserved_listener_identity
            {
                return Err(AddressIndexError::ReferenceMismatch);
            }
        }
    }
    Ok(())
}

fn validate_address_key(value: &str) -> Result<(), ()> {
    if value.len() == ADDRESS_KEY_HEX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_digest(value: &str) -> Result<(), AddressIndexError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(AddressIndexError::InvalidRecord)
    }
}

fn validate_opaque(value: &str) -> Result<(), AddressIndexError> {
    if !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        Ok(())
    } else {
        Err(AddressIndexError::InvalidRecord)
    }
}

fn digest_bytes(domain: &[u8], bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanDigestWire<'a> {
    group_ref_digest: &'a str,
    group_generation: u64,
    roots: &'a [PlannedRoot],
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddressIndexWire {
    schema_version: String,
    producer: String,
    address_key: String,
    session_nonce: String,
    plan_digest: String,
    group_ref: String,
    group_ref_digest: String,
    group_generation: u64,
    roots: Vec<IndexedRootWire>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexedRootWire {
    ordinal: u32,
    role: String,
    root_ref: String,
    root_ref_digest: String,
    root_generation: u64,
    spec_digest: String,
    reserved_listener_identity: String,
}

#[cfg(all(test, windows))]
mod tests {
    use std::fs;

    use super::*;
    use crate::{
        journal::{JournalPlanValue, PlannedRoot},
        journal_store::{JournalStore, JournalStoreConfig},
    };
    use tempfile::tempdir;

    const PLAN_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ROOT_DIGEST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SPEC_DIGEST: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn mutate_json(bytes: &[u8], mutation: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        mutation(&mut value);
        serde_json::to_vec(&value).unwrap()
    }

    fn plan() -> JournalPlanValue {
        JournalPlanValue {
            plan_digest: PLAN_DIGEST.into(),
            group_ref_digest: ROOT_DIGEST.into(),
            group_generation: 1,
            roots: vec![PlannedRoot {
                ordinal: 0,
                role: "capture".into(),
                root_ref_digest: SPEC_DIGEST.into(),
                root_generation: 1,
                spec_digest: ROOT_DIGEST.into(),
                reserved_listener_identity: "listener-0".into(),
            }],
        }
    }

    #[test]
    fn refs_parse_directly_to_one_index_key_and_kind() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let group = group_ref_for(key).expect("group ref");
        let root = root_ref_for(key, 7).expect("root ref");
        assert_eq!(
            parse_address_ref(&group).unwrap().kind,
            AddressRefKind::Group
        );
        assert_eq!(
            parse_address_ref(&root).unwrap().kind,
            AddressRefKind::Root { ordinal: 7 }
        );
        assert_eq!(parse_address_ref(&root).unwrap().address_key, key);
        assert!(parse_address_ref("rr1_opaque-request-ref").is_err());
        assert!(parse_address_ref(&format!("r1r_{key}_00")).is_err());
    }

    #[test]
    fn complete_index_round_trip_rejects_unknown_and_plan_mismatch() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let group = group_ref_for(key).unwrap();
        let root = root_ref_for(key, 0).unwrap();
        let mut value = plan();
        value.group_ref_digest = digest_opaque_ref(&group);
        value.roots[0].root_ref_digest = digest_opaque_ref(&root);
        value.plan_digest = canonical_plan_digest(
            &value.group_ref_digest,
            value.group_generation,
            &value.roots,
        )
        .unwrap();
        let index =
            ReconcileAddressIndexV1::from_plan(&value, "session-1".into(), group, &[root]).unwrap();
        let encoded = index.encode().unwrap();
        assert_eq!(ReconcileAddressIndexV1::decode(&encoded).unwrap(), index);
        assert!(ReconcileAddressIndexV1::decode(&[encoded.as_slice(), br" "].concat()).is_err());
        let wrong = mutate_json(&encoded, |record| {
            record["planDigest"] = serde_json::json!(
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            );
        });
        assert!(matches!(
            ReconcileAddressIndexV1::decode(&wrong),
            Err(AddressIndexError::InvalidRecord)
        ));

        let mut self_consistent = index.clone();
        self_consistent.roots[0].role = "worker".into();
        let mut changed_plan = value.clone();
        changed_plan.roots[0].role = "worker".into();
        self_consistent.plan_digest = canonical_plan_digest(
            &self_consistent.group_ref_digest,
            self_consistent.group_generation,
            &changed_plan.roots,
        )
        .unwrap();
        assert!(self_consistent.encode().is_ok());
        assert!(matches!(
            self_consistent.validate_against_plan(&value),
            Err(AddressIndexError::PlanMismatch)
        ));
    }

    #[test]
    fn reopened_address_uses_only_ref_and_root_without_directory_scan() {
        let directory = tempdir().unwrap();
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let group = group_ref_for(key).unwrap();
        let root = root_ref_for(key, 0).unwrap();
        let mut value = plan();
        value.group_ref_digest = digest_opaque_ref(&group);
        value.roots[0].root_ref_digest = digest_opaque_ref(&root);
        value.plan_digest = canonical_plan_digest(
            &value.group_ref_digest,
            value.group_generation,
            &value.roots,
        )
        .unwrap();
        let config = JournalStoreConfig::new(
            directory.path().to_path_buf(),
            "session-1".into(),
            value.plan_digest.clone(),
        )
        .unwrap();
        let store = JournalStore::new(config).unwrap();
        let journal = RuntimeSessionJournalV1::planned(
            &value,
            "session-1".into(),
            "2026-01-01T00:00:00Z".into(),
        )
        .unwrap();
        store.create_initial(&value, &journal).unwrap();
        let index = ReconcileAddressIndexV1::from_plan(
            &value,
            "session-1".into(),
            group.clone(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        persist_address_index(&store, &index).unwrap();
        let reopened = reopen_from_ref(directory.path().to_path_buf(), &root).unwrap();
        assert_eq!(reopened.kind, AddressRefKind::Root { ordinal: 0 });
        assert_eq!(reopened.journal.state, JournalState::PlannedUnbound);
        assert_eq!(reopened.plan, value);
    }

    #[test]
    fn reopen_fails_closed_for_invalid_unknown_and_mismatched_index_records() {
        let directory = tempdir().unwrap();
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let group = group_ref_for(key).unwrap();
        let root = root_ref_for(key, 0).unwrap();
        let mut value = plan();
        value.group_ref_digest = digest_opaque_ref(&group);
        value.roots[0].root_ref_digest = digest_opaque_ref(&root);
        value.plan_digest = canonical_plan_digest(
            &value.group_ref_digest,
            value.group_generation,
            &value.roots,
        )
        .unwrap();
        let config = JournalStoreConfig::new(
            directory.path().to_path_buf(),
            "session-1".into(),
            value.plan_digest.clone(),
        )
        .unwrap();
        let store = JournalStore::new(config).unwrap();
        let journal = RuntimeSessionJournalV1::planned(
            &value,
            "session-1".into(),
            "2026-01-01T00:00:00Z".into(),
        )
        .unwrap();
        store.create_initial(&value, &journal).unwrap();
        let index = ReconcileAddressIndexV1::from_plan(
            &value,
            "session-1".into(),
            group,
            std::slice::from_ref(&root),
        )
        .unwrap();
        persist_address_index(&store, &index).unwrap();

        assert!(matches!(
            reopen_from_ref(directory.path().to_path_buf(), "r1r_bad"),
            Err(AddressIndexError::InvalidReference)
        ));
        let unknown = root_ref_for(
            "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            0,
        )
        .unwrap();
        assert!(matches!(
            reopen_from_ref(directory.path().to_path_buf(), &unknown),
            Err(AddressIndexError::Storage(JournalStoreError::NotFound))
        ));

        let index_path = directory
            .path()
            .join(format!("runtime-ref-index-v1-{key}.json"));
        let original = fs::read(&index_path).unwrap();
        let wrong_plan = mutate_json(&original, |record| {
            record["planDigest"] = serde_json::json!(
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            );
        });
        fs::write(&index_path, wrong_plan).unwrap();
        assert!(matches!(
            reopen_from_ref(directory.path().to_path_buf(), &root),
            Err(AddressIndexError::InvalidRecord)
        ));
        fs::write(&index_path, &original).unwrap();

        let mut wrong_session = index.clone();
        wrong_session.session_nonce = "other-session".into();
        fs::write(&index_path, wrong_session.encode().unwrap()).unwrap();
        assert!(matches!(
            reopen_from_ref(directory.path().to_path_buf(), &root),
            Err(AddressIndexError::Storage(JournalStoreError::NotFound))
        ));
        fs::write(&index_path, &original).unwrap();

        let partial = mutate_json(&original, |record| {
            record["roots"].as_array_mut().unwrap().clear();
        });
        fs::write(&index_path, &partial).unwrap();
        assert!(matches!(
            reopen_from_ref(directory.path().to_path_buf(), &root),
            Err(AddressIndexError::InvalidRecord)
        ));
        assert_eq!(fs::read(&index_path).unwrap(), partial);
        fs::write(&index_path, &original).unwrap();
        assert_eq!(fs::read(&index_path).unwrap(), original);
    }

    #[test]
    fn auxiliary_index_rejects_oversize_before_create_and_keeps_foreign_collision() {
        let directory = tempdir().unwrap();
        let store = JournalStore::new(
            JournalStoreConfig::new(
                directory.path().to_path_buf(),
                "session-1".into(),
                PLAN_DIGEST.into(),
            )
            .unwrap(),
        )
        .unwrap();
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            store.create_or_read_immutable_auxiliary(key, &vec![b'x'; 1024 * 1024 + 1]),
            Err(JournalStoreError::TooLarge)
        );
        assert!(directory.path().read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".json")));

        let index_path = directory
            .path()
            .join(format!("runtime-ref-index-v1-{key}.json"));
        fs::write(&index_path, b"foreign-index").unwrap();
        assert_eq!(
            store.create_or_read_immutable_auxiliary(key, b"replacement"),
            Ok(b"foreign-index".to_vec())
        );
        assert_eq!(fs::read(&index_path).unwrap(), b"foreign-index");
    }

    #[test]
    fn partial_root_index_cannot_reconstruct_a_plan() {
        let directory = tempdir().unwrap();
        let key = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        let group = group_ref_for(key).unwrap();
        let root_zero = root_ref_for(key, 0).unwrap();
        let root_one = root_ref_for(key, 1).unwrap();
        let mut value = plan();
        value.roots.push(PlannedRoot {
            ordinal: 1,
            role: "worker".into(),
            root_ref_digest: digest_opaque_ref(&root_one),
            root_generation: 2,
            spec_digest: ROOT_DIGEST.into(),
            reserved_listener_identity: "listener-1".into(),
        });
        value.group_ref_digest = digest_opaque_ref(&group);
        value.roots[0].root_ref_digest = digest_opaque_ref(&root_zero);
        value.plan_digest = canonical_plan_digest(
            &value.group_ref_digest,
            value.group_generation,
            &value.roots,
        )
        .unwrap();
        let index = ReconcileAddressIndexV1::from_plan(
            &value,
            "session-1".into(),
            group,
            &[root_zero.clone(), root_one],
        )
        .unwrap();
        let index_path = directory
            .path()
            .join(format!("runtime-ref-index-v1-{key}.json"));
        let partial = mutate_json(&index.encode().unwrap(), |record| {
            record["roots"].as_array_mut().unwrap().pop();
        });
        fs::write(&index_path, partial).unwrap();
        assert!(matches!(
            reopen_from_ref(directory.path().to_path_buf(), &root_zero),
            Err(AddressIndexError::InvalidRecord)
        ));
    }
}
