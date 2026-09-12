use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fmt,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

#[cfg(test)]
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value};

const JOURNAL_SCHEMA: &str = "RuntimeSessionJournalV1";
const JOURNAL_PRODUCER: &str = "capture-runtime";
const HOST: &str = "127.0.0.1";
const JOURNAL_ENV: &str = "CAPTURE_TEST_JOURNAL_PATH";
const MARKER_ENV: &str = "CAPTURE_TEST_MARKER_PATH";
const SESSION_ENV: &str = "CAPTURE_TEST_SESSION_NONCE";
const ORDINAL_ENV: &str = "CAPTURE_TEST_ROOT_ORDINAL";
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const MARKER_RETRY: Duration = Duration::from_millis(10);
const MARKER_TIMEOUT: Duration = Duration::from_secs(2);
const HOLD_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeError {
    Invocation,
    Environment,
    JournalRead,
    JournalRejected,
    MarkerWrite,
}

impl fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Invocation => "activation probe invocation was invalid",
            Self::Environment => "activation probe environment was invalid",
            Self::JournalRead => "activation probe journal could not be read",
            Self::JournalRejected => "activation probe journal was rejected",
            Self::MarkerWrite => "activation probe marker could not be written",
        };
        formatter.write_str(message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbeConfig {
    journal_path: PathBuf,
    marker_path: PathBuf,
    session_nonce: String,
    root_ordinal: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchingRecord {
    journal_revision: u64,
}

fn main() {
    let result = run_probe(parse_config(env::args_os().skip(1)), std::process::id());
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(2);
    }
    thread::sleep(HOLD_TIMEOUT);
}

fn run_probe(config: Result<ProbeConfig, ProbeError>, process_id: u32) -> Result<(), ProbeError> {
    let config = config?;
    let record = read_launching_record(&config, process_id)?;
    write_marker(&config, process_id, &record)
}

fn parse_config<I>(arguments: I) -> Result<ProbeConfig, ProbeError>
where
    I: IntoIterator<Item = OsString>,
{
    let arguments: Vec<_> = arguments.into_iter().collect();
    if arguments.len() != 5
        || arguments[0] != "serve"
        || arguments[1] != "--host"
        || arguments[2] != HOST
        || arguments[3] != "--port"
    {
        return Err(ProbeError::Invocation);
    }
    let port_text = arguments[4].to_str().ok_or(ProbeError::Invocation)?;
    let port = port_text
        .parse::<u16>()
        .map_err(|_| ProbeError::Invocation)?;
    if port == 0 || port_text != port.to_string() {
        return Err(ProbeError::Invocation);
    }

    let journal_path = required_path(JOURNAL_ENV)?;
    let marker_path = required_path(MARKER_ENV)?;
    if journal_path == marker_path || !journal_path.is_absolute() || !marker_path.is_absolute() {
        return Err(ProbeError::Environment);
    }
    let session_nonce = required_text(SESSION_ENV)?;
    if !valid_opaque(&session_nonce) {
        return Err(ProbeError::Environment);
    }
    let ordinal_text = required_text(ORDINAL_ENV)?;
    let root_ordinal = ordinal_text
        .parse::<u32>()
        .map_err(|_| ProbeError::Environment)?;
    if ordinal_text != root_ordinal.to_string() {
        return Err(ProbeError::Environment);
    }
    Ok(ProbeConfig {
        journal_path,
        marker_path,
        session_nonce,
        root_ordinal,
    })
}

fn required_path(name: &str) -> Result<PathBuf, ProbeError> {
    let value = env::var_os(name).ok_or(ProbeError::Environment)?;
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty()
        || path.as_os_str().to_str().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(ProbeError::Environment);
    }
    Ok(path)
}

fn required_text(name: &str) -> Result<String, ProbeError> {
    let value = env::var_os(name).ok_or(ProbeError::Environment)?;
    let value = value.to_str().ok_or(ProbeError::Environment)?.to_owned();
    if value.is_empty() {
        return Err(ProbeError::Environment);
    }
    Ok(value)
}

fn read_launching_record(
    config: &ProbeConfig,
    process_id: u32,
) -> Result<LaunchingRecord, ProbeError> {
    let bytes = read_bounded(&config.journal_path)?;
    let journal: Value = serde_json::from_slice(&bytes).map_err(|_| ProbeError::JournalRejected)?;
    validate_journal(&journal, config, process_id)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, ProbeError> {
    let file = File::open(path).map_err(|_| ProbeError::JournalRead)?;
    let size = file.metadata().map_err(|_| ProbeError::JournalRead)?.len();
    if size > MAX_JOURNAL_BYTES {
        return Err(ProbeError::JournalRejected);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProbeError::JournalRead)?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(ProbeError::JournalRejected);
    }
    Ok(bytes)
}

