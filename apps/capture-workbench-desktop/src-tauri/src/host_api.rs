use std::{path::PathBuf, sync::Arc};

use serde_json::Value;

use crate::{
    config::DesktopRuntimeStatus,
    contracts::{
        DesktopLibraryDetail, DesktopLibrarySummary, LibraryCaptureUpdate,
        LibraryDiscardSelectionsRequest, LibraryDocumentRequest, LibraryEdits,
        LibraryExportPayload, LibraryExportRequest, LibraryImportSelectionRequest,
        LibraryListRequest, LibrarySaveEditsRequest, LibrarySourceSelectionBatch,
        RuntimeCancelUploadInput, RuntimeCaptureEventsInput, RuntimeCreateCaptureInput,
        RuntimeIdInput, RuntimeInstallationStartInput, RuntimeRecordingCaptureInput,
        RuntimeRequirementInput, SourceSelectionKind, StructuringModelInstallationStartInput,
    },
    library::LibraryStore,
    resources::RuntimeExecutablePaths,
    runtime_client::{self, UploadCancellations},
    source_selection::SourceSelections,
    speech_gpu::{DesktopSpeechGpuStatus, SpeechGpuSettings},
    state::DesktopState,
};

pub(crate) fn desktop_speech_gpu_status(state: &DesktopState) -> DesktopSpeechGpuStatus {
    DesktopSpeechGpuStatus::read(state.data_dir())
}

pub(crate) fn desktop_set_speech_prefer_gpu(
    state: &DesktopState,
    assets: Option<&RuntimeExecutablePaths>,
    prefer_gpu: bool,
) -> Result<DesktopSpeechGpuStatus, String> {
    let settings = SpeechGpuSettings { prefer_gpu };
    if settings != SpeechGpuSettings::load(state.data_dir()) {
        settings.save(state.data_dir())?;
        let assets = assets.ok_or_else(|| "Capture runtime assets are unavailable.".to_string())?;
        state.start(assets.clone());
    }
    Ok(DesktopSpeechGpuStatus::read(state.data_dir()))
}

pub(crate) fn desktop_runtime_status(state: &DesktopState) -> DesktopRuntimeStatus {
    state.status()
}

pub(crate) fn runtime_ready(state: &DesktopState) -> Result<Value, String> {
    runtime_client::ready(state)
}

pub(crate) fn library_inspect_selected_sources(
    selections: &SourceSelections,
    owner: &str,
    paths: Vec<PathBuf>,
    kind: SourceSelectionKind,
) -> Result<LibrarySourceSelectionBatch, String> {
    selections.inspect_batch(owner, paths, kind)
}

pub(crate) fn library_import_selection(
    owner: &str,
    selections: &SourceSelections,
    library: &LibraryStore,
    request: LibraryImportSelectionRequest,
) -> Result<DesktopLibrarySummary, String> {
    selections.import(owner, request, library)
}

pub(crate) fn library_discard_selections(
    owner: &str,
    selections: &SourceSelections,
    request: LibraryDiscardSelectionsRequest,
) -> Result<(), String> {
    selections.discard(owner, &request.selection_tokens)
}

pub(crate) fn library_update_capture(
    library: &LibraryStore,
    update: LibraryCaptureUpdate,
) -> Result<DesktopLibrarySummary, String> {
    library.update_capture(update)
}

pub(crate) fn library_list(
    library: &LibraryStore,
    request: LibraryListRequest,
) -> Result<Vec<DesktopLibrarySummary>, String> {
    library.list(request)
}

pub(crate) fn library_get(
    library: &LibraryStore,
    request: LibraryDocumentRequest,
) -> Result<DesktopLibraryDetail, String> {
    library.get(request)
}

pub(crate) fn library_save_edits(
    library: &LibraryStore,
    request: LibrarySaveEditsRequest,
) -> Result<LibraryEdits, String> {
    library.save_edits(&request.document_id, request.edits)
}

pub(crate) fn library_export(
    library: &LibraryStore,
    request: LibraryExportRequest,
) -> Result<LibraryExportPayload, String> {
    library.export(request)
}

pub(crate) fn library_source_bytes(
    library: &LibraryStore,
    request: LibraryDocumentRequest,
) -> Result<Vec<u8>, String> {
    library.source_bytes(request)
}

pub(crate) fn library_delete(
    library: &LibraryStore,
    request: LibraryDocumentRequest,
) -> Result<(), String> {
    library.delete(request)
}

pub(crate) fn runtime_requirements(state: &DesktopState) -> Result<Value, String> {
    runtime_client::requirements(state)
}

pub(crate) fn runtime_start_installation(
    state: &DesktopState,
    input: RuntimeInstallationStartInput,
) -> Result<Value, String> {
    runtime_client::start_installation(state, input)
}

pub(crate) fn runtime_list_installations(state: &DesktopState) -> Result<Value, String> {
    runtime_client::list_installations(state)
}

pub(crate) fn runtime_get_installation(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::installation(state, input)
}

pub(crate) fn runtime_cancel_installation(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::cancel_installation(state, input)
}

pub(crate) fn runtime_uninstall_requirement(
    state: &DesktopState,
    input: RuntimeRequirementInput,
) -> Result<Value, String> {
    runtime_client::uninstall_requirement(state, input)
}

pub(crate) fn runtime_structuring_model_options(state: &DesktopState) -> Result<Value, String> {
    runtime_client::structuring_model_options(state)
}

pub(crate) fn runtime_start_structuring_model_installation(
    state: &DesktopState,
    input: StructuringModelInstallationStartInput,
) -> Result<Value, String> {
    runtime_client::start_structuring_model_installation(state, input)
}

pub(crate) fn runtime_get_structuring_model_installation(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::structuring_model_installation(state, input)
}

pub(crate) fn runtime_cancel_upload(
    uploads: &UploadCancellations,
    input: RuntimeCancelUploadInput,
) -> Result<(), String> {
    runtime_client::cancel_upload(uploads, input)
}

pub(crate) fn runtime_create_capture(
    state: &DesktopState,
    library: &LibraryStore,
    uploads: &Arc<UploadCancellations>,
    input: RuntimeCreateCaptureInput,
) -> Result<Value, String> {
    let upload = uploads.begin(&input.client_request_id)?;
    runtime_client::create_capture(state, library, input, &upload)
}

pub(crate) fn runtime_start_recording_capture(
    state: &DesktopState,
    library: &LibraryStore,
    uploads: &Arc<UploadCancellations>,
    input: RuntimeRecordingCaptureInput,
) -> Result<Value, String> {
    let upload = uploads.begin(&input.client_request_id)?;
    runtime_client::start_recording_capture(state, library, input, &upload)
}

pub(crate) fn runtime_get_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::capture(state, input)
}

pub(crate) fn runtime_get_capture_events(
    state: &DesktopState,
    input: RuntimeCaptureEventsInput,
) -> Result<Value, String> {
    runtime_client::capture_events(state, input)
}

pub(crate) fn runtime_get_partial(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::capture_partial(state, input)
}

pub(crate) fn runtime_cancel_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::cancel_capture(state, input)
}

pub(crate) fn runtime_get_raw(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::raw_capture(state, input)
}

pub(crate) fn runtime_get_ocr(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::capture_ocr(state, input)
}

pub(crate) fn runtime_get_result(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::capture_result(state, input)
}

pub(crate) fn runtime_delete_capture(
    state: &DesktopState,
    input: RuntimeIdInput,
) -> Result<Value, String> {
    runtime_client::delete_capture(state, input)
}
