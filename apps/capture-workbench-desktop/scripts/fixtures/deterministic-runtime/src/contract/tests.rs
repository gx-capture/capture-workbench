use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::Duration,
};

const PDF: &[u8] = b"%PDF-1.7\nCAPTURE_TEXT:Installed PDF page one\x0cInstalled PDF page two";
const IMAGE: &[u8] = b"\x89PNG\r\n\x1a\nCAPTURE_TEXT:Installed image words";
const AUDIO: &[u8] = b"RIFF\0\0\0\0WAVECAPTURE_TEXT:Installed audio one|Installed audio two";
const REQUEST_ID: &str = "e9bdf91d-32db-4a21-846d-a8d7ee669559";

fn fixture() -> FixtureState {
    FixtureState::new(FixtureSettings {
        api_token: "fixture-test-credential-unused-by-routing".into(),
        max_upload_bytes: 50 * 1024 * 1024,
    })
}

fn json_request(method: &str, path: &str, key: Option<&str>, body: Value) -> Request {
    let mut headers = HashMap::from([("content-type".into(), "application/json".into())]);
    if let Some(key) = key {
        headers.insert("x-idempotency-key".into(), key.into());
    }
    Request {
        method: method.into(),
        path: path.into(),
        headers,
        body: serde_json::to_vec(&body).unwrap(),
    }
}

// Exercise the fixture's actual TCP framing, including non-UTF8 source bytes.
// No files, external processes, credentials, or environment changes are needed.
fn wire_exchange(state: &FixtureState, request: Request) -> (u16, String, Vec<u8>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let request =
                crate::http::read_request(&mut stream).unwrap_or_else(|_| panic!("read request"));
            crate::http::write_response(&mut stream, state.route(request));
        });
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "{} {} HTTP/1.1\r\nHost: {address}\r\nContent-Length: {}\r\n",
            request.method,
            request.path,
            request.body.len()
        )
        .unwrap();
        for (name, value) in request.headers {
            write!(stream, "{name}: {value}\r\n").unwrap();
        }
        stream.write_all(b"\r\n").unwrap();
        for fragment in request.body.chunks(8192) {
            stream.write_all(fragment).unwrap();
        }
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        server.join().unwrap();
        let separator = find_bytes(&response, b"\r\n\r\n").unwrap();
        let headers = String::from_utf8(response[..separator].to_vec()).unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, headers, response[separator + 4..].to_vec())
    })
}

fn exchange(state: &FixtureState, request: Request, expected_status: u16) -> Value {
    let (status, _, body) = wire_exchange(state, request);
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    assert_eq!(status, expected_status, "unexpected response: {value}");
    value
}

fn open_request(kind: &str, media_type: &str, content: &[u8]) -> Request {
    let request_id = format!("{REQUEST_ID}-ingestion");
    json_request(
        "POST",
        "/v2/ingestions",
        Some(&request_id),
        json!({
            "protocolVersion": "2", "clientRequestId": request_id,
            "kind": kind, "mode": "file", "fileName": format!("installed-fixture.{kind}"),
            "mediaType": media_type, "totalBytes": content.len(),
        }),
    )
}

fn chunk_request(id: &str, index: usize, start: usize, total: usize, bytes: &[u8]) -> Request {
    Request {
        method: "PUT".into(),
        path: format!("/v2/ingestions/{id}/chunks/{index}"),
        headers: HashMap::from([
            ("content-type".into(), "application/octet-stream".into()),
            (
                "x-idempotency-key".into(),
                format!("{REQUEST_ID}-chunk-{index}"),
            ),
            (
                "content-range".into(),
                format!("bytes {start}-{}/{total}", start + bytes.len() - 1),
            ),
            ("digest".into(), format!("sha-256={}", sha256_hex(bytes))),
        ]),
        body: bytes.into(),
    }
}

fn finalize_request(id: &str, bytes: &[u8]) -> Request {
    json_request(
        "POST",
        &format!("/v2/ingestions/{id}/finalize"),
        None,
        json!({
            "protocolVersion": "2", "totalBytes": bytes.len(), "sha256": sha256_hex(bytes),
        }),
    )
}

fn start_request(id: &str, mode: &str) -> Request {
    json_request(
        "POST",
        "/v2/captures",
        Some(REQUEST_ID),
        json!({
            "protocolVersion": "2", "clientRequestId": REQUEST_ID,
            "ingestionId": id, "structuringMode": mode, "startPolicy": "eager",
        }),
    )
}

