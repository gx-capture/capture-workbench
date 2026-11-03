use sha2::{Digest, Sha256};

#[cfg(all(test, windows))]
use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(all(test, windows))]
use super::{
    identity::{capture_directory_identity, capture_file_identity, same_identity},
    marker::MARKER_FILE_NAME,
};

use super::identity::FileIdentity;

pub(super) fn root_identity_digest(
    group_staging_identity: &str,
    ordinal: u32,
    root: &crate::journal::PlannedRoot,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/run-staging-root/v1\0");
    put_string(&mut hasher, group_staging_identity);
    hasher.update(ordinal.to_be_bytes());
    put_string(&mut hasher, &root.role);
    hasher.update(root.root_generation.to_be_bytes());
    put_string(&mut hasher, &root.root_ref_digest);
    put_string(&mut hasher, &root.spec_digest);
    put_string(&mut hasher, &root.reserved_listener_identity);
    hex_lower(&hasher.finalize())
}

/// V2 intentionally cannot validate the prior V1 staging commitment.  The
/// durable field remains the same private `rootDigest`, but a restarted
/// observer must treat a V1 value as unknown instead of silently adopting it.
pub(super) fn run_staging_scope_digest(
    producer_root_identity: FileIdentity,
    shared_parent_identity: FileIdentity,
    group_identity: FileIdentity,
    marker_identity: FileIdentity,
    group_staging_identity: &str,
    marker_bytes: &[u8],
    root_identities: &[FileIdentity],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"capture-runtime/run-staging-scope/v2\0");
    put_string_field(&mut hasher, "groupStagingIdentity", group_staging_identity);
    put_bytes_field(&mut hasher, "markerBytes", marker_bytes);
    put_file_identity_field(
        &mut hasher,
        "producerRootFileIdentity",
        producer_root_identity,
    );
    put_file_identity_field(
        &mut hasher,
        "sharedParentFileIdentity",
        shared_parent_identity,
    );
    put_file_identity_field(&mut hasher, "groupFileIdentity", group_identity);
    put_file_identity_field(&mut hasher, "markerFileIdentity", marker_identity);
    put_string(&mut hasher, "rootCount");
    hasher.update((root_identities.len() as u64).to_be_bytes());
    for (ordinal, identity) in root_identities.iter().copied().enumerate() {
        put_string(&mut hasher, "rootFileIdentity");
        hasher.update((ordinal as u64).to_be_bytes());
        put_file_identity_payload(&mut hasher, identity);
    }
    hex_lower(&hasher.finalize())
}

pub(super) fn required_file_identity(
    identity: Option<FileIdentity>,
    name: &str,
) -> Result<FileIdentity, String> {
    identity.ok_or_else(|| format!("Capture runtime {name} identity was missing."))
}

fn put_string_field(hasher: &mut Sha256, field: &str, value: &str) {
    put_string(hasher, field);
    put_string(hasher, value);
}

