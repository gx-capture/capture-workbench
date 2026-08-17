use std::path::Path;

use crate::contracts::LibrarySourceInput;

use super::MAX_SOURCE_BYTES;

pub(crate) fn validate_source_input(input: &LibrarySourceInput) -> Result<(), String> {
    let file_name = input.file_name.trim();
    if file_name.is_empty()
        || file_name.len() > 255
        || file_name
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'"' | b'\\'))
        || Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name)
    {
        return Err("Capture source file name is invalid.".into());
    }
    if !matches!(
        input.media_type.as_str(),
        "application/pdf" | "image/png" | "image/jpeg" | "audio/wav" | "audio/mpeg" | "audio/mp4"
    ) {
        return Err("Capture source media type is unsupported.".into());
    }
    if input.bytes.is_empty() || input.bytes.len() > MAX_SOURCE_BYTES {
        return Err("Capture source exceeds the desktop library limit.".into());
    }
    Ok(())
}

pub(crate) fn verified_media_type(file_name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let media_type = if bytes.starts_with(b"%PDF-") {
        ("application/pdf", matches!(extension.as_str(), "pdf"))
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image/png", matches!(extension.as_str(), "png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ("image/jpeg", matches!(extension.as_str(), "jpg" | "jpeg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        ("audio/wav", matches!(extension.as_str(), "wav"))
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        ("audio/mpeg", matches!(extension.as_str(), "mp3"))
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        ("audio/mp4", matches!(extension.as_str(), "m4a" | "mp4"))
    } else {
        return Err("Selected source signature is unsupported.".into());
    };
    if !media_type.1 {
        return Err("Selected source extension does not match its signature.".into());
    }
    Ok(media_type.0)
}

pub(crate) fn validate_document_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Capture library document identifier is invalid.".into());
    }
    Ok(())
}

pub(crate) fn validate_status(value: &str) -> Result<(), String> {
    if !matches!(
        value,
        "queued"
            | "processing"
            | "persisting"
            | "recovery_required"
            | "awaiting_confirmation"
            | "completed"
            | "failed"
            | "canceled"
    ) {
        return Err("Capture library status is invalid.".into());
    }
    Ok(())
}
