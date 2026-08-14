package com.gx.capture.runtime.client;

/** Authentication failures returned by the runtime. */
public class CaptureAuthenticationError extends CaptureRuntimeError {
  public CaptureAuthenticationError(String message, int status, String requestId) {
    super(message, status, "unauthorized", "auth", false, null, null, requestId, null);
  }
}