fn put_bytes_field(hasher: &mut Sha256, field: &str, value: &[u8]) {
    put_string(hasher, field);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn put_file_identity_field(hasher: &mut Sha256, field: &str, identity: FileIdentity) {
    put_string(hasher, field);
    put_file_identity_payload(hasher, identity);
}

fn put_file_identity_payload(hasher: &mut Sha256, identity: FileIdentity) {
    hasher.update(identity.first.to_be_bytes());
    hasher.update(identity.second.to_be_bytes());
}

pub(super) fn put_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

pub(super) fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn real_scope_digest_fixture(
        producer_root: &Path,
        shared_parent: &Path,
        group: &Path,
        marker: &Path,
        roots: &[PathBuf],
    ) -> String {
        let root_identities = roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("real root identity"))
            .collect::<Vec<_>>();
        run_staging_scope_digest(
            capture_directory_identity(producer_root).expect("real producer root identity"),
            capture_directory_identity(shared_parent).expect("real shared parent identity"),
            capture_directory_identity(group).expect("real group identity"),
            capture_file_identity(marker).expect("real marker identity"),
            "group-staging-identity",
            &fs::read(marker).expect("real marker bytes"),
            &root_identities,
        )
    }

    fn scope_digest_fixture(
        producer_root: FileIdentity,
        shared_parent: FileIdentity,
        group: FileIdentity,
        marker: FileIdentity,
        roots: &[FileIdentity],
    ) -> String {
        run_staging_scope_digest(
            producer_root,
            shared_parent,
            group,
            marker,
            "group-staging-identity",
            br#"{"schemaVersion":"RunStagingMarkerV1"}"#,
            roots,
        )
    }

    #[test]
    fn v2_scope_digest_commits_each_owned_identity_and_root_order() {
        let producer_root = FileIdentity {
            first: 1,
            second: 2,
        };
        let shared_parent = FileIdentity {
            first: 3,
            second: 4,
        };
        let group = FileIdentity {
            first: 5,
            second: 6,
        };
        let marker = FileIdentity {
            first: 7,
            second: 8,
        };
        let roots = [
            FileIdentity {
                first: 9,
                second: 10,
            },
            FileIdentity {
                first: 11,
                second: 12,
            },
        ];
        let original = scope_digest_fixture(producer_root, shared_parent, group, marker, &roots);

        let mutations = [
            scope_digest_fixture(
                FileIdentity {
                    first: 101,
                    second: 2,
                },
                shared_parent,
                group,
                marker,
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                FileIdentity {
                    first: 103,
                    second: 4,
                },
                group,
                marker,
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                shared_parent,
                FileIdentity {
                    first: 105,
                    second: 6,
                },
                marker,
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                shared_parent,
                group,
                FileIdentity {
                    first: 107,
                    second: 8,
                },
                &roots,
            ),
            scope_digest_fixture(
                producer_root,
                shared_parent,
                group,
                marker,
                &[roots[1], roots[0]],
            ),
        ];

        for mutated in mutations {
            assert_ne!(mutated, original);
        }
        assert_eq!(
            original,
            scope_digest_fixture(producer_root, shared_parent, group, marker, &roots)
        );
    }

    #[test]
    fn v2_scope_digest_distinguishes_a_byte_identical_marker_copy() {
        let original = scope_digest_fixture(
            FileIdentity {
                first: 1,
                second: 2,
            },
            FileIdentity {
                first: 3,
                second: 4,
            },
            FileIdentity {
                first: 5,
                second: 6,
            },
            FileIdentity {
                first: 7,
                second: 8,
            },
            &[FileIdentity {
                first: 9,
                second: 10,
            }],
        );
        let copied_marker = scope_digest_fixture(
            FileIdentity {
                first: 1,
                second: 2,
            },
            FileIdentity {
                first: 3,
                second: 4,
            },
            FileIdentity {
                first: 5,
                second: 6,
            },
            FileIdentity {
                first: 107,
                second: 108,
            },
            &[FileIdentity {
                first: 9,
                second: 10,
            }],
        );

        assert_ne!(copied_marker, original);
    }

    #[test]
    fn v2_scope_digest_is_not_a_legacy_v1_commitment() {
        let producer_root = FileIdentity {
            first: 1,
            second: 2,
        };
        let shared_parent = FileIdentity {
            first: 3,
            second: 4,
        };
        let group = FileIdentity {
            first: 5,
            second: 6,
        };
        let marker = FileIdentity {
            first: 7,
            second: 8,
        };
        let roots = [FileIdentity {
            first: 9,
            second: 10,
        }];
        let marker_bytes = br#"{"schemaVersion":"RunStagingMarkerV1"}"#;
        let current = scope_digest_fixture(producer_root, shared_parent, group, marker, &roots);

        let mut legacy = Sha256::new();
        legacy.update(b"capture-runtime/run-staging-scope/v1\0");
        put_string(&mut legacy, "group-staging-identity");
        legacy.update((marker_bytes.len() as u64).to_be_bytes());
        legacy.update(marker_bytes);
        for (ordinal, identity) in roots.iter().copied().enumerate() {
            legacy.update((ordinal as u64).to_be_bytes());
            legacy.update(identity.first.to_be_bytes());
            legacy.update(identity.second.to_be_bytes());
        }

        assert_ne!(current, hex_lower(&legacy.finalize()));
    }

    #[cfg(windows)]
    #[test]
    fn v2_scope_digest_rejects_real_same_path_group_replacement_with_moved_scope() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let producer_root = directory.path().join("producer-root");
        let shared_parent = producer_root.join("private-run-staging");
        let group = shared_parent.join("group-staging-identity");
        let marker = group.join(MARKER_FILE_NAME);
        let roots = [group.join("root-00000000"), group.join("root-00000001")];
        fs::create_dir_all(&roots[0]).expect("root zero");
        fs::create_dir(&roots[1]).expect("root one");
        fs::write(&marker, br#"{"schemaVersion":"RunStagingMarkerV1"}"#).expect("marker");
        let original_group_identity =
            capture_directory_identity(&group).expect("original group identity");
        let original_marker_identity = capture_file_identity(&marker).expect("marker identity");
        let original_root_identities = roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("root identity"))
            .collect::<Vec<_>>();
        let original =
            real_scope_digest_fixture(&producer_root, &shared_parent, &group, &marker, &roots);

        let moved = shared_parent.join("moved-group");
        fs::rename(&group, &moved).expect("move original group");
        fs::create_dir(&group).expect("same path replacement group");
        fs::rename(moved.join(MARKER_FILE_NAME), group.join(MARKER_FILE_NAME))
            .expect("move original marker into replacement");
        for ordinal in 0..roots.len() {
            fs::rename(
                moved.join(format!("root-{ordinal:08}")),
                group.join(format!("root-{ordinal:08}")),
            )
            .expect("move original root into replacement");
        }
        let replaced =
            real_scope_digest_fixture(&producer_root, &shared_parent, &group, &marker, &roots);

        assert!(!same_identity(&group, Some(original_group_identity)));
        assert_eq!(
            capture_file_identity(&marker).expect("moved marker identity"),
            original_marker_identity
        );
        let replacement_root_identities = roots
            .iter()
            .map(|root| capture_directory_identity(root).expect("moved root identity"))
            .collect::<Vec<_>>();
        assert_eq!(replacement_root_identities, original_root_identities);
        assert_ne!(replaced, original);
        assert_eq!(
            fs::read(&marker).expect("replacement marker bytes"),
            br#"{"schemaVersion":"RunStagingMarkerV1"}"#
        );
    }

    #[cfg(windows)]
    #[test]
    fn v2_scope_digest_rejects_real_byte_identical_marker_replacement() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let producer_root = directory.path().join("producer-root");
        let shared_parent = producer_root.join("private-run-staging");
        let group = shared_parent.join("group-staging-identity");
        let marker = group.join(MARKER_FILE_NAME);
        let root = group.join("root-00000000");
        fs::create_dir_all(&root).expect("root");
        let marker_bytes = br#"{"schemaVersion":"RunStagingMarkerV1"}"#;
        fs::write(&marker, marker_bytes).expect("marker");
        let original_marker_identity = capture_file_identity(&marker).expect("marker identity");
        let original = real_scope_digest_fixture(
            &producer_root,
            &shared_parent,
            &group,
            &marker,
            std::slice::from_ref(&root),
        );

        let copy = group.join("marker-copy");
        fs::copy(&marker, &copy).expect("copy marker");
        fs::remove_file(&marker).expect("remove original marker");
        fs::rename(&copy, &marker).expect("install byte-identical marker copy");
        let replacement_marker_identity =
            capture_file_identity(&marker).expect("replacement marker identity");
        let replaced = real_scope_digest_fixture(
            &producer_root,
            &shared_parent,
            &group,
            &marker,
            std::slice::from_ref(&root),
        );

        assert!(!same_identity(&marker, Some(original_marker_identity)));
        assert_ne!(replacement_marker_identity, original_marker_identity);
        assert_eq!(fs::read(&marker).expect("marker bytes"), marker_bytes);
        assert_ne!(replaced, original);
    }

    #[test]
    fn scope_digest_rejects_missing_filesystem_identity() {
        for name in [
            "producer root",
            "staging parent",
            "staging group",
            "staging marker",
            "staging root 0",
        ] {
            assert!(required_file_identity(None, name).is_err());
        }
        assert!(required_file_identity(
            Some(FileIdentity {
                first: 1,
                second: 2
            }),
            "root"
        )
        .is_ok());
    }
}
