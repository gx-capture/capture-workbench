pub use crate::contracts::{BackendConfig, DesktopRuntimeStatus};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_redacts_bearer_token() {
        let config = BackendConfig {
            base_url: "http://127.0.0.1:49152".into(),
            token: "do-not-print-this".into(),
            runtime_version: "0.4.1".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        };

        let output = format!("{config:?}");
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("do-not-print-this"));
    }

    #[test]
    fn angular_transport_uses_camel_case_without_authorization_prefix() {
        let config = BackendConfig {
            base_url: "http://127.0.0.1:49152".into(),
            token: "secret".into(),
            runtime_version: "0.4.1".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        };

        assert_eq!(
            serde_json::to_value(config).expect("serialize"),
            serde_json::json!({
                "baseUrl": "http://127.0.0.1:49152",
                "token": "secret",
                "runtimeVersion": "0.4.1",
                "apiVersion": "2.0",
                "captureDocumentSchemaVersion": "2"
            })
        );
    }
}
