#![cfg(windows)]

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use capture_sidecar_launcher::{
    build_immutable_group_plan, CompleteGroupBinding, CompleteGroupBindingReceiptV1,
    GroupRootPlanInput, ImmutableGroupPlan, OwnedRuntimeSession, PersistError, PrepareError,
    ReconcileRefSink, SidecarLaunchSpec, SidecarManifest, VerifiedGroupBinding,
};
use sha2::{Digest, Sha256};

const SCHEMA_FILE_NAME: &str = "capture-document-v2.schema.json";
const SCHEMA_SHA256: &str = "850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335";

struct RecordingSink {
    binding: Mutex<Option<Vec<u8>>>,
}

impl RecordingSink {
    fn new() -> Self {
        Self {
            binding: Mutex::new(None),
        }
    }

    fn binding(&self) -> CompleteGroupBinding {
        let bytes = self
            .binding
            .lock()
            .expect("sink lock")
            .clone()
            .expect("binding persisted");
        CompleteGroupBinding::decode(&bytes).expect("persisted binding")
    }
}

impl ReconcileRefSink for RecordingSink {
    fn persist(
        &self,
        _binding_attempt_id: &capture_sidecar_launcher::BindingAttemptId,
        binding: &CompleteGroupBinding,
    ) -> Result<(), PersistError> {
        *self.binding.lock().expect("sink lock") = Some(binding.encode()?);
        Ok(())
    }

    fn read_back(
        &self,
        _binding_attempt_id: &capture_sidecar_launcher::BindingAttemptId,
    ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
        let bytes = self
            .binding
            .lock()
            .expect("sink lock")
            .clone()
            .ok_or(PersistError::Storage)?;
        let binding = CompleteGroupBinding::decode(&bytes)?;
        CompleteGroupBindingReceiptV1::from_binding(binding)
    }

    fn verify(
        &self,
        _binding_attempt_id: &capture_sidecar_launcher::BindingAttemptId,
        expected: &CompleteGroupBinding,
        read_back: &CompleteGroupBindingReceiptV1,
    ) -> Result<VerifiedGroupBinding, PersistError> {
        if read_back.binding() != expected {
            return Err(PersistError::Rejected);
        }
        VerifiedGroupBinding::from_receipt(read_back.clone())
    }
}

struct RejectingSink;

impl RejectingSink {
    fn new() -> Self {
        Self
    }
}

impl ReconcileRefSink for RejectingSink {
    fn persist(
        &self,
        _binding_attempt_id: &capture_sidecar_launcher::BindingAttemptId,
        _binding: &CompleteGroupBinding,
    ) -> Result<(), PersistError> {
        Err(PersistError::Rejected)
    }

    fn read_back(
        &self,
        _binding_attempt_id: &capture_sidecar_launcher::BindingAttemptId,
    ) -> Result<CompleteGroupBindingReceiptV1, PersistError> {
        Err(PersistError::Storage)
    }

    fn verify(
        &self,
        _binding_attempt_id: &capture_sidecar_launcher::BindingAttemptId,
        _expected: &CompleteGroupBinding,
        _read_back: &CompleteGroupBindingReceiptV1,
    ) -> Result<VerifiedGroupBinding, PersistError> {
        Err(PersistError::Rejected)
    }
}

fn write_asset(directory: &Path, executable_path: &Path) -> PathBuf {
    fs::create_dir_all(directory).expect("asset directory");
    let executable = fs::read(executable_path).expect("test executable");
    let mut hasher = Sha256::new();
    hasher.update(&executable);
    let executable_sha256 = format!("{:x}", hasher.finalize());
    let file_name = executable_path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("test executable name")
        .to_owned();
    let manifest = SidecarManifest {
        manifest_version: "1".into(),
        runtime_version: "0.4.2".into(),
        api_version: "2.0".into(),
        capture_document_schema_version: "2".into(),
        platform: "windows".into(),
        arch: "x86_64".into(),
        file_name,
        bytes: executable.len() as u64,
        sha256: executable_sha256,
        schema_file_name: SCHEMA_FILE_NAME.into(),
        schema_sha256: SCHEMA_SHA256.into(),
    };
    fs::write(
        directory.join(SCHEMA_FILE_NAME),
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../capture-runtime-client-python/src/capture_runtime_client/private/schemas/capture-document.schema.json"
        )),
    )
    .expect("canonical schema");
    let manifest_path = directory.join("capture-runtime-manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest).expect("manifest JSON"),
    )
    .expect("manifest");
    manifest_path
}

