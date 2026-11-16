mod desktop;
mod library;
mod runtime;

pub use desktop::{BackendConfig, DesktopRuntimeStatus};
pub(crate) use library::{
    LibraryCaptureOptions, LibraryCaptureUpdate, LibraryDocumentDetail, LibraryDocumentRequest,
    LibraryDocumentSummary, LibraryEditMaps, LibraryEdits, LibraryExportFormat,
    LibraryExportPayload, LibraryExportRequest, LibraryListRequest, LibrarySaveEditsRequest,
    LibrarySourcePayload, OcrEvidenceV1, MAX_EDITS_BYTES,
};
pub(crate) use runtime::{
    RuntimeCancelUploadInput, RuntimeCreateCaptureInput, RuntimeIdInput,
    RuntimeInstallationStartInput, RuntimeModelInstallationStartInput, RuntimeRequirementInput,
    RuntimeStreamingCaptureInput, RuntimeStreamingEventsInput,
};

mod selection;
pub(crate) use selection::*;

#[cfg(any(test, feature = "model-smoke-app-data"))]
pub(crate) use library::LibraryImportSourceRequest;