fn get(state: &FixtureState, path: &str, status: u16) -> Value {
    exchange(state, json_request("GET", path, None, Value::Null), status)
}

fn upload(state: &FixtureState, kind: &str, media_type: &str, content: &[u8]) -> String {
    let opened = exchange(state, open_request(kind, media_type, content), 201);
    let id = opened["ingestionId"].as_str().unwrap().to_owned();
    // Host sends chunks of up to 1 MiB. Check a real boundary crossing as well
    // as the short PDF/image/audio fixtures used by the installed exercise.
    for (index, chunk) in content.chunks(1024 * 1024).enumerate() {
        let offset = index * 1024 * 1024;
        let uploaded = exchange(
            state,
            chunk_request(&id, index, offset, content.len(), chunk),
            200,
        );
        assert_eq!(uploaded["nextOffset"], offset + chunk.len());
        assert_eq!(uploaded["nextChunkIndex"], index + 1);
    }
    let finalized = exchange(state, finalize_request(&id, content), 200);
    assert_eq!(finalized["status"], "ready");
    assert_eq!(finalized["finalizedSha256"], sha256_hex(content));
    assert_eq!(finalized["receivedBytes"], content.len());
    assert_eq!(finalized["contiguousBytes"], content.len());
    assert_eq!(get(state, &format!("/v2/ingestions/{id}"), 200), finalized);
    id
}

#[test]
fn desktop_pdf_and_image_complete_with_raw_ocr_result_and_cleanup() {
    for (kind, media_type, bytes, expected_text, expected_pages) in [
        (
            "pdf",
            "application/pdf",
            PDF,
            "Installed PDF page one\nInstalled PDF page two",
            2,
        ),
        ("image", "image/png", IMAGE, "Installed image words", 1),
    ] {
        let state = fixture();
        let id = upload(&state, kind, media_type, bytes);
        let created = exchange(&state, start_request(&id, "host"), 202);
        assert_eq!(created["protocolVersion"], "2");
        assert_eq!(created["ingestionId"], id);
        assert_eq!(created["kind"], kind);
        assert_eq!(created["status"], "completed");
        assert_eq!(created["progress"], 1.0);
        assert_eq!(created["completedAt"], COMPLETED_AT);
        assert!(
            created.get("stage").is_none(),
            "operation must use the v2 shape"
        );
        let capture_id = created["captureId"].as_str().unwrap();
        let path = format!("/v2/captures/{capture_id}");
        assert_eq!(get(&state, &path, 200), created);
        let raw = get(&state, &format!("{path}/raw"), 200);
        assert_eq!(raw["sourceText"], expected_text);
        assert_eq!(raw["source"]["sha256"], sha256_hex(bytes));
        let result = get(&state, &format!("{path}/result"), 200);
        assert_eq!(result["operation"], created);
        assert_eq!(result["raw"], raw);
        assert_eq!(result["result"]["source"], raw["source"]);
        assert_eq!(result["result"]["rawSegments"], raw["segments"]);
        assert_eq!(result["result"]["targetText"], expected_text);
        assert_eq!(
            result["result"]["blocks"].as_array().unwrap().len(),
            expected_pages
        );
        let ready = get(&state, "/v2/health/ready", 200);
        let ocr = get(&state, &format!("{path}/ocr"), 200);
        assert_eq!(ocr["schemaVersion"], "3");
        assert_eq!(ocr["captureId"], capture_id);
        assert_eq!(ocr["status"], "completed");
        assert_eq!(ocr["source"], raw["source"]);
        assert_eq!(ocr["pageCount"], expected_pages);
        assert_eq!(ocr["runtimeVersion"], ready["ocrCompute"]["runtimeVersion"]);
        assert_eq!(ocr["contractSha256"], ready["ocrCompute"]["contractSha256"]);
        assert_eq!(
            ready["ocrCompute"]["workerSha256"].as_str().unwrap().len(),
            64
        );
        for (index, page) in ocr["pages"].as_array().unwrap().iter().enumerate() {
            assert_eq!(page["page"], index + 1);
            assert_eq!(page["text"], raw["segments"][index]["text"]);
            assert_eq!(page["provenance"], ocr["provenance"]);
            assert_eq!(page["status"], "recognized");
        }
        exchange(
            &state,
            json_request("DELETE", &path, None, Value::Null),
            204,
        );
        get(&state, &path, 404);
        get(&state, &format!("/v2/ingestions/{id}"), 404);
    }
}