fn public_root_input(
    executable_path: &Path,
    manifest_path: &Path,
    port: u16,
    role: &str,
    generation: u64,
) -> GroupRootPlanInput {
    let token = format!("{}-{}", role, "e".repeat(64 - role.len() - 1));
    GroupRootPlanInput::new(
        role.to_owned(),
        generation,
        SidecarLaunchSpec::new(
            executable_path.to_path_buf(),
            port,
            token.clone(),
            vec![("CAPTURE_API_TOKEN".into(), token)],
            Vec::new(),
        ),
        manifest_path.to_path_buf(),
    )
}

fn assert_no_producer_entries(producer_root: &Path) {
    assert!(
        fs::read_dir(producer_root)
            .expect("producer root")
            .next()
            .is_none(),
        "invalid public plan must not create producer records"
    );
}

fn public_plan(producer_root: &Path, asset_directory: &Path) -> (ImmutableGroupPlan, String) {
    let executable_path = std::env::current_exe().expect("current executable");
    let manifest_path = write_asset(asset_directory, &executable_path);
    let token = "a".repeat(64);
    let mut marker_digest = Sha256::new();
    marker_digest.update(asset_directory.as_os_str().as_encoded_bytes());
    let marker_name = format!(
        "CAPTURE_PUBLIC_FROZEN_MARKER_{}",
        &format!("{:x}", marker_digest.finalize())[..16]
    );
    std::env::set_var(&marker_name, "before");
    let spec = SidecarLaunchSpec::new(
        executable_path,
        43_127,
        token.clone(),
        vec![("CAPTURE_API_TOKEN".into(), token)],
        vec![marker_name.clone()],
    );
    let plan = build_immutable_group_plan(
        producer_root.to_path_buf(),
        7,
        vec![GroupRootPlanInput::new(
            "capture".into(),
            1,
            spec,
            manifest_path,
        )],
    )
    .expect("public producer plan");
    (plan, marker_name)
}

fn journal_has_state(producer_root: &Path, state: &str) -> bool {
    fs::read_dir(producer_root)
        .expect("producer root")
        .filter_map(Result::ok)
        .filter_map(|entry| {
            (entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
                .then(|| fs::read(entry.path()).ok())
                .flatten()
        })
        .any(|bytes| {
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                return false;
            };
            value
                .get("schemaVersion")
                .and_then(serde_json::Value::as_str)
                == Some("RuntimeSessionJournalV1")
                && value.get("state").and_then(serde_json::Value::as_str) == Some(state)
        })
}

#[test]
fn public_builder_freezes_inputs_and_prepare_persists_bound_state() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let asset_directory = directory.path().join("asset");
    let (plan, marker_name) = public_plan(&producer_root, &asset_directory);

    std::env::set_var(&marker_name, "after");
    let sink = RecordingSink::new();
    let prepared = OwnedRuntimeSession::prepare_group(&plan, &sink).expect("public prepare");
    drop(prepared);

    assert!(journal_has_state(&producer_root, "prepared_bound"));
    assert!(!producer_root.join("private-run-staging").exists());
    std::env::remove_var(marker_name);
}

