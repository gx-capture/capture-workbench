use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocumentExtent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) page_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) duration_ms: Option<f64>,
}

impl DocumentExtent {
    /// Mirrors result details: source page count, then grouped nonblank and
    /// processed pages. Only recordings have a duration (the latest raw end).
    pub(super) fn derive(raw: &Value, media_type: &str) -> Self {
        let segments = raw["segments"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if media_type.starts_with("audio/") || media_type.starts_with("video/") {
            let duration_ms = segments
                .iter()
                .filter(|segment| segment["locator"]["kind"] == "time")
                .filter_map(|segment| segment["locator"]["endMs"].as_f64())
                .filter(|end| end.is_finite() && *end > 0.0)
                .reduce(f64::max);
            return Self {
                page_count: None,
                duration_ms,
            };
        }
        let mut pages = BTreeSet::new();
        for segment in segments {
            if segment["locator"]["kind"] == "page"
                && segment["text"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty())
            {
                if let Some(page) = segment["locator"]["page"].as_u64() {
                    pages.insert(page);
                }
            }
        }
        if let Some(processed) = raw["ocrPageScope"]["processedPageNumbers"].as_array() {
            pages.extend(processed.iter().filter_map(Value::as_u64));
        }
        let page_count = raw["ocrPageScope"]["sourcePageCount"]
            .as_u64()
            .or_else(|| (!pages.is_empty()).then_some(pages.len() as u64))
            .or_else(|| (media_type != "application/pdf").then_some(1));
        Self {
            page_count,
            duration_ms: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn document_pages_follow_source_scope_or_grouped_pages() {
        let raw = json!({
            "segments": [
                {"text": "one", "locator": {"kind": "page", "page": 3}},
                {"text": "two", "locator": {"kind": "page", "page": 3}},
                {"text": "   ", "locator": {"kind": "page", "page": 5}}
            ],
            "ocrPageScope": {"sourcePageCount": 12, "processedPageNumbers": [3, 5]}
        });
        assert_eq!(
            DocumentExtent::derive(&raw, "application/pdf").page_count,
            Some(12)
        );
        let mut unscoped = raw.clone();
        unscoped.as_object_mut().unwrap().remove("ocrPageScope");
        assert_eq!(
            DocumentExtent::derive(&unscoped, "application/pdf").page_count,
            Some(1)
        );
        unscoped["ocrPageScope"] = json!({"processedPageNumbers": [3, 5]});
        assert_eq!(
            DocumentExtent::derive(&unscoped, "application/pdf").page_count,
            Some(2)
        );
        assert_eq!(
            DocumentExtent::derive(&raw, "application/pdf").duration_ms,
            None
        );
    }

    #[test]
    fn empty_document_and_image_have_no_duration() {
        let raw = json!({"segments": []});
        assert_eq!(
            DocumentExtent::derive(&raw, "application/pdf"),
            DocumentExtent::default()
        );
        assert_eq!(
            DocumentExtent::derive(&raw, "image/png"),
            DocumentExtent {
                page_count: Some(1),
                duration_ms: None,
            }
        );
    }

    #[test]
    fn recording_duration_uses_latest_positive_time_end_only() {
        let raw = json!({"segments": [
            {"locator": {"kind": "time", "endMs": 4200}},
            {"locator": {"kind": "time", "endMs": 1200}},
            {"locator": {"kind": "page", "page": 99, "endMs": 9999}}
        ]});
        assert_eq!(
            DocumentExtent::derive(&raw, "audio/mpeg"),
            DocumentExtent {
                page_count: None,
                duration_ms: Some(4200.0),
            }
        );
        for raw in [
            json!({"segments": []}),
            json!({"segments": [
                {"locator": {"kind": "time", "endMs": 0}},
                {"locator": {"kind": "time", "endMs": -10}},
                {"locator": {"kind": "time", "endMs": "unknown"}}
            ]}),
        ] {
            assert_eq!(
                DocumentExtent::derive(&raw, "video/mp4"),
                DocumentExtent::default()
            );
        }
    }
}
