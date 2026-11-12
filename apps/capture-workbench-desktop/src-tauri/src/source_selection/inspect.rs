use crate::{
    contracts::{SourceRejectionReason as Reason, SourceSelectionKind},
    library::{validation::verified_media_type, MAX_SOURCE_BYTES},
};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

pub(crate) struct OpenedSource {
    pub handle: File,
    pub file_name: String,
    pub byte_length: u64,
    pub media_type: String,
}

enum InspectionFailure {
    Unreadable(&'static str),
    NotRegularFile,
    NotLocal,
    Empty,
    TooLarge,
    Unsupported(&'static str),
    Changed,
}
impl InspectionFailure {
    fn reason(&self) -> Reason {
        match self {
            Self::Unreadable(message) | Self::Unsupported(message) => {
                // Messages are static, privacy-safe compatibility errors for smoke imports.
                let _ = message;
                if matches!(self, Self::Unsupported(_)) {
                    Reason::Unsupported
                } else {
                    Reason::Unreadable
                }
            }
            Self::NotRegularFile => Reason::NotRegularFile,
            Self::NotLocal => Reason::NotLocal,
            Self::Empty => Reason::Empty,
            Self::TooLarge => Reason::TooLarge,
            Self::Changed => Reason::Unreadable,
        }
    }
    #[cfg(any(test, feature = "model-smoke-app-data"))]
    fn message(self) -> String {
        match self {
            Self::Unreadable(message) | Self::Unsupported(message) => message,
            Self::NotRegularFile => "Selected source must be a regular non-symlink file.",
            Self::NotLocal => "Selected source must be on a local disk.",
            Self::Empty | Self::TooLarge => "Selected source exceeds the desktop library limit.",
            Self::Changed => "Selected source changed during import.",
        }
        .into()
    }
}

pub(crate) fn inspect_source(
    path: &Path,
    kind: SourceSelectionKind,
) -> Result<OpenedSource, Reason> {
    inspect(path, kind, MAX_SOURCE_BYTES as u64).map_err(|error| error.reason())
}

#[cfg(any(test, feature = "model-smoke-app-data"))]
pub(crate) fn inspect_source_for_fixture(
    path: &Path,
    max_bytes: usize,
) -> Result<OpenedSource, String> {
    inspect(path, SourceSelectionKind::All, max_bytes as u64).map_err(InspectionFailure::message)
}

fn inspect(
    path: &Path,
    kind: SourceSelectionKind,
    max_bytes: u64,
) -> Result<OpenedSource, InspectionFailure> {
    use InspectionFailure as Failure;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| Failure::Unreadable("Selected source cannot be inspected."))?;
    // Reject links and directory junctions, while permitting regular cloud
    // placeholders whose open may hydrate the selected file.
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(Failure::NotRegularFile);
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| Failure::Unreadable("Selected source cannot be resolved."))?;
    if !is_local(&canonical) {
        return Err(Failure::NotLocal);
    }
    let mut handle = File::open(&canonical)
        .map_err(|_| Failure::Unreadable("Selected source cannot be opened."))?;
    let opened_metadata = handle
        .metadata()
        .map_err(|_| Failure::Unreadable("Selected source cannot be inspected."))?;
    if !opened_metadata.is_file() {
        return Err(Failure::NotRegularFile);
    }
    let byte_length = opened_metadata.len();
    if byte_length != metadata.len() {
        return Err(Failure::Changed);
    }
    if byte_length == 0 {
        return Err(Failure::Empty);
    }
    if byte_length > max_bytes {
        return Err(Failure::TooLarge);
    }
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(Failure::Unsupported(
            "Selected source file name is invalid.",
        ))?
        .to_owned();
    let mut prefix = vec![0; byte_length.min(512) as usize];
    handle
        .read_exact(&mut prefix)
        .map_err(|_| Failure::Changed)?;
    let media_type = verified_media_type(&file_name, &prefix)
        .map_err(|message| {
            Failure::Unsupported(
                if message == "Selected source extension does not match its signature." {
                    "Selected source extension does not match its signature."
                } else {
                    "Selected source signature is unsupported."
                },
            )
        })?
        .to_owned();
    if matches!(kind, SourceSelectionKind::Documents)
        && !matches!(
            media_type.as_str(),
            "application/pdf" | "image/png" | "image/jpeg"
        )
    {
        return Err(Failure::Unsupported(
            "Selected source signature is unsupported.",
        ));
    }
    Ok(OpenedSource {
        handle,
        file_name,
        byte_length,
        media_type,
    })
}
#[cfg(windows)]
fn is_local(path: &Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    if !path.is_absolute() {
        return false;
    }
    let Some(drive) = local_drive(path) else {
        return false;
    };
    let root = [drive as u16, b':' as u16, b'\\' as u16, 0];
    // GetDriveTypeW: 2 removable, 3 fixed, 5 CD-ROM, 6 RAM disk. Refused: 0 unknown,
    // 1 no root directory, 4 remote (a mapped network drive).
    matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3 | 5 | 6)
}
#[cfg(not(windows))]
fn is_local(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
#[path = "inspect_tests.rs"]
mod tests;

#[cfg(windows)]
fn local_drive(path: &Path) -> Option<u8> {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => Some(drive),
            _ => None,
        },
        _ => None,
    }
}