fn validate_journal(
    journal: &Value,
    config: &ProbeConfig,
    process_id: u32,
) -> Result<LaunchingRecord, ProbeError> {
    let root = exact_object(
        journal,
        &[
            "schemaVersion",
            "producer",
            "sessionNonce",
            "journalRevision",
            "planDigest",
            "state",
            "createdAt",
            "updatedAt",
            "jobBinding",
            "binding",
            "stagingBinding",
            "roots",
            "proof",
            "recoveryEpoch",
            "attempt",
        ],
    )?;
    if string_field(root, "schemaVersion")? != JOURNAL_SCHEMA
        || string_field(root, "producer")? != JOURNAL_PRODUCER
        || string_field(root, "sessionNonce")? != config.session_nonce
        || string_field(root, "state")? != "launching"
        || !valid_opaque(string_field(root, "sessionNonce")?)
        || !valid_digest(string_field(root, "planDigest")?)
        || string_field(root, "createdAt")?.is_empty()
        || string_field(root, "updatedAt")?.is_empty()
        || !root["proof"].is_null()
        || number_field(root, "journalRevision")? == 0
        || number_field(root, "attempt")? > 3
    {
        return Err(ProbeError::JournalRejected);
    }
    let journal_revision = number_field(root, "journalRevision")?;
    validate_job_binding(root.get("jobBinding"))?;
    validate_binding(root.get("binding"), root.get("roots"))?;
    validate_staging_binding(root.get("stagingBinding"), &config.session_nonce)?;
    let roots = root
        .get("roots")
        .and_then(Value::as_array)
        .ok_or(ProbeError::JournalRejected)?;
    if roots.is_empty() || config.root_ordinal as usize >= roots.len() {
        return Err(ProbeError::JournalRejected);
    }
    let mut seen_nonces = HashSet::with_capacity(roots.len());
    let mut seen_listeners = HashSet::with_capacity(roots.len());
    let mut selected_pid = None;
    for (index, value) in roots.iter().enumerate() {
        let root = exact_object(
            value,
            &[
                "ordinal",
                "role",
                "rootRefDigest",
                "rootGeneration",
                "rootNonce",
                "pid",
                "creationIdentity",
                "state",
                "reservedListenerIdentity",
                "loopbackPort",
                "liveListenerReadiness",
                "startedAt",
            ],
        )?;
        if number_field(root, "ordinal")? != index as u64
            || string_field(root, "role")?.is_empty()
            || !valid_digest(string_field(root, "rootRefDigest")?)
            || number_field(root, "rootGeneration")? == 0
            || !valid_opaque(string_field(root, "rootNonce")?)
            || number_field(root, "pid")? == 0
            || string_field(root, "state")? != "suspended"
            || !root["liveListenerReadiness"].is_null()
            || !valid_opaque(string_field(root, "reservedListenerIdentity")?)
            || number_field(root, "loopbackPort")? == 0
            || string_field(root, "startedAt")?.is_empty()
            || !seen_nonces.insert(string_field(root, "rootNonce")?)
            || !seen_listeners.insert(string_field(root, "reservedListenerIdentity")?)
        {
            return Err(ProbeError::JournalRejected);
        }
        validate_creation_identity(root.get("creationIdentity"))?;
        if index == config.root_ordinal as usize {
            selected_pid = Some(number_field(root, "pid")?);
        }
    }
    if selected_pid != Some(u64::from(process_id)) {
        return Err(ProbeError::JournalRejected);
    }
    Ok(LaunchingRecord { journal_revision })
}

fn validate_job_binding(value: Option<&Value>) -> Result<(), ProbeError> {
    let binding = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &["setupState", "jobNonce"],
    )?;
    if string_field(binding, "setupState")? != "committed"
        || !valid_opaque(string_field(binding, "jobNonce")?)
    {
        return Err(ProbeError::JournalRejected);
    }
    Ok(())
}

