use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path, PathBuf},
};

pub(super) const PRODUCT_IDENTIFIER: &str = "io.github.gx-capture.capture-workbench";

pub(crate) fn validate_app_data_dir(configured: &Path) -> Result<PathBuf, String> {
    let roaming = dirs::data_dir().ok_or_else(|| {
        "Capture Workbench dev host could not resolve the roaming app-data directory.".to_string()
    })?;
    let local = dirs::data_local_dir().ok_or_else(|| {
        "Capture Workbench dev host could not resolve the local app-data directory.".to_string()
    })?;
    let mut forbidden_roots = vec![
        roaming.join(PRODUCT_IDENTIFIER),
        local.join(PRODUCT_IDENTIFIER),
    ];
    for env_name in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(env_name) {
            let base_path = PathBuf::from(base);
            if base_path.is_absolute() {
                forbidden_roots.push(base_path.join(PRODUCT_IDENTIFIER));
            }
        }
    }
    validate_app_data_dir_against(configured, &forbidden_roots)
}

pub(super) fn validate_app_data_dir_against(
    configured: &Path,
    forbidden_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    if !configured.is_absolute() {
        return Err("Capture Workbench dev host --app-data path must be absolute.".into());
    }
    let candidate = split_existing(configured)?;
    for forbidden in forbidden_roots {
        if !forbidden.is_absolute() {
            return Err(
                "Capture Workbench dev host forbidden app-data root must be absolute.".into(),
            );
        }
        let forbidden_resolved = split_existing(forbidden)?;
        let forbidden_id = file_identity(&forbidden_resolved.existing)?;
        if is_within_forbidden(&candidate, &forbidden_resolved, forbidden_id)? {
            return Err(
                "Capture Workbench dev host --app-data must not equal or be inside the product app-data directory."
                    .into(),
            );
        }
    }
    Ok(candidate.joined())
}

struct ResolvedPath {
    existing: PathBuf,
    tail: Vec<OsString>,
}

impl ResolvedPath {
    fn joined(&self) -> PathBuf {
        let mut path = self.existing.clone();
        for part in &self.tail {
            path.push(part);
        }
        path
    }
}

fn split_existing(path: &Path) -> Result<ResolvedPath, String> {
    if !path.is_absolute() {
        return Err("Capture Workbench dev host path must be absolute.".into());
    }
    let mut prefix_components: Vec<Component<'_>> = path.components().collect();
    let mut raw_tail: Vec<Component<'_>> = Vec::new();
    let mut existing = loop {
        let candidate: PathBuf = prefix_components.iter().collect();
        if let Ok(resolved) = fs::canonicalize(&candidate) {
            break resolved;
        }
        let Some(last) = prefix_components.pop() else {
            return Err("Capture Workbench dev host --app-data path could not be resolved.".into());
        };
        raw_tail.push(last);
    };
    let mut tail = Vec::new();
    for component in raw_tail.into_iter().rev() {
        match component {
            Component::Normal(part) => tail.push(part.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if tail.pop().is_none() {
                    existing = ancestor_parent(&existing).ok_or_else(|| {
                        "Capture Workbench dev host --app-data path is invalid.".to_string()
                    })?;
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(
                    "Capture Workbench dev host --app-data path could not be resolved.".into(),
                );
            }
        }
    }
    Ok(ResolvedPath { existing, tail })
}

fn is_within_forbidden(
    candidate: &ResolvedPath,
    forbidden: &ResolvedPath,
    forbidden_id: FileIdentity,
) -> Result<bool, String> {
    let mut ancestor = candidate.existing.clone();
    loop {
        let ancestor_id = file_identity(&ancestor)?;
        if ancestor_id == forbidden_id {
            let mut after = components_after(&ancestor, &candidate.existing)?;
            after.extend(candidate.tail.iter().cloned());
            if components_start_with(&after, &forbidden.tail) {
                return Ok(true);
            }
        }
        match ancestor_parent(&ancestor) {
            Some(parent) => ancestor = parent,
            None => return Ok(false),
        }
    }
}

/// The parent directory, or `None` at a drive root or share root.
fn ancestor_parent(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    if parent.as_os_str().is_empty() || parent == path {
        None
    } else {
        Some(parent.to_path_buf())
    }
}

fn components_after(ancestor: &Path, descendant: &Path) -> Result<Vec<OsString>, String> {
    let mut names = Vec::new();
    let mut current = descendant.to_path_buf();
    while current != ancestor {
        let Some(name) = current.file_name() else {
            return Err("Capture Workbench dev host --app-data path could not be resolved.".into());
        };
        names.push(name.to_os_string());
        current = ancestor_parent(&current).ok_or_else(|| {
            "Capture Workbench dev host --app-data path could not be resolved.".to_string()
        })?;
    }
    names.reverse();
    Ok(names)
}

fn components_start_with(components: &[OsString], prefix: &[OsString]) -> bool {
    prefix.len() <= components.len()
        && components
            .iter()
            .zip(prefix.iter())
            .all(|(component, expected)| names_match(component, expected))
}

fn names_match(left: &OsStr, right: &OsStr) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume_serial: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(not(windows))]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    };

    // access_mode(0) queries metadata. FILE_FLAG_BACKUP_SEMANTICS is required to open a directory.
    let file = fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|error| {
            format!("Capture Workbench dev host path identity could not be read: {error}")
        })?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let read = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if read == 0 {
        let error = std::io::Error::last_os_error();
        return Err(format!(
            "Capture Workbench dev host path identity could not be read: {error}"
        ));
    }
    if info.dwVolumeSerialNumber == 0 && info.nFileIndexHigh == 0 && info.nFileIndexLow == 0 {
        // A volume that reports no identity would make unrelated directories
        // compare equal.
        return Err(
            "Capture Workbench dev host path is on a volume that reports no file identity.".into(),
        );
    }
    Ok(FileIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_index_high: info.nFileIndexHigh,
        file_index_low: info.nFileIndexLow,
    })
}

#[cfg(not(windows))]
fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).map_err(|error| {
        format!("Capture Workbench dev host path identity could not be read: {error}")
    })?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
