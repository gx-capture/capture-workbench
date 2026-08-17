pub(super) fn validate_document_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Capture library document identifier is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_opaque_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Capture Runtime identifier is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_client_request_id(value: &str) -> Result<(), String> {
    validate_opaque_id(value)
        .map_err(|_| "Capture client request identifier is invalid.".to_string())
}

pub(super) fn validate_requirement_id(value: &str) -> Result<(), String> {
    if !matches!(
        value,
        "windowsml-ocr" | "whisper-primary" | "ollama-runtime" | "capture-ollama-model"
    ) {
        return Err("Capture Runtime requirement identifier is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_model_option_id(value: &str) -> Result<(), String> {
    if !matches!(value, "qwen3.5-0.8b-v1" | "qwen3.5-2b-v1" | "qwen3.5-4b-v1") {
        return Err("Capture Runtime model option identifier is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_structuring_mode(value: &str) -> Result<(), String> {
    if matches!(value, "runtime" | "host") {
        Ok(())
    } else {
        Err("Capture structuring mode is invalid.".into())
    }
}
