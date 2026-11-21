use serde_json::Value;

use super::transport::redact_token;

/// How the runtime frames the event stream's body after the headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Chunked,
    Length(usize),
    UntilClose,
}

/// Reads a capture's event stream incrementally (issue #479).
///
/// The runtime keeps the stream open while a capture runs, so the host cannot
/// wait for it to close. Bytes are pushed as they arrive; the status is checked
/// as soon as the headers are complete, the body is de-chunked as far as whole
/// chunks reach, and only events terminated by a blank line are returned. A
/// trailing incomplete event is dropped: the next call resumes after the last
/// returned event's id.
pub(super) struct EventStream {
    raw: Vec<u8>,
    body_start: Option<usize>,
    framing: Framing,
    /// Raw bytes after the headers already decoded into `body`.
    decoded_until: usize,
    body: Vec<u8>,
    ended: bool,
}

impl EventStream {
    pub(super) fn new() -> Self {
        Self {
            raw: Vec::new(),
            body_start: None,
            framing: Framing::UntilClose,
            decoded_until: 0,
            body: Vec::new(),
            ended: false,
        }
    }

    /// Adds received bytes. Fails on a non-2xx status or malformed framing.
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.raw.extend_from_slice(bytes);
        if self.body_start.is_none() {
            let Some(separator) = self.raw.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                return Ok(());
            };
            self.framing = read_headers(&self.raw[..separator])?;
            self.body_start = Some(separator + 4);
            self.decoded_until = separator + 4;
        }
        self.decode()
    }

    /// The peer closed the connection.
    pub(super) fn finish(&mut self) {
        self.ended = true;
    }

    pub(super) fn headers_received(&self) -> bool {
        self.body_start.is_some()
    }

    /// The body is complete: the last chunk, the full Content-Length, or the peer closed.
    pub(super) fn ended(&self) -> bool {
        self.ended
    }

    pub(super) fn has_complete_event(&self) -> bool {
        complete_events_end(&self.body).is_some_and(|end| {
            self.body[..end]
                .split(|byte| *byte == b'\n')
                .any(|line| strip_cr(line).starts_with(b"data: "))
        })
    }

    /// The complete events received so far, with the token redacted.
    pub(super) fn events(&self, token: &str) -> Result<Value, String> {
        let complete = &self.body[..complete_events_end(&self.body).unwrap_or(0)];
        let events = complete
            .split(|byte| *byte == b'\n')
            .filter_map(|line| strip_cr(line).strip_prefix(b"data: "))
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

    fn decode(&mut self) -> Result<(), String> {
        let Some(body_start) = self.body_start else {
            return Ok(());
        };
        match self.framing {
            Framing::UntilClose => {
                self.body.extend_from_slice(&self.raw[self.decoded_until..]);
                self.decoded_until = self.raw.len();
            }
            Framing::Length(length) => {
                let end = (body_start + length).min(self.raw.len());
                self.body
                    .extend_from_slice(&self.raw[self.decoded_until..end]);
                self.decoded_until = end;
                if self.body.len() == length {
                    self.ended = true;
                }
            }
            Framing::Chunked => loop {
                let remaining = &self.raw[self.decoded_until..];
                let Some(size_end) = remaining.windows(2).position(|window| window == b"\r\n")
                else {
                    return Ok(());
                };
                let size_line = std::str::from_utf8(&remaining[..size_end])
                    .map_err(|_| "Capture Runtime chunk size was invalid.".to_string())?;
                let size_text = size_line.split(';').next().unwrap_or_default().trim();
                let size = usize::from_str_radix(size_text, 16)
                    .map_err(|_| "Capture Runtime chunk size was invalid.".to_string())?;
                if size == 0 {
                    self.ended = true;
                    return Ok(());
                }
                let chunk_start = size_end + 2;
                let chunk_end = chunk_start
                    .checked_add(size)
                    .ok_or_else(|| "Capture Runtime chunk size overflowed.".to_string())?;
                let Some(framing) = remaining.get(chunk_end..chunk_end + 2) else {
                    return Ok(());
                };
                if framing != b"\r\n" {
                    return Err("Capture Runtime chunk was malformed.".into());
                }
                self.body
                    .extend_from_slice(&remaining[chunk_start..chunk_end]);
                self.decoded_until += chunk_end + 2;
            },
        }
        Ok(())
    }
}

fn read_headers(headers: &[u8]) -> Result<Framing, String> {
    let headers = std::str::from_utf8(headers)
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
    let mut framing = Framing::UntilClose;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding"
                if value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked")) =>
            {
                framing = Framing::Chunked;
            }
            "content-length" if framing != Framing::Chunked => {
                framing = Framing::Length(value.trim().parse::<usize>().map_err(|_| {
                    "Capture Runtime response Content-Length was invalid.".to_string()
                })?);
            }
            _ => {}
        }
    }
    Ok(framing)
}