fn validate_binding(value: Option<&Value>, roots: Option<&Value>) -> Result<(), ProbeError> {
    let binding = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &[
            "kind",
            "bindingAttemptId",
            "groupRefDigest",
            "groupGeneration",
            "rootBindings",
            "activationReceiptDigest",
        ],
    )?;
    if string_field(binding, "kind")? != "bound"
        || !valid_opaque(string_field(binding, "bindingAttemptId")?)
        || !valid_digest(string_field(binding, "groupRefDigest")?)
        || number_field(binding, "groupGeneration")? == 0
        || !valid_digest(string_field(binding, "activationReceiptDigest")?)
    {
        return Err(ProbeError::JournalRejected);
    }
    let root_bindings = binding
        .get("rootBindings")
        .and_then(Value::as_array)
        .ok_or(ProbeError::JournalRejected)?;
    let roots = roots
        .and_then(Value::as_array)
        .ok_or(ProbeError::JournalRejected)?;
    if root_bindings.is_empty() || root_bindings.len() != roots.len() {
        return Err(ProbeError::JournalRejected);
    }
    for (index, (binding, root)) in root_bindings.iter().zip(roots).enumerate() {
        let binding = exact_object(
            binding,
            &[
                "ordinal",
                "role",
                "rootRefDigest",
                "rootGeneration",
                "specDigest",
                "reservedListenerIdentity",
            ],
        )?;
        let root = root.as_object().ok_or(ProbeError::JournalRejected)?;
        if number_field(binding, "ordinal")? != index as u64
            || number_field(root, "ordinal")? != index as u64
            || string_field(binding, "role")? != string_field(root, "role")?
            || string_field(binding, "rootRefDigest")? != string_field(root, "rootRefDigest")?
            || number_field(binding, "rootGeneration")? != number_field(root, "rootGeneration")?
            || !valid_digest(string_field(binding, "specDigest")?)
            || string_field(binding, "reservedListenerIdentity")?
                != string_field(root, "reservedListenerIdentity")?
        {
            return Err(ProbeError::JournalRejected);
        }
    }
    Ok(())
}

fn validate_staging_binding(value: Option<&Value>, session_nonce: &str) -> Result<(), ProbeError> {
    let binding = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &["runNonce", "rootDigest", "scope"],
    )?;
    if string_field(binding, "runNonce")? != session_nonce
        || !valid_digest(string_field(binding, "rootDigest")?)
        || string_field(binding, "scope")? != "run"
    {
        return Err(ProbeError::JournalRejected);
    }
    Ok(())
}

fn validate_creation_identity(value: Option<&Value>) -> Result<(), ProbeError> {
    let identity = exact_object(
        value.ok_or(ProbeError::JournalRejected)?,
        &["kind", "value"],
    )?;
    if string_field(identity, "kind")?.is_empty() || string_field(identity, "value")?.is_empty() {
        return Err(ProbeError::JournalRejected);
    }
    Ok(())
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, ProbeError> {
    let object = value.as_object().ok_or(ProbeError::JournalRejected)?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(ProbeError::JournalRejected);
    }
    Ok(object)
}

fn string_field<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str, ProbeError> {
    object
        .get(name)
        .and_then(Value::as_str)
        .ok_or(ProbeError::JournalRejected)
}

