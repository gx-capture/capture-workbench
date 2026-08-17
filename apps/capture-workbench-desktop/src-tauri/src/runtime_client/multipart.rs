use rand::{rngs::OsRng, RngCore};

use super::transport::RequestBody;

/// Builds the runtime's multipart upload without changing field order or CRLF framing.
pub(super) fn multipart_capture_body(
    file_name: &str,
    media_type: &str,
    source_kind: &str,
    bytes: &[u8],
) -> Result<RequestBody, String> {
    if file_name.is_empty()
        || file_name
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'"' | b'\\'))
    {
        return Err("Capture source file name is invalid.".into());
    }
    let boundary = format!("capture-workbench-{}", random_hex()?);
    let mut body = Vec::with_capacity(bytes.len() + 1024);
    multipart_field(
        &mut body,
        &boundary,
        "file",
        bytes,
        Some((file_name, media_type)),
    );
    multipart_field(
        &mut body,
        &boundary,
        "sourceKind",
        source_kind.as_bytes(),
        None,
    );
    multipart_field(&mut body, &boundary, "structuringMode", b"runtime", None);
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(RequestBody {
        bytes: body,
        content_type: format!("multipart/form-data; boundary={boundary}"),
    })
}

fn multipart_field(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    value: &[u8],
    file: Option<(&str, &str)>,
) {
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    if let Some((file_name, media_type)) = file {
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\nContent-Type: {media_type}\r\n\r\n"
            )
            .as_bytes(),
        );
    } else {
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(value);
    body.extend_from_slice(b"\r\n");
}

pub(super) fn random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Capture Runtime multipart boundary cannot be generated.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
