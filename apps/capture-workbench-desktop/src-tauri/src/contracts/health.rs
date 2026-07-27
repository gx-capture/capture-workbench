#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyHandshake {
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeResult {
    Ready(ReadyHandshake),
    NotReady,
}
