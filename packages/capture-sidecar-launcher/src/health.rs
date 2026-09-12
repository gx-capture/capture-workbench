use std::{
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::{
    constants::{HEALTH_PATH, LOOPBACK_HOST, MAX_HEALTH_RESPONSE_BYTES},
    manifest::SidecarManifest,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

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
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Some(remaining) = remaining_budget(deadline) else {
        return Ok(ProbeResult::NotReady);
    };
    let mut stream = match TcpStream::connect_timeout(&address, remaining.min(CONNECT_TIMEOUT)) {
        Ok(stream) => stream,
        Err(_) => return Ok(ProbeResult::NotReady),
    };
    let Some(remaining) = remaining_budget(deadline) else {
        return Ok(ProbeResult::NotReady);
    };
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if !write_request(&mut stream, request.as_bytes(), deadline)? {
        return Ok(ProbeResult::NotReady);
    }

    let Some(response) = read_response(&mut stream, deadline)? else {
        return Ok(ProbeResult::NotReady);
    };
    if remaining_budget(deadline).is_none() {
        return Ok(ProbeResult::NotReady);
    }
    finish_probe_result(parse_health_response(&response, manifest), deadline)
}

fn remaining_budget(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
}

fn write_request(
    stream: &mut TcpStream,
    request: &[u8],
    deadline: Instant,
) -> Result<bool, String> {
    write_request_with_deadline(stream, request, deadline, |stream, remaining| {
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())
    })
}

fn write_request_with_deadline<W, F>(
    writer: &mut W,
    request: &[u8],
    deadline: Instant,
    mut set_timeout: F,
) -> Result<bool, String>
where
    W: Write,
    F: FnMut(&mut W, Duration) -> Result<(), String>,
{
    let mut written = 0;
    while written < request.len() {
        let Some(remaining) = remaining_budget(deadline) else {
            return Ok(false);
        };
        set_timeout(writer, remaining)?;
        match writer.write(&request[written..]) {
            Ok(0) => return Ok(false),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Ok(false),
        }
    }
    Ok(true)
}

fn finish_probe_result(
    result: Result<ProbeResult, String>,
    deadline: Instant,
) -> Result<ProbeResult, String> {
    if remaining_budget(deadline).is_none() {
        Ok(ProbeResult::NotReady)
    } else {
        result
    }
}

