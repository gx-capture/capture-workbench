use std::{
    collections::{HashMap, HashSet},
    env,
    io::{Read, Write},
    net::TcpStream,
};

use serde_json::{json, Value};

const MAX_REQUEST_BYTES: usize = 51 * 1024 * 1024;
const CORS_METHODS: &str = "GET, POST, DELETE, OPTIONS";
const CORS_HEADERS: &str = "Accept, Authorization, Content-Type, X-Idempotency-Key";

pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

pub struct Response {
    status: u16,
    body: Option<Value>,
    headers: Vec<(String, String)>,
}

impl Response {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: Some(body),
            headers: Vec::new(),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            body: None,
            headers: Vec::new(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn with_cors(mut self, origin: Option<&str>) -> Self {
        if let Some(origin) = origin {
            self.headers
                .push(("Access-Control-Allow-Origin".into(), origin.into()));
            self.headers.push(("Vary".into(), "Origin".into()));
        }
        self
    }
}

pub fn api_error(status: u16, code: &str, message: &str) -> Response {
    Response::json(
        status,
        json!({ "error": { "code": code, "message": message } }),
    )
}

pub fn api_error_details(status: u16, code: &str, message: &str, details: Value) -> Response {
    Response::json(
        status,
        json!({ "error": { "code": code, "message": message, "details": details } }),
    )
}

pub enum AuthorizationDecision {
    Authorized,
    Respond(Response),
}

pub struct LocalRequestPolicy {
    token: String,
    allowed_hosts: HashSet<String>,
    allowed_origins: HashSet<String>,
}

impl LocalRequestPolicy {
    pub fn from_env(token: &str) -> Result<Self, String> {
        let allowed_hosts = csv_env("CAPTURE_ALLOWED_HOSTS")
            .into_iter()
            .filter_map(|host| exact_authority(&host))
            .collect::<HashSet<_>>();
        if allowed_hosts.is_empty() {
            return Err("CAPTURE_ALLOWED_HOSTS must not be empty.".into());
        }
        Ok(Self {
            token: token.into(),
            allowed_hosts,
            allowed_origins: csv_env("CAPTURE_ALLOWED_ORIGINS").into_iter().collect(),
        })
    }

    pub fn authorize(&self, request: &Request) -> AuthorizationDecision {
        let host = request
            .headers
            .get("host")
            .and_then(|host| exact_authority(host));
        if host
            .as_ref()
            .is_none_or(|host| !self.allowed_hosts.contains(host))
        {
            return AuthorizationDecision::Respond(api_error(
                400,
                "invalid_host",
                "Request Host is not allowed.",
            ));
        }
        let origin = request.headers.get("origin");
        if origin.is_some_and(|origin| !self.allowed_origins.contains(origin)) {
            return AuthorizationDecision::Respond(api_error(
                403,
                "origin_not_allowed",
                "Request Origin is not allowed.",
            ));
        }
        if request.method == "OPTIONS" {
            return AuthorizationDecision::Respond(
                Response::json(200, json!({}))
                    .header("Access-Control-Allow-Methods", CORS_METHODS)
                    .header("Access-Control-Allow-Headers", CORS_HEADERS)
                    .header("Access-Control-Max-Age", "600"),
            );
        }
        let expected = format!("Bearer {}", self.token);
        if request.headers.get("authorization") != Some(&expected) {
            return AuthorizationDecision::Respond(
                api_error(401, "unauthorized", "A valid Bearer token is required.")
                    .header("WWW-Authenticate", "Bearer"),
            );
        }
        AuthorizationDecision::Authorized
    }

    pub fn permitted_origin<'a>(&self, origin: Option<&'a str>) -> Option<&'a str> {
        origin.filter(|origin| self.allowed_origins.contains(*origin))
    }
}

pub fn read_request(stream: &mut TcpStream) -> Result<Request, Response> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut expected_total = None;
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|_| api_error(400, "invalid_request", "Request body could not be read."))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(api_error(
                413,
                "upload_too_large",
                "Upload exceeds the deterministic fixture limit.",
            ));
        }
        if expected_total.is_none() {
            if let Some(separator) = find_bytes(&bytes, b"\r\n\r\n") {
                let headers = std::str::from_utf8(&bytes[..separator]).map_err(|_| {
                    api_error(400, "invalid_request", "Request headers are invalid.")
                })?;
                let content_length = header_lines(headers)
                    .get("content-length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                expected_total = Some(separator + 4 + content_length);
            }
        }
        if expected_total.is_some_and(|total| bytes.len() >= total) {
            break;
        }
    }

    let separator = find_bytes(&bytes, b"\r\n\r\n")
        .ok_or_else(|| api_error(400, "invalid_request", "Request headers are incomplete."))?;
    let headers_text = std::str::from_utf8(&bytes[..separator])
        .map_err(|_| api_error(400, "invalid_request", "Request headers are invalid."))?;
    let mut lines = headers_text.lines();
    let mut request_line = lines
        .next()
        .ok_or_else(|| api_error(400, "invalid_request", "Request line is missing."))?
        .split_whitespace();
    let method = request_line
        .next()
        .ok_or_else(|| api_error(400, "invalid_request", "Request method is missing."))?
        .to_owned();
    let path = request_line
        .next()
        .ok_or_else(|| api_error(400, "invalid_request", "Request path is missing."))?
        .split('?')
        .next()
        .unwrap_or_default()
        .to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Ok(Request {
        method,
        path,
        headers,
        body: bytes[separator + 4..].to_vec(),
    })
}

pub fn write_response(stream: &mut TcpStream, response: Response) {
    let reason = match response.status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        _ => "Error",
    };
    let body = response
        .body
        .map(|body| serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec()))
        .unwrap_or_default();
    let _ = write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n",
        response.status,
        reason,
        body.len()
    );
    if !body.is_empty() {
        let _ = write!(stream, "Content-Type: application/json\r\n");
    }
    for (name, value) in response.headers {
        let _ = write!(stream, "{name}: {value}\r\n");
    }
    let _ = write!(stream, "Connection: close\r\n\r\n");
    let _ = stream.write_all(&body);
}

pub fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn header_lines(value: &str) -> HashMap<String, String> {
    value
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect()
}

fn csv_env(name: &str) -> Vec<String> {
    env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn exact_authority(value: &str) -> Option<String> {
    let authority = value.trim().to_ascii_lowercase();
    let (host, port) = authority.rsplit_once(':')?;
    if host != "127.0.0.1" || port.parse::<u16>().ok().is_none_or(|port| port == 0) {
        return None;
    }
    Some(authority)
}
