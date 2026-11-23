//! Test controls for captures, read on every capture request from
//! `capture-deterministic-capture-control.json` in the runtime's isolated TEMP.
//! The installed launcher clears non-allowlisted environment variables but
//! keeps TEMP, so a test that owns that directory can steer this fake with a
//! file. Without the file every capture finishes its extraction at once: a
//! runtime-structured capture completes, a host-structured one waits at the
//! `awaiting_structuring` checkpoint.
//!
//! `holdCaptures`: captures report that they are still extracting, so a test
//! can reload, cancel or restart while one runs. Removing the hold lets their
//! extraction finish. `captureStatusUnavailable`: a capture status read answers 503,
//! the way a runtime that cannot answer would. `deleteUnavailable`: a capture
//! delete answers 503 and leaves the capture unchanged. `failCaptures`: captures
//! created while it is set end failed, with a failed OCR projection.
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

#[cfg(test)]
use std::sync::Mutex;

use serde_json::Value;

const CONTROL_FILE_NAME: &str = "capture-deterministic-capture-control.json";

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct CaptureControlSettings {
    pub hold_captures: bool,
    pub capture_status_unavailable: bool,
    pub delete_unavailable: bool,
    pub fail_captures: bool,
}

pub struct CaptureControl(Source);

enum Source {
    Off,
    File(PathBuf),
    #[cfg(test)]
    Fixed(Mutex<CaptureControlSettings>),
}

impl CaptureControl {
    pub fn from_env() -> Self {
        match env::var_os("TEMP").map(PathBuf::from) {
            Some(temporary) => Self(Source::File(temporary.join(CONTROL_FILE_NAME))),
            None => Self(Source::Off),
        }
    }

    #[cfg(test)]
    pub fn off() -> Self {
        Self(Source::Off)
    }

    #[cfg(test)]
    pub fn fixed(settings: CaptureControlSettings) -> Self {
        Self(Source::Fixed(Mutex::new(settings)))
    }

    #[cfg(test)]
    pub fn set(&self, settings: CaptureControlSettings) {
        if let Source::Fixed(current) = &self.0 {
            *current.lock().expect("capture control") = settings;
        }
    }

    /// The controls in force now. An unreadable or invalid file is an error,
    /// so a test that wrote a broken file sees it fail instead of no control.
    pub fn current(&self) -> Result<CaptureControlSettings, String> {
        match &self.0 {
            Source::Off => Ok(CaptureControlSettings::default()),
            Source::File(path) => read_settings(path),
            #[cfg(test)]
            Source::Fixed(settings) => Ok(*settings.lock().expect("capture control")),
        }
    }
}

fn read_settings(path: &Path) -> Result<CaptureControlSettings, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(CaptureControlSettings::default())
        }
        Err(_) => return Err("Capture control file could not be read.".into()),
    };
    let value: Value = serde_json::from_slice(&contents)
        .map_err(|_| "Capture control file is not valid JSON.".to_string())?;
    let flag = |name: &str| match value.get(name) {
        None => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(format!("Capture control {name} must be a boolean.")),
    };
    Ok(CaptureControlSettings {
        hold_captures: flag("holdCaptures")?,
        capture_status_unavailable: flag("captureStatusUnavailable")?,
        delete_unavailable: flag("deleteUnavailable")?,
        fail_captures: flag("failCaptures")?,
    })
}
