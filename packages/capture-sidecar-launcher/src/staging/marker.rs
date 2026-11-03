use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(test)]
use std::cell::Cell;
#[cfg(test)]
use std::fs::{self, File};

use serde::{Deserialize, Serialize};

use super::{
    budget::StagingBudget,
    failure::StagingFailureKind,
    identity::{capture_file_identity, read_bounded, FileIdentity},
};

pub(super) const MARKER_FILE_NAME: &str = ".capture-run-staging-v1";
pub(super) const MARKER_SCHEMA_VERSION: &str = "RunStagingMarkerV1";
pub(super) const MARKER_PRODUCER: &str = "capture-runtime";
// Keep marker reads bounded by the journal record ceiling used by the store.
pub(super) const MAX_MARKER_BYTES: usize = 1024 * 1024;

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_MARKER_FLUSH: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_PARTIAL_WRITE: Cell<u8> = const { Cell::new(0) };
    static FAIL_NEXT_MARKER_READBACK: Cell<u8> = const { Cell::new(0) };
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunStagingMarkerV1 {
    pub(super) schema_version: String,
    pub(super) producer: String,
    pub(super) session_nonce: String,
    pub(super) plan_digest: String,
    pub(super) group_staging_identity: String,
    pub(super) roots: Vec<RunStagingMarkerRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunStagingMarkerRoot {
    pub(super) ordinal: u32,
    pub(super) root_identity_digest: String,
}

pub(super) struct OwnedMarker {
    pub(super) path: PathBuf,
    pub(super) identity: Option<FileIdentity>,
    pub(super) bytes: Vec<u8>,
}

pub(super) fn create_marker(
    path: &Path,
    bytes: &[u8],
    budget: &StagingBudget,
) -> Result<OwnedMarker, (StagingFailureKind, Option<FileIdentity>, Vec<u8>)> {
    if let Err(kind) = budget.check() {
        return Err((kind, None, Vec::new()));
    }
    let mut file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(path)
    {
        Ok(file) => file,
        Err(_) => {
            if let Err(kind) = budget.check() {
                return Err((kind, None, Vec::new()));
            }
            return Err((StagingFailureKind::MarkerCollision, None, Vec::new()));
        }
    };
    let identity = capture_file_identity(path).ok();
    if identity.is_none() {
        if let Err(kind) = budget.check() {
            return Err((kind, None, Vec::new()));
        }
        return Err((StagingFailureKind::MarkerWrite, identity, Vec::new()));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, Vec::new()));
    }
    #[cfg(test)]
    let write_result = if FAIL_NEXT_MARKER_PARTIAL_WRITE.with(|fault| fault.replace(0)) != 0 {
        let mut writer = PartialMarkerWriter {
            file: &mut file,
            remaining: 4,
        };
        write_confirmed_prefix_with_budget(&mut writer, bytes, budget)
    } else {
        write_confirmed_prefix_with_budget(&mut file, bytes, budget)
    };
    #[cfg(not(test))]
    let write_result = write_confirmed_prefix_with_budget(&mut file, bytes, budget);
    let (confirmed, write_complete) = match write_result {
        Ok(result) => result,
        Err((kind, confirmed)) => return Err((kind, identity, confirmed)),
    };
    if !write_complete {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    if file.flush().is_err() {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    #[cfg(test)]
    if FAIL_NEXT_MARKER_FLUSH.with(|fault| fault.replace(0)) != 0 {
        return Err((StagingFailureKind::Durability, identity, confirmed.clone()));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    if file.sync_all().is_err() {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::Durability, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    drop(file);
    #[cfg(test)]
    if FAIL_NEXT_MARKER_READBACK.with(|fault| fault.replace(0)) != 0 {
        // Simulate a post-write foreign mutation before the read-back check.
        // The bytes retained in the owner must still be the write-confirmed
        // value, never this observation.
        let _ = fs::write(path, b"foreign-marker-bytes");
    }
    if capture_file_identity(path).ok() != identity {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    let read_back = match read_bounded(path) {
        Ok(read_back) => read_back,
        Err(()) => {
            if let Err(kind) = budget.check() {
                return Err((kind, identity, confirmed));
            }
            return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
        }
    };
    if read_back != bytes || serde_json::from_slice::<RunStagingMarkerV1>(&read_back).is_err() {
        if let Err(kind) = budget.check() {
            return Err((kind, identity, confirmed));
        }
        return Err((StagingFailureKind::MarkerReadBack, identity, confirmed));
    }
    if let Err(kind) = budget.check() {
        return Err((kind, identity, confirmed));
    }
    Ok(OwnedMarker {
        path: path.to_path_buf(),
        identity,
        bytes: confirmed,
    })
}

pub(super) fn write_confirmed_prefix_with_budget<W: Write>(
    writer: &mut W,
    bytes: &[u8],
    budget: &StagingBudget,
) -> Result<(Vec<u8>, bool), (StagingFailureKind, Vec<u8>)> {
    let mut offset = 0;
    while offset < bytes.len() {
        if let Err(kind) = budget.check() {
            return Err((kind, bytes[..offset].to_vec()));
        }
        match writer.write(&bytes[offset..]) {
            Ok(0) => return Ok((bytes[..offset].to_vec(), false)),
            Ok(count) if count <= bytes.len() - offset => offset += count,
            Ok(_) => return Ok((bytes[..offset].to_vec(), false)),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok((bytes[..offset].to_vec(), false)),
        }
    }
    Ok((bytes.to_vec(), true))
}

#[cfg(test)]
struct PartialMarkerWriter<'file> {
    file: &'file mut File,
    remaining: usize,
}

#[cfg(test)]
impl Write for PartialMarkerWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected partial marker write failure",
            ));
        }
        let count = self.remaining.min(bytes.len());
        let written = self.file.write(&bytes[..count])?;
        self.remaining = self.remaining.saturating_sub(written);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
pub(crate) fn fail_next_marker_flush_for_test() {
    FAIL_NEXT_MARKER_FLUSH.with(|fault| fault.set(1));
}

#[cfg(test)]
pub(crate) fn fail_next_marker_partial_write_for_test() {
    FAIL_NEXT_MARKER_PARTIAL_WRITE.with(|fault| fault.set(1));
}

#[cfg(test)]
pub(crate) fn fail_next_marker_readback_for_test() {
    FAIL_NEXT_MARKER_READBACK.with(|fault| fault.set(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PartialWriter {
        written: Vec<u8>,
        first_chunk: usize,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.first_chunk != 0 {
                let count = self.first_chunk.min(bytes.len());
                self.written.extend_from_slice(&bytes[..count]);
                self.first_chunk = 0;
                return Ok(count);
            }
            self.written.extend_from_slice(b"foreign-suffix");
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected partial write failure",
            ))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_marker_write_retains_only_our_confirmed_prefix() {
        let mut writer = PartialWriter {
            written: Vec::new(),
            first_chunk: 2,
        };

        let (confirmed, complete) =
            write_confirmed_prefix_with_budget(&mut writer, b"abcdef", &StagingBudget::unbounded())
                .expect("write budget");

        assert_eq!(confirmed, b"ab");
        assert!(!complete);
        assert_eq!(writer.written, b"abforeign-suffix");
        assert_ne!(confirmed, writer.written);
    }
}
