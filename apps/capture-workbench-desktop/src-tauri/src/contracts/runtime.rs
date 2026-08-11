use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallationStartInput {
    pub client_request_id: String,
    pub requirement_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelInstallationStartInput {
    pub client_request_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCreateCaptureInput {
    pub document_id: String,
    pub client_request_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStreamingCaptureInput {
    pub document_id: String,
    pub client_request_id: String,
    pub structuring_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStreamingEventsInput {
    pub id: String,
    pub last_event_id: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdInput {
    pub id: String,
}