/// The end of the last event terminated by a blank line (LF or CRLF line endings).
fn complete_events_end(body: &[u8]) -> Option<usize> {
    let mut end = None;
    let mut line_start = 0;
    for (index, byte) in body.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        if line_start > 0 && strip_cr(&body[line_start..index]).is_empty() {
            end = Some(index + 1);
        }
        line_start = index + 1;
    }
    end
}

fn strip_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::EventStream;

    const HEADERS: &[u8] =
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";

    fn chunk(text: &str) -> Vec<u8> {
        format!("{:x}\r\n{text}\r\n", text.len()).into_bytes()
    }

    #[test]
    fn returns_only_events_terminated_by_a_blank_line() {
        let mut stream = EventStream::new();
        stream.push(HEADERS).expect("headers");
        stream
            .push(&chunk(
                "id: 1\nevent: segment\ndata: {\"sequence\":1}\n\nid: 2\ndata: {\"seq",
            ))
            .expect("chunk");
        assert!(stream.has_complete_event());
        assert_eq!(
            stream
                .events("token")
                .expect("events")
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        stream.push(&chunk("uence\":2}\n\n")).expect("chunk");
        let events = stream.events("token").expect("events");
        assert_eq!(events[1]["sequence"], 2);
        assert!(!stream.ended());
    }

    #[test]
    fn decodes_chunks_split_across_reads_byte_by_byte() {
        let mut bytes = HEADERS.to_vec();
        bytes.extend(chunk(": heartbeat\n\n"));
        bytes.extend(chunk(
            "id: 3\r\nevent: checkpoint\r\ndata: {\"sequence\":3}\r\n\r\n",
        ));
        bytes.extend(b"0\r\n\r\n");
        let mut stream = EventStream::new();
        for byte in bytes {
            stream.push(&[byte]).expect("byte");
        }
        assert!(stream.ended());
        let events = stream.events("token").expect("events");
        assert_eq!(events.as_array().map(Vec::len), Some(1));
        assert_eq!(events[0]["sequence"], 3);
    }

    #[test]
    fn a_peer_that_closes_inside_a_chunk_keeps_the_complete_events() {
        let mut stream = EventStream::new();
        stream.push(HEADERS).expect("headers");
        stream
            .push(&chunk("data: {\"sequence\":7}\n\n"))
            .expect("chunk");
        stream.push(b"40\r\ndata: {\"seq").expect("truncated chunk");
        stream.finish();
        assert!(stream.ended());
        let events = stream.events("token").expect("events");
        assert_eq!(events.as_array().map(Vec::len), Some(1));
        assert_eq!(events[0]["sequence"], 7);
    }

    #[test]
    fn a_heartbeat_alone_is_not_an_event() {
        let mut stream = EventStream::new();
        stream.push(HEADERS).expect("headers");
        stream.push(&chunk(": heartbeat\n\n")).expect("heartbeat");
        assert!(!stream.has_complete_event());
        assert_eq!(
            stream.events("token").expect("events"),
            serde_json::json!([])
        );
    }

    #[test]
    fn content_length_body_ends_at_its_length() {
        let body = "data: {\"sequence\":4}\n\n";
        let mut stream = EventStream::new();
        stream
            .push(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .expect("response");
        assert!(stream.ended());
        assert_eq!(stream.events("token").expect("events")[0]["sequence"], 4);
    }

    #[test]
    fn rejects_a_non_success_status_and_malformed_chunks_without_response_bytes() {
        let mut rejected = EventStream::new();
        let error = rejected
            .push(b"HTTP/1.1 404 Not Found\r\nX-Echo: Bearer secret-token\r\n\r\n")
            .expect_err("rejection");
        assert_eq!(error, "Capture Runtime request was rejected with HTTP 404.");
        let mut malformed = EventStream::new();
        malformed.push(HEADERS).expect("headers");
        let error = malformed
            .push(b"zz secret-token\r\n")
            .expect_err("malformed chunk");
        assert!(!error.contains("secret-token"));
    }

    #[test]
    fn event_payloads_are_redacted() {
        let mut stream = EventStream::new();
        stream.push(HEADERS).expect("headers");
        stream
            .push(&chunk("data: {\"message\":\"Bearer secret-token\"}\n\n"))
            .expect("chunk");
        assert_eq!(
            stream.events("secret-token").expect("events")[0]["message"],
            "Bearer [REDACTED]"
        );
    }
}
