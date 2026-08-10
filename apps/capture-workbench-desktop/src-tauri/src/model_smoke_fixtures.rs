use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::library::MAX_SOURCE_BYTES;
use serde::Deserialize;

const FIXTURE_ROOT_ENV: &str = "CAPTURE_SMOKE_FIXTURE_ROOT";
const FIXTURE_PDF_ENV: &str = "CAPTURE_SMOKE_FIXTURE_PDF";
const FIXTURE_IMAGE_ENV: &str = "CAPTURE_SMOKE_FIXTURE_IMAGE";
const FIXTURE_AUDIO_ENV: &str = "CAPTURE_SMOKE_FIXTURE_AUDIO";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSmokeImportFixtureRequest {
    pub(crate) fixture_key: String,
}

#[derive(Clone)]
pub(crate) struct ModelSmokeFixtureRegistry {
    root: PathBuf,
    fixtures: BTreeMap<&'static str, PathBuf>,
}

impl ModelSmokeFixtureRegistry {
    pub(crate) fn from_environment(app_data: &Path, temp_root: &Path) -> Result<Self, String> {
        let root = environment_path(FIXTURE_ROOT_ENV)?;
        let pdf = environment_path(FIXTURE_PDF_ENV)?;
        let image = environment_path(FIXTURE_IMAGE_ENV)?;
        let audio = environment_path(FIXTURE_AUDIO_ENV)?;
        Self::from_declared_paths(&root, app_data, temp_root, &pdf, &image, &audio)
    }

    fn from_declared_paths(
        root: &Path,
        app_data: &Path,
        temp_root: &Path,
        pdf: &Path,
        image: &Path,
        audio: &Path,
    ) -> Result<Self, String> {
        if !root.is_absolute()
            || !app_data.is_absolute()
            || !temp_root.is_absolute()
            || !pdf.is_absolute()
            || !image.is_absolute()
            || !audio.is_absolute()
        {
            return Err("Model smoke fixture roots and declarations must be absolute.".into());
        }
        let root = fs::canonicalize(root)
            .map_err(|_| "Model smoke fixture root is unavailable.".to_string())?;
        let temp_root = fs::canonicalize(temp_root)
            .map_err(|_| "Model smoke temporary root is unavailable.".to_string())?;
        let app_data = fs::canonicalize(app_data)
            .map_err(|_| "Model smoke app data root is unavailable.".to_string())?;
        if root.parent().is_none()
            || temp_root.parent() != Some(root.as_path())
            || app_data.parent() != Some(temp_root.as_path())
        {
            return Err("Model smoke fixture ownership roots are invalid.".into());
        }

        Ok(Self {
            root,
            fixtures: BTreeMap::from([
                ("audio", audio.to_path_buf()),
                ("image", image.to_path_buf()),
                ("pdf", pdf.to_path_buf()),
            ]),
        })
    }

    pub(crate) fn resolve(&self, fixture_key: &str) -> Result<PathBuf, String> {
        let source = self
            .fixtures
            .get(fixture_key)
            .ok_or_else(|| "Model smoke fixture key is not declared.".to_string())?;
        let source_metadata = fs::symlink_metadata(source)
            .map_err(|_| "Model smoke fixture is unavailable.".to_string())?;
        if source_metadata.file_type().is_symlink() || !source_metadata.file_type().is_file() {
            return Err("Model smoke fixture must be a regular non-symlink file.".into());
        }
        if source_metadata.len() == 0 || source_metadata.len() > MAX_SOURCE_BYTES as u64 {
            return Err("Model smoke fixture exceeds the desktop library limit.".into());
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if !extension_allowed_for_key(fixture_key, &extension) {
            return Err("Model smoke fixture extension does not match its declared key.".into());
        }
        let canonical = fs::canonicalize(source)
            .map_err(|_| "Model smoke fixture cannot be resolved.".to_string())?;
        if canonical == self.root || !canonical.starts_with(&self.root) {
            return Err("Model smoke fixture is outside the owned run root.".into());
        }
        let canonical_metadata = fs::metadata(&canonical)
            .map_err(|_| "Model smoke fixture cannot be inspected.".to_string())?;
        if !canonical_metadata.is_file() || canonical_metadata.len() != source_metadata.len() {
            return Err("Model smoke fixture changed during validation.".into());
        }
        Ok(canonical)
    }
}

fn environment_path(name: &str) -> Result<PathBuf, String> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Model smoke fixture registry is not configured.".to_string())
}

