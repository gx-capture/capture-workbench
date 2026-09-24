use std::fmt;

use serde::Serialize;

/// Memory-only connection information returned to the Angular desktop host.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

impl fmt::Debug for BackendConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackendConfig")
            .field("base_url", &self.base_url)
            .field("token", &"[REDACTED]")
            .field("runtime_version", &self.runtime_version)
            .field("api_version", &self.api_version)
            .field(
                "capture_document_schema_version",
                &self.capture_document_schema_version,
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub status: String,
    pub detail: String,
    pub base_url: Option<String>,
    pub runtime_version: Option<String>,
    pub api_version: Option<String>,
    pub capture_document_schema_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_page_numbers: Option<Vec<u32>>,
}

impl DesktopRuntimeStatus {
    pub(crate) fn starting() -> Self {
        Self {
            status: "starting".into(),
            detail: "Capture runtime is starting.".into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
            pdf_page_numbers: None,
        }
    }

    pub(crate) fn failed(detail: impl Into<String>) -> Self {
        Self {
            status: "failed".into(),
            detail: detail.into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
            pdf_page_numbers: None,
        }
    }

    pub(crate) fn failed_cleanup(detail: impl Into<String>) -> Self {
        Self {
            status: "failed-cleanup".into(),
            detail: detail.into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
            pdf_page_numbers: None,
        }
    }

    pub(crate) fn ready(config: &BackendConfig) -> Self {
        Self {
            status: "ready".into(),
            detail: "Capture runtime is ready.".into(),
            base_url: Some(config.base_url.clone()),
            runtime_version: Some(config.runtime_version.clone()),
            api_version: Some(config.api_version.clone()),
            capture_document_schema_version: Some(config.capture_document_schema_version.clone()),
            pdf_page_numbers: acceptance_pdf_page_numbers(),
        }
    }

    pub(crate) fn stopped() -> Self {
        Self {
            status: "stopped".into(),
            detail: "Capture runtime was stopped by Capture Workbench.".into(),
            base_url: None,
            runtime_version: None,
            api_version: None,
            capture_document_schema_version: None,
            pdf_page_numbers: None,
        }
    }
}

fn acceptance_pdf_page_numbers() -> Option<Vec<u32>> {
    #[cfg(feature = "acceptance-app-data")]
    {
        return acceptance_pdf_page_numbers_for_scope(
            std::env::var("CAPTURE_ACCEPTANCE_PDF_PAGE_SCOPE")
                .ok()
                .as_deref(),
        );
    }

    #[cfg(not(feature = "acceptance-app-data"))]
    {
        None
    }
}

#[cfg(any(feature = "acceptance-app-data", test))]
fn acceptance_pdf_page_numbers_for_scope(scope: Option<&str>) -> Option<Vec<u32>> {
    (scope == Some("page-1")).then_some(vec![1])
}

#[cfg(test)]
mod tests {
    use super::{acceptance_pdf_page_numbers_for_scope, BackendConfig, DesktopRuntimeStatus};

    #[test]
    fn acceptance_scope_is_exactly_page_one() {
        assert_eq!(
            acceptance_pdf_page_numbers_for_scope(Some("page-1")),
            Some(vec![1])
        );
        assert_eq!(acceptance_pdf_page_numbers_for_scope(None), None);
        assert_eq!(
            acceptance_pdf_page_numbers_for_scope(Some("all-pages")),
            None
        );
        assert_eq!(acceptance_pdf_page_numbers_for_scope(Some("page-2")), None);
    }

    #[test]
    fn non_ready_statuses_omit_the_optional_scope() {
        let serialized = serde_json::to_value(DesktopRuntimeStatus::starting()).expect("status");
        assert!(!serialized
            .as_object()
            .expect("status object")
            .contains_key("pdfPageNumbers"));
    }

    #[cfg(not(feature = "acceptance-app-data"))]
    #[test]
    fn production_ready_status_omits_the_acceptance_only_scope() {
        let serialized = serde_json::to_value(DesktopRuntimeStatus::ready(&BackendConfig {
            base_url: "http://127.0.0.1:1".into(),
            token: "token".into(),
            runtime_version: "0.4.2".into(),
            api_version: "2.0".into(),
            capture_document_schema_version: "2".into(),
        }))
        .expect("status");
        assert!(!serialized
            .as_object()
            .expect("status object")
            .contains_key("pdfPageNumbers"));
    }
}
