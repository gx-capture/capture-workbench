use serde_json::Value;

use super::transport::{decode_body, redact_token};

/// Decodes the existing line-oriented SSE wire format into the IPC JSON array.
/// Event ids, names, comments, and heartbeats remain transport framing details.
pub(super) fn parse_response(response: &[u8], token: &str) -> Result<Value, String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Capture Runtime response was malformed.".to_string())?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "Capture Runtime response headers were invalid.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Capture Runtime response status was malformed.".to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "Capture Runtime request was rejected with HTTP {status}."
        ));
    }
    let body = decode_body(headers, &response[separator + 4..])?;
    let events = body
        .split(|byte| *byte == b'\n')
        .filter_map(|line| line.strip_prefix(b"data: "))
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut value: Value = serde_json::from_slice(line)
                .map_err(|_| "Capture Runtime SSE event was not valid JSON.".to_string())?;
            redact_token(&mut value, token);
            Ok(value)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Value::Array(events))
}
