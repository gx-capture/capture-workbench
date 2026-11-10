use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeInstallationStartInput {
    pub client_request_id: String,
    pub requirement_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeModelInstallationStartInput {
    pub client_request_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeCreateCaptureInput {
    pub document_id: String,
    pub client_request_id: String,
    #[serde(default)]
    pub pdf_page_numbers: Option<Vec<u32>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStreamingCaptureInput {
    pub document_id: String,
    pub client_request_id: String,
    pub structuring_mode: String,
    /// Ask the runtime to label who speaks each segment.
    #[serde(default)]
    pub identify_speakers: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStreamingEventsInput {
    pub id: String,
    pub last_event_id: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeIdInput {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeRequirementInput {
    pub requirement_id: String,
}
