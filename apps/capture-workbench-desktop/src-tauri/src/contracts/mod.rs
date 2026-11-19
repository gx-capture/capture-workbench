mod desktop;
mod library;
mod runtime;

pub use desktop::{BackendConfig, DesktopRuntimeStatus};
pub(crate) use library::{
    DesktopLibraryDetail, DesktopLibrarySummary, LibraryCaptureOptions, LibraryCaptureUpdate,
    LibraryDocumentRequest, LibraryEditMaps, LibraryEdits, LibraryExportFormat,
    LibraryExportPayload, LibraryExportRequest, LibraryListRequest, LibrarySaveEditsRequest,
    LibrarySourcePayload, OcrEvidenceV1, MAX_EDITS_BYTES,
};
pub(crate) use runtime::{
    RuntimeCancelUploadInput, RuntimeCreateCaptureInput, RuntimeIdInput,
    RuntimeInstallationStartInput, RuntimeRequirementInput, RuntimeStreamingCaptureInput,
    RuntimeStreamingEventsInput, StructuringModelInstallationStartInput,
};

mod selection;
pub(crate) use selection::*;

#[cfg(test)]
pub(crate) use library::LibraryImportSourceRequest;
