use std::{
    env,
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::http::Response;

pub struct RequestLog(Option<Mutex<File>>);

impl RequestLog {
    pub fn from_env() -> io::Result<Self> {
        let direct = env::var_os("CAPTURE_DETERMINISTIC_REQUEST_LOG").map(PathBuf::from);
        // The installed launcher clears non-allowlisted environment variables.
        // Its isolated TEMP survives; only this fake reads this opt-in bridge.
        let temporary = env::var_os("TEMP").map(PathBuf::from);
        let path = resolve_path(direct, temporary.as_deref())?;
        Self::open(path.as_deref())
    }

    fn open(path: Option<&Path>) -> io::Result<Self> {
        path.map(|path| OpenOptions::new().create(true).append(true).open(path))
            .transpose()
            .map(|file| Self(file.map(Mutex::new)))
    }

    pub fn record(&self, method: &str, path: &str, response: &Response) -> io::Result<()> {
        if let Some(file) = &self.0 {
            let mut file = file
                .lock()
                .map_err(|_| io::Error::other("Request log lock failed."))?;
            serde_json::to_writer(&mut *file, &entry(method, path, response))?;
            file.write_all(b"\n")?;
            file.flush()?;
        }
        Ok(())
    }
}

fn resolve_path(direct: Option<PathBuf>, temporary: Option<&Path>) -> io::Result<Option<PathBuf>> {
    if let Some(path) = direct.filter(|path| !path.as_os_str().is_empty()) {
        return Ok(Some(path));
    }
    let Some(temporary) = temporary else {
        return Ok(None);
    };
    let config = temporary.join("capture-deterministic-request-log.json");
    let contents = match std::fs::read(config) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let config: Value = serde_json::from_slice(&contents)?;
    let path = config["CAPTURE_DETERMINISTIC_REQUEST_LOG"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("Invalid request log configuration."))?;
    // The bridge cannot redirect logging outside the isolated temporary directory.
    if path.file_name().is_none()
        || path.parent().map(std::fs::canonicalize).transpose()?
            != Some(std::fs::canonicalize(temporary)?)
    {
        return Err(io::Error::other(
            "Request log must be inside isolated TEMP.",
        ));
    }
    Ok(Some(path))
}

fn entry(method: &str, path: &str, response: &Response) -> Value {
    let method = match method {
        "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" => method,
        _ => "OTHER",
    };
    let mut value = json!({
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "method": method,
        "route": route_template(path),
        "status": response.status,
    });
    if !(200..300).contains(&response.status) {
        value["errorCode"] = response
            .body
            .as_ref()
            .and_then(|body| body["error"]["code"].as_str())
            .filter(|code| {
                !code.is_empty()
                    && code.len() <= 80
                    && code.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
            .unwrap_or("unknown_error")
            .into();
    }
    value
}

fn route_template(path: &str) -> &'static str {
    let parts: Vec<_> = path
        .split('?')
        .next()
        .unwrap_or_default()
        .split('/')
        .collect();
    match parts.as_slice() {
        ["", "v2", "health", "ready"] => "/v2/health/ready",
        ["", "v2", "runtime", "requirements"] => "/v2/runtime/requirements",
        ["", "v2", "runtime", "requirements", _, "installation"] => {
            "/v2/runtime/requirements/{requirementId}/installation"
        }
        ["", "v2", "runtime", "model-options"] => "/v2/runtime/model-options",
        ["", "v2", "runtime", "installations"] => "/v2/runtime/installations",
        ["", "v2", "runtime", "installations", _] => "/v2/runtime/installations/{installationId}",
        ["", "v2", "runtime", "installations", _, "cancel"] => {
            "/v2/runtime/installations/{installationId}/cancel"
        }
        ["", "v2", "runtime", "model-installations"] => "/v2/runtime/model-installations",
        ["", "v2", "runtime", "model-installations", _] => {
            "/v2/runtime/model-installations/{installationId}"
        }
        ["", "v2", "ingestions"] => "/v2/ingestions",
        ["", "v2", "ingestions", _] => "/v2/ingestions/{ingestionId}",
        ["", "v2", "ingestions", _, "finalize"] => "/v2/ingestions/{ingestionId}/finalize",
        ["", "v2", "ingestions", _, "chunks", _] => {
            "/v2/ingestions/{ingestionId}/chunks/{chunkIndex}"
        }
        ["", "v2", "captures"] => "/v2/captures",
        ["", "v2", "captures", _] => "/v2/captures/{captureId}",
        ["", "v2", "captures", _, "raw"] => "/v2/captures/{captureId}/raw",
        ["", "v2", "captures", _, "result"] => "/v2/captures/{captureId}/result",
        ["", "v2", "captures", _, "structure"] => "/v2/captures/{captureId}/structure",
        ["", "v2", "captures", _, "ocr"] => "/v2/captures/{captureId}/ocr",
        ["", "v2", "captures", _, "partial"] => "/v2/captures/{captureId}/partial",
        ["", "v2", "captures", _, "events"] => "/v2/captures/{captureId}/events",
        ["", "v2", "captures", _, "cancel"] => "/v2/captures/{captureId}/cancel",
        _ => "unmatched",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::api_error;
    use std::sync::Arc;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(format!(
                    "request-log-test-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            std::fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn entries_never_include_ids_queries_headers_bodies_or_messages() {
        let response = api_error(409, "chunk_conflict", "Bearer private-body");
        let value = entry(
            "PUT",
            "/v2/ingestions/private-id/chunks/secret-index?token=private-query",
            &response,
        );
        assert_eq!(
            value["route"],
            "/v2/ingestions/{ingestionId}/chunks/{chunkIndex}"
        );
        assert_eq!(value["errorCode"], "chunk_conflict");
        assert_eq!(value["status"], 409);
        assert!(value["timestamp"].as_u64().unwrap() > 0);
        assert!(!value.to_string().contains("private"));
        assert!(!value.to_string().contains("secret-index"));
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert_eq!(
            entry("secret-method", "/private/path", &response)["method"],
            "OTHER"
        );
        assert_eq!(route_template("/private/path"), "unmatched");
        assert_eq!(
            route_template("/v2/ingestions/id/finalize?private"),
            "/v2/ingestions/{ingestionId}/finalize"
        );
    }

    #[test]
    fn append_is_line_delimited_and_serialized_across_threads() {
        let directory = TestDirectory::new();
        let path = directory.0.join("requests.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let log = Arc::new(RequestLog::open(Some(&path)).unwrap());
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let log = Arc::clone(&log);
                std::thread::spawn(move || {
                    log.record("GET", "/v2/health/ready", &Response::empty(200))
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        drop(log);
        let contents = std::fs::read_to_string(path).unwrap();
        let lines: Vec<Value> = contents
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 13);
        for line in &lines[1..] {
            assert!(line.get("errorCode").is_none());
        }
        RequestLog::open(None)
            .unwrap()
            .record("GET", "/private", &Response::empty(200))
            .unwrap();
    }

    #[test]
    fn installed_bridge_is_opt_in_and_confined_to_temp() {
        let directory = TestDirectory::new();
        assert_eq!(resolve_path(None, Some(&directory.0)).unwrap(), None);
        let path = directory.0.join("requests.jsonl");
        let config = directory.0.join("capture-deterministic-request-log.json");
        std::fs::write(
            &config,
            json!({"CAPTURE_DETERMINISTIC_REQUEST_LOG": path}).to_string(),
        )
        .unwrap();
        assert_eq!(
            resolve_path(None, Some(&directory.0)).unwrap(),
            Some(path.clone())
        );
        let direct = directory.0.join("direct.jsonl");
        assert_eq!(
            resolve_path(Some(direct.clone()), Some(&directory.0)).unwrap(),
            Some(direct)
        );
        std::fs::write(
            config,
            json!({"CAPTURE_DETERMINISTIC_REQUEST_LOG": directory.0.join("../escaped.jsonl")})
                .to_string(),
        )
        .unwrap();
        assert!(resolve_path(None, Some(&directory.0)).is_err());
    }
}
