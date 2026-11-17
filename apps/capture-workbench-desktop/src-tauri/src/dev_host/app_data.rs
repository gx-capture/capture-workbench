use std::{
    fs,
    path::{Component, Path, PathBuf},
};

const PRODUCT_IDENTIFIER: &str = "io.github.gx-capture.capture-workbench";

pub(crate) fn validate_app_data_dir(configured: &Path) -> Result<PathBuf, String> {
    let mut forbidden_roots = Vec::new();
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
    let canonical_configured = resolve_canonical_path(configured)?;
    for forbidden in forbidden_roots {
        if !forbidden.is_absolute() {
            continue;
        }
        if let Ok(canonical_forbidden) = resolve_canonical_path(forbidden) {
            if is_same_or_descendant(&canonical_configured, &canonical_forbidden) {
                return Err(
                    "Capture Workbench dev host --app-data must not equal or be inside the product app-data directory."
                        .into(),
                );
            }
        }
    }
    Ok(canonical_configured)
}

fn resolve_canonical_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Capture Workbench dev host path must be absolute.".into());
    }
    let mut prefix_components: Vec<Component<'_>> = path.components().collect();
    let mut tail: Vec<Component<'_>> = Vec::new();
    let mut canonical = loop {
        let candidate: PathBuf = prefix_components.iter().collect();
        if let Ok(resolved) = fs::canonicalize(&candidate) {
            break resolved;
        }
        let Some(last) = prefix_components.pop() else {
            return Err("Capture Workbench dev host --app-data path could not be resolved.".into());
        };
        tail.push(last);
    };
    for component in tail.into_iter().rev() {
        match component {
            Component::Normal(part) => canonical.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !canonical.pop() {
                    return Err("Capture Workbench dev host --app-data path is invalid.".into());
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(
                    "Capture Workbench dev host --app-data path could not be resolved.".into(),
                );
            }
        }
    }
    Ok(canonical)
}

fn is_same_or_descendant(candidate: &Path, forbidden: &Path) -> bool {
    let mut candidate_components = candidate.components();
    for forbidden_component in forbidden.components() {
        let Some(candidate_component) = candidate_components.next() else {
            return false;
        };
        if !components_match(candidate_component, forbidden_component) {
            return false;
        }
    }
    true
}

fn components_match(left: Component<'_>, right: Component<'_>) -> bool {
    if cfg!(windows) {
        match (left, right) {
            (Component::Normal(a), Component::Normal(b)) => a
                .to_string_lossy()
                .eq_ignore_ascii_case(&b.to_string_lossy()),
            (Component::Prefix(a), Component::Prefix(b)) => a
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy()),
            _ => left == right,
        }
    } else {
        left == right
    }
}
