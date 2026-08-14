package com.gx.capture.runtime.client;

import java.util.List;
import java.util.Map;

/** Remote problem code; unknown codes are intentionally retained rather than rejected. */
public class CaptureRemoteError extends CaptureRuntimeError {
  public CaptureRemoteError(
      String message,
      int status,
      String code,
      String category,
      boolean retryable,
      Map<String, Object> details,
      List<Map<String, Object>> issues,
      String requestId) {
    super(message, status, code, category, retryable, details, issues, requestId, null);
  }
}