fn read_response(stream: &mut TcpStream, deadline: Instant) -> Result<Option<Vec<u8>>, String> {
    let max_bytes = usize::try_from(MAX_HEALTH_RESPONSE_BYTES)
        .expect("health response limit must fit in usize");
    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        let Some(remaining) = remaining_budget(deadline) else {
            return Ok(None);
        };
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
        let available = (max_bytes + 1 - response.len()).min(chunk.len());
        match stream.read(&mut chunk[..available]) {
            Ok(0) => {
                return Ok(remaining_budget(deadline).map(|_| response));
            }
            Ok(count) => {
                response.extend_from_slice(&chunk[..count]);
                if response.len() > max_bytes {
                    return Err(
                        "Capture runtime readiness response exceeded the safety limit.".into(),
                    );
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        }
    }
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
    use std::{
        io::{self, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    fn manifest() -> SidecarManifest {
        SidecarManifest {
            manifest_version: "1".into(),
            runtime_version: "0.4.2".into(),
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

    struct ScriptedWriter {
        output: Vec<u8>,
        attempts: usize,
        timeouts: Vec<Duration>,
        delay: Duration,
    }

    impl Write for ScriptedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            thread::sleep(self.delay);
            match self.attempts {
                0 => {
                    self.attempts += 1;
                    let count = bytes.len().min(1);
                    self.output.extend_from_slice(&bytes[..count]);
                    Ok(count)
                }
                1 => {
                    self.attempts += 1;
                    Err(io::Error::from(ErrorKind::Interrupted))
                }
                _ => {
                    self.attempts += 1;
                    self.output.extend_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct ZeroProgressWriter;

    impl Write for ZeroProgressWriter {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            Ok(0)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn request_writer_retries_short_and_interrupted_writes_with_remaining_deadline() {
        let mut writer = ScriptedWriter {
            output: Vec::new(),
            attempts: 0,
            timeouts: Vec::new(),
            delay: Duration::from_millis(10),
        };
        let deadline = Instant::now() + Duration::from_millis(200);
        let completed =
            write_request_with_deadline(&mut writer, b"request", deadline, |writer, remaining| {
                writer.timeouts.push(remaining);
                Ok(())
            })
            .expect("write");

        assert!(completed);
        assert_eq!(writer.output, b"request");
        assert_eq!(writer.attempts, 3);
        assert_eq!(writer.timeouts.len(), 3);
        assert!(writer
            .timeouts
            .windows(2)
            .all(|window| window[0] > window[1]));
    }

    #[test]
    fn request_writer_fails_closed_on_zero_progress() {
        let mut writer = ZeroProgressWriter;
        let completed = write_request_with_deadline(
            &mut writer,
            b"request",
            Instant::now() + Duration::from_secs(1),
            |_writer, _remaining| Ok(()),
        )
        .expect("write");

        assert!(!completed);
    }

    #[test]
    fn request_writer_makes_no_progress_after_deadline() {
        let mut writer = ScriptedWriter {
            output: Vec::new(),
            attempts: 0,
            timeouts: Vec::new(),
            delay: Duration::ZERO,
        };
        let deadline = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .expect("past deadline");
        let completed =
            write_request_with_deadline(&mut writer, b"request", deadline, |writer, remaining| {
                writer.timeouts.push(remaining);
                Ok(())
            })
            .expect("write");

        assert!(!completed);
        assert_eq!(writer.attempts, 0);
        assert!(writer.timeouts.is_empty());
    }

    #[test]
    fn post_parse_deadline_never_accepts_ready() {
        let ready = Ok(ProbeResult::Ready(ReadyHandshake {
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        }));
        let deadline = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .expect("past deadline");

        assert_eq!(
            finish_probe_result(ready, deadline),
            Ok(ProbeResult::NotReady)
        );
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
            let body = r#"{"ready":true,"runtimeVersion":"0.4.2","apiVersion":"2.0","captureDocumentSchemaVersion":"2","capabilities":{}}"#;
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
        let body = br#"{"ready":true,"runtimeVersion":"0.4.2","apiVersion":"2.0","captureDocumentSchemaVersion":"99","capabilities":{}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        );
        let error = parse_health_response(response.as_bytes(), &manifest()).expect_err("schema");
        assert!(error.contains("captureDocumentSchemaVersion"));
        assert!(!error.contains("99"));
    }

    #[test]
    fn partial_response_is_rejected_without_echoing_the_token() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n{\"ready\":true")
                .expect("partial response");
        });

        let error = probe_ready_once(port, "partial-secret-token", &manifest())
            .expect_err("partial response");
        assert!(error.contains("invalid JSON"));
        assert!(!error.contains("partial-secret-token"));
        server.join().expect("server");
    }

    #[test]
    fn silent_peer_is_bounded_by_the_whole_probe_deadline() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (release, wait) = mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("accept");
            wait.recv().expect("release");
        });

        let started = Instant::now();
        let result = probe_ready_once(port, "silent-secret-token", &manifest());
        let elapsed = started.elapsed();
        assert_eq!(result, Ok(ProbeResult::NotReady));
        assert!(elapsed < Duration::from_secs(2), "probe took {elapsed:?}");
        release.send(()).expect("release server");
        server.join().expect("server");
    }

    #[test]
    fn slow_drip_response_cannot_extend_the_whole_probe_deadline() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\n\r\n{")
                .expect("response prefix");
            for _ in 0..16 {
                thread::sleep(Duration::from_millis(150));
                if stream.write_all(b" ").is_err() {
                    break;
                }
            }
        });

        let started = Instant::now();
        let result = probe_ready_once(port, "slow-secret-token", &manifest());
        let elapsed = started.elapsed();
        assert_eq!(result, Ok(ProbeResult::NotReady));
        assert!(elapsed < Duration::from_secs(2), "probe took {elapsed:?}");
        server.join().expect("server");
    }

    #[test]
    fn oversized_response_is_rejected_before_unbounded_read() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            stream.read(&mut request).expect("request");
            let body = vec![b'x'; MAX_HEALTH_RESPONSE_BYTES as usize + 1];
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            stream.write_all(headers.as_bytes()).expect("headers");
            stream.write_all(&body).expect("body");
        });

        let error = probe_ready_once(port, "oversized-secret-token", &manifest())
            .expect_err("oversized response");
        assert!(error.contains("safety limit"));
        assert!(!error.contains("oversized-secret-token"));
        server.join().expect("server");
    }
}