#[test]
fn chunked_upload_crosses_the_host_one_mebibyte_boundary() {
    let mut bytes = b"%PDF-1.7\n".to_vec();
    bytes.resize(1024 * 1024 + 17, 0xff);
    let state = fixture();
    let id = upload(&state, "pdf", "application/pdf", &bytes);
    let ingestion = get(&state, &format!("/v2/ingestions/{id}"), 200);
    assert_eq!(ingestion["nextChunkIndex"], 2);
}

#[test]
fn desktop_sized_recording_completes_over_fifty_two_tcp_chunks() {
    let started = std::time::Instant::now();
    let state = FixtureState::new(FixtureSettings {
        api_token: "fixture-test-credential-unused-by-routing".into(),
        // The desktop launch policy passes this value to both real and fake runtimes.
        max_upload_bytes: 2 * 1024 * 1024 * 1024,
    });
    let total = 52 * 1024 * 1024;
    let mut request = open_request("audio", "audio/wav", AUDIO);
    let mut metadata: Value = serde_json::from_slice(&request.body).unwrap();
    metadata["totalBytes"] = total.into();
    request.body = serde_json::to_vec(&metadata).unwrap();
    let opened = exchange(&state, request, 201);
    let id = opened["ingestionId"].as_str().unwrap();
    let mut chunk = vec![0; 1024 * 1024];
    chunk[..4].copy_from_slice(b"RIFF");
    chunk[4..8].copy_from_slice(&((total - 8) as u32).to_le_bytes());
    chunk[8..16].copy_from_slice(b"WAVEfmt ");
    chunk[16..20].copy_from_slice(&16_u32.to_le_bytes());
    chunk[20..22].copy_from_slice(&1_u16.to_le_bytes());
    chunk[22..24].copy_from_slice(&2_u16.to_le_bytes());
    chunk[24..28].copy_from_slice(&48_000_u32.to_le_bytes());
    chunk[28..32].copy_from_slice(&192_000_u32.to_le_bytes());
    chunk[32..34].copy_from_slice(&4_u16.to_le_bytes());
    chunk[34..36].copy_from_slice(&16_u16.to_le_bytes());
    chunk[36..40].copy_from_slice(b"data");
    chunk[40..44].copy_from_slice(&((total - 44) as u32).to_le_bytes());
    let marker = b"CAPTURE_TEXT:Installed large recording words";
    chunk[44..44 + marker.len()].copy_from_slice(marker);
    let mut digest = Sha256::new();
    for index in 0..52 {
        digest.update(&chunk);
        let uploaded = exchange(
            &state,
            chunk_request(id, index, index * chunk.len(), total, &chunk),
            200,
        );
        assert_eq!(uploaded["nextChunkIndex"], index + 1);
        chunk.fill(0);
    }
    let finalized = exchange(
        &state,
        json_request(
            "POST",
            &format!("/v2/ingestions/{id}/finalize"),
            None,
            json!({"totalBytes": total, "sha256": format!("{:x}", digest.finalize())}),
        ),
        200,
    );
    assert_eq!(finalized["receivedBytes"], total);
    let capture = exchange(&state, start_request(id, "host"), 202);
    assert_eq!(capture["status"], "completed");
    let result = get(
        &state,
        &format!(
            "/v2/captures/{}/result",
            capture["captureId"].as_str().unwrap()
        ),
        200,
    );
    assert_eq!(
        result["result"]["sourceText"],
        "Installed large recording words"
    );
    eprintln!("52-chunk local TCP recording path: {:?}", started.elapsed());
}

#[test]
fn retries_are_idempotent_and_conflicting_metadata_is_rejected() {
    let state = fixture();
    let first = exchange(&state, open_request("pdf", "application/pdf", PDF), 201);
    assert_eq!(
        exchange(&state, open_request("pdf", "application/pdf", PDF), 201),
        first
    );
    let conflict = exchange(&state, open_request("image", "image/png", IMAGE), 409);
    assert_eq!(conflict["error"]["code"], "idempotency_conflict");
    let id = first["ingestionId"].as_str().unwrap();
    let chunk = exchange(&state, chunk_request(id, 0, 0, PDF.len(), PDF), 200);
    assert_eq!(
        exchange(&state, chunk_request(id, 0, 0, PDF.len(), PDF), 200),
        chunk
    );
    let ready = exchange(&state, finalize_request(id, PDF), 200);
    assert_eq!(exchange(&state, finalize_request(id, PDF), 200), ready);
    let capture = exchange(&state, start_request(id, "host"), 202);
    assert_eq!(exchange(&state, start_request(id, "host"), 202), capture);
    assert_eq!(
        exchange(&state, start_request(id, "runtime"), 409)["error"]["code"],
        "idempotency_conflict"
    );
}

