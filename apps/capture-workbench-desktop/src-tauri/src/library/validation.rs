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
        "application/pdf" | "image/png" | "image/jpeg"
    ) && !RECORDING_MEDIA_TYPES.contains(&input.media_type.as_str())
    {
        return Err("Capture source media type is unsupported.".into());
    }
    if input.bytes.is_empty() || input.bytes.len() > MAX_SOURCE_BYTES {
        return Err("Capture source exceeds the desktop library limit.".into());
    }
    Ok(())
}

/// Recordings the runtime transcribes: audio, and video whose audio track is
/// transcribed. Phones often give a recording an extension that does not name
/// its container (an `.m4a` holding 3GP), so any of these extensions is taken
/// with any recording signature.
pub(crate) const RECORDING_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "m4a", "m4b", "aac", "flac", "ogg", "oga", "opus", "wma", "amr", "aif", "aiff",
    "caf", "mka", "3gp", "3g2", "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "asf", "flv",
    "mpg", "mpeg", "ts", "mts", "m2ts",
];

/// The media types `recording_media_type` gives, as the runtime's source sniffer does.
pub(crate) const RECORDING_MEDIA_TYPES: &[&str] = &[
    "audio/wav",
    "audio/mpeg",
    "audio/aac",
    "audio/flac",
    "audio/ogg",
    "audio/mp4",
    "audio/amr",
    "audio/aiff",
    "audio/x-caf",
    "video/quicktime",
    "video/x-matroska",
    "video/x-ms-asf",
    "video/x-msvideo",
    "video/x-flv",
    "video/mpeg",
    "video/mp2t",
];

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
    } else if let Some(media_type) = recording_media_type(bytes) {
        (
            media_type,
            RECORDING_EXTENSIONS.contains(&extension.as_str()),
        )
    } else {
        return Err("Selected source signature is unsupported.".into());
    };
    if !media_type.1 {
        return Err("Selected source extension does not match its signature.".into());
    }
    Ok(media_type.0)
}

fn recording_media_type(bytes: &[u8]) -> Option<&'static str> {
    let at = |offset: usize, signature: &[u8]| {
        bytes.len() >= offset + signature.len()
            && &bytes[offset..offset + signature.len()] == signature
    };
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return Some("audio/wav");
    }
    if at(0, b"RIFF") && at(8, b"AVI ") {
        return Some("video/x-msvideo");
    }
    if at(0, b"ID3") {
        return Some("audio/mpeg");
    }
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0 {
        // Both open with an 11-bit sync word; ADTS marks its layer bits zero.
        return Some(if bytes[1] & 0x06 == 0 {
            "audio/aac"
        } else {
            "audio/mpeg"
        });
    }
    if at(0, b"fLaC") {
        return Some("audio/flac");
    }
    if at(0, b"OggS") {
        return Some("audio/ogg");
    }
    if at(4, b"ftyp") {
        return Some("audio/mp4");
    }
    if [b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"]
        .iter()
        .any(|box_type| at(4, *box_type))
    {
        return Some("video/quicktime");
    }
    if at(0, &[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some("video/x-matroska");
    }
    if at(0, &[0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]) {
        return Some("video/x-ms-asf");
    }
    if at(0, b"#!AMR") {
        return Some("audio/amr");
    }
    if at(0, b"FORM") && (at(8, b"AIFF") || at(8, b"AIFC")) {
        return Some("audio/aiff");
    }
    if at(0, b"caff") {
        return Some("audio/x-caf");
    }
    if at(0, b"FLV") {
        return Some("video/x-flv");
    }
    if at(0, &[0x00, 0x00, 0x01, 0xba]) {
        return Some("video/mpeg");
    }
    if bytes.len() > 188 && bytes[0] == 0x47 && bytes[188] == 0x47 {
        return Some("video/mp2t");
    }
    None
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