fn number_field(object: &Map<String, Value>, name: &str) -> Result<u64, ProbeError> {
    object
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(ProbeError::JournalRejected)
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn write_marker(
    config: &ProbeConfig,
    process_id: u32,
    record: &LaunchingRecord,
) -> Result<(), ProbeError> {
    let marker = format!(
        "state=launching\nordinal={}\npid={process_id}\njournalRevision={}\n",
        config.root_ordinal, record.journal_revision
    );
    let deadline = Instant::now() + MARKER_TIMEOUT;
    loop {
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&config.marker_path)
        {
            Ok(mut file) => {
                file.write_all(marker.as_bytes())
                    .and_then(|_| file.flush())
                    .and_then(|_| file.sync_all())
                    .map_err(|_| ProbeError::MarkerWrite)?;
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(ProbeError::MarkerWrite);
            }
            Err(_) if Instant::now() < deadline => thread::sleep(MARKER_RETRY),
            Err(_) => return Err(ProbeError::MarkerWrite),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(directory: &Path, session: &str, ordinal: u32) -> ProbeConfig {
        ProbeConfig {
            journal_path: directory.join("runtime-session.json"),
            marker_path: directory.join(format!("marker-{ordinal}.txt")),
            session_nonce: session.into(),
            root_ordinal: ordinal,
        }
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn tempdir() -> TestDirectory {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = env::temp_dir().join(format!(
            "capture-activation-probe-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("temporary fixture directory");
        TestDirectory { path }
    }

    fn valid_journal(session: &str, pid: u32, root_count: usize) -> Value {
        let roots = (0..root_count)
            .map(|ordinal| {
                json!({
                    "ordinal": ordinal,
                    "role": if ordinal == 0 { "capture" } else { "worker" },
                    "rootRefDigest": format!("{ordinal:064x}"),
                    "rootGeneration": ordinal + 1,
                    "rootNonce": format!("root-{ordinal}"),
                    "pid": if ordinal == 0 { pid } else { pid.saturating_add(1 + ordinal as u32) },
                    "creationIdentity": { "kind": "windows-process-creation", "value": format!("{ordinal:016x}") },
                    "state": "suspended",
                    "reservedListenerIdentity": format!("listener-{ordinal}"),
                    "loopbackPort": 49152 + ordinal,
                    "liveListenerReadiness": null,
                    "startedAt": "2026-09-12T00:00:00Z"
                })
            })
            .collect::<Vec<_>>();
        let root_bindings = roots
            .iter()
            .map(|root| {
                json!({
                    "ordinal": root["ordinal"],
                    "role": root["role"],
                    "rootRefDigest": root["rootRefDigest"],
                    "rootGeneration": root["rootGeneration"],
                    "specDigest": format!("{}", "a".repeat(64)),
                    "reservedListenerIdentity": root["reservedListenerIdentity"]
                })
            })
            .collect::<Vec<_>>();
        json!({
            "schemaVersion": JOURNAL_SCHEMA,
            "producer": JOURNAL_PRODUCER,
            "sessionNonce": session,
            "journalRevision": 3,
            "planDigest": "b".repeat(64),
            "state": "launching",
            "createdAt": "2026-09-12T00:00:00Z",
            "updatedAt": "2026-09-12T00:00:00Z",
            "jobBinding": { "setupState": "committed", "jobNonce": "job-1" },
            "binding": {
                "kind": "bound",
                "bindingAttemptId": "attempt-1",
                "groupRefDigest": "c".repeat(64),
                "groupGeneration": 1,
                "rootBindings": root_bindings,
                "activationReceiptDigest": "d".repeat(64)
            },
            "stagingBinding": { "runNonce": session, "rootDigest": "e".repeat(64), "scope": "run" },
            "roots": roots,
            "proof": null,
            "recoveryEpoch": 0,
            "attempt": 0
        })
    }

    fn write_configured_journal(config: &ProbeConfig, journal: &Value) {
        fs::write(
            &config.journal_path,
            serde_json::to_vec(journal).expect("journal JSON"),
        )
        .expect("journal");
    }

    fn run_with(config: &ProbeConfig, process_id: u32) -> Result<(), ProbeError> {
        run_probe(Ok(config.clone()), process_id)
    }

    #[test]
    fn launching_with_own_pid_writes_minimal_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        write_configured_journal(
            &config,
            &valid_journal(&config.session_nonce, std::process::id(), 1),
        );
        run_with(&config, std::process::id()).expect("valid Launching record");
        let marker = fs::read_to_string(&config.marker_path).expect("marker");
        assert_eq!(
            marker,
            format!(
                "state=launching\nordinal=0\npid={}\njournalRevision=3\n",
                std::process::id()
            )
        );
    }

    #[test]
    fn ready_state_is_rejected_without_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        let mut journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        journal["state"] = json!("ready");
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn malformed_and_unknown_journal_are_rejected_without_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        fs::write(&config.journal_path, b"not-json").expect("malformed journal");
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        let mut journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        journal["unexpected"] = json!(true);
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn wrong_session_root_and_pid_are_rejected_without_marker() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        let mut journal = valid_journal("other-session", std::process::id(), 1);
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        journal = valid_journal(&config.session_nonce, std::process::id(), 1);
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(
                &ProbeConfig {
                    root_ordinal: 1,
                    ..config.clone()
                },
                std::process::id()
            ),
            Err(ProbeError::JournalRejected)
        );
        journal["roots"][0]["pid"] = json!(std::process::id().saturating_add(1));
        write_configured_journal(&config, &journal);
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::JournalRejected)
        );
        assert!(!config.marker_path.exists());
    }

    #[test]
    fn marker_collision_never_overwrites_existing_bytes() {
        let directory = tempdir();
        let config = config(&directory.path, "session-1", 0);
        write_configured_journal(
            &config,
            &valid_journal(&config.session_nonce, std::process::id(), 1),
        );
        fs::write(&config.marker_path, b"foreign").expect("foreign marker");
        assert_eq!(
            run_with(&config, std::process::id()),
            Err(ProbeError::MarkerWrite)
        );
        assert_eq!(fs::read(&config.marker_path).expect("marker"), b"foreign");
    }

    #[test]
    fn invocation_requires_the_exact_serve_host_port_shape() {
        assert_eq!(
            parse_config(
                ["serve", "--host", "localhost", "--port", "49152"]
                    .into_iter()
                    .map(OsString::from),
            ),
            Err(ProbeError::Invocation)
        );
        assert_eq!(
            parse_config(
                ["serve", "--host", HOST, "--port", "0"]
                    .into_iter()
                    .map(OsString::from),
            ),
            Err(ProbeError::Invocation)
        );
    }
}
