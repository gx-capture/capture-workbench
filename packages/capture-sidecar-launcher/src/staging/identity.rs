use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

use super::{failure::StagingCleanupError, marker::MAX_MARKER_BYTES};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct FileIdentity {
    pub(super) first: u64,
    pub(super) second: u64,
}

impl std::fmt::Debug for FileIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FileIdentity(REDACTED)")
    }
}

pub(super) fn ensure_existing_directory(path: &Path) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.is_dir() && !metadata_is_reparse(&metadata) {
        Ok(())
    } else {
        Err(())
    }
}

pub(super) fn has_multiple_hard_links(path: &Path, metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        let _ = metadata;
        windows_file_link_count(path).map_or(true, |count| count > 1)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        metadata.nlink() > 1
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        let _ = metadata;
        false
    }
}

pub(super) fn ensure_path_absent_and_safe(path: &Path) -> Result<(), ()> {
    if let Some(parent) = path.parent() {
        ensure_existing_directory(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(_) => Err(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

pub(super) fn validate_safe_chain(path: &Path) -> Result<(), ()> {
    let mut current = path;
    loop {
        let metadata = fs::symlink_metadata(current).map_err(|_| ())?;
        if metadata_is_reparse(&metadata) {
            return Err(());
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

pub(super) fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub(super) fn is_empty_directory(path: &Path) -> Result<bool, StagingCleanupError> {
    let mut entries = fs::read_dir(path).map_err(|_| StagingCleanupError::ForeignEntry)?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|_| StagingCleanupError::ForeignEntry)?
        .is_none())
}

pub(super) fn read_bounded(path: &Path) -> Result<Vec<u8>, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file()
        || metadata_is_reparse(&metadata)
        || metadata.len() > MAX_MARKER_BYTES as u64
    {
        return Err(());
    }
    let file = File::open(path).map_err(|_| ())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > MAX_MARKER_BYTES {
        Err(())
    } else {
        Ok(bytes)
    }
}

pub(super) fn same_identity(path: &Path, expected: Option<FileIdentity>) -> bool {
    expected.is_some() && capture_any_identity(path).ok() == expected
}

pub(super) fn capture_directory_identity(path: &Path) -> Result<FileIdentity, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(());
    }
    capture_path_identity(path, &metadata)
}

pub(super) fn capture_file_identity(path: &Path) -> Result<FileIdentity, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(());
    }
    capture_path_identity(path, &metadata)
}

pub(super) fn capture_any_identity(path: &Path) -> Result<FileIdentity, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata_is_reparse(&metadata) {
        return Err(());
    }
    capture_path_identity(path, &metadata)
}

fn capture_path_identity(path: &Path, metadata: &fs::Metadata) -> Result<FileIdentity, ()> {
    #[cfg(windows)]
    {
        let _ = metadata;
        capture_windows_identity(path)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(FileIdentity {
            first: metadata.dev(),
            second: metadata.ino(),
        })
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        let _ = metadata;
        Err(())
    }
}

#[cfg(windows)]
fn capture_windows_identity(path: &Path) -> Result<FileIdentity, ()> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr::null_mut};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        return Err(());
    }
    Ok(FileIdentity {
        first: information.dwVolumeSerialNumber as u64,
        second: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

#[cfg(windows)]
fn windows_file_link_count(path: &Path) -> Result<u32, ()> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr::null_mut};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        Err(())
    } else {
        Ok(information.nNumberOfLinks)
    }
}

pub(super) fn path_is_reparse(path: &Path) -> Result<bool, ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    Ok(metadata_is_reparse(&metadata))
}

pub(super) fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;
        metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
