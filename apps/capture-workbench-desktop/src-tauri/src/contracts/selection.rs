use super::LibraryCaptureOptions;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceSelectionKind {
    Documents,
    Recordings,
    All,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LibrarySelectSourcesRequest {
    pub kind: SourceSelectionKind,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySourceSelection {
    pub selection_token: String,
    pub file_name: String,
    pub byte_length: u64,
    pub media_type: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceRejectionReason {
    Unsupported,
    Empty,
    TooLarge,
    NotRegularFile,
    NotLocal,
    Unreadable,
    LimitReached,
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySourceSelectionBatch {
    pub selections: Vec<LibrarySourceSelection>,
    pub rejected: Vec<SourceRejectionReason>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LibraryImportSelectionRequest {
    pub selection_token: String,
    pub capture_options: Option<LibraryCaptureOptions>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LibraryDiscardSelectionsRequest {
    pub selection_tokens: Vec<String>,
}
