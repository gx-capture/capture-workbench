#[cfg(windows)]
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};

#[cfg(test)]
use std::cell::Cell;

#[cfg(windows)]
use crate::journal::{JournalPlanValue, JournalState, RuntimeSessionJournalV1, StagingBinding};

#[cfg(windows)]
use super::{
    failure::StagingCleanupError,
    identity::{
        capture_directory_identity, capture_file_identity, has_multiple_hard_links,
        metadata_is_reparse, validate_safe_chain, FileIdentity,
    },
    marker::{
        RunStagingMarkerV1, MARKER_FILE_NAME, MARKER_PRODUCER, MARKER_SCHEMA_VERSION,
        MAX_MARKER_BYTES,
    },
    release_tree::{
        check_staging_release_budget, collect_release_nodes, read_release_entries,
        MAX_RELEASE_TREE_DEPTH, MAX_RELEASE_TREE_ENTRIES,
    },
    scope_digest::{root_identity_digest, run_staging_scope_digest},
};

#[cfg(all(test, windows))]
use super::{
    marker::RunStagingMarkerRoot,
    scope_digest::{hex_lower, put_string},
};

#[cfg(test)]
thread_local! {
    static CANCEL_RESTART_AFTER_MARKER: Cell<bool> = const { Cell::new(false) };
}

// Kept aligned with the descriptor's private staging root; the descriptor
// constant is intentionally private to launcher.rs.
const PRIVATE_RUN_STAGING_DIRECTORY: &str = "private-run-staging";

#[cfg(windows)]
const MAX_RESTART_STAGING_CANDIDATES: usize = 64;

/// Sanitized failure reasons for the read-only restart staging observer.  No
/// path, native identifier, or storage diagnostic crosses this boundary.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartStagingObservationReason {
    InvalidRecord,
    RecordUnavailable,
    MissingStaging,
    AmbiguousStaging,
    TraversalBound,
    Reparse,
    IdentityChanged,
    ForeignEntry,
    HardLink,
    Cancelled,
    Deadline,
}

/// Exact filesystem evidence from one read-only restart observation.  The
/// fields remain private so this value cannot become cleanup or activation
/// authority by construction.  The identities and bounded marker bytes are
/// retained for a later owner to revalidate immediately before any CAS or
/// destructive operation.
#[cfg(windows)]
pub(crate) struct RestartStagingObservation {
    group_path: PathBuf,
    group_staging_identity: String,
    binding: StagingBinding,
    producer_root_identity: FileIdentity,
    shared_parent_identity: FileIdentity,
    group_identity: FileIdentity,
    marker_identity: FileIdentity,
    marker_bytes: Vec<u8>,
    root_identities: Vec<FileIdentity>,
}

#[cfg(windows)]
impl RestartStagingObservation {
    #[cfg(test)]
    fn binding(&self) -> &StagingBinding {
        &self.binding
    }

    #[cfg(test)]
    fn group_path(&self) -> &Path {
        &self.group_path
    }
}

