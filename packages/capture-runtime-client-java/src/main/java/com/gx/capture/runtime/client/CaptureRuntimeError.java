package com.gx.capture.runtime.client;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Common machine-code taxonomy shared by all Java SDK failures. */
public class CaptureRuntimeError extends RuntimeException {
  private final Integer status;
  private final String code;
  private final String category;
  private final boolean retryable;
  private final Map<String, Object> details;
  private final List<Map<String, Object>> issues;
  private final String requestId;

  protected CaptureRuntimeError(
      String message,
      Integer status,
      String code,
      String category,
      boolean retryable,
      Map<String, Object> details,
      List<Map<String, Object>> issues,
      String requestId,
      Throwable cause) {
    super(message, cause);
    this.status = status;
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.details = details == null ? Map.of() : Map.copyOf(details);
    this.issues = issues == null ? List.of() : List.copyOf(issues);
    this.requestId = requestId;
  }

  public Integer status() { return status; }
  public String code() { return code; }
  public String category() { return category; }
  public boolean retryable() { return retryable; }
  public Map<String, Object> details() { return details; }
  public List<Map<String, Object>> issues() { return issues; }
  public String requestId() { return requestId; }

  static CaptureRuntimeError fromResponse(
      int status, byte[] body, com.fasterxml.jackson.databind.ObjectMapper mapper) {
    String message = "Capture Runtime request failed with HTTP status " + status;
    try {
      JsonNode root = mapper.readTree(body);
      JsonNode error = root == null ? null : root.get("error");
      if (error != null && error.isObject()) {
        var code = text(error, "code", "remote_error");
        var remoteMessage = text(error, "message", message);
        var category = text(error, "category", "remote");
        var retryable = error.path("retryable").asBoolean(false);
        var requestId = error.hasNonNull("requestId") ? error.get("requestId").asText() : null;
        var details = mapper.convertValue(error.path("details"), Map.class);
        var issues = mapper.convertValue(error.path("issues"), List.class);
        if (status == 401 || status == 403 || "unauthorized".equals(code)) {
          return new CaptureAuthenticationError("Capture Runtime authentication failed", status, requestId);
        }
        return new CaptureRemoteError(
            remoteMessage, status, code, category, retryable, details, issues, requestId);
      }
    } catch (IOException | RuntimeException ignored) {
      // Preserve the status taxonomy even when a proxy returned a malformed body.
    }
    if (status == 401 || status == 403) {
      return new CaptureAuthenticationError("Capture Runtime authentication failed", status, null);
    }
    return new CaptureRemoteError(
        message, status, "http_error", "transport", status >= 500, Map.of(), List.of(), null);
  }

  private static String text(JsonNode node, String field, String fallback) {
    var value = node.get(field);
    return value == null || value.isNull() || value.asText().isBlank() ? fallback : value.asText();
  }
}
