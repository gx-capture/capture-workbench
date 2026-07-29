use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySourceInput {
    pub file_name: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCaptureUpdate {
    pub document_id: String,
    pub capture_id: Option<String>,
    #[serde(default)]
    pub clear_capture_id: bool,
    pub status: String,
    pub stage: Option<String>,
    pub raw: Option<Value>,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListRequest {
    pub query: Option<String>,
    pub status: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocumentRequest {
    pub document_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryExportRequest {
    pub document_id: String,
    pub format: LibraryExportFormat,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryExportFormat {
    Json,
    Text,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocumentSummary {
    pub document_id: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_length: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub status: String,
    pub stage: Option<String>,
    pub capture_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocumentDetail {
    #[serde(flatten)]
    pub summary: LibraryDocumentSummary,
    pub raw: Option<Value>,
    pub result: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySourcePayload {
    pub document_id: String,
    pub file_name: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryExportPayload {
    pub file_name: String,
    pub media_type: String,
    pub content: String,
}