/// Reopen one producer-owned run scope without turning the observed paths into
/// cleanup authority.  The journal supplies the immutable session/plan
/// binding; the marker supplies the otherwise undiscoverable staging nonce;
/// every filesystem identity is captured again before the V2 digest is
/// compared with the durable binding.
#[cfg(windows)]
pub(crate) fn observe_restart_staging(
    producer_root: &Path,
    plan: &JournalPlanValue,
    journal: &RuntimeSessionJournalV1,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<RestartStagingObservation, RestartStagingObservationReason> {
    check_restart_staging_budget(deadline, cancellation)?;
    journal
        .validate_against_plan(plan)
        .map_err(|_| RestartStagingObservationReason::InvalidRecord)?;
    let has_allowed_state = matches!(
        journal.state,
        JournalState::Ready
            | JournalState::Launching
            | JournalState::Running
            | JournalState::Closing
    ) || (journal.state == JournalState::ReconcileRequired
        && has_complete_restart_resources(journal, plan));
    if !has_allowed_state {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    if plan.roots.is_empty() || plan.roots.len() > MAX_RELEASE_TREE_ENTRIES {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    if journal.roots.len() != plan.roots.len() {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    let binding = journal
        .staging_binding
        .as_ref()
        .ok_or(RestartStagingObservationReason::MissingStaging)?
        .clone();
    if binding.run_nonce != journal.session_nonce || binding.scope != "run" {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }

    if validate_safe_chain(producer_root).is_err() {
        return Err(RestartStagingObservationReason::Reparse);
    }
    let producer_root_identity = restart_directory_identity(producer_root, deadline, cancellation)?;
    let shared_parent = producer_root.join(PRIVATE_RUN_STAGING_DIRECTORY);
    if validate_safe_chain(&shared_parent).is_err() {
        return Err(RestartStagingObservationReason::Reparse);
    }
    let shared_parent_identity =
        restart_directory_identity(&shared_parent, deadline, cancellation)?;

    let mut remaining_entries = MAX_RELEASE_TREE_ENTRIES;
    let mut candidate_count = 0_usize;
    let mut candidate = None;
    let mut parent_entries = read_release_entries(
        &shared_parent,
        deadline,
        cancellation,
        &mut remaining_entries,
    )
    .map_err(map_restart_staging_cleanup_error)?;
    parent_entries.sort_by_key(|entry| entry.path());
    for entry in parent_entries {
        check_restart_staging_budget(deadline, cancellation)?;
        let group_path = entry.path();
        if group_path.parent() != Some(shared_parent.as_path()) {
            return Err(RestartStagingObservationReason::ForeignEntry);
        }
        let group_identity = restart_directory_identity(&group_path, deadline, cancellation)?;
        candidate_count = candidate_count
            .checked_add(1)
            .ok_or(RestartStagingObservationReason::TraversalBound)?;
        if candidate_count > MAX_RESTART_STAGING_CANDIDATES {
            return Err(RestartStagingObservationReason::TraversalBound);
        }
        let group_name = group_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(RestartStagingObservationReason::InvalidRecord)?;
        let marker_path = group_path.join(MARKER_FILE_NAME);
        let (marker_bytes, marker_identity) =
            read_restart_marker(&marker_path, deadline, cancellation, &mut remaining_entries)?;
        let marker = decode_restart_marker(&marker_bytes)?;
        validate_restart_marker_header(&marker, group_name)?;
        if marker.session_nonce != journal.session_nonce || marker.plan_digest != plan.plan_digest {
            continue;
        }
        validate_restart_marker_against_plan(&marker, plan)?;
        if candidate.is_some() {
            return Err(RestartStagingObservationReason::AmbiguousStaging);
        }
        candidate = Some((
            group_path,
            group_identity,
            marker,
            marker_bytes,
            marker_identity,
        ));
    }

    let (
        group_path,
        candidate_group_identity,
        marker,
        candidate_marker_bytes,
        candidate_marker_identity,
    ) = candidate.ok_or(RestartStagingObservationReason::MissingStaging)?;
    if validate_safe_chain(&group_path).is_err() {
        return Err(RestartStagingObservationReason::Reparse);
    }
    let group_identity = restart_directory_identity(&group_path, deadline, cancellation)?;
    if group_identity != candidate_group_identity {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    let marker_path = group_path.join(MARKER_FILE_NAME);
    let mut group_entries =
        read_release_entries(&group_path, deadline, cancellation, &mut remaining_entries)
            .map_err(map_restart_staging_cleanup_error)?;
    group_entries.sort_by_key(|entry| entry.path());
    let mut saw_marker = false;
    let mut saw_roots = vec![false; plan.roots.len()];
    for entry in group_entries {
        check_restart_staging_budget(deadline, cancellation)?;
        let path = entry.path();
        if path.parent() != Some(group_path.as_path()) {
            return Err(RestartStagingObservationReason::ForeignEntry);
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| RestartStagingObservationReason::IdentityChanged)?;
        if metadata_is_reparse(&metadata) {
            return Err(RestartStagingObservationReason::Reparse);
        }
        if path == marker_path {
            if saw_marker || !metadata.is_file() {
                return Err(RestartStagingObservationReason::ForeignEntry);
            }
            saw_marker = true;
            continue;
        }
        let ordinal = parse_restart_root_ordinal(&path)?;
        if ordinal >= plan.roots.len() || saw_roots[ordinal] || !metadata.is_dir() {
            return Err(if metadata.is_dir() {
                RestartStagingObservationReason::ForeignEntry
            } else {
                RestartStagingObservationReason::IdentityChanged
            });
        }
        saw_roots[ordinal] = true;
    }
    if !saw_marker || saw_roots.iter().any(|seen| !seen) {
        return Err(RestartStagingObservationReason::MissingStaging);
    }
    if has_multiple_hard_links(
        &marker_path,
        &fs::symlink_metadata(&marker_path)
            .map_err(|_| RestartStagingObservationReason::IdentityChanged)?,
    ) {
        return Err(RestartStagingObservationReason::HardLink);
    }

    let (marker_bytes, marker_identity) =
        read_restart_marker(&marker_path, deadline, cancellation, &mut remaining_entries)?;
    if marker_bytes != candidate_marker_bytes || marker_identity != candidate_marker_identity {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    validate_restart_marker_against_plan(&marker, plan)?;

    let mut root_identities = Vec::with_capacity(plan.roots.len());
    for ordinal in 0..plan.roots.len() {
        check_restart_staging_budget(deadline, cancellation)?;
        let root_path = group_path.join(format!("root-{ordinal:08}"));
        let root_identity = restart_directory_identity(&root_path, deadline, cancellation)?;
        let mut descendants = Vec::new();
        collect_release_nodes(
            &root_path,
            root_identity,
            1,
            MAX_RELEASE_TREE_DEPTH,
            &mut descendants,
            deadline,
            cancellation,
            &mut remaining_entries,
        )
        .map_err(map_restart_staging_cleanup_error)?;
        let reread_root_identity = restart_directory_identity(&root_path, deadline, cancellation)?;
        if reread_root_identity != root_identity {
            return Err(RestartStagingObservationReason::IdentityChanged);
        }
        root_identities.push(root_identity);
    }

    let reread_group_identity = restart_directory_identity(&group_path, deadline, cancellation)?;
    let reread_shared_parent_identity =
        restart_directory_identity(&shared_parent, deadline, cancellation)?;
    let reread_producer_root_identity =
        restart_directory_identity(producer_root, deadline, cancellation)?;
    if reread_group_identity != group_identity
        || reread_shared_parent_identity != shared_parent_identity
        || reread_producer_root_identity != producer_root_identity
    {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    check_restart_staging_budget(deadline, cancellation)?;
    let actual_digest = run_staging_scope_digest(
        producer_root_identity,
        shared_parent_identity,
        group_identity,
        marker_identity,
        &marker.group_staging_identity,
        &marker_bytes,
        &root_identities,
    );
    if actual_digest != binding.root_digest {
        return Err(RestartStagingObservationReason::IdentityChanged);
    }
    Ok(RestartStagingObservation {
        group_path,
        group_staging_identity: marker.group_staging_identity,
        binding,
        producer_root_identity,
        shared_parent_identity,
        group_identity,
        marker_identity,
        marker_bytes,
        root_identities,
    })
}

#[cfg(windows)]
fn has_complete_restart_resources(
    journal: &RuntimeSessionJournalV1,
    plan: &JournalPlanValue,
) -> bool {
    journal.attempt < 3
        && matches!(
            journal.job_binding.as_ref(),
            Some(crate::journal::JobBinding {
                setup_state: crate::journal::JobSetupState::Committed,
                ..
            })
        )
        && journal.staging_binding.is_some()
        && journal.roots.len() == plan.roots.len()
        && journal
            .roots
            .iter()
            .enumerate()
            .all(|(ordinal, root)| root.ordinal == ordinal as u32)
}

#[cfg(windows)]
fn check_restart_staging_budget(
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<(), RestartStagingObservationReason> {
    check_staging_release_budget(deadline, cancellation).map_err(map_restart_staging_cleanup_error)
}

#[cfg(windows)]
fn map_restart_staging_cleanup_error(
    error: StagingCleanupError,
) -> RestartStagingObservationReason {
    match error {
        StagingCleanupError::Cancelled => RestartStagingObservationReason::Cancelled,
        StagingCleanupError::Deadline => RestartStagingObservationReason::Deadline,
        StagingCleanupError::TraversalBound => RestartStagingObservationReason::TraversalBound,
        StagingCleanupError::Reparse => RestartStagingObservationReason::Reparse,
        StagingCleanupError::HardLink => RestartStagingObservationReason::HardLink,
        StagingCleanupError::ForeignEntry => RestartStagingObservationReason::ForeignEntry,
        StagingCleanupError::IdentityChanged
        | StagingCleanupError::JournalChanged
        | StagingCleanupError::OwnershipUnknown
        | StagingCleanupError::NonEmpty
        | StagingCleanupError::DeleteFailed => RestartStagingObservationReason::IdentityChanged,
    }
}

#[cfg(windows)]
fn consume_restart_entry(
    remaining_entries: &mut usize,
) -> Result<(), RestartStagingObservationReason> {
    if *remaining_entries == 0 {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    *remaining_entries -= 1;
    Ok(())
}

#[cfg(windows)]
fn restart_directory_identity(
    path: &Path,
    deadline: Instant,
    cancellation: &AtomicBool,
) -> Result<FileIdentity, RestartStagingObservationReason> {
    check_restart_staging_budget(deadline, cancellation)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RestartStagingObservationReason::RecordUnavailable
        } else {
            RestartStagingObservationReason::ForeignEntry
        }
    })?;
    if metadata_is_reparse(&metadata) {
        return Err(RestartStagingObservationReason::Reparse);
    }
    if !metadata.is_dir() {
        return Err(RestartStagingObservationReason::ForeignEntry);
    }
    check_restart_staging_budget(deadline, cancellation)?;
    let identity = capture_directory_identity(path)
        .map_err(|_| RestartStagingObservationReason::IdentityChanged)?;
    check_restart_staging_budget(deadline, cancellation)?;
    Ok(identity)
}

#[cfg(windows)]
fn read_restart_marker(
    path: &Path,
    deadline: Instant,
    cancellation: &AtomicBool,
    remaining_entries: &mut usize,
) -> Result<(Vec<u8>, FileIdentity), RestartStagingObservationReason> {
    check_restart_staging_budget(deadline, cancellation)?;
    consume_restart_entry(remaining_entries)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RestartStagingObservationReason::MissingStaging
        } else {
            RestartStagingObservationReason::ForeignEntry
        }
    })?;
    if !metadata.is_file() {
        return Err(RestartStagingObservationReason::ForeignEntry);
    }
    if metadata_is_reparse(&metadata) {
        return Err(RestartStagingObservationReason::Reparse);
    }
    if has_multiple_hard_links(path, &metadata) {
        return Err(RestartStagingObservationReason::HardLink);
    }
    if metadata.len() > MAX_MARKER_BYTES as u64 {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    let file = File::open(path).map_err(|_| RestartStagingObservationReason::ForeignEntry)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| RestartStagingObservationReason::ForeignEntry)?;
    check_restart_staging_budget(deadline, cancellation)?;
    if bytes.len() > MAX_MARKER_BYTES {
        return Err(RestartStagingObservationReason::TraversalBound);
    }
    let identity = capture_file_identity(path)
        .map_err(|_| RestartStagingObservationReason::IdentityChanged)?;
    #[cfg(test)]
    if CANCEL_RESTART_AFTER_MARKER.with(|fault| fault.replace(false)) {
        cancellation.store(true, std::sync::atomic::Ordering::Release);
    }
    check_restart_staging_budget(deadline, cancellation)?;
    Ok((bytes, identity))
}

#[cfg(windows)]
fn decode_restart_marker(
    bytes: &[u8],
) -> Result<RunStagingMarkerV1, RestartStagingObservationReason> {
    let marker = serde_json::from_slice::<RunStagingMarkerV1>(bytes)
        .map_err(|_| RestartStagingObservationReason::InvalidRecord)?;
    let canonical =
        serde_json::to_vec(&marker).map_err(|_| RestartStagingObservationReason::InvalidRecord)?;
    if canonical != bytes {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    Ok(marker)
}

#[cfg(windows)]
fn validate_restart_marker_header(
    marker: &RunStagingMarkerV1,
    group_name: &str,
) -> Result<(), RestartStagingObservationReason> {
    if marker.schema_version != MARKER_SCHEMA_VERSION
        || marker.producer != MARKER_PRODUCER
        || !is_restart_opaque(&marker.session_nonce)
        || !is_restart_digest(&marker.plan_digest)
        || !is_restart_private_nonce(&marker.group_staging_identity)
        || marker.group_staging_identity != group_name
    {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    Ok(())
}

#[cfg(windows)]
fn validate_restart_marker_against_plan(
    marker: &RunStagingMarkerV1,
    plan: &JournalPlanValue,
) -> Result<(), RestartStagingObservationReason> {
    if marker.roots.len() != plan.roots.len() || marker.roots.len() > MAX_RELEASE_TREE_ENTRIES {
        return Err(RestartStagingObservationReason::InvalidRecord);
    }
    for (ordinal, (actual, planned)) in marker.roots.iter().zip(&plan.roots).enumerate() {
        if actual.ordinal != ordinal as u32
            || !is_restart_digest(&actual.root_identity_digest)
            || actual.root_identity_digest
                != root_identity_digest(&marker.group_staging_identity, actual.ordinal, planned)
        {
            return Err(RestartStagingObservationReason::InvalidRecord);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn parse_restart_root_ordinal(path: &Path) -> Result<usize, RestartStagingObservationReason> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(RestartStagingObservationReason::ForeignEntry)?;
    let Some(suffix) = name.strip_prefix("root-") else {
        return Err(RestartStagingObservationReason::ForeignEntry);
    };
    if suffix.len() != 8 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RestartStagingObservationReason::ForeignEntry);
    }
    suffix
        .parse::<usize>()
        .map_err(|_| RestartStagingObservationReason::ForeignEntry)
}

#[cfg(windows)]
fn is_restart_private_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(windows)]
fn is_restart_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

#[cfg(windows)]
fn is_restart_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
pub(crate) fn cancel_restart_after_marker_for_test() {
    CANCEL_RESTART_AFTER_MARKER.with(|fault| fault.set(true));
}

#[cfg(all(test, windows))]
mod tests {
    use std::{process::Command, time::Duration};

    use sha2::{Digest, Sha256};

    use super::*;

    #[cfg(windows)]
    use crate::{
        journal::{
            BoundRoot, CreationIdentity, JobBinding, JobSetupState, JournalBinding, JournalRoot,
            RootState,
        },
        prepare::{build_immutable_group_plan, PreparePlanDraft, PrepareRootDraft},
    };

    #[cfg(windows)]
    fn legacy_v1_scope_digest_fixture(
        group_staging_identity: &str,
        marker_bytes: &[u8],
        root_identities: &[FileIdentity],
    ) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"capture-runtime/run-staging-scope/v1\0");
        put_string(&mut hasher, group_staging_identity);
        hasher.update((marker_bytes.len() as u64).to_be_bytes());
        hasher.update(marker_bytes);
        for (ordinal, identity) in root_identities.iter().copied().enumerate() {
            hasher.update((ordinal as u64).to_be_bytes());
            hasher.update(identity.first.to_be_bytes());
            hasher.update(identity.second.to_be_bytes());
        }
        hex_lower(&hasher.finalize())
    }

    #[cfg(windows)]
    struct RestartStagingFixture {
        directory: tempfile::TempDir,
        producer_root: PathBuf,
        plan: JournalPlanValue,
        journal: RuntimeSessionJournalV1,
        group: PathBuf,
        marker: PathBuf,
        roots: Vec<PathBuf>,
    }

    #[cfg(windows)]
    impl RestartStagingFixture {
        fn new(root_count: usize) -> Self {
            let directory = tempfile::tempdir().expect("restart staging fixture directory");
            let producer_root = directory.path().join("producer-root");
            fs::create_dir(&producer_root).expect("producer root");
            let plan = build_immutable_group_plan(
                PreparePlanDraft {
                    group_generation: 1,
                    roots: (0..root_count)
                        .map(|ordinal| PrepareRootDraft {
                            ordinal: ordinal as u32,
                            role: format!("root-{ordinal}"),
                            root_generation: ordinal as u64 + 1,
                            spec_digest: format!("{:064x}", ordinal + 1),
                            reserved_listener_identity: format!("listener-{ordinal}"),
                        })
                        .collect(),
                },
                producer_root.clone(),
                "session-1".into(),
            )
            .expect("restart staging plan")
            .value;
            let group_staging_identity = "0123456789abcdef0123456789abcdef";
            let shared_parent = producer_root.join(PRIVATE_RUN_STAGING_DIRECTORY);
            let group = shared_parent.join(group_staging_identity);
            fs::create_dir_all(&group).expect("staging group");
            let roots = (0..root_count)
                .map(|ordinal| group.join(format!("root-{ordinal:08}")))
                .collect::<Vec<_>>();
            for root in &roots {
                fs::create_dir(root).expect("staging root");
            }
            let marker = group.join(MARKER_FILE_NAME);
            let marker_record = RunStagingMarkerV1 {
                schema_version: MARKER_SCHEMA_VERSION.into(),
                producer: MARKER_PRODUCER.into(),
                session_nonce: "session-1".into(),
                plan_digest: plan.plan_digest.clone(),
                group_staging_identity: group_staging_identity.into(),
                roots: plan
                    .roots
                    .iter()
                    .map(|root| RunStagingMarkerRoot {
                        ordinal: root.ordinal,
                        root_identity_digest: root_identity_digest(
                            group_staging_identity,
                            root.ordinal,
                            root,
                        ),
                    })
                    .collect(),
            };
            let marker_bytes = serde_json::to_vec(&marker_record).expect("marker encoding");
            fs::write(&marker, &marker_bytes).expect("marker");

            let binding = JournalBinding::Bound {
                binding_attempt_id: "attempt-1".into(),
                group_ref_digest: plan.group_ref_digest.clone(),
                group_generation: plan.group_generation,
                root_bindings: plan
                    .roots
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
                activation_receipt_digest:
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            };
            let root_identities = roots
                .iter()
                .map(|root| capture_directory_identity(root).expect("root identity"))
                .collect::<Vec<_>>();
            let staging_binding = StagingBinding {
                run_nonce: "session-1".into(),
                root_digest: run_staging_scope_digest(
                    capture_directory_identity(&producer_root).expect("producer identity"),
                    capture_directory_identity(&shared_parent).expect("parent identity"),
                    capture_directory_identity(&group).expect("group identity"),
                    capture_file_identity(&marker).expect("marker identity"),
                    group_staging_identity,
                    &marker_bytes,
                    &root_identities,
                ),
                scope: "run".into(),
            };
            let mut journal = RuntimeSessionJournalV1::planned(
                &plan,
                "session-1".into(),
                "2026-01-01T00:00:00Z".into(),
            )
            .expect("planned journal");
            journal.state = JournalState::Ready;
            journal.journal_revision = 1;
            journal.updated_at = "2026-01-01T00:00:01Z".into();
            journal.binding = binding;
            journal.job_binding = Some(JobBinding {
                setup_state: JobSetupState::Committed,
                job_nonce: "job-1".into(),
            });
            journal.staging_binding = Some(staging_binding);
            journal.roots = plan
                .roots
                .iter()
                .map(|root| JournalRoot {
                    ordinal: root.ordinal,
                    role: root.role.clone(),
                    root_ref_digest: root.root_ref_digest.clone(),
                    root_generation: root.root_generation,
                    root_nonce: format!("root-nonce-{}", root.ordinal),
                    pid: std::process::id(),
                    creation_identity: CreationIdentity {
                        kind: "windows-process-creation".into(),
                        value: "1".into(),
                    },
                    state: RootState::Suspended,
                    reserved_listener_identity: root.reserved_listener_identity.clone(),
                    loopback_port: 40000 + root.ordinal as u16,
                    live_listener_readiness: None,
                    started_at: "2026-01-01T00:00:00Z".into(),
                })
                .collect();
            journal
                .validate_against_plan(&plan)
                .expect("valid restart staging journal");

            Self {
                directory,
                producer_root,
                plan,
                journal,
                group,
                marker,
                roots,
            }
        }

        fn observe(&self) -> Result<RestartStagingObservation, RestartStagingObservationReason> {
            observe_restart_staging(
                &self.producer_root,
                &self.plan,
                &self.journal,
                Instant::now() + Duration::from_secs(10),
                &AtomicBool::new(false),
            )
        }
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_accepts_real_one_and_n_root_scopes() {
        for root_count in [1, 2] {
            let fixture = RestartStagingFixture::new(root_count);
            let observation = fixture.observe().expect("complete staging observation");
            assert_eq!(
                observation.binding(),
                fixture.journal.staging_binding.as_ref().expect("binding")
            );
            assert_eq!(observation.group_path(), fixture.group.as_path());
            assert!(fixture.marker.is_file());
            assert_eq!(fixture.roots.len(), root_count);
            assert!(fixture.directory.path().exists());
        }

        for attempt in [1, 2] {
            let mut retry = RestartStagingFixture::new(1);
            retry.journal.state = JournalState::ReconcileRequired;
            retry.journal.attempt = attempt;
            assert!(retry.observe().is_ok(), "complete retry attempt {attempt}");
        }
        let mut missing_resources = RestartStagingFixture::new(1);
        missing_resources.journal.state = JournalState::ReconcileRequired;
        missing_resources.journal.attempt = 1;
        missing_resources.journal.roots.clear();
        assert!(matches!(
            missing_resources.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_rejects_replaced_group_and_byte_identical_marker() {
        let group_fixture = RestartStagingFixture::new(1);
        let moved_group = group_fixture
            .group
            .parent()
            .expect("shared parent")
            .join("moved-group");
        fs::rename(&group_fixture.group, &moved_group).expect("move original group");
        fs::create_dir(&group_fixture.group).expect("replacement group");
        fs::rename(
            moved_group.join(MARKER_FILE_NAME),
            group_fixture.marker.clone(),
        )
        .expect("move original marker");
        for (ordinal, root) in group_fixture.roots.iter().enumerate() {
            fs::rename(moved_group.join(format!("root-{ordinal:08}")), root)
                .expect("move original root");
        }
        fs::remove_dir(&moved_group).expect("remove empty moved group");
        assert!(matches!(
            group_fixture.observe(),
            Err(RestartStagingObservationReason::IdentityChanged)
        ));

        let marker_fixture = RestartStagingFixture::new(1);
        let marker_copy = marker_fixture.group.join("marker-copy");
        fs::copy(&marker_fixture.marker, &marker_copy).expect("copy marker");
        fs::remove_file(&marker_fixture.marker).expect("remove marker");
        fs::rename(&marker_copy, &marker_fixture.marker).expect("replace marker");
        assert!(matches!(
            marker_fixture.observe(),
            Err(RestartStagingObservationReason::IdentityChanged)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_rejects_missing_foreign_and_hardlinked_stage_without_mutation() {
        let missing_marker = RestartStagingFixture::new(1);
        let before = fs::read(&missing_marker.marker).expect("marker bytes");
        fs::remove_file(&missing_marker.marker).expect("remove marker");
        assert!(matches!(
            missing_marker.observe(),
            Err(RestartStagingObservationReason::MissingStaging)
        ));
        assert!(!missing_marker.marker.exists());
        assert!(!before.is_empty());

        let foreign_entry = RestartStagingFixture::new(1);
        fs::write(foreign_entry.group.join("foreign"), b"foreign").expect("foreign entry");
        assert!(matches!(
            foreign_entry.observe(),
            Err(RestartStagingObservationReason::ForeignEntry)
        ));
        assert!(foreign_entry.group.join("foreign").is_file());

        let hardlinked = RestartStagingFixture::new(1);
        let payload = hardlinked.roots[0].join("payload");
        let hardlink = hardlinked.roots[0].join("hardlink");
        fs::write(&payload, b"payload").expect("payload");
        fs::hard_link(&payload, &hardlink).expect("hardlink");
        assert!(matches!(
            hardlinked.observe(),
            Err(RestartStagingObservationReason::HardLink)
        ));
        assert!(payload.is_file() && hardlink.is_file());

        let missing_root = RestartStagingFixture::new(2);
        fs::remove_dir(&missing_root.roots[1]).expect("remove second root");
        assert!(matches!(
            missing_root.observe(),
            Err(RestartStagingObservationReason::MissingStaging)
        ));

        let reparse = RestartStagingFixture::new(1);
        let target = reparse.directory.path().join("foreign-target");
        fs::create_dir(&target).expect("reparse target");
        fs::remove_dir(&reparse.roots[0]).expect("remove root for junction");
        let junction = Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                reparse.roots[0].to_str().expect("junction path"),
                target.to_str().expect("junction target"),
            ])
            .status()
            .expect("mklink junction");
        assert!(junction.success(), "junction fixture could not be created");
        assert!(matches!(
            reparse.observe(),
            Err(RestartStagingObservationReason::Reparse)
        ));
        assert!(target.exists());
    }

    #[cfg(windows)]
    #[test]
    fn restart_observer_requires_canonical_closed_marker_and_full_budget() {
        let fixture = RestartStagingFixture::new(1);
        let valid = fs::read(&fixture.marker).expect("valid marker");
        let mut noncanonical = b" ".to_vec();
        noncanonical.extend_from_slice(&valid);
        fs::write(&fixture.marker, &noncanonical).expect("noncanonical marker");
        assert!(matches!(
            fixture.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let duplicate = RestartStagingFixture::new(1);
        let duplicate_bytes = String::from_utf8(fs::read(&duplicate.marker).expect("marker"))
            .expect("marker utf8")
            .replacen(
                "\"producer\":",
                "\"schemaVersion\":\"RunStagingMarkerV1\",\"producer\":",
                1,
            );
        fs::write(&duplicate.marker, duplicate_bytes.as_bytes()).expect("duplicate marker");
        assert!(matches!(
            duplicate.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let unknown = RestartStagingFixture::new(1);
        let mut unknown_value: serde_json::Value =
            serde_json::from_slice(&valid).expect("marker json");
        unknown_value
            .as_object_mut()
            .expect("marker object")
            .insert("unknown".into(), true.into());
        fs::write(
            &unknown.marker,
            serde_json::to_vec(&unknown_value).expect("unknown marker"),
        )
        .expect("unknown marker write");
        assert!(matches!(
            unknown.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let wrong_type = RestartStagingFixture::new(1);
        let mut wrong_type_value: serde_json::Value =
            serde_json::from_slice(&valid).expect("marker json");
        wrong_type_value
            .as_object_mut()
            .expect("marker object")
            .insert("roots".into(), "wrong-type".into());
        fs::write(
            &wrong_type.marker,
            serde_json::to_vec(&wrong_type_value).expect("wrong type marker"),
        )
        .expect("wrong type marker write");
        assert!(matches!(
            wrong_type.observe(),
            Err(RestartStagingObservationReason::InvalidRecord)
        ));

        let mut legacy_binding = RestartStagingFixture::new(1);
        let marker_bytes = fs::read(&legacy_binding.marker).expect("legacy marker bytes");
        let root_identities = legacy_binding
            .roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("legacy root identity"))
            .collect::<Vec<_>>();
        let legacy_digest = legacy_v1_scope_digest_fixture(
            "0123456789abcdef0123456789abcdef",
            &marker_bytes,
            &root_identities,
        );
        legacy_binding
            .journal
            .staging_binding
            .as_mut()
            .expect("legacy staging binding")
            .root_digest = legacy_digest;
        assert!(matches!(
            legacy_binding.observe(),
            Err(RestartStagingObservationReason::IdentityChanged)
        ));

        let cancelled = RestartStagingFixture::new(1);
        assert!(matches!(
            observe_restart_staging(
                &cancelled.producer_root,
                &cancelled.plan,
                &cancelled.journal,
                Instant::now() + Duration::from_secs(10),
                &AtomicBool::new(true),
            ),
            Err(RestartStagingObservationReason::Cancelled)
        ));

        let cancelled_after_work = RestartStagingFixture::new(1);
        let marker_before_cancel = fs::read(&cancelled_after_work.marker).expect("marker");
        cancel_restart_after_marker_for_test();
        assert!(matches!(
            cancelled_after_work.observe(),
            Err(RestartStagingObservationReason::Cancelled)
        ));
        assert_eq!(
            fs::read(&cancelled_after_work.marker).expect("marker"),
            marker_before_cancel
        );

        let expired = RestartStagingFixture::new(1);
        assert!(matches!(
            observe_restart_staging(
                &expired.producer_root,
                &expired.plan,
                &expired.journal,
                Instant::now() - Duration::from_millis(1),
                &AtomicBool::new(false),
            ),
            Err(RestartStagingObservationReason::Deadline)
        ));

        let oversized = RestartStagingFixture::new(1);
        let oversized_bytes = vec![b'x'; MAX_MARKER_BYTES + 1];
        fs::write(&oversized.marker, &oversized_bytes).expect("oversized marker");
        assert!(matches!(
            oversized.observe(),
            Err(RestartStagingObservationReason::TraversalBound)
        ));
        assert_eq!(
            fs::read(&oversized.marker).expect("oversized marker"),
            oversized_bytes
        );

        let candidate_bound = RestartStagingFixture::new(1);
        let candidate_marker_before =
            fs::read(&candidate_bound.marker).expect("candidate bound marker");
        let candidate_parent = candidate_bound
            .producer_root
            .join(PRIVATE_RUN_STAGING_DIRECTORY);
        for index in 1..=MAX_RESTART_STAGING_CANDIDATES {
            let group_name = format!("{index:032x}");
            let group = candidate_parent.join(&group_name);
            fs::create_dir(&group).expect("candidate group");
            let marker = RunStagingMarkerV1 {
                schema_version: MARKER_SCHEMA_VERSION.into(),
                producer: MARKER_PRODUCER.into(),
                session_nonce: format!("foreign-{index}"),
                plan_digest: candidate_bound.plan.plan_digest.clone(),
                group_staging_identity: group_name,
                roots: Vec::new(),
            };
            fs::write(
                group.join(MARKER_FILE_NAME),
                serde_json::to_vec(&marker).expect("candidate marker"),
            )
            .expect("candidate marker");
        }
        assert!(matches!(
            candidate_bound.observe(),
            Err(RestartStagingObservationReason::TraversalBound)
        ));
        assert_eq!(
            fs::read(&candidate_bound.marker).expect("candidate bound marker"),
            candidate_marker_before
        );
        assert!(candidate_parent
            .join(format!("{:032x}", MAX_RESTART_STAGING_CANDIDATES))
            .join(MARKER_FILE_NAME)
            .is_file());

        let deep = RestartStagingFixture::new(1);
        let mut deepest = deep.roots[0].clone();
        for depth in 0..=MAX_RELEASE_TREE_DEPTH {
            deepest.push(format!("d{depth:02}"));
            fs::create_dir(&deepest).expect("nested staging directory");
        }
        let deep_result = deep.observe();
        let deep_reason = deep_result.as_ref().err().copied();
        assert_eq!(
            deep_reason,
            Some(RestartStagingObservationReason::TraversalBound),
            "unexpected deep observation reason: {deep_reason:?}"
        );
        assert!(deep.roots[0].is_dir() && deepest.is_dir());
    }
}