fn extension_allowed_for_key(fixture_key: &str, extension: &str) -> bool {
    match fixture_key {
        "pdf" => extension == "pdf",
        "image" => matches!(extension, "png" | "jpg" | "jpeg"),
        "audio" => matches!(extension, "wav" | "mp3" | "m4a" | "mp4"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, fs::OpenOptions};

    use tempfile::tempdir;

    use super::ModelSmokeFixtureRegistry;

    fn declared_registry(
        root: &std::path::Path,
        pdf: &std::path::Path,
        image: &std::path::Path,
        audio: &std::path::Path,
    ) -> Result<ModelSmokeFixtureRegistry, String> {
        let temp_root = root.join("temp");
        let app_data = temp_root.join("app-data");
        fs::create_dir_all(&app_data).expect("owned app data");
        ModelSmokeFixtureRegistry::from_declared_paths(
            root, &app_data, &temp_root, pdf, image, audio,
        )
    }

    #[test]
    fn resolves_only_predeclared_keys_under_the_owned_root() {
        let run = tempdir().expect("run root");
        let pdf = run.path().join("prepared.pdf");
        let image = run.path().join("prepared.png");
        let audio = run.path().join("prepared.mp3");
        fs::write(&pdf, b"%PDF-fixture").expect("pdf");
        fs::write(&image, b"png-fixture").expect("image");
        fs::write(&audio, b"ID3fixture").expect("audio");
        let registry = declared_registry(run.path(), &pdf, &image, &audio).expect("registry");

        assert_eq!(
            registry.resolve("pdf").expect("pdf key"),
            fs::canonicalize(&pdf).expect("canonical pdf")
        );
        assert!(registry.resolve("missing").is_err());
        assert!(registry.resolve("").is_err());
    }

    #[test]
    fn rejects_fixture_paths_outside_the_owned_root_without_leaking_them() {
        let run = tempdir().expect("run root");
        let outside = tempdir().expect("outside root");
        let outside_pdf = outside.path().join("private.pdf");
        let image = run.path().join("prepared.png");
        let audio = run.path().join("prepared.mp3");
        fs::write(&outside_pdf, b"%PDF-private").expect("outside pdf");
        fs::write(&image, b"png-fixture").expect("image");
        fs::write(&audio, b"ID3fixture").expect("audio");
        let registry =
            declared_registry(run.path(), &outside_pdf, &image, &audio).expect("registry");

        let error = registry.resolve("pdf").expect_err("outside path rejected");
        assert!(!error.contains(&outside_pdf.to_string_lossy().to_string()));
    }

    #[test]
    fn requires_an_owned_temp_and_app_data_layout() {
        let run = tempdir().expect("run root");
        let outside = tempdir().expect("outside root");
        let source = run.path().join("prepared.pdf");
        fs::write(&source, b"%PDF-fixture").expect("source");

        assert!(ModelSmokeFixtureRegistry::from_declared_paths(
            run.path(),
            outside.path(),
            outside.path(),
            &source,
            &source,
            &source,
        )
        .is_err());

        let nested_run = run.path().join("owned-run");
        let nested_temp = nested_run.join("temp");
        let nested_app_data = nested_temp.join("app-data");
        fs::create_dir_all(&nested_app_data).expect("nested app data");
        let nested_source = nested_run.join("prepared.pdf");
        fs::write(&nested_source, b"%PDF-fixture").expect("nested source");
        assert!(ModelSmokeFixtureRegistry::from_declared_paths(
            run.path(),
            &nested_app_data,
            &nested_temp,
            &nested_source,
            &nested_source,
            &nested_source,
        )
        .is_err());

        assert!(ModelSmokeFixtureRegistry::from_declared_paths(
            run.path(),
            &run.path().join("temp").join("app-data"),
            &run.path().join("temp"),
            std::path::Path::new("prepared.pdf"),
            &source,
            &source,
        )
        .is_err());
    }

    #[test]
    fn rejects_directories_empty_files_unsupported_extensions_and_oversize() {
        let run = tempdir().expect("run root");
        let valid = run.path().join("valid.pdf");
        fs::write(&valid, b"%PDF-fixture").expect("valid");

        let directory_registry =
            declared_registry(run.path(), run.path(), &valid, &valid).expect("directory registry");
        assert!(directory_registry.resolve("pdf").is_err());

        let empty = run.path().join("empty.pdf");
        fs::write(&empty, []).expect("empty");
        let empty_registry =
            declared_registry(run.path(), &empty, &valid, &valid).expect("empty registry");
        assert!(empty_registry.resolve("pdf").is_err());

        let unsupported = run.path().join("fixture.exe");
        fs::write(&unsupported, b"not executable").expect("unsupported");
        let unsupported_registry = declared_registry(run.path(), &unsupported, &valid, &valid)
            .expect("unsupported registry");
        assert!(unsupported_registry.resolve("pdf").is_err());

        let oversized = run.path().join("oversized.pdf");
        OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&oversized)
            .expect("oversized")
            .set_len(50 * 1024 * 1024 + 1)
            .expect("oversized length");
        let oversized_registry =
            declared_registry(run.path(), &oversized, &valid, &valid).expect("oversized registry");
        assert!(oversized_registry.resolve("pdf").is_err());
    }

    #[test]
    fn accepts_only_the_existing_desktop_source_extension_allowlist() {
        let run = tempdir().expect("run root");
        let fallback = run.path().join("fallback.pdf");
        fs::write(&fallback, b"fixture").expect("fallback");
        for (extension, key) in [
            ("pdf", "pdf"),
            ("png", "image"),
            ("jpg", "image"),
            ("jpeg", "image"),
            ("wav", "audio"),
            ("mp3", "audio"),
            ("m4a", "audio"),
            ("mp4", "audio"),
        ] {
            let source = run.path().join(format!("fixture.{extension}"));
            fs::write(&source, b"fixture").expect("source");
            let registry = match key {
                "pdf" => declared_registry(run.path(), &source, &fallback, &fallback),
                "image" => declared_registry(run.path(), &fallback, &source, &fallback),
                "audio" => declared_registry(run.path(), &fallback, &fallback, &source),
                _ => unreachable!(),
            }
            .expect("registry");
            assert!(registry.resolve(key).is_ok(), "extension {extension}");
        }

        let image_with_pdf_extension =
            declared_registry(run.path(), &fallback, &fallback, &fallback).expect("registry");
        assert!(image_with_pdf_extension.resolve("image").is_err());
    }
}