#[test]
fn public_sink_failure_leaves_durable_planned_unbound_without_staging() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let (plan, marker_name) = public_plan(&producer_root, &directory.path().join("asset"));

    let error = match OwnedRuntimeSession::prepare_group(&plan, &RejectingSink::new()) {
        Ok(prepared) => {
            drop(prepared);
            panic!("rejecting sink must fail prepare");
        }
        Err(error) => error,
    };
    assert_eq!(error, PrepareError::Binding(PersistError::Rejected));
    assert!(journal_has_state(&producer_root, "planned_unbound"));
    assert!(!journal_has_state(&producer_root, "prepared_bound"));
    assert!(!producer_root.join("private-run-staging").exists());
    assert!(!format!("{error:?}").contains("CAPTURE_PUBLIC_FROZEN_MARKER"));
    std::env::remove_var(marker_name);
}

#[test]
fn public_builder_rejects_invalid_manifest_before_durable_prepare() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let asset_directory = directory.path().join("asset");
    let executable_path = std::env::current_exe().expect("current executable");
    let manifest_path = write_asset(&asset_directory, &executable_path);
    let mut manifest: SidecarManifest =
        serde_json::from_slice(&fs::read(&manifest_path).expect("manifest bytes"))
            .expect("manifest");
    manifest.sha256 = "b".repeat(64);
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest).expect("invalid manifest JSON"),
    )
    .expect("tampered manifest");
    let token = "b".repeat(64);
    let error = match build_immutable_group_plan(
        producer_root.clone(),
        7,
        vec![GroupRootPlanInput::new(
            "capture".into(),
            1,
            SidecarLaunchSpec::new(
                executable_path,
                43_127,
                token.clone(),
                vec![("CAPTURE_API_TOKEN".into(), token)],
                Vec::new(),
            ),
            manifest_path,
        )],
    ) {
        Ok(plan) => {
            drop(plan);
            panic!("tampered artifact must fail closed");
        }
        Err(error) => error,
    };
    assert_eq!(error, PrepareError::InvalidPlan);
    assert!(!producer_root.join("private-run-staging").exists());
    assert!(!format!("{error:?}").contains("b".repeat(64).as_str()));
    assert!(fs::read_dir(producer_root)
        .expect("producer root")
        .next()
        .is_none());
}

#[test]
fn public_builder_rejects_tampered_schema_before_durable_prepare() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let asset_directory = directory.path().join("asset");
    let executable_path = std::env::current_exe().expect("current executable");
    let manifest_path = write_asset(&asset_directory, &executable_path);
    fs::write(asset_directory.join(SCHEMA_FILE_NAME), b"foreign schema").expect("tampered schema");
    let token = "c".repeat(64);
    let error = match build_immutable_group_plan(
        producer_root.clone(),
        7,
        vec![GroupRootPlanInput::new(
            "capture".into(),
            1,
            SidecarLaunchSpec::new(
                executable_path,
                43_127,
                token.clone(),
                vec![("CAPTURE_API_TOKEN".into(), token)],
                Vec::new(),
            ),
            manifest_path,
        )],
    ) {
        Ok(plan) => {
            drop(plan);
            panic!("tampered schema must fail closed");
        }
        Err(error) => error,
    };
    assert_eq!(error, PrepareError::InvalidPlan);
    assert!(!format!("{error:?}").contains("foreign schema"));
    assert!(fs::read_dir(producer_root)
        .expect("producer root")
        .next()
        .is_none());
}

#[test]
fn public_builder_rejects_missing_executable_before_durable_prepare() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let asset_directory = directory.path().join("asset");
    let current_executable = std::env::current_exe().expect("current executable");
    let manifest_path = write_asset(&asset_directory, &current_executable);
    let missing_executable = asset_directory.join("missing-capture-runtime.exe");
    let mut manifest: SidecarManifest =
        serde_json::from_slice(&fs::read(&manifest_path).expect("manifest bytes"))
            .expect("manifest");
    manifest.file_name = "missing-capture-runtime.exe".into();
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest).expect("manifest JSON"),
    )
    .expect("manifest");
    let token = "d".repeat(64);
    let error = match build_immutable_group_plan(
        producer_root.clone(),
        7,
        vec![GroupRootPlanInput::new(
            "capture".into(),
            1,
            SidecarLaunchSpec::new(
                missing_executable,
                43_127,
                token.clone(),
                vec![("CAPTURE_API_TOKEN".into(), token)],
                Vec::new(),
            ),
            manifest_path,
        )],
    ) {
        Ok(plan) => {
            drop(plan);
            panic!("missing executable must fail closed");
        }
        Err(error) => error,
    };
    assert_eq!(error, PrepareError::InvalidPlan);
    assert!(fs::read_dir(producer_root)
        .expect("producer root")
        .next()
        .is_none());
}