#[test]
fn invalid_uploads_do_not_advance_or_finalize_the_ingestion() {
    let state = fixture();
    let opened = exchange(&state, open_request("pdf", "application/pdf", PDF), 201);
    let id = opened["ingestionId"].as_str().unwrap();
    exchange(&state, start_request(id, "host"), 409);
    let cases = [
        (
            chunk_request(id, 1, 0, PDF.len(), PDF),
            "chunk_out_of_order",
        ),
        (
            chunk_request(id, 0, 0, PDF.len() + 1, PDF),
            "chunk_total_conflict",
        ),
        (
            {
                let mut request = chunk_request(id, 0, 0, PDF.len(), PDF);
                request.body[0] ^= 1;
                request
            },
            "chunk_checksum_mismatch",
        ),
    ];
    for (request, code) in cases {
        assert_eq!(exchange(&state, request, 409)["error"]["code"], code);
    }
    let mut short = chunk_request(id, 0, 0, PDF.len(), PDF);
    short.body.pop();
    assert_eq!(
        exchange(&state, short, 422)["error"]["code"],
        "chunk_length_mismatch"
    );
    exchange(&state, finalize_request(id, PDF), 409);
    assert_eq!(get(&state, &format!("/v2/ingestions/{id}"), 200), opened);
    exchange(&state, chunk_request(id, 0, 0, PDF.len(), PDF), 200);
    let mut different = PDF.to_vec();
    different[0] ^= 1;
    assert_eq!(
        exchange(&state, chunk_request(id, 0, 0, PDF.len(), &different), 409)["error"]["code"],
        "chunk_conflict"
    );
    exchange(&state, finalize_request(id, &different), 409);
    assert_eq!(
        get(&state, &format!("/v2/ingestions/{id}"), 200)["status"],
        "open"
    );
    exchange(&state, finalize_request(id, PDF), 200);
    assert_eq!(
        exchange(&state, chunk_request(id, 0, 0, PDF.len(), PDF), 409)["error"]["code"],
        "chunk_rejected"
    );
}

#[test]
fn document_idempotency_headers_must_match_and_abandoned_uploads_can_be_deleted() {
    let state = fixture();
    let mut missing = open_request("pdf", "application/pdf", PDF);
    missing.headers.remove("x-idempotency-key");
    exchange(&state, missing, 422);
    let mut mismatch = open_request("pdf", "application/pdf", PDF);
    mismatch
        .headers
        .insert("x-idempotency-key".into(), "another-request".into());
    exchange(&state, mismatch, 409);
    let opened = exchange(&state, open_request("pdf", "application/pdf", PDF), 201);
    let id = opened["ingestionId"].as_str().unwrap();
    exchange(
        &state,
        json_request("DELETE", &format!("/v2/ingestions/{id}"), None, Value::Null),
        204,
    );
    get(&state, &format!("/v2/ingestions/{id}"), 404);
    exchange(&state, finalize_request(id, PDF), 404);
    exchange(&state, start_request(id, "host"), 404);
    exchange(&state, open_request("pdf", "application/pdf", PDF), 201);
}

#[test]
fn pdf_page_selection_preserves_source_page_locators() {
    let state = fixture();
    let id = upload(&state, "pdf", "application/pdf", PDF);
    let mut start = start_request(&id, "host");
    let mut payload: Value = serde_json::from_slice(&start.body).unwrap();
    payload["pdfPageNumbers"] = json!([2]);
    start.body = serde_json::to_vec(&payload).unwrap();
    let capture = exchange(&state, start, 202);
    let path = format!("/v2/captures/{}", capture["captureId"].as_str().unwrap());
    let raw = get(&state, &format!("{path}/raw"), 200);
    assert_eq!(raw["segments"][0]["order"], 0);
    assert_eq!(raw["segments"][0]["locator"]["page"], 2);
    assert_eq!(raw["sourceText"], "Installed PDF page two");
    assert_eq!(
        get(&state, &format!("{path}/ocr"), 200)["pages"][0]["page"],
        2
    );
}

