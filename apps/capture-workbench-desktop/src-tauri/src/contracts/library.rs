use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_OCR_EVIDENCE_PAGES: usize = 500;
const MAX_OCR_EVIDENCE_STRING: usize = 512;
const MAX_OCR_EVIDENCE_MESSAGE: usize = 500;
const MAX_OCR_EVIDENCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_OCR_EVIDENCE_COUNT: u64 = 8_000_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidenceFailureV1 {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidenceConfidenceSummaryV1 {
    pub score_state: String,
    pub numeric_count: u64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidenceRasterV1 {
    pub width: u64,
    pub height: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidencePageV1 {
    pub page: u64,
    pub status: String,
    pub raster: OcrEvidenceRasterV1,
    pub normalized_char_count: u64,
    pub box_count: u64,
    pub confidence: Option<f64>,
    pub confidence_summary: OcrEvidenceConfidenceSummaryV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<OcrEvidenceFailureV1>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidenceProvenanceV1 {
    pub status: String,
    pub runtime_version: String,
    pub contract_sha256: String,
    pub engine: Option<String>,
    pub model: Option<String>,
    pub model_digest: Option<String>,
    pub device: Option<String>,
    pub profile_id: String,
    pub profile_spec_sha256: String,
    pub worker_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidenceV1 {
    pub schema_version: u8,
    pub capture_id: String,
    pub source_sha256: String,
    pub status: String,
    pub page_count: u64,
    pub pages: Vec<OcrEvidencePageV1>,
    pub summary: OcrEvidenceSummaryV1,
    pub provenance: OcrEvidenceProvenanceV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<OcrEvidenceFailureV1>,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrEvidenceSummaryV1 {
    pub normalized_char_count: u64,
    pub box_count: u64,
    pub confidence_summary: OcrEvidenceConfidenceSummaryV1,
}

impl OcrEvidenceV1 {
    pub fn validate(&self) -> Result<(), String> {
        let encoded = serde_json::to_vec(self)
            .map_err(|error| format!("OCR evidence cannot be encoded: {error}"))?;
        if encoded.len() > MAX_OCR_EVIDENCE_BYTES {
            return Err("OCR evidence exceeds the durable size limit.".into());
        }
        if self.schema_version != 1 {
            return Err("OCR evidence schemaVersion is unsupported.".into());
        }
        validate_string(&self.capture_id, "captureId", MAX_OCR_EVIDENCE_STRING)?;
        validate_sha256(&self.source_sha256, "sourceSha256")?;
        if self.status != "completed" && self.status != "failed" {
            return Err("OCR evidence status is invalid.".into());
        }
        if self.page_count > MAX_OCR_EVIDENCE_PAGES as u64
            || self.pages.len() != self.page_count as usize
        {
            return Err("OCR evidence pageCount/pages are invalid.".into());
        }
        for (index, page) in self.pages.iter().enumerate() {
            validate_page(page, index + 1)?;
        }
        if self.status == "completed" {
            if self.failure.is_some()
                || self.pages.iter().any(|page| page.status == "failed")
                || !self.pages.iter().any(|page| page.status == "recognized")
                || self.provenance.status != "resolved"
            {
                return Err("OCR evidence completed shape is invalid.".into());
            }
        } else if self.failure.is_none() {
            return Err("OCR evidence failed shape is invalid.".into());
        }
        let normalized_char_count = self
            .pages
            .iter()
            .try_fold(0_u64, |sum, page| {
                sum.checked_add(page.normalized_char_count)
            })
            .ok_or_else(|| "OCR evidence summary counts overflow.".to_string())?;
        let box_count = self
            .pages
            .iter()
            .try_fold(0_u64, |sum, page| sum.checked_add(page.box_count))
            .ok_or_else(|| "OCR evidence summary counts overflow.".to_string())?;
        if self.summary.normalized_char_count != normalized_char_count
            || self.summary.box_count != box_count
            || self.summary.normalized_char_count > MAX_OCR_EVIDENCE_COUNT
            || self.summary.box_count > MAX_OCR_EVIDENCE_COUNT
        {
            return Err("OCR evidence summary counts are invalid.".into());
        }
        validate_confidence_summary(&self.summary.confidence_summary)?;
        validate_summary_confidence_consistency(self)?;
        validate_provenance(&self.provenance)?;
        if let Some(failure) = &self.failure {
            validate_failure(failure)?;
        }
        validate_sha256(&self.digest, "digest")?;
        if self.digest == "0".repeat(64) {
            return Err("OCR evidence digest is empty.".into());
        }
        let mut payload = serde_json::to_value(self)
            .map_err(|error| format!("OCR evidence cannot be encoded: {error}"))?;
        payload
            .as_object_mut()
            .and_then(|object| object.remove("digest"))
            .ok_or_else(|| "OCR evidence digest is missing.".to_string())?;
        let actual_digest = format!("{:x}", Sha256::digest(canonical_json(&payload).as_bytes()));
        if self.digest != actual_digest {
            return Err("OCR evidence digest does not match its content.".into());
        }
        Ok(())
    }
}

fn validate_page(page: &OcrEvidencePageV1, expected_page: usize) -> Result<(), String> {
    if page.page != expected_page as u64 {
        return Err("OCR evidence pages must be ordered 1..N.".into());
    }
    if page.raster.width == 0
        || page.raster.height == 0
        || page.raster.width > 100_000
        || page.raster.height > 100_000
    {
        return Err("OCR evidence raster dimensions are invalid.".into());
    }
    if page.status != "recognized" && page.status != "empty" && page.status != "failed" {
        return Err("OCR evidence page status is invalid.".into());
    }
    validate_confidence(page.confidence, "page confidence")?;
    validate_confidence_summary(&page.confidence_summary)?;
    match page.status.as_str() {
        "recognized" => {
            if page.normalized_char_count == 0
                || page.failure.is_some()
                || page.confidence.is_none()
            {
                return Err("OCR evidence recognized page shape is invalid.".into());
            }
        }
        "empty" => {
            if page.normalized_char_count != 0
                || page.box_count != 0
                || page.confidence.is_some()
                || page.failure.is_some()
            {
                return Err("OCR evidence empty page shape is invalid.".into());
            }
        }
        "failed" => {
            if page.normalized_char_count != 0
                || page.box_count != 0
                || page.confidence.is_some()
                || page.failure.is_none()
            {
                return Err("OCR evidence failed page shape is invalid.".into());
            }
        }
        _ => unreachable!(),
    }
    if page.normalized_char_count > MAX_OCR_EVIDENCE_COUNT || page.box_count > 100_000 {
        return Err("OCR evidence box count exceeds the durable limit.".into());
    }
    if page.status != "recognized" && page.confidence_summary.numeric_count != 0 {
        return Err("OCR evidence non-recognized page confidence is invalid.".into());
    }
    Ok(())
}

fn validate_provenance(provenance: &OcrEvidenceProvenanceV1) -> Result<(), String> {
    if provenance.status != "resolved" && provenance.status != "unavailable" {
        return Err("OCR evidence provenance status is invalid.".into());
    }
    validate_string(
        &provenance.runtime_version,
        "runtimeVersion",
        MAX_OCR_EVIDENCE_STRING,
    )?;
    validate_sha256(&provenance.contract_sha256, "contractSha256")?;
    validate_string(&provenance.profile_id, "profileId", MAX_OCR_EVIDENCE_STRING)?;
    validate_sha256(&provenance.profile_spec_sha256, "profileSpecSha256")?;
    validate_sha256(&provenance.worker_sha256, "workerSha256")?;
    match provenance.status.as_str() {
        "resolved" => {
            if provenance.engine.as_deref() != Some("windowsml-ocr")
                || provenance.model.as_deref().is_none()
                || provenance.model_digest.as_deref().is_none()
                || provenance.device.as_deref().is_none()
            {
                return Err("OCR evidence resolved provenance is invalid.".into());
            }
            validate_string(
                provenance.model.as_deref().unwrap_or_default(),
                "model",
                MAX_OCR_EVIDENCE_STRING,
            )?;
            validate_string(
                provenance.device.as_deref().unwrap_or_default(),
                "device",
                MAX_OCR_EVIDENCE_STRING,
            )?;
            let digest = provenance.model_digest.as_deref().unwrap_or_default();
            if !digest.starts_with("sha256:") || digest.len() != 71 || !is_lower_hex(&digest[7..]) {
                return Err("OCR evidence modelDigest is invalid.".into());
            }
            if digest == format!("sha256:{}", "0".repeat(64)) {
                return Err("OCR evidence modelDigest is empty.".into());
            }
        }
        "unavailable" => {
            if provenance.engine.is_some()
                || provenance.model.is_some()
                || provenance.model_digest.is_some()
                || provenance.device.is_some()
            {
                return Err("OCR evidence unavailable provenance is invalid.".into());
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_failure(failure: &OcrEvidenceFailureV1) -> Result<(), String> {
    if failure.code.len() < 2
        || failure.code.len() > 64
        || !failure.code.as_bytes()[0].is_ascii_lowercase()
        || !failure
            .code
            .bytes()
            .skip(1)
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("OCR evidence failure code is invalid.".into());
    }
    validate_string(
        &failure.message,
        "failure message",
        MAX_OCR_EVIDENCE_MESSAGE,
    )?;
    if failure.message != format!("OCR failure: {}.", failure.code) {
        return Err("OCR evidence failure message is not sanitized.".into());
    }
    if failure.stage.as_deref().is_some_and(|stage| {
        stage.is_empty()
            || stage.len() > MAX_OCR_EVIDENCE_STRING
            || !stage.as_bytes()[0].is_ascii_lowercase()
            || !stage.bytes().skip(1).all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.-".contains(&byte)
            })
    }) {
        return Err("OCR evidence failure stage is invalid.".into());
    }
    Ok(())
}

fn validate_confidence(value: Option<f64>, label: &str) -> Result<(), String> {
    if value.is_some_and(|value| !is_canonical_confidence(value)) {
        return Err(format!("OCR evidence {label} is invalid."));
    }
    Ok(())
}

fn is_canonical_confidence(value: f64) -> bool {
    value.is_finite()
        && (0.0..=1.0).contains(&value)
        && !(value == 0.0 && value.is_sign_negative())
        && ((value * 10_000.0).round() - value * 10_000.0).abs() <= 1e-9
}

fn validate_confidence_summary(summary: &OcrEvidenceConfidenceSummaryV1) -> Result<(), String> {
    match summary.score_state.as_str() {
        "none"
            if summary.numeric_count == 0
                && summary.min.is_none()
                && summary.max.is_none()
                && summary.mean.is_none() =>
        {
            Ok(())
        }
        "numeric"
            if summary.numeric_count > 0
                && summary.min.zip(summary.max).zip(summary.mean).is_some_and(
                    |((min, max), mean)| {
                        validate_confidence(Some(min), "confidence summary min").is_ok()
                            && validate_confidence(Some(max), "confidence summary max").is_ok()
                            && validate_confidence(Some(mean), "confidence summary mean").is_ok()
                            && min <= max
                    },
                ) =>
        {
            Ok(())
        }
        _ => Err("OCR evidence confidence summary is invalid.".into()),
    }
}

fn validate_summary_confidence_consistency(evidence: &OcrEvidenceV1) -> Result<(), String> {
    let summaries = evidence
        .pages
        .iter()
        .map(|page| &page.confidence_summary)
        .filter(|summary| summary.score_state == "numeric")
        .collect::<Vec<_>>();
    let expected = if summaries.is_empty() {
        OcrEvidenceConfidenceSummaryV1 {
            score_state: "none".into(),
            numeric_count: 0,
            min: None,
            max: None,
            mean: None,
        }
    } else {
        let numeric_count = summaries
            .iter()
            .try_fold(0_u64, |sum, summary| sum.checked_add(summary.numeric_count))
            .ok_or_else(|| "OCR evidence confidence count overflow.".to_string())?;
        let min = summaries
            .iter()
            .filter_map(|summary| summary.min)
            .fold(f64::INFINITY, f64::min);
        let max = summaries
            .iter()
            .filter_map(|summary| summary.max)
            .fold(f64::NEG_INFINITY, f64::max);
        let weighted_sum = summaries
            .iter()
            .try_fold(0.0_f64, |sum, summary| {
                Some(sum + summary.mean? * summary.numeric_count as f64)
            })
            .ok_or_else(|| "OCR evidence confidence summary is incomplete.".to_string())?;
        OcrEvidenceConfidenceSummaryV1 {
            score_state: "numeric".into(),
            numeric_count,
            min: Some(min),
            max: Some(max),
            mean: Some(weighted_sum / numeric_count as f64),
        }
    };
    let actual = &evidence.summary.confidence_summary;
    if actual.score_state != expected.score_state
        || actual.numeric_count != expected.numeric_count
        || !approximately_equal(actual.min, expected.min)
        || !approximately_equal(actual.max, expected.max)
        || !approximately_equal(actual.mean, expected.mean)
    {
        return Err("OCR evidence summary confidence is inconsistent.".into());
    }
    Ok(())
}

fn approximately_equal(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => (left - right).abs() <= 0.0002,
        _ => false,
    }
}

fn validate_string(value: &str, label: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(format!("OCR evidence {label} is invalid."));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64 || !is_lower_hex(value) {
        return Err(format!("OCR evidence {label} is invalid."));
    }
    Ok(())
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => canonical_number(value),
        Value::String(value) => serde_json::to_string(value).expect("string serialization"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).expect("key serialization"),
                            canonical_json(&values[*key])
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_number(value: &serde_json::Number) -> String {
    if let Some(integer) = value.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = value.as_u64() {
        return integer.to_string();
    }
    value
        .as_f64()
        .filter(|value| is_canonical_confidence(*value))
        .map(format_bounded_confidence)
        .unwrap_or_else(|| "null".into())
}

fn format_bounded_confidence(value: f64) -> String {
    let scaled = (value * 10_000.0).round() as u64;
    let integer = scaled / 10_000;
    let fractional = scaled % 10_000;
    if fractional == 0 {
        return integer.to_string();
    }
    let fraction = format!("{fractional:04}").trim_end_matches('0').to_string();
    format!("{integer}.{fraction}")
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySourceInput {
    pub file_name: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportSourceRequest {
    pub source_path: String,
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
    pub recovery_code: Option<String>,
    pub recovery_message: Option<String>,
    #[serde(default)]
    pub ocr_evidence: Option<OcrEvidenceV1>,
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
    pub recovery_code: Option<String>,
    pub recovery_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocumentDetail {
    #[serde(flatten)]
    pub summary: LibraryDocumentSummary,
    pub raw: Option<Value>,
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_evidence: Option<OcrEvidenceV1>,
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