#[test]
fn public_builder_persists_complete_ordered_multi_root_binding() {
    let directory = tempfile::tempdir().expect("tempdir");
    let producer_root = directory.path().join("producer");
    fs::create_dir(&producer_root).expect("producer root");
    let executable_path = std::env::current_exe().expect("current executable");
    let manifest_path = write_asset(&directory.path().join("asset"), &executable_path);
    let plan = build_immutable_group_plan(
        producer_root.clone(),
        7,
        vec![
            public_root_input(&executable_path, &manifest_path, 43_127, "capture", 1),
            public_root_input(&executable_path, &manifest_path, 43_128, "worker", 2),
        ],
    )
    .expect("public two-root plan");

    let sink = RecordingSink::new();
    let prepared = OwnedRuntimeSession::prepare_group(&plan, &sink).expect("public prepare");
    drop(prepared);

    let binding = sink.binding();
    let roots = binding.root_bindings();
    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0].ordinal(), 0);
    assert_eq!(roots[1].ordinal(), 1);
    assert_eq!(roots[0].role(), "capture");
    assert_eq!(roots[1].role(), "worker");
    assert_eq!(roots[0].root_generation(), 1);
    assert_eq!(roots[1].root_generation(), 2);
    assert_ne!(roots[0].root_ref(), roots[1].root_ref());
    assert_ne!(roots[0].root_ref_digest(), roots[1].root_ref_digest());
    assert_ne!(
        roots[0].reserved_listener_identity(),
        roots[1].reserved_listener_identity()
    );
    assert!(journal_has_state(&producer_root, "prepared_bound"));
}

#[test]
fn public_builder_rejects_empty_zero_generation_and_duplicate_ports_without_files() {
    let executable_path = std::env::current_exe().expect("current executable");

    let empty_directory = tempfile::tempdir().expect("empty tempdir");
    let empty_producer = empty_directory.path().join("producer");
    fs::create_dir(&empty_producer).expect("empty producer root");
    let empty = build_immutable_group_plan(empty_producer.clone(), 7, Vec::new());
    assert!(matches!(empty, Err(PrepareError::InvalidPlan)));
    assert_no_producer_entries(&empty_producer);

    let zero_directory = tempfile::tempdir().expect("zero tempdir");
    let zero_producer = zero_directory.path().join("producer");
    fs::create_dir(&zero_producer).expect("zero producer root");
    let zero_manifest = write_asset(&zero_directory.path().join("asset"), &executable_path);
    let zero = build_immutable_group_plan(
        zero_producer.clone(),
        7,
        vec![public_root_input(
            &executable_path,
            &zero_manifest,
            43_127,
            "capture",
            0,
        )],
    );
    assert!(matches!(zero, Err(PrepareError::InvalidPlan)));
    assert_no_producer_entries(&zero_producer);

    let duplicate_directory = tempfile::tempdir().expect("duplicate tempdir");
    let duplicate_producer = duplicate_directory.path().join("producer");
    fs::create_dir(&duplicate_producer).expect("duplicate producer root");
    let duplicate_manifest =
        write_asset(&duplicate_directory.path().join("asset"), &executable_path);
    let duplicate = build_immutable_group_plan(
        duplicate_producer.clone(),
        7,
        vec![
            public_root_input(&executable_path, &duplicate_manifest, 43_127, "capture", 1),
            public_root_input(&executable_path, &duplicate_manifest, 43_127, "worker", 2),
        ],
    );
    assert!(matches!(duplicate, Err(PrepareError::InvalidPlan)));
    assert_no_producer_entries(&duplicate_producer);
}