#[test]
fn progressive_audio_host_requests_complete_with_events_partial_and_result() {
    let state = fixture();
    let mut open = open_request("audio", "audio/wav", AUDIO);
    open.headers.remove("x-idempotency-key");
    let mut payload: Value = serde_json::from_slice(&open.body).unwrap();
    payload.as_object_mut().unwrap().remove("protocolVersion");
    open.body = serde_json::to_vec(&payload).unwrap();
    let opened = exchange(&state, open, 201);
    let id = opened["ingestionId"].as_str().unwrap();
    exchange(&state, chunk_request(id, 0, 0, AUDIO.len(), AUDIO), 200);
    exchange(&state, finalize_request(id, AUDIO), 200);
    let capture = exchange(
        &state,
        json_request(
            "POST",
            "/v2/captures",
            None,
            json!({
                "clientRequestId": REQUEST_ID, "ingestionId": id,
                "structuringMode": "runtime", "startPolicy": "eager", "identifySpeakers": false,
            }),
        ),
        202,
    );
    let path = format!("/v2/captures/{}", capture["captureId"].as_str().unwrap());
    let (status, headers, events) = wire_exchange(
        &state,
        json_request("GET", &format!("{path}/events"), None, Value::Null),
    );
    assert_eq!(status, 200);
    assert!(headers.contains("Content-Type: text/event-stream"));
    let events = String::from_utf8(events).unwrap();
    let event: Value = serde_json::from_str(
        events
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(event["eventType"], "completed");
    let mut replay = json_request("GET", &format!("{path}/events"), None, Value::Null);
    replay.headers.insert("last-event-id".into(), "1".into());
    assert!(wire_exchange(&state, replay).2.is_empty());
    let partial = get(&state, &format!("{path}/partial"), 200);
    assert_eq!(partial["segments"].as_array().unwrap().len(), 2);
    assert_eq!(partial["segments"][0]["locator"]["kind"], "time");
    assert_eq!(get(&state, &path, 200)["status"], "completed");
    assert_eq!(
        get(&state, &format!("{path}/result"), 200)["result"]["targetText"],
        "Installed audio one\nInstalled audio two"
    );
    exchange(
        &state,
        json_request("DELETE", &path, None, Value::Null),
        204,
    );
}

#[test]
fn desktop_pdf_ingestion_opens_with_the_host_request() {
    let state = fixture();
    let request_id = "e9bdf91d-32db-4a21-846d-a8d7ee669559-ingestion";
    let (status, body) = state
        .route(json_request(
            "POST",
            "/v2/ingestions",
            Some(request_id),
            json!({
                "protocolVersion": "2",
                "clientRequestId": request_id,
                "kind": "pdf",
                "mode": "file",
                "fileName": "installed-fixture.pdf",
                "mediaType": "application/pdf",
                "totalBytes": 64,
            }),
        ))
        .into_parts();
    assert_eq!(status, 201, "PDF ingestion must be accepted");
    assert_eq!(body["status"], "open");
    assert_eq!(body["receivedBytes"], 0);
}

#[test]
fn uninstall_requirement_returns_installable_and_rejects_an_unknown_id() {
    let state = fixture();
    let before = get(&state, "/v2/runtime/requirements", 200);
    let installed = before["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["requirementId"] == "windowsml-ocr")
        .unwrap()
        .clone();
    assert_eq!(installed["status"], "ready");

    let remove = json_request(
        "DELETE",
        "/v2/runtime/requirements/windowsml-ocr/installation",
        None,
        Value::Null,
    );
    let removed = exchange(&state, remove, 200);
    let mut expected = installed;
    expected["status"] = json!("installable");
    assert_eq!(removed, expected);

    let repeated = exchange(
        &state,
        json_request(
            "DELETE",
            "/v2/runtime/requirements/windowsml-ocr/installation",
            None,
            Value::Null,
        ),
        200,
    );
    assert_eq!(repeated, removed);

    let after = get(&state, "/v2/runtime/requirements", 200);
    let items = after["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .find(|item| item["requirementId"] == "windowsml-ocr")
            .unwrap()["status"],
        "installable"
    );
    assert_eq!(
        items
            .iter()
            .find(|item| item["requirementId"] == "speech-recognition")
            .unwrap()["status"],
        "ready"
    );

    let unknown = exchange(
        &state,
        json_request(
            "DELETE",
            "/v2/runtime/requirements/no-such-engine/installation",
            None,
            Value::Null,
        ),
        404,
    );
    assert_eq!(unknown["error"]["code"], "requirement_not_found");
    assert_eq!(
        unknown["error"]["message"],
        "Runtime requirement was not found."
    );
}
