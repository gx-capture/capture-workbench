use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

use serde_json::Value;

use crate::{
    constants::{HEALTH_PATH, LOOPBACK_HOST, MAX_HEALTH_RESPONSE_BYTES},
    manifest::SidecarManifest,
};

/// Readiness handshake returned by `/v2/health/ready`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyHandshake {
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

/// Result of one bounded readiness probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeResult {
    Ready(ReadyHandshake),
    NotReady,
}

/// Probes the authenticated loopback readiness endpoint once.
pub fn probe_ready_once(
    port: u16,
    token: &str,
    manifest: &SidecarManifest,
) -> Result<ProbeResult, String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
        Ok(stream) => stream,
        Err(_) => return Ok(ProbeResult::NotReady),
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;

    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Ok(ProbeResult::NotReady);
    }

    let mut response = Vec::new();
    if stream
        .take(MAX_HEALTH_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .is_err()
    {
        return Ok(ProbeResult::NotReady);
    }
    if response.len() as u64 > MAX_HEALTH_RESPONSE_BYTES {
        return Err("Capture runtime readiness response exceeded the safety limit.".into());
    }
    parse_health_response(&response, manifest)
}

fn parse_health_response(
    response: &[u8],
    manifest: &SidecarManifest,
) -> Result<ProbeResult, String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Capture runtime readiness response was malformed.".to_string())?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "Capture runtime readiness headers were not UTF-8.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Capture runtime readiness status was malformed.".to_string())?;
    if status == 503 {
        return Ok(ProbeResult::NotReady);
    }
    if status != 200 {
        return Err(format!(
            "Capture runtime readiness request was rejected with HTTP {status}."
        ));
    }

    let body = &response[separator + 4..];
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| "Capture runtime readiness body was invalid JSON.".to_string())?;
    validate_handshake(&value, manifest).map(ProbeResult::Ready)
}

fn validate_handshake(value: &Value, manifest: &SidecarManifest) -> Result<ReadyHandshake, String> {
    let ready = value.get("ready").and_then(Value::as_bool).unwrap_or(false)
        || value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("ready"));
    if !ready {
        return Err("Capture runtime did not report ready.".into());
    }
    if value.get("capabilities").is_none_or(Value::is_null) {
        return Err("Capture runtime readiness response omitted capabilities.".into());
    }

    let runtime_version = response_string(value, "runtimeVersion")?;
    let api_version = response_string(value, "apiVersion")?;
    let schema_version = response_string(value, "captureDocumentSchemaVersion")?;
    compare_handshake(
        "runtimeVersion",
        &runtime_version,
        &manifest.runtime_version,
    )?;
    compare_handshake("apiVersion", &api_version, &manifest.api_version)?;
    compare_handshake(
        "captureDocumentSchemaVersion",
        &schema_version,
        &manifest.capture_document_schema_version,
    )?;

    Ok(ReadyHandshake {
        runtime_version,
        api_version,
        capture_document_schema_version: schema_version,
    })
}

fn response_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .or_else(|| value.get("versions").and_then(|versions| versions.get(key)))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Capture runtime readiness response omitted {key}."))
}

fn compare_handshake(name: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime readiness {name} is incompatible with the verified manifest."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, sync::mpsc, thread};

    fn manifest() -> SidecarManifest {
        SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.1".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: "capture-runtime.exe".into(),
            bytes: 1,
            sha256: "0".repeat(64),
            schema_file_name: "capture-document-v2.schema.json".into(),
            schema_sha256: "0".repeat(64),
        }
    }

    #[test]
    fn authenticated_ready_handshake_is_exact_and_token_is_only_in_request() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            sender.send(request[..count].to_vec()).expect("send");
            let body = r#"{"ready":true,"runtimeVersion":"0.4.1","apiVersion":"2.0","captureDocumentSchemaVersion":"2","capabilities":{}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });

        let result = probe_ready_once(port, "secret-token", &manifest()).expect("probe");
        assert!(matches!(result, ProbeResult::Ready(_)));
        let request = String::from_utf8(receiver.recv().expect("request")).expect("utf8");
        assert!(request.contains("Authorization: Bearer secret-token"));
        server.join().expect("server");
    }

    #[test]
    fn incompatible_handshake_does_not_echo_the_received_value() {
        let body = br#"{"ready":true,"runtimeVersion":"0.4.1","apiVersion":"2.0","captureDocumentSchemaVersion":"99","capabilities":{}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        );
        let error = parse_health_response(response.as_bytes(), &manifest()).expect_err("schema");
        assert!(error.contains("captureDocumentSchemaVersion"));
        assert!(!error.contains("99"));
    }
}
